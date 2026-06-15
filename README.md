# ♪ Whistling Fred — Amiga MOD Player in the Browser

A self-contained, zero-dependency web page that plays the classic Amiga ProTracker
tune **`WHISFRED.MOD`** ("whistling fred" by *mel o'dee / Shadows*, 1992) — and
animates **Fred**, a little SVG character who whistles the melody and drums the
beat in perfect sync with the music.

👉 **Live demo:** https://hschaefer123.github.io/whistling-fred/

![Format: ProTracker 4-CH (M.K.) · 31 samples](https://img.shields.io/badge/format-ProTracker%20M.K.-ff8c1a)
![No build step](https://img.shields.io/badge/build-none-3ad6ff)
![Runs offline](https://img.shields.io/badge/offline-yes-ffd24a)

--- 

## What it does

- 🎵 **Real MOD playback** — a small, hand-written ProTracker (`.MOD`) replayer
  rendering 4 channels through the **Web Audio API**. No libraries, no WASM.
- 🤖 **Synced animation** — the replayer emits per-channel note-on events with
  absolute audio-clock timestamps, so Fred's lips follow the **whistle** lead
  and his hands strike the bongos on the **kick** & **snare**.
- 📊 **Live VU meters** for the four channels (Drums · Whistle · Arpeggio · Bass).
- 💾 **Fully embedded & offline** — the `.MOD` is base64-encoded into the page,
  so you can just open `index.html` from disk. Nothing to install.

### Effects supported by the replayer

`0` arpeggio · `1/2` porta up/down · `3` tone porta · `4` vibrato · `5/6`
(+volume slide) · `9` sample offset · `A` volume slide · `B` position jump ·
`C` set volume · `D` pattern break · `F` speed/tempo · `E1/E2` fine porta ·
`E9` retrig · `EA/EB` fine volume slide · `EC` note cut · `ED` note delay ·
`EE` pattern delay.

---

## Run it locally

It's a static page — any of these work:

```bash
# 1) Simplest: just open the file
open index.html

# 2) Or serve it (tiny built-in Node server, serves this folder on :8123)
node server.js
# → http://127.0.0.1:8123
```

> Audio only starts after you click **▶ PLAY** — browsers block autoplay until
> a user gesture.

---

## Project layout

| File | Purpose |
| --- | --- |
| `index.html`   | The page: layout, CSS, the animated SVG of Fred. |
| `protracker.js`| Minimal ProTracker `.MOD` replayer for the Web Audio API. |
| `whistler.js`  | Glue — decodes the MOD, drives playback, animates Fred in sync. |
| `mod-data.js`  | `WHISFRED.MOD` embedded as base64. |
| `WHISFRED.MOD` | The original 1992 module file (for reference / re-use). |
| `server.js`    | Optional tiny static file server for local development. |

---

## Want to play `WHISFRED.MOD` in a "real" tracker?

Grab [`WHISFRED.MOD`](WHISFRED.MOD) and load it into **BassoonTracker**, a
full ProTracker clone that runs entirely in the browser:

🎛️ **https://www.stef.be/bassoontracker/**

You can drag-and-drop the `.MOD` straight into it to inspect the patterns,
samples and effects the way the original Amiga musicians did.

---

## Credits

- **Music:** "whistling fred" by *mel o'dee / Shadows* (1992).
- **Player & animation:** this project.
- **BassoonTracker:** by [Steffest](https://www.stef.be/bassoontracker/).

The original module ships with the sample-name message: *"feel free to use this"*.

---

## License

The code in this repository is released under the **MIT License**.
The `WHISFRED.MOD` module is the work of its original author(s) and is included
for historical and demonstrative purposes.
