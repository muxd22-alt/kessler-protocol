"""BAKE-OFF v2 — what do the extra ~900 bytes actually buy?

Symmetrical 3v3. Both teams have identical physics, weapons, health and the same
16-feature basis. The only difference is which brain drives team A, so any
difference in outcome is attributable to the policy architecture alone.

Scored with the SAME pre-registered multi-objective fitness used for the 46-byte
bake-off (server/fitness.py), so the two tables are comparable in spirit.

Run: python bake_off_squad.py
"""
from __future__ import annotations

import json
import os
import statistics
import sys
from typing import Any, Dict, List

import kb1k as K
import squad

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

SEEDS = list(range(160))

# Pre-registered fitness constants, mirrored here so the scorer can normalise
# with the right hull denominators for a 3-unit squad.
W_DAMAGE, W_WIN, W_SURVIVAL = 0.35, 0.40, 0.25
LAMBDA_VAR, T_MIN_SURV = 0.15, 0.20
SQUAD_HP = squad.UNIT_HP * 3


def throughput(dmg: float, steps: float) -> float:
    import math
    return math.log1p(dmg / max(steps, 1.0) * 60.0)


def completion(dmg: float) -> float:
    return dmg / SQUAD_HP


def retention(hp: float) -> float:
    return max(0.0, hp) / SQUAD_HP


def score(runs: List[Dict[str, float]], nrm: Dict[str, float]) -> Dict[str, Any]:
    n = len(runs)
    thr = sum(throughput(r["damage_dealt"], r["steps"]) for r in runs) / n / nrm["thr"]
    prg = sum(completion(r["damage_dealt"]) for r in runs) / n / nrm["prg"]
    ret = sum(retention(r["ehp"]) for r in runs) / n / nrm["ret"]
    mean = (thr + prg + ret) / 3.0
    var = ((thr - mean) ** 2 + (prg - mean) ** 2 + (ret - mean) ** 2) / 3.0
    fit = W_DAMAGE * thr + W_WIN * prg + W_SURVIVAL * ret - LAMBDA_VAR * var
    ret_mean = sum(r["ehp"] for r in runs) / n / SQUAD_HP
    dq = ret_mean < T_MIN_SURV
    ctx = [sum(r["ctx_mix"][i] for r in runs) / max(sum(sum(r["ctx_mix"]) for r in runs), 1)
           for i in range(K.NCTX)]
    return {
        "fitness": round(-1.0 if dq else fit, 4),
        "disqualified": dq,
        "thrup": round(thr, 3), "prog": round(prg, 3), "retain": round(ret, 3),
        "variance": round(var, 5),
        "win_rate": round(sum(r["won"] for r in runs) / n, 4),
        "damage": round(sum(r["damage_dealt"] for r in runs) / n, 1),
        "kills": round(sum(r["kills"] for r in runs) / n, 2),
        "context_mix": [round(c, 3) for c in ctx],
        "tactic_spread": len({max(range(K.NACT), key=lambda i: r["tactic_mix"][i])
                              for r in runs}),
    }


def main() -> None:
    # Reference normalisers: the specialist constants, measured on the same seeds.
    specs = {
        "SPEC_STRIKE": ("kb1k_teacher", 0),   # strike_adv
        "SPEC_GUARD": ("kb1k_teacher", 10),   # guard
        "SPEC_ORBIT": ("kb1k_teacher", 8),    # orbit_l
    }
    spec_runs: Dict[str, List[Dict[str, float]]] = {}
    for name, (brain, tactic) in specs.items():
        spec_runs[name] = [squad.rollout((brain, "kb1k"), s) for s in SEEDS]
    nrm = {
        "thr": max(max(throughput(r["damage_dealt"], r["steps"]) for r in v) for v in spec_runs.values()),
        "prg": max(max(completion(r["damage_dealt"]) for r in v) for v in spec_runs.values()),
        "ret": max(max(retention(r["ehp"]) for r in v) for v in spec_runs.values()),
    }

    kb = K.KB1K.load()
    cands = [
        ("kb1k 948B (gated)", "kb1k", 948),
        ("kb1k teacher f32", "kb1k_teacher", K.NACT * K.NF * K.NCTX * 4),
        ("kb46 46B (flat)", "kb46", 46),
        ("constant strike", 0, 0),
        ("constant guard", 10, 0),
        ("constant orbit", 8, 0),
        ("constant bait", 7, 0),
    ]

    print("=" * 104)
    print("BAKE-OFF v2 — symmetrical 3v3 · 46 BYTES vs 948 BYTES (orthogonal context gating)")
    print(f"fitness w={W_DAMAGE}/{W_WIN}/{W_SURVIVAL} lambda={LAMBDA_VAR} floor={T_MIN_SURV} · {len(SEEDS)} seeds")
    print("=" * 104)

    rows: List[Dict[str, Any]] = []
    for name, brain, nbytes in cands:
        # team A is the candidate (str or int), team B is always the gated 1KB
        # brain so every row is measured against an identical live opponent.
        b = (brain, "kb1k")
        runs = [squad.rollout(b, s) for s in SEEDS]
        sc = score(runs, nrm)
        sc["name"] = name
        sc["bytes"] = nbytes
        rows.append(sc)

    rows.sort(key=lambda r: -r["fitness"])
    hdr = (f"{'policy':20s} {'fitness':>8s} {'thrup':>6s} {'prog':>6s} {'retain':>7s} "
           f"{'var':>7s} {'win':>5s} {'dmg':>6s} {'kills':>6s} {'bytes':>6s} {'tact':>5s}")
    print(hdr)
    print("-" * len(hdr))
    for r in rows:
        print(f"{r['name']:20s} {r['fitness']:+8.4f} {r['thrup']:6.2f} {r['prog']:6.2f} "
              f"{r['retain']:7.2f} {r['variance']:7.4f} {r['win_rate']:5.2f} "
              f"{r['damage']:6.1f} {r['kills']:6.2f} {r['bytes']:6d} {r['tactic_spread']:5d}")

    gated = next(r for r in rows if r["name"].startswith("kb1k 948"))
    flat = next(r for r in rows if r["name"].startswith("kb46"))
    print("-" * len(hdr))
    print(f"\ncontext mix of the gated brain (ADVANCE/FLANK/HOLD/RETREAT): "
          f"{gated['context_mix']}")
    print(f"fitness: gated {gated['fitness']:+.4f} vs flat-46B {flat['fitness']:+.4f}"
          f"  ->  {gated['fitness'] - flat['fitness']:+.4f} for +{948 - 46} bytes")
    print(f"tactic diversity: gated {gated['tactic_spread']} vs flat {flat['tactic_spread']}")

    out = {
        "seeds": len(SEEDS),
        "fitness_constants": {"w_damage": W_DAMAGE, "w_win": W_WIN,
                              "w_survival": W_SURVIVAL, "lambda_var": LAMBDA_VAR,
                              "survival_floor": T_MIN_SURV},
        "payload_bytes": kb.payload_bytes if kb else None,
        "results": rows,
    }
    here = os.path.dirname(os.path.abspath(__file__))
    with open(os.path.join(here, "bake_off_squad.json"), "w", encoding="utf-8") as fh:
        json.dump(out, fh, indent=2)
    print("\nwrote bake_off_squad.json")
    print("=" * 104)


if __name__ == "__main__":
    main()