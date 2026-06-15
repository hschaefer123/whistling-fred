/* Minimal but musical ProTracker (.MOD) replayer for the Web Audio API.
 * 4 channels, "M.K." format. Renders via ScriptProcessor and exposes
 * per-channel note-on events (with absolute AudioContext times) so the
 * page can animate the whistling character in perfect sync.
 *
 * Effects implemented: 0 arpeggio, 1/2 porta up/down, 3 tone porta,
 * 4 vibrato, 5/6 (+volslide), 9 sample offset, A volume slide,
 * B position jump, C set volume, D pattern break, F speed/tempo,
 * E1/E2 fine porta, E9 retrig, EA/EB fine volslide, EC note cut,
 * ED note delay, EE pattern delay.
 */
(function (global) {
  'use strict';

  var PERIODS = [
    856,808,762,720,678,640,604,570,538,508,480,453,
    428,404,381,360,339,320,302,285,269,254,240,226,
    214,202,190,180,170,160,151,143,135,127,120,113
  ];

  // sine table for vibrato/tremolo
  var SINE = [
    0,24,49,74,97,120,141,161,180,197,212,224,235,244,250,253,
    255,253,250,244,235,224,212,197,180,161,141,120,97,74,49,24
  ];

  var PAULA_PAL = 7093789.2;

  function periodToFinetune(period, finetune) {
    if (!finetune) return period;
    var ft = finetune < 8 ? finetune : finetune - 16; // 0..7, 8..15 -> -8..-1
    return period * Math.pow(2, -ft / 96);
  }

  function ProTracker(arrayBuffer, sampleRate) {
    this.sampleRate = sampleRate;
    var d = new Uint8Array(arrayBuffer);
    this.data = d;

    this.title = readString(d, 0, 20);

    // 31 samples
    this.samples = [];
    var off = 20;
    for (var i = 0; i < 31; i++) {
      var name = readString(d, off, 22);
      var len = ((d[off + 22] << 8) | d[off + 23]) * 2;
      var finetune = d[off + 24] & 0x0f;
      var volume = d[off + 25];
      var repStart = ((d[off + 26] << 8) | d[off + 27]) * 2;
      var repLen = ((d[off + 28] << 8) | d[off + 29]) * 2;
      this.samples.push({
        name: name, length: len, finetune: finetune, volume: volume,
        repeatStart: repStart, repeatLength: repLen, data: null
      });
      off += 30;
    }

    this.songLength = d[950];
    this.orders = [];
    var maxPat = 0;
    for (i = 0; i < 128; i++) {
      this.orders.push(d[952 + i]);
      if (d[952 + i] > maxPat) maxPat = d[952 + i];
    }
    this.numPatterns = maxPat + 1;

    // patterns: each pattern 64 rows x 4 channels x 4 bytes
    var patBase = 1084;
    this.patterns = [];
    for (var p = 0; p < this.numPatterns; p++) {
      var rows = [];
      for (var r = 0; r < 64; r++) {
        var chans = [];
        for (var c = 0; c < 4; c++) {
          var o = patBase + p * 1024 + r * 16 + c * 4;
          var b0 = d[o], b1 = d[o + 1], b2 = d[o + 2], b3 = d[o + 3];
          var period = ((b0 & 0x0f) << 8) | b1;
          var sample = (b0 & 0xf0) | (b2 >> 4);
          var effect = b2 & 0x0f;
          var param = b3;
          chans.push({ period: period, sample: sample, effect: effect, param: param });
        }
        rows.push(chans);
      }
      this.patterns.push(rows);
    }

    // sample PCM data
    var sOff = patBase + this.numPatterns * 1024;
    for (i = 0; i < 31; i++) {
      var s = this.samples[i];
      if (s.length > 0) {
        var pcm = new Float32Array(s.length);
        for (var j = 0; j < s.length; j++) {
          var v = d[sOff + j];
          pcm[j] = (v < 128 ? v : v - 256) / 128;
        }
        s.data = pcm;
        sOff += s.length;
      }
    }

    this._initState();
  }

  function readString(d, off, len) {
    var s = '';
    for (var i = 0; i < len; i++) {
      var c = d[off + i];
      if (c === 0) break;
      if (c >= 32 && c < 127) s += String.fromCharCode(c);
    }
    return s.trim();
  }

  ProTracker.prototype._initState = function () {
    this.speed = 6;       // ticks per row
    this.tempo = 125;     // BPM
    this.orderIndex = 0;
    this.row = 0;
    this.tick = 0;
    this.patternDelay = 0;
    this.samplesPerTick = Math.round(this.sampleRate * 2.5 / this.tempo);
    this.tickSampleCounter = 0;
    this.patternBreakRow = -1;
    this.positionJump = -1;
    this.ended = false;

    this.channels = [];
    for (var c = 0; c < 4; c++) {
      this.channels.push({
        sampleNum: 0, sampleData: null,
        samplePos: 0, period: 0, targetPeriod: 0, periodForRate: 0,
        volume: 0, finetune: 0,
        effect: 0, param: 0,
        vibratoPos: 0, vibratoSpeed: 0, vibratoDepth: 0,
        tremoloPos: 0, tremoloSpeed: 0, tremoloDepth: 0,
        portaSpeed: 0,
        repeatStart: 0, repeatLength: 0, length: 0,
        retrigCount: 0, noteDelay: 0, pendingNote: null,
        // stereo: Amiga panning L R R L
        pan: (c === 0 || c === 3) ? -0.35 : 0.35,
        lastVolume: 0
      });
    }

    // sync event queue: each {time, channel, period, sample, volume}
    this.events = [];
    this.totalSamplesRendered = 0;
    this.playStartTime = 0; // set by host
  };

  ProTracker.prototype.reset = function () {
    this._initState();
  };

  // process one tick (advances row/order as needed)
  ProTracker.prototype._tick = function (bufferSampleOffset) {
    if (this.tick === 0) {
      if (this.patternDelay > 0) {
        // during pattern delay we re-process effects but not new row
      } else {
        this._processRow(bufferSampleOffset);
      }
    } else {
      this._processEffectsTick();
    }

    this.tick++;
    if (this.tick >= this.speed * (this.patternDelay + 1)) {
      this.tick = 0;
      this.patternDelay = 0;
      this._advanceRow();
    }
  };

  ProTracker.prototype._advanceRow = function () {
    if (this.positionJump >= 0 || this.patternBreakRow >= 0) {
      if (this.positionJump >= 0) {
        this.orderIndex = this.positionJump;
        this.row = this.patternBreakRow >= 0 ? this.patternBreakRow : 0;
      } else {
        this.row = this.patternBreakRow;
        this.orderIndex++;
      }
      this.positionJump = -1;
      this.patternBreakRow = -1;
      if (this.orderIndex >= this.songLength) { this.orderIndex = 0; }
      return;
    }
    this.row++;
    if (this.row >= 64) {
      this.row = 0;
      this.orderIndex++;
      if (this.orderIndex >= this.songLength) {
        this.orderIndex = 0; // loop song
      }
    }
  };

  ProTracker.prototype._processRow = function (bufferSampleOffset) {
    var patNum = this.orders[this.orderIndex];
    var pattern = this.patterns[patNum];
    var rowData = pattern[this.row];

    for (var c = 0; c < 4; c++) {
      var note = rowData[c];
      var ch = this.channels[c];
      ch.effect = note.effect;
      ch.param = note.param;

      var hi = note.effect, p = note.param;
      var noteDelay = (hi === 0xE && (p >> 4) === 0xD) ? (p & 0x0f) : 0;

      // sample change
      if (note.sample > 0) {
        var s = this.samples[note.sample - 1];
        ch.sampleNum = note.sample;
        ch.volume = s.volume;
        ch.finetune = s.finetune;
        ch.sampleData = s.data;
        ch.length = s.length;
        ch.repeatStart = s.repeatStart;
        ch.repeatLength = s.repeatLength;
      }

      var hasNote = note.period > 0;
      var isTonePorta = (hi === 0x3 || hi === 0x5);

      if (hasNote) {
        var per = periodToFinetune(note.period, ch.finetune);
        if (isTonePorta) {
          ch.targetPeriod = per;
        } else if (noteDelay > 0) {
          ch.pendingNote = { period: per };
          ch.noteDelay = noteDelay;
        } else {
          ch.period = per;
          ch.targetPeriod = per;
          ch.periodForRate = per;
          ch.samplePos = (hi === 0x9) ? (p * 256) : 0; // 9xx offset
          if (hi !== 0x4 && hi !== 0x6) ch.vibratoPos = 0;
          if (hi !== 0x7) ch.tremoloPos = 0;
          // emit sync event
          this._emit(c, per, ch.sampleNum, ch.volume, bufferSampleOffset);
        }
      }

      // tick-0 effect handling
      this._processRowEffect(ch, c, hi, p);
    }
  };

  ProTracker.prototype._emit = function (c, period, sampleNum, volume, bufferSampleOffset) {
    var t = this.playStartTime +
      (this.totalSamplesRendered + bufferSampleOffset) / this.sampleRate;
    this.events.push({
      time: t, channel: c, period: period, sample: sampleNum, volume: volume,
      order: this.orderIndex
    });
  };

  ProTracker.prototype._processRowEffect = function (ch, c, hi, p) {
    var x = p >> 4, y = p & 0x0f;
    switch (hi) {
      case 0x3: // tone porta
        if (p) ch.portaSpeed = p;
        break;
      case 0x4: // vibrato
        if (x) ch.vibratoSpeed = x;
        if (y) ch.vibratoDepth = y;
        break;
      case 0x5: // tone porta + volslide (porta uses last speed)
        break;
      case 0x6: // vibrato + volslide
        break;
      case 0x7: // tremolo
        if (x) ch.tremoloSpeed = x;
        if (y) ch.tremoloDepth = y;
        break;
      case 0xC: // set volume
        ch.volume = Math.min(64, p);
        break;
      case 0xB: // position jump
        this.positionJump = p;
        break;
      case 0xD: // pattern break
        this.patternBreakRow = (x * 10 + y);
        break;
      case 0xF: // speed / tempo
        if (p === 0) break;
        if (p < 0x20) { this.speed = p; }
        else { this.tempo = p; this.samplesPerTick = Math.round(this.sampleRate * 2.5 / this.tempo); }
        break;
      case 0xE:
        switch (x) {
          case 0x1: ch.period -= y; ch.periodForRate = ch.period; break; // fine porta up
          case 0x2: ch.period += y; ch.periodForRate = ch.period; break; // fine porta down
          case 0xA: ch.volume = Math.min(64, ch.volume + y); break; // fine vol up
          case 0xB: ch.volume = Math.max(0, ch.volume - y); break;  // fine vol down
          case 0xD: break; // note delay handled above
          case 0xE: this.patternDelay = y; break; // pattern delay
          case 0x9: ch.retrigCount = 0; break; // retrig (per tick)
          case 0xC: ch.noteCut = y; break; // note cut
        }
        break;
    }
  };

  ProTracker.prototype._processEffectsTick = function () {
    for (var c = 0; c < 4; c++) {
      var ch = this.channels[c];
      var hi = ch.effect, p = ch.param;
      var x = p >> 4, y = p & 0x0f;

      // note delay
      if (ch.pendingNote && ch.noteDelay > 0) {
        ch.noteDelay--;
        if (ch.noteDelay === 0) {
          ch.period = ch.pendingNote.period;
          ch.periodForRate = ch.period;
          ch.samplePos = 0;
          this._emit(c, ch.period, ch.sampleNum, ch.volume, 0);
          ch.pendingNote = null;
        }
      }

      switch (hi) {
        case 0x0: // arpeggio
          if (p !== 0) {
            var phase = this.tick % 3;
            var add = phase === 0 ? 0 : (phase === 1 ? x : y);
            ch.periodForRate = this._arpeggioPeriod(ch.period, add);
          }
          break;
        case 0x1: ch.period -= p; ch.periodForRate = ch.period; break; // porta up
        case 0x2: ch.period += p; ch.periodForRate = ch.period; break; // porta down
        case 0x3: this._tonePorta(ch); break;
        case 0x4: this._vibrato(ch); break;
        case 0x5: this._tonePorta(ch); this._volSlide(ch, x, y); break;
        case 0x6: this._vibrato(ch); this._volSlide(ch, x, y); break;
        case 0x7: this._tremolo(ch); break;
        case 0xA: this._volSlide(ch, x, y); break;
        case 0xE:
          if (x === 0x9 && y > 0) { // retrig
            ch.retrigCount++;
            if (ch.retrigCount >= y) { ch.samplePos = 0; ch.retrigCount = 0; }
          } else if (x === 0xC && this.tick === y) { // note cut
            ch.volume = 0;
          }
          break;
      }
      if (hi !== 0x4 && hi !== 0x6 && hi !== 0x0) {
        // keep rate in sync with period when not modulated
        ch.periodForRate = ch.period;
      }
    }
  };

  ProTracker.prototype._arpeggioPeriod = function (period, semis) {
    if (semis === 0) return period;
    // find nearest index, add semis
    var idx = 0, best = 1e9;
    for (var i = 0; i < PERIODS.length; i++) {
      var dd = Math.abs(PERIODS[i] - period);
      if (dd < best) { best = dd; idx = i; }
    }
    var ni = Math.min(PERIODS.length - 1, idx + semis);
    return PERIODS[ni] * (period / PERIODS[idx]);
  };

  ProTracker.prototype._tonePorta = function (ch) {
    if (ch.targetPeriod === 0) return;
    if (ch.period < ch.targetPeriod) {
      ch.period = Math.min(ch.targetPeriod, ch.period + ch.portaSpeed);
    } else if (ch.period > ch.targetPeriod) {
      ch.period = Math.max(ch.targetPeriod, ch.period - ch.portaSpeed);
    }
    ch.periodForRate = ch.period;
  };

  ProTracker.prototype._vibrato = function (ch) {
    var delta = SINE[ch.vibratoPos & 31] * ch.vibratoDepth / 128;
    ch.periodForRate = ch.period + ((ch.vibratoPos & 32) ? -delta : delta) * ((ch.vibratoPos & 63) < 32 ? 1 : 1);
    // simpler: sign from position
    var v = SINE[ch.vibratoPos & 31] * ch.vibratoDepth / 128;
    ch.periodForRate = ch.period + ((ch.vibratoPos & 32) ? -v : v);
    ch.vibratoPos = (ch.vibratoPos + ch.vibratoSpeed) & 63;
  };

  ProTracker.prototype._tremolo = function (ch) {
    var v = SINE[ch.tremoloPos & 31] * ch.tremoloDepth / 64;
    var vol = ch.volume + ((ch.tremoloPos & 32) ? -v : v);
    ch._tremVol = Math.max(0, Math.min(64, vol));
    ch.tremoloPos = (ch.tremoloPos + ch.tremoloSpeed) & 63;
  };

  ProTracker.prototype._volSlide = function (ch, x, y) {
    if (x > 0) ch.volume = Math.min(64, ch.volume + x);
    else if (y > 0) ch.volume = Math.max(0, ch.volume - y);
  };

  // Render `numSamples` of stereo audio into outL/outR
  ProTracker.prototype.render = function (outL, outR, numSamples) {
    for (var i = 0; i < numSamples; i++) {
      if (this.tickSampleCounter <= 0) {
        this._tick(i);
        this.tickSampleCounter = this.samplesPerTick;
      }
      this.tickSampleCounter--;

      var l = 0, r = 0;
      for (var c = 0; c < 4; c++) {
        var ch = this.channels[c];
        if (!ch.sampleData || ch.periodForRate <= 0 || ch.length <= 0) continue;
        var rate = PAULA_PAL / (ch.periodForRate * 2);
        var step = rate / this.sampleRate;

        var pos = ch.samplePos;
        var ip = pos | 0;
        if (ip >= ch.length) {
          if (ch.repeatLength > 2) {
            ip = ch.repeatStart + ((ip - ch.repeatStart) % ch.repeatLength);
          } else { continue; }
        }
        // linear interpolation
        var frac = pos - (pos | 0);
        var s0 = ch.sampleData[ip] || 0;
        var i2 = ip + 1;
        if (i2 >= ch.length) {
          i2 = ch.repeatLength > 2 ? ch.repeatStart : ip;
        }
        var s1 = ch.sampleData[i2] || 0;
        var smp = s0 + (s1 - s0) * frac;

        var vol = (ch._tremVol !== undefined && ch.effect === 0x7) ? ch._tremVol : ch.volume;
        smp *= vol / 64;
        ch.lastVolume = vol;

        // pan
        var panL = ch.pan < 0 ? 1 : (1 - ch.pan);
        var panR = ch.pan > 0 ? 1 : (1 + ch.pan);
        l += smp * panL;
        r += smp * panR;

        // advance
        var np = ch.samplePos + step;
        if ((np | 0) >= ch.length) {
          if (ch.repeatLength > 2) {
            while (np >= ch.repeatStart + ch.repeatLength) np -= ch.repeatLength;
          } else {
            ch.sampleData = null; // one-shot finished
          }
        }
        ch.samplePos = np;
      }

      outL[i] = l * 0.32;
      outR[i] = r * 0.32;
    }
    this.totalSamplesRendered += numSamples;
  };

  global.ProTracker = ProTracker;
})(window);
