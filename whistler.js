/* Glue: decode the embedded MOD, drive Web Audio playback, and animate
 * Fred the whistler in sync with the whistle (lead) channel. */
(function () {
  'use strict';

  var LEAD = 1;          // channel carrying the whistle melody
  var BASS = 3;          // channel carrying the bass (drives body bob)
  var DRUMS = 0;          // drum channel (kick + hihat live here)
  // Drums are identified by SAMPLE number, not pitch:
  var KICK_SAMPLE = 6;    // low drum on ch0, beats 1 & 3            -> left hand
  var SNARE_SAMPLE = 7;   // E-2 snare; its backbeat rhythm runs through the BASS
                          // channel between the bass notes, and also shows up in
                          // the drum channel near the end                -> right hand
  var INTRO_ORDERS = 2;  // first 8 bars (orders 0-1) are intro: no whistling yet
  var BUFFER = 4096;

  var ctx, node, player, playing = false, started = false;
  var rafId = null;

  // ---- decode base64 MOD into ArrayBuffer ----
  function base64ToArrayBuffer(b64) {
    var bin = atob(b64);
    var len = bin.length;
    var bytes = new Uint8Array(len);
    for (var i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }

  // ---- DOM refs ----
  var $ = function (id) { return document.getElementById(id); };
  var fred = $('fred'), mouth = $('mouth'), mouthInner = $('mouthInner'),
      air = $('air'), cheekL = $('cheekL'), cheekR = $('cheekR'),
      head = $('head'), body = $('body'), notesLayer = $('notes'),
      armL = $('armL'), armR = $('armR'),
      browL = $('browL'), browR = $('browR'),
      lidL = $('lidL'), lidR = $('lidR'),
      pupL = $('pupL'), pupR = $('pupR'),
      vuBars = document.querySelectorAll('#vu .bar i'),
      introBadge = $('introBadge'),
      playBtn = $('play');

  function updateIntroBadge(show) {
    if (introBadge) introBadge.classList.toggle('show', !!show);
  }

  // ---- animation state ----
  var whistleEnergy = 0;   // 0..1 mouth openness (smoothed)
  var targetMouth = 0;
  var bob = 0, bobTarget = 0;
  var strikeL = 0, strikeR = 0;   // 1 = hand on drum, decays back to raised rest
  var lastNotePeriod = 320;
  var nextBlink = 1.2;

  function setup() {
    var buf = base64ToArrayBuffer(window.MOD_BASE64);
    var probeRate = 44100;
    player = new ProTracker(buf, probeRate);
    $('title').textContent = player.title || 'whistling fred';

    // Build the scrolling message from the MOD's sample-name "text".
    var msg = player.samples.map(function (s) { return s.name; })
      .filter(function (s) { return s && s.length > 1; }).join('   ·   ');
    if (msg) $('msg').textContent = '★  ' + msg + '  ★  WHISTLING FRED  ·  AMIGA MOD  ★  ';
  }

  function ensureAudio() {
    if (ctx) return;
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    // rebuild player at the real sample rate
    var buf = base64ToArrayBuffer(window.MOD_BASE64);
    player = new ProTracker(buf, ctx.sampleRate);

    node = ctx.createScriptProcessor(BUFFER, 0, 2);
    node.onaudioprocess = function (e) {
      var l = e.outputBuffer.getChannelData(0);
      var r = e.outputBuffer.getChannelData(1);
      if (playing) {
        player.render(l, r, l.length);
      } else {
        l.fill(0); r.fill(0);
      }
    };
    node.connect(ctx.destination);
  }

  // ---- note period -> vertical position hint for floating notes ----
  function periodToPitch01(period) {
    // lower period = higher pitch. map ~110..360 to 1..0
    var p = Math.max(110, Math.min(360, period));
    return 1 - (p - 110) / (360 - 110);
  }

  var NOTE_GLYPHS = ['♪', '♫', '♩', '♬', '♭'];
  var NOTE_COLORS = ['#ffd24a', '#3ad6ff', '#ff8c1a', '#ff4d8a', '#9affb0'];

  function spawnNote(pitch01) {
    var el = document.createElement('div');
    el.className = 'note';
    el.textContent = NOTE_GLYPHS[(Math.random() * NOTE_GLYPHS.length) | 0];
    var col = NOTE_COLORS[(Math.random() * NOTE_COLORS.length) | 0];
    el.style.color = col;
    // emit near Fred's mouth (mouth is ~ x62%, y61% of stage)
    el.style.left = (58 + Math.random() * 8) + '%';
    el.style.top = (54 - pitch01 * 8) + '%';
    el.style.setProperty('--dx', ((Math.random() * 120 + 40)) + 'px');
    el.style.setProperty('--rot', ((Math.random() * 60 - 10)) + 'deg');
    el.style.fontSize = (20 + pitch01 * 18) + 'px';
    notesLayer.appendChild(el);
    setTimeout(function () { el.remove(); }, 1600);
  }

  // ---- dispatch scheduled sync events when their time arrives ----
  function dispatchEvents() {
    if (!player) return;
    var now = ctx ? ctx.currentTime : 0;
    var ev = player.events;
    while (ev.length && ev[0].time <= now) {
      var e = ev.shift();
      if (e.volume <= 0) continue;
      // During the intro (first 8 bars) the whistle hasn't started yet.
      if (e.channel === LEAD && e.order >= INTRO_ORDERS) {
        // a new whistle note -> pucker + puff + flying note
        lastNotePeriod = e.period;
        targetMouth = 0.55 + (e.volume / 64) * 0.45;
        whistleEnergy = Math.min(1, whistleEnergy + 0.5);
        spawnNote(periodToPitch01(e.period));
      } else if (e.channel === BASS) {
        // The bass channel carries the snare (sample 7) interleaved between the
        // actual bass notes — that interleaving IS the backbeat rhythm.
        if (e.sample === SNARE_SAMPLE) strikeR = 1;
        else bobTarget = 1;                    // a real bass note -> body bob
      } else if (e.channel === DRUMS) {
        // Fred drums with his hands: kick -> left hand, snare -> right hand.
        if (e.sample === KICK_SAMPLE) {
          strikeL = 1;
          bobTarget = Math.max(bobTarget, 0.5); // kick also thumps the body
        } else if (e.sample === SNARE_SAMPLE) {
          strikeR = 1;                          // snare appears here near the end
        }
        // the hihat (sample 3) is left out so the kick/snare beat reads clearly
      }
    }
    // keep the queue from growing unbounded if tab was backgrounded
    if (ev.length > 400) ev.splice(0, ev.length - 200);
  }

  // ---- main animation loop ----
  var lastT = 0;
  function frame(t) {
    rafId = requestAnimationFrame(frame);
    var dt = lastT ? Math.min(0.05, (t - lastT) / 1000) : 0.016;
    lastT = t;

    dispatchEvents();

    // read live channel volumes from the player for VU + sustained openness
    if (player) {
      for (var c = 0; c < 4; c++) {
        var ch = player.channels[c];
        var v = (ch && ch.sampleData) ? (ch.lastVolume / 64) : 0;
        if (vuBars[c]) vuBars[c].style.height = Math.round(v * 100) + '%';
      }
      var inIntro = player.orderIndex < INTRO_ORDERS;
      var leadV = (!inIntro && player.channels[LEAD].sampleData) ? player.channels[LEAD].lastVolume / 64 : 0;
      targetMouth = Math.max(targetMouth * 0.9, leadV * 0.9);
      updateIntroBadge(inIntro && playing);
    }

    // smooth mouth + energy
    whistleEnergy += (targetMouth - whistleEnergy) * Math.min(1, dt * 14);
    whistleEnergy = Math.max(0, whistleEnergy - dt * 0.4);
    targetMouth *= 0.92;

    var open = playing ? whistleEnergy : 0;

    // pitch wobble: higher pitch -> tighter, higher mouth + raised brows
    var pitch = periodToPitch01(lastNotePeriod); // 0 low .. 1 high
    var rx = 5 + (1 - open) * 3 + (1 - pitch) * 3;        // wider lips on low/closed
    var ry = 4 + open * 9;                                 // taller when whistling
    mouth.setAttribute('rx', rx.toFixed(1));
    mouth.setAttribute('ry', ry.toFixed(1));
    mouth.setAttribute('cy', (196 - pitch * 4).toFixed(1));
    mouthInner.setAttribute('rx', (rx * 0.45).toFixed(1));
    mouthInner.setAttribute('ry', (ry * 0.45).toFixed(1));
    mouthInner.setAttribute('cy', (196 - pitch * 4).toFixed(1));

    // cheeks puff with energy
    var puff = 1 + open * 0.5;
    cheekL.setAttribute('rx', (16 * puff).toFixed(1));
    cheekR.setAttribute('rx', (16 * puff).toFixed(1));
    cheekL.style.opacity = (0.35 + open * 0.4).toFixed(2);
    cheekR.style.opacity = (0.35 + open * 0.4).toFixed(2);

    // air stream visibility pulses with whistling
    air.style.opacity = (open > 0.25 ? (0.4 + open * 0.6) : 0).toFixed(2);

    // eyebrows lift with pitch
    var browLift = pitch * 6 * open;
    browL.setAttribute('transform', 'translate(0,' + (-browLift).toFixed(1) + ')');
    browR.setAttribute('transform', 'translate(0,' + (-browLift).toFixed(1) + ')');

    // body bob to bass + a gentle musical sway
    bob += (bobTarget - bob) * Math.min(1, dt * 16);
    bobTarget *= 0.86;
    var time = t / 1000;
    var sway = playing ? Math.sin(time * 2.4) * 2.2 : 0;
    var bounce = playing ? (Math.abs(Math.sin(time * 3.1)) * 3 + bob * 7) : 0;
    body.setAttribute('transform',
      'translate(' + sway.toFixed(2) + ',' + (-bounce).toFixed(2) + ') rotate(' +
      (sway * 0.4).toFixed(2) + ' 150 300)');
    // head bobs slightly more, tilts with pitch
    head.setAttribute('transform',
      'translate(0,' + (-bounce * 0.4).toFixed(2) + ') rotate(' +
      ((pitch - 0.5) * 3 * open).toFixed(2) + ' 150 150)');

    // drumming hands: drop onto the drumhead on a hit, spring back up.
    // strike = 1 at the moment of contact, decays to 0 (hand hovering).
    strikeL += (0 - strikeL) * Math.min(1, dt * 17);
    strikeR += (0 - strikeR) * Math.min(1, dt * 17);
    var hoverL = playing ? Math.sin(time * 5.0) * 2.5 : 0;
    var hoverR = playing ? Math.sin(time * 5.0 + 1.7) * 2.5 : 0;
    var dyL = strikeL * 16 - hoverL;   // +down to hit, -up while hovering
    var dyR = strikeR * 16 - hoverR;
    armL.setAttribute('transform',
      'translate(0,' + dyL.toFixed(1) + ') rotate(' + (strikeL * 6).toFixed(1) + ' 104 262)');
    armR.setAttribute('transform',
      'translate(0,' + dyR.toFixed(1) + ') rotate(' + (-strikeR * 6).toFixed(1) + ' 196 262)');

    // pupils drift toward the notes
    var look = Math.sin(time * 1.7) * 3;
    pupL.setAttribute('cx', (120 + look).toFixed(1));
    pupR.setAttribute('cx', (188 + look).toFixed(1));

    // blinking
    nextBlink -= dt;
    if (nextBlink < 0) {
      blink();
      nextBlink = 1.6 + Math.random() * 2.6;
    }
  }

  var blinkPhase = 0;
  function blink() {
    var h = 0, dir = 1;
    var iv = setInterval(function () {
      h += dir * 5;
      if (h >= 18) dir = -1;
      lidL.setAttribute('height', Math.max(0, h));
      lidR.setAttribute('height', Math.max(0, h));
      if (h <= 0 && dir < 0) { clearInterval(iv); lidL.setAttribute('height', 0); lidR.setAttribute('height', 0); }
    }, 16);
  }

  // ---- controls ----
  function start() {
    ensureAudio();
    if (ctx.state === 'suspended') ctx.resume();
    // (Re)anchor the event timeline so the next sample to be rendered plays
    // at roughly "now"; this keeps sync correct across pause/resume.
    var latency = ctx.baseLatency || (BUFFER / ctx.sampleRate);
    player.playStartTime = ctx.currentTime + latency -
      player.totalSamplesRendered / ctx.sampleRate;
    player.events.length = 0;
    started = true;
    playing = true;
    playBtn.textContent = '⏸ PAUSE';
  }
  function pause() {
    playing = false;
    playBtn.textContent = '▶ RESUME';
  }

  playBtn.addEventListener('click', function () {
    if (playing) pause(); else start();
  });

  // boot
  setup();
  rafId = requestAnimationFrame(frame);
})();
