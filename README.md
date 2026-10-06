# Kessler Protocol

> **Every enemy is flown live by one small decision model.** A 2D space-shooter
> showcase proving that real-time game AI can run as probabilistic inference —
> on-device, at 60 FPS, with every belief rendered overhead.

🎮 **Play it now:** `https://muxd22-alt.github.io/kessler-protocol/`
_(if it 404s, enable Pages once: repo **Settings → Pages → Source: GitHub Actions**,
then re-run the **Deploy demo** workflow)_

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

## 2. What System One is — and why it isn't "just another enemy AI"

System One is a **small decision model that plays the role of a whole enemy
squad's commander**. Every 90–300 ms it answers, for every agent at once:
*"what is your intent, how sure are you, and what were the alternatives?"* It
never moves a pixel itself — a 60 FPS steering layer turns its intents into
motion. That split is the whole trick: **slow, smart, probabilistic decisions;
fast, dumb, smooth movement.**

| | Behavior trees / FSM | Utility AI | Scripted patterns | Cloud LLM | **System One (here)** |
|---|---|---|---|---|---|
| Decision style | hard rules, nested branches | hand-weighted scores | fixed choreography | giant prompt, network | **probabilistic intent + full distribution** |
| Many agents | N rule sets to maintain | N weight vectors | one timeline per enemy | one giant prompt, slow, costly | **one model, one batched call** |
| Uncertainty | invisible — it just picks a branch | invisible — scores hide doubt | n/a | vague prose | **explicit confidence + per-option bars** |
| Explainability | "rule 7 fired" | "because weight 0.8" | script line #412 | plausible text | **live input drivers with signed impact** |
| New behaviour | author more rules | re-tune weights | author more script | unpredictable, slow | **generalises from the same scoring** |
| Cost / latency | ~0 | ~0 | ~0 | 100s ms + network + $ | **<1 ms in-process, works offline** |
| Works offline | yes | yes | yes | **no** | **yes (local twin)** |

The four things that make this demo different from an ordinary shmup:

1. **You can see the mind.** Every enemy carries a live panel: intent, confidence
   %, and its full probability distribution. Nothing is hidden behind an
   animation.
2. **It knows what it doesn't know.** Inject EMP noise and watch confidence
   collapse toward the 20–25% floor, then *recover* as evidence returns. A
   behavior tree cannot be uncertain; this system is uncertainty-aware by
   construction.
3. **One call decides a squad.** Surge six contacts and watch a single batched
   request return six sets of beliefs — no per-agent round trips.
4. **Difficulty is a brain parameter, not a damage multiplier.** EASY/ HARD
   change belief gain, confusion noise and decision cadence *first*; speed, fire
   rate, elites and i-frames follow to match.

Press **I** (or tap **◈ SYSTEM ONE**) in game for the live panel: capabilities,
the comparison above, session stats (engine, decisions issued, rolling average
confidence, agents per batch, cadence) and a **"why it chose"** readout showing
the signed drivers behind the most confident agent's decision — proximity, own
hull, threat density, flank bias, player hull.

## 3. Features

| System | What it does |
|---|---|
| 🧠 System One bridge | Batched intents + confidence + full distributions, in-flight guard, per-load adaptive cadence |
| 📊 AI telemetry HUD | Per-enemy probability overlays, live decision feed, latency sparkline, server/local status |
| ◈ System One panel | Capabilities vs classic AI, live session stats, signed "why it chose" drivers (explainability) |
| 🎚️ AI Stress Lab (⚙) | EMP pulse, missile barrage, hull sabotage, surge spawns, spawn/speed/noise sliders |
| 🎨 Seed themes | One seed → entire look: faction ship colors, faction fire, stars, sky, nebulas (`T` to remix) |
| ⚔️ Difficulty modes | EASY dazed AI @300 ms … HARD razor beliefs @90 ms, faster, ruthless, elite-dense |
| 📱 Mobile / foldable | One-thumb drag steering, optional FIRE/EMP thumb pads, safe-area aware, portrait+landscape, tablet-scale ships, tablet/foldable viewport handling |
| ✨ Game feel | Baked parallax starfield (3 draw calls), nebulas, warp-in spawns, shockwave explosions, score popups, combos, screen shake, synth SFX, high-score persistence |

**Desktop:** hold click / WASD fly · SPACE fire · **E** EMP · **T** remix theme ·
**I** System One panel · **P** pause · **M** mute · **R** restart · ⚙ stress lab.

**Mobile (1–2 thumbs):**
- **One thumb:** press and drag anywhere to fly — the ship keeps its offset from
  your finger so your thumb never covers it — and it auto-fires while you steer.
- **Two thumbs:** left thumb drags to fly, right thumb holds the on-screen
  **FIRE** pad; the smaller **EMP** pad sits above-left of it.
- **❚❚** pauses; **◈ SYSTEM ONE** opens the explainability panel; ⚙ opens the
  stress lab. All pads respect notch/punch-hole safe areas and reposition on
  rotation, fold or windowed mode.

## 4. Quickstart

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

## 5. The decision API (for hackers)

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

## 6. Assets — all free, all credited

All art is **[Kenney Space Shooter Redux/Extension (CC0)](https://kenney.nl/assets/space-shooter-redux)** —
ships, missiles, meteors, effects, station parts live in
`client/public/assets/`. Particles (`nebula`, `dot`) and all SFX are
procedurally generated at runtime — the repo ships zero binary blobs beyond
the Kenney PNGs. `client/public/assets/download_assets.py` documents the
original fetch recipe.

## 7. Deployment (GitHub Pages — free, automatic)

This repo ships a Pages workflow (`.github/workflows/pages.yml`): every push
to `main` typechecks, builds, and publishes `client/dist`.

1. Push to GitHub, then open **Settings → Pages → Build and deployment →
   Source: GitHub Actions**.
2. Push to `main` (or **Actions → Deploy demo → Run workflow**). Your game is
   live at `https://muxd22-alt.github.io/kessler-protocol/`.
3. Put that URL at the top of this README.

The build uses relative asset paths (`base: './'`), so forks, project pages,
and custom domains all work. The hosted build auto-runs the local twin.

### Performance & hosting notes

Measured on the deployed Pages build:

| Layer | Raw | Gzip (what users download) |
|---|---|---|
| `phaser-*.js` (engine, cached forever) | 1.19 MB | **~310 KB** |
| `index-*.js` (all game code + AI) | 50 KB | **~16 KB** |

What we do to get there:

- **Starfield is baked, not redrawn.** Every layer is rendered once into a
  texture and scrolled with a `TileSprite` — ~3 draw calls per frame instead of
  ~265 per-frame circles (the single biggest mobile-CPU win). A dozen live
  twinklers keep it breathing.
- **Colliders are registered once.** Meteor-vs-enemy overlap used to be
  *created every frame* — a real leak; now a persistent collider.
- **No per-frame allocations.** Enemy/bullet lists are snapshotted once per
  group per frame instead of repeatedly; the HUD takes one entity snapshot for
  both its counter and overlays.
- **Engine split from game code** (`manualChunks`) so Phaser downloads in
  parallel and stays cached while game code updates.
- **Terser, 2 compress passes**, console/debugger stripped; chunk warning gone.
- **Fixed 60 FPS physics**, `powerPreference: 'high-performance'`.
- **Installable PWA**: `manifest.webmanifest` + SVG icon → "Add to Home Screen"
  gives a fullscreen, standalone game.
- `client/public/_headers` sets 1-year immutable caching for fingerprinted
  assets. Note: GitHub only honors `_headers` once you attach a **custom
  domain**; on the default `*.github.io` host GitHub serves its own 10-minute
  cache (gzip is applied either way, as shown above).

## 8. Project layout

```
kessler_protocol/
├── client/                  # Phaser 3 + TypeScript + Vite (+ Capacitor for APK)
│   ├── src/
│   │   ├── scenes/          # Boot (loader) · Game (sim) · HUD (telemetry/menus/panels)
│   │   ├── ai/localBrain.ts # TS twin of the server brain + DIFF_AI presets
│   │   ├── ai/              # …+ explainFactors(): signed "why it chose" drivers
│   │   ├── fx/              # theme.ts (seed looks + serverEnabled) · sfx.ts
│   │   └── ui/safeArea.ts   # notch/foldable insets + responsive UI/entity scales
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

## 9. License

Code: Apache 2.0 (see `LICENSE`). Art: CC0 by Kenney — thanks for the pixels.
PRs welcome: new intents, new moods, better calibration plots.
