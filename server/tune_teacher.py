"""Tune the analytic teacher's posture against the multi-objective fitness
BEFORE any student is evaluated (pre-registration - no strawman baseline).

Search space is deliberately tiny: four additive logit biases
(adv / strf / ret / flank). The policy stays hand-designed - we are choosing
posture, not learning behaviour. The winner is frozen into teacher_tune.json
and consumed by train_brain.py.

Run: python tune_teacher.py
"""
from __future__ import annotations

import itertools
import json
import os
import sys
from typing import Dict, List

import brain
import fitness
import sim

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

TUNE_SEEDS = list(range(40))
GRID = {
    "adv": [-0.30, 0.0, 0.30],
    "strf": [-0.30, 0.0, 0.30, 0.60],
    "ret": [-0.45, 0.0, 0.45],
    "flk": [-0.15, 0.0],
}

_SPEC_RUNS: Dict[str, List[dict]] = {}
_SCORER: fitness.FitnessScorer = None  # type: ignore[assignment]


def _teacher_policy(o, env):
    """Evaluate the TEACHER itself (the 46-byte weights are derived from it)."""
    st = {"p": [env.px, env.py, env.php / sim.PLAYER_HP],
          "e": [["a", env.ex, env.ey, env.ehp / sim.ENEMY_HP]], "proj": env.proj}
    logits = brain.teacher_logits(st, "a")
    return max(range(len(logits)), key=lambda i: logits[i])


def _prepare() -> None:
    """Specialists do not depend on the tune - measure them once."""
    global _SCORER, _SPEC_RUNS
    if _SCORER is not None:
        return
    _SPEC_RUNS = {
        k: [sim.rollout(lambda o, e, i=i: i, s) for s in TUNE_SEEDS]
        for k, i in fitness.SPECIALISTS.items()
    }
    _SCORER = fitness.FitnessScorer.from_specialists(
        _SPEC_RUNS, sim.PLAYER_HP, sim.ENEMY_HP)


def evaluate_tune(tune: Dict[str, float], seeds=TUNE_SEEDS) -> Dict[str, float]:
    _prepare()
    brain.TEACHER_TUNE.update(tune)
    runs = [sim.rollout(_teacher_policy, s) for s in seeds]
    return _SCORER.score(runs)


def main() -> None:
    print("=" * 72)
    print("Teacher posture search - multi-objective fitness")
    print(f"  weights w_damage={fitness.W_DAMAGE} w_win={fitness.W_WIN} "
          f"w_survival={fitness.W_SURVIVAL}  lambda_var={fitness.LAMBDA_VAR}  "
          f"survival_floor={fitness.T_MIN_SURV}")
    print("=" * 72)

    base = {k: 0.0 for k in GRID}
    base_score = evaluate_tune(dict(base))
    print(f"baseline (zero biases): fitness {base_score['fitness']:+.4f}  "
          f"thr/prog/ret {base_score['thrup']:.2f}/{base_score['prog']:.2f}/"
          f"{base_score['retain']:.2f}  var {base_score['variance']:.4f}")
    for name, key in fitness.SPECIALISTS.items():
        s = _SCORER.score(_SPEC_RUNS[name])
        print(f"  specialist {name:5s}: fitness {s['fitness']:+.4f}  "
              f"thr/prog/ret {s['thrup']:.2f}/{s['prog']:.2f}/{s['retain']:.2f}  "
              f"var {s['variance']:.4f}")

    keys = list(GRID)
    best = (base_score["fitness"], dict(base))
    tried = 0
    for combo in itertools.product(*(GRID[k] for k in keys)):
        tune = dict(zip(keys, combo))
        s = evaluate_tune(tune)
        tried += 1
        if s["fitness"] > best[0]:
            best = (s["fitness"], tune)
            print(f"  new best {s['fitness']:+.4f}  {tune}  "
                  f"thr/prog/ret {s['thrup']:.2f}/{s['prog']:.2f}/{s['retain']:.2f} "
                  f"var {s['variance']:.4f}")

    print(f"\nevaluated {tried} postures x {len(TUNE_SEEDS)} seeds")
    print(f"BEST posture {best[1]}  fitness {best[0]:+.4f}")

    here = os.path.dirname(os.path.abspath(__file__))
    out = {
        "tune": best[1],
        "fitness": best[0],
        "constants": {
            "w_damage": fitness.W_DAMAGE,
            "w_win": fitness.W_WIN,
            "w_survival": fitness.W_SURVIVAL,
            "lambda_var": fitness.LAMBDA_VAR,
            "survival_floor": fitness.T_MIN_SURV,
        },
        "search": GRID,
        "tuning_seeds": len(TUNE_SEEDS),
    }
    with open(os.path.join(here, "teacher_tune.json"), "w", encoding="utf-8") as fh:
        json.dump(out, fh, indent=2)
    print("wrote teacher_tune.json (frozen) - now re-run train_brain.py")
    print("=" * 72)


if __name__ == "__main__":
    main()