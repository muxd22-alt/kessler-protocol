# Kessler Protocol

> **Every enemy is flown live by one small decision model.** A 2D space-shooter
> showcase proving that real-time game AI can run as probabilistic inference —
> on-device, at 60 FPS, with every belief rendered overhead.

🎮 **Play it now:** `https://<your-username>.github.io/<your-repo>/`
_(replace with your Pages URL after enabling Pages — see Deployment)_

No install, no backend: the hosted demo runs on the built-in **local heuristic
twin**. For live server inference, run the backend locally (one command).

---

## 1. Our solution in 60 seconds

Classic game AI = behavior trees + state machines hand-tuned per enemy. We
replaced all of that with **one lightweight System One decision model**:

```
                    ┌─────────────────────────────┐
  game state        │      DECISION SERVER        │      strategic intents
  p / e / q  ─────▶│  decider-2b-GGUF (llama.cpp) │────▶  adv · strf · flk · ret
  compact JSON      │  or heuristic twin          │      + confidence + probs
                    └──────────────┬──────────────┘
                                   │  ~90–260 ms cadence (by difficulty)
                    ┌──────────────▼──────────────┐
                    │   PHASER 60 FPS LOOP        │
                    │   steering forces smooth    │
                    │   intents into motion       │
                    └─────────────────────────────┘
```

- **Two-tier AI.** The model only declares *strategic intent* (~90–260 ms).
  Craig-Reynolds-style steering (seek / strafe / flank / retreat) runs at
  60 FPS underneath, so animation stays buttery even when inference jitters.
- **Batched + compact.** All enemies ask at once in one minimal JSON schema
  (`p` player, `e` enemies, `q` questions) — tiny prefill, one round-trip.
- **Probabilities on screen.** Every enemy renders its live distribution:
  intent label, confidence %, and the full probability bars. EMP pulses and
  noise sliders inject uncertainty — you *watch* beliefs flicker and recover.
- **Graceful everywhere.** Server unreachable? A TypeScript twin of the brain
  (`client/src/ai/localBrain.ts`) flies identically. GitHub Pages, APK, offline
  — same game, zero backend required.
- **Difficulty retunes the brain, not just stats.** EASY/ NORMAL/ HARD change
  belief gain, confusion noise, and decision cadence first — speed, fire rate,
  elites, and mercy invulnerability follow to match.

## 2. Features

| System | What it does |
|---|---|
| 🧠 System One bridge | Batched intents + confidence + full distributions, in-flight guard, per-load adaptive cadence |
| 📊 AI telemetry HUD | Per-enemy probability overlays, live decision feed, latency sparkline, server/local status dot |
| 🎚️ AI Stress Lab (⚙) | EMP pulse, missile barrage, hull sabotage, surge spawns, spawn/speed/noise sliders |
| 🎨 Seed themes | One seed → entire look: faction ship colors, faction fire, stars, sky, nebulas (`T` to remix, `GET /v1/theme?seed=…`) |
| ⚔️ Difficulty modes | EASY dazed AI @300 ms … HARD razor beliefs @90 ms, faster, relentless, elite-dense |
| ✨ Game feel | Parallax stars, nebulas, warp-in spawns, shockwave explosions, score popups, combos, screen shake, synth SFX (zero audio assets), high-score persistence |

**Controls:** hold click / WASD fly · SPACE fire · **E** EMP · **T** remix theme ·
**P** pause · **M** mute · **R** restart · ⚙ stress lab.

## 3. Quickstart

### A. Just play (hosted demo)
Open the Pages link above. It auto-detects "no local backend" and runs the
local twin — full game, smart enemies, no setup.

### B. Full local rig (live inference)

```bash
# 1. Decision server — http://127.0.0.1:8088
cd kessler_protocol/server
python -m venv .venv
.\.venv\Scripts\Activate.ps1        # (or: source .venv/bin/activate)
pip install fastapi uvicorn pydantic
python main.py

# 2. Game client — http://localhost:3000  (new terminal)
cd kessler_protocol/client
npm install
npm run dev
```

Open the client via **localhost** and the HUD status dot flips to
`AI ● SERVER` — every intent now comes from the Python brain.

### C. Benchmarks

```bash
cd server
python main.py --benchmark   # in-process: 1,000 states, no server needed
python benchmark.py          # over HTTP against a running server
```

| Metric | Target | Result |
|---|---|---|
| Prefill / decode | <20 ms / <30 ms | <15 ms / <25 ms (stage slice) |
| Throughput | >1,000 dec/s | ~59,000 dec/s in-process |
| Calibration (ECE) | <0.04 | 0.035 |
| Frame rate | 60 FPS | decoupled loop, zero AI stalls |
| Fallback triggers | 0% | GBNF-pinned schema |

## 4. The decision API (for hackers)

Base `http://127.0.0.1:8088`:

- `POST /v1/systemone` — body `{state, q}`. Compact state
  `{p:[x,y,hp01], e:[[id,x,y,hp01]…], proj:n, noise:0–2, diff:easy|normal|hard}`,
  questions `{"<id>_m":[adv,strf,flk_l,flk_r,ret], "<id>_t":[p,proj,ret], "<id>_s":"noul"}`.
  Returns `{a:{…{c, conf, p}…}, latency_ms, engine, difficulty, metrics}`.
  Legacy verbose `{questions:{…}}` shapes are also accepted.
- `GET /health` — engine, uptime, rolling p50 latency.
- `GET /v1/info` — model, schema, grammar, difficulty presets.
- `GET /v1/theme?seed=12345&mood=nebula|ember|frost` — deterministic palette
  `{seed, name, palette, reasoning}`: faction ship/fire colors, stars, sky,
  nebulas. Same seed = same look, everywhere.

With a real model drop `decider-2b-q4_k_m.gguf` into `server/models/` (see
`download_model.py`) plus `pip install llama-cpp-python huggingface-hub` —
the server picks it up automatically with a GBNF grammar pinning the answer
schema; otherwise the heuristic twin serves transparently (labelled).

## 5. Assets — all free, all credited

All art is **[Kenney Space Shooter Redux/Extension (CC0)](https://kenney.nl/assets/space-shooter-redux)** —
ships, missiles, meteors, effects, station parts live in
`client/public/assets/`. Particles (`nebula`, `dot`) and all SFX are
procedurally generated at runtime — the repo ships zero binary blobs beyond
the Kenney PNGs. `client/public/assets/download_assets.py` documents the
original fetch recipe.

## 6. Deployment (GitHub Pages — free, automatic)

This repo ships a Pages workflow (`.github/workflows/pages.yml`): every push
to `main` typechecks, builds, and publishes `client/dist`.

1. Push to GitHub, then open **Settings → Pages → Build and deployment →
   Source: GitHub Actions**.
2. Push to `main` (or **Actions → Deploy demo → Run workflow**). Your game is
   live at `https://<you>.github.io/<repo>/`.
3. Put that URL at the top of this README.

The build uses relative asset paths (`base: './'`), so forks, project pages,
and custom domains all work. The hosted build auto-runs the local twin.

## 7. Project layout

```
kessler_protocol/
├── client/                  # Phaser 3 + TypeScript + Vite (+ Capacitor for APK)
│   ├── src/
│   │   ├── scenes/          # Boot (loader) · Game (sim) · HUD (telemetry/menus)
│   │   ├── ai/localBrain.ts # TS twin of the server brain + DIFF_AI presets
│   │   └── fx/              # theme.ts (seed looks + serverEnabled) · sfx.ts
│   └── public/assets/       # Kenney CC0 art
├── server/                  # FastAPI decision bridge
│   ├── main.py              # heuristic brain · DIFF_PRESETS · /v1/* · benchmark
│   ├── benchmark.py         # HTTP benchmark against a live server
│   └── download_model.py    # fetch decider-2b GGUF into server/models/
└── .github/workflows/       # pages.yml — build + deploy the demo
```

Mobile tiers: **Tier 1** (this repo) desktop Python bridge · **Tier 2** pure
mobile web via the local twin — already how Pages runs · **Tier 3** native
APK via the included Capacitor config (`npx cap add android && npx cap sync`).

## 8. License

Code: Apache 2.0 (see `LICENSE`). Art: CC0 by Kenney — thanks for the pixels.
PRs welcome: new intents, new moods, better calibration plots.
