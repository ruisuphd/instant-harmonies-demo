# Instant Harmonies — Live Demo

Real-time symbolic key detection + just-intonation tuning, hosted on GitHub Pages.

## 🎹 Try the demo

**Live URL**: https://ruisuphd.github.io/instant-harmonies-demo/

You'll need:
- A modern browser with Web MIDI API support (Chrome, Edge, Opera)
- A USB MIDI keyboard (or use a virtual one like VMPK / a software synth that supports virtual MIDI)
- A few minutes to test

## What it does

This is the deployment companion to my PhD project at Maynooth University. It demonstrates **T6_T1**, a 67K-parameter GRU-based symbolic key detector trained on classical piano repertoire, applied to a real-time just-intonation (JI) tuning system:

1. You play notes on your MIDI keyboard
2. The browser sends note events to the backend (hosted on Hugging Face Spaces)
3. The backend runs T6_T1 inference and returns the predicted key
4. The browser applies just-intonation ratios for the detected key
5. Audio is generated locally (Web Audio API) with the corrected tuning

## Architecture

```
┌───────────────────────────────────────────┐
│ Browser (THIS REPO, GitHub Pages)         │
│ - Web MIDI API → live note input          │
│ - Local note buffering                    │
│ - WebSocket client → backend              │
│ - Tuning logic (just-intonation ratios)   │
│ - Web Audio API → synthesised output      │
└────────────────────┬──────────────────────┘
                     │ WebSocket (Socket.IO)
                     │ https://yoryouyoi-instant-harmonies.hf.space
                     ▼
┌───────────────────────────────────────────┐
│ Backend (HF Spaces free CPU tier)         │
│ - Flask + Socket.IO                       │
│ - HarmonicContextGRUPhase1 (T6_T1) GRU    │
│ - ~50 ms inference per prediction         │
└───────────────────────────────────────────┘
```

## Model

**T6_T1** is the canonical Phase I deployable engine:
- Architecture: 1-layer GRU, hidden size 96, ~67K parameters
- Features: pitch-class embeddings + register + delta-time + duration + velocity + active-mask + global pitch-class-profile
- Training data: 525 records (250 ATEPP + 275 DCML Strategy A)
- Augmentation: 12-fold deterministic pitch-transposition (Z/12 cyclic group)
- Test FW MIREX: 0.6707 ± 0.0103 (n=5 seeds, ATEPP-41 frozen test split)

Cross-GPU reproducibility (T4 PyTorch 2.10): Δ = −0.0003 (PASS at pre-committed ±0.0005).

Full provenance: [main research repo](https://github.com/ruisuphd/just-intonation-ai-function) — see `CROSS_GPU_REPRO_FINDINGS_2026-05-24.md`.

## Feedback

If you try the demo, I'd love your feedback for the user-study arm of my thesis. Please fill out: **[feedback form](https://forms.gle/PLACEHOLDER)** (~3 min).

## Local development

```bash
# Frontend (this repo)
git clone https://github.com/ruisuphd/instant-harmonies-demo
cd instant-harmonies-demo
python3 -m http.server 8000
# → http://localhost:8000

# Backend (main repo)
git clone https://github.com/ruisuphd/just-intonation-ai-function
cd just-intonation-ai-function
pip install -r requirements.txt
python demo_server.py  # (lightweight demo backend; see HF Space for production)
```

To point the local frontend at a local backend, add `?backend=http://localhost:7860` to the URL, or set `window.INSTANT_HARMONIES_BACKEND_URL` in the browser console before connecting.

## Citation

```bibtex
@phdthesis{su2026instant,
  author = {Rui Su},
  title  = {Instant Harmonies: Real-Time Adaptive Just Intonation Tuning},
  school = {Maynooth University},
  year   = {2026},
}
```

## License

MIT — see `LICENSE`.
