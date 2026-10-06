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

## 3. The smallest decision system we could build (46 bytes)

We stopped asking "how do we make this bigger and smarter" and asked
**"how small can a decision system be before it stops being one?"**

**Observation.** Everything the enemy needs to pick one of five intents fits in
**8 numbers**: `bias, far, tent_hi, tent_lo, hurt, danger, pweak, sideC`.

**The trick.** Our analytic policy turned out to be *exactly linear* in that
basis. Softmax only cares about logits up to an additive constant, so if we can
reproduce the logits we reproduce the probabilities **exactly**. That means no
SGD, no framework, no network — just a least-squares solve for the weights,
then int8 quantisation:

```
5 intents × 8 features = 40 weights  +  2 for the shoot-urgency scalar
+ 1 float32 dequantisation scale                    = 46 bytes total
```

Regenerate and verify any time (`python train_brain.py`):

| Metric | Result |
|---|---|
| Argmax agreement with the analytic teacher | **99.5 %** |
| Mean probability error | **0.0007** |
| Max probability error | 0.012 |
| Calibration drift vs teacher | **0.0000** |
| Runtime policy size | **46 bytes** |

Inference is ~40 multiply-adds plus a 5-way softmax.

### 4.1 Bake-off: 46 bytes vs pure-Python PPO

Because a single scalar makes any comparison a strawman, we scored everything
with a **pre-registered multi-objective fitness** (`server/fitness.py`), fixed
*before* any student was evaluated:

```
Fitness = 0.35·(THRUP/THRUP_max) + 0.40·(PROG/PROG_max) + 0.25·(RETAIN/RETAIN_max)
          − 0.15·Var(THRUP, PROG, RETAIN)
```

- **THRUP** — damage throughput, log-compressed (`log1p`) so dps-padding stops paying.
- **PROG** — objective completion as a *continuous* fraction of the player's hull removed, not a binary win flag, so incremental progress counts even in losses.
- **RETAIN** — retention: fraction of the enemy's own hull left.
- Each axis is normalised by the specialist constant that maximises it (STRF / ADV / RET), so the three specialists each score ~1.0 on one axis only.
- **Survival floor 0.20** disqualifies "suicidal high-damage loops" outright.
- The **variance penalty** is what forces versatility: a specialist pays for being one-dimensional.

The teacher's four logit biases were then tuned against *that* fitness
(`tune_teacher.py`, 72 postures × 40 seeds) and frozen before the students ran.

Measured in a headless arena (`server/sim.py`), 200 identical seeds:

| Policy | Fitness | Thrup | Prog | Retain | Var | Win | Damage | Policy size |
|---|---|---|---|---|---|---|---|---|
| **utility-46B (shipped)** | **+0.7512** | 1.11 | 0.82 | 0.22 | 0.136 | **64 %** | **57.3** | **46 B** |
| ppo-mlp (246 params) | +0.1814 | 0.00 | 0.00 | 0.81 | 0.147 | 0 % | 0.0 | 984 B (246 B int8) |
| ppo-linear (54 params) | +0.1814 | 0.00 | 0.00 | 0.81 | 0.147 | 0 % | 0.0 | 216 B (54 B int8) |
| constant RET | +0.1814 | 0.00 | 0.00 | 0.81 | 0.138 | 0 % | 0.0 | 0 B |
| random | +0.1134 | 0.02 | 0.02 | 0.42 | 0.036 | 0 % | 1.2 | 0 B |
| constant STRF | **disqualified** | 0.74 | 0.59 | 0.02 | 0.097 | 21 % | 41.5 | 0 B |
| constant ADV | **disqualified** | 1.33 | 0.95 | 0.18 | 0.231 | 81 % | 66.7 | 0 B |

What this actually shows, stated plainly:

1. **The survival floor works.** Both aggressive specialists — the ones that
   win the most fights — are *disqualified* for dying doing it. Without that
   floor, "always ADVANCE" would have won the table and taught us nothing.
2. **The 46-byte policy beats every specialist** because it is the only agent
   that damages, progresses *and* retains. Hand-designed, 46 bytes, zero
   training pipeline.
3. **Both PPO students collapsed into "always retreat"** — identical metrics,
   0 damage. The pure-Python PPO (54 and 246 params, 768k env steps) found the
   camping optimum and got stuck. *Honest caveat:* this is our from-scratch
   stdlib PPO, not a tuned numpy/vectorised one; a properly tuned RL setup could
   close some of that gap. We report what we measured rather than what would be
   convenient.
4. **The PPO students are also 5×–21× larger** for strictly worse behaviour.

**Try it live:** open the ⚙ stress lab and press `🧠 Brain:` to swap between
`46 BYTES` and `PPO 246 par`. Watch the PPO enemies refuse to close in.

Reproduce the whole pipeline:

```bash
cd server
python tune_teacher.py   # freeze teacher posture against the fitness
python train_brain.py    # derive + verify the 46-byte policy
python train_ppo.py      # pure-python PPO (no numpy/torch)
python bake_off.py       # the table above -> bake_off.json
```

Everything is stdlib-only Python. The shipped client ships **zero** ML
dependencies — just the generated weights file.

## 4. Features

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

## 5. Quickstart

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

## 6. The decision API (for hackers)

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

## 7. Assets — all free, all credited

All art is **[Kenney Space Shooter Redux/Extension (CC0)](https://kenney.nl/assets/space-shooter-redux)** —
ships, missiles, meteors, effects, station parts live in
`client/public/assets/`. Particles (`nebula`, `dot`) and all SFX are
procedurally generated at runtime — the repo ships zero binary blobs beyond
the Kenney PNGs. `client/public/assets/download_assets.py` documents the
original fetch recipe.

## 8. Deployment (GitHub Pages — free, automatic)

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

## 9. Project layout

```
kessler_protocol/
├── client/                  # Phaser 3 + TypeScript + Vite (+ Capacitor for APK)
│   ├── src/
│   │   ├── scenes/          # Boot (loader) · Game (sim) · HUD (telemetry/panels)
│   │   ├── ai/
│   │   │   ├── tinyBrain.ts          # 46-byte policy inference (~40 MACs)
│   │   │   ├── tinyBrainWeights.ts   # GENERATED - 42 int8 weights + scale
│   │   │   ├── ppoBrain.ts           # the PPO students, for the live A/B
│   │   │   ├── ppoMlpWeights.ts      # GENERATED by server/train_ppo.py
│   │   │   └── localBrain.ts         # DIFF_AI presets + explainFactors()
│   │   ├── fx/              # theme.ts (seed looks + serverEnabled) · sfx.ts
│   │   └── ui/safeArea.ts   # notch/foldable insets + responsive UI/entity scales
│   └── public/assets/       # Kenney CC0 art
├── server/                  # stdlib-only Python, no ML dependencies
│   ├── brain.py             # features · analytic teacher · 46-byte policy runtime
│   ├── fitness.py           # pre-registered multi-objective fitness
│   ├── sim.py               # headless arena (mirrors GameScene dynamics)
│   ├── tune_teacher.py      # freeze teacher posture against the fitness
│   ├── train_brain.py       # closed-form LS -> 46-byte policy (+ verification)
│   ├── train_ppo.py         # pure-python PPO (no numpy/torch)
│   ├── bake_off.py          # the head-to-head table
│   ├── main.py              # FastAPI bridge: /v1/systemone · /v1/theme · /health
│   └── benchmark.py         # HTTP benchmark against a live server
└── .github/workflows/       # pages.yml — build + deploy the demo
```

Mobile tiers: **Tier 1** (this repo) desktop Python bridge · **Tier 2** pure
mobile web via the local twin — already how Pages runs · **Tier 3** native
APK via the included Capacitor config (`npx cap add android && npx cap sync`).

## 10. License

Code: Apache 2.0 (see `LICENSE`). Art: CC0 by Kenney — thanks for the pixels.
PRs welcome: new intents, new moods, better calibration plots.
