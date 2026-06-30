# Instant Harmonies — Live Demo

Real-time MIDI just-intonation tuning in the browser.

**Live:** https://ruisuphd.github.io/instant-harmonies-demo/

## Requirements

- A Chromium-based browser with Web MIDI support (Chrome, Edge, Opera)
- A USB MIDI keyboard (or a virtual MIDI device)

## What it does

Play notes on a MIDI keyboard; the app detects the musical key in real time and
retunes the output to just-intonation ratios, synthesising audio locally via the
Web Audio API.

## Run locally

```bash
git clone https://github.com/ruisuphd/instant-harmonies-demo
cd instant-harmonies-demo
python3 -m http.server 8000   # → http://localhost:8000
```

Point at a different backend: append `?backend=<url>` to the URL, or set
`window.INSTANT_HARMONIES_BACKEND_URL` before connecting.

## License

MIT — see [`LICENSE`](LICENSE).
