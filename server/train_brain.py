"""Derive the smallest possible decision policy for this game.

Key insight (this is the whole project in one paragraph):
    The analytic "teacher" policy is *exactly linear* in a small hand-picked
    feature basis. A softmax only cares about logits up to an additive
    constant, so if we can reproduce the teacher's logits we reproduce the
    teacher's probabilities EXACTLY. That means we do not need SGD, a neural
    network, or an LLM — we can just solve a least-squares system for the
    weights and quantise them.

    8 features x 5 intents = 40 weights, plus 2 for the shoot-urgency scalar,
    quantised to int8 with one shared float32 scale  ->  46 bytes of policy.

Because the fit is closed-form we can *measure* the result instead of hoping:
    agreement  = argmax match rate against the teacher
    max |dp|   = worst probability deviation from the teacher
    ECE        = calibration error of the tiny policy against the teacher
    shoot MAE  = mean absolute error of the urgency scalar

Run:  python train_brain.py
Writes: brain_weights.json  +  ../client/src/ai/tinyBrainWeights.ts
"""
from __future__ import annotations

import json
import math
import os
import random
import sys
from typing import Any, Dict, List, Tuple

from brain import (
    CLASSES, NFEAT, FEATURE_NAMES, DECISION_TEMP, DEFAULT_GAIN, BASE_JITTER,
    features_raw, teacher_logits, teacher_shoot, softmax, TinyBrain, load_tune,
)

SAMPLES = 1200
RIDGE = 1e-9

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")


# ---------------------------------------------------------------------------
# Synthetic states (the same generator is reused by the PPO bake-off)
# ---------------------------------------------------------------------------

def random_state(rng: random.Random) -> Dict[str, Any]:
    return {
        "p": [round(rng.uniform(40, 960), 2), round(rng.uniform(260, 720), 2), round(rng.uniform(0.05, 1.0), 2)],
        "e": [["a", round(rng.uniform(0, 1000), 2), round(rng.uniform(-140, 660), 2), round(rng.uniform(0.05, 1.0), 2)]],
        "proj": round(rng.uniform(0, 16), 1),
    }


def dataset(seed: int = 7):
    rng = random.Random(seed)
    rows: List[List[float]] = []
    logits: List[List[float]] = []
    shoots: List[float] = []
    for _ in range(SAMPLES):
        st = random_state(rng)
        f = features_raw(st["p"][0], st["p"][1], st["p"][2], st["e"][0][1], st["e"][0][2], st["e"][0][3], st["proj"])
        rows.append(f)
        logits.append(teacher_logits(st, "a"))
        shoots.append(teacher_shoot(st, "a"))
    return rows, logits, shoots


# ---------------------------------------------------------------------------
# Closed-form least squares (normal equations + Gaussian elimination)
# ---------------------------------------------------------------------------

def solve_least_squares(A: List[List[float]], y: List[float], ridge: float = RIDGE) -> List[float]:
    n, d = len(A), len(A[0])
    M = [[0.0] * d for _ in range(d)]
    v = [0.0] * d
    for k in range(n):
        ak = A[k]
        for i in range(d):
            ai = ak[i]
            if ai == 0.0:
                continue
            v[i] += ai * y[k]
            Mi = M[i]
            for j in range(d):
                Mi[j] += ai * ak[j]
    for i in range(d):
        M[i][i] += ridge
    # Gaussian elimination with partial pivoting
    for col in range(d):
        piv = max(range(col, d), key=lambda r: abs(M[r][col]))
        if abs(M[piv][col]) < 1e-14:
            continue
        M[col], M[piv] = M[piv], M[col]
        v[col], v[piv] = v[piv], v[col]
        p = M[col][col]
        for j in range(col, d):
            M[col][j] /= p
        v[col] /= p
        for r in range(d):
            if r == col:
                continue
            f = M[r][col]
            if f == 0.0:
                continue
            for j in range(col, d):
                M[r][j] -= f * M[col][j]
            v[r] -= f * v[col]
    return v


# ---------------------------------------------------------------------------
# Quantisation
# ---------------------------------------------------------------------------

def quantise(flat: List[float]) -> Tuple[List[int], float]:
    m = max(abs(v) for v in flat) or 1.0
    scale = m / 127.0
    return [max(-127, min(127, int(round(v / scale)))) for v in flat], scale


# ---------------------------------------------------------------------------
# Verification
# ---------------------------------------------------------------------------

def verify(tiny: TinyBrain, rows, logits, shoots) -> Dict[str, Any]:
    w = tiny._w()
    agree = 0
    max_dp = 0.0
    sum_dp = 0.0
    bins: List[List[Tuple[bool, float]]] = [[] for _ in range(10)]
    for f, tl in zip(rows, logits):
        approx = [sum(w[i][c] * f[c] for c in range(NFEAT)) for i in range(len(CLASSES))]
        target = softmax(tl, temp=DECISION_TEMP)
        ps = softmax(approx, temp=DECISION_TEMP)
        tb = max(range(len(CLASSES)), key=lambda i: target[i])
        pb = max(range(len(CLASSES)), key=lambda i: ps[i])
        agree += 1 if tb == pb else 0
        dp = max(abs(ps[i] - target[i]) for i in range(len(CLASSES)))
        max_dp = max(max_dp, dp)
        sum_dp += dp / len(CLASSES)
        bins[min(9, int(max(target) * 10))].append((max(ps), max(target)))

    n = len(rows)
    total = sum(len(b) for b in bins) or 1
    # Calibration drift: how far the quantised policy's stated confidence moves
    # away from the teacher's, binned by the teacher's own confidence.
    drift = sum((len(b) / total) * abs(
        (sum(c for _, c in b) / len(b)) - (sum(tc for _, tc in b) / len(b))
    ) for b in bins if b)

    # Shoot urgency through the real 2-weight path
    shot_err = 0.0
    for (f, y_true) in zip(rows, shoots):
        v = (tiny.shot[0] * f[0] + tiny.shot[1] * f[1]) * tiny.scale
        shot_err += abs(max(0.0, min(1.0, v)) - y_true)
    return {
        "agreement": round(agree / n, 4),
        "max_prob_error": round(max_dp, 5),
        "mean_prob_error": round(sum_dp / n, 5),
        "calibration_drift": round(drift, 5),
        "shoot_mae": round(shot_err / n, 5),
    }


def main() -> None:
    tune = load_tune()
    print("=" * 64)
    print("KESSLER - deriving the smallest possible decision policy")
    print("=" * 64)
    print(f"teacher tune : {tune}  (from tune_teacher.py / teacher_tune.json)")
    rows, logits, shoots = dataset()
    print(f"observation : {NFEAT} features -> {', '.join(FEATURE_NAMES)}")
    print(f"action space: {len(CLASSES)} intents {CLASSES}")
    print(f"method      : closed-form least squares on teacher logits (no SGD, no framework)")
    print(f"samples     : {len(rows)} synthetic states, ridge={RIDGE}")

    weights: List[float] = []
    for i in range(len(CLASSES)):
        row = solve_least_squares(rows, [l[i] for l in logits])
        weights.extend(row)
        print(f"  {CLASSES[i]:>6s} w = [" + ", ".join(f"{v:+.4f}" for v in row) + "]")

    shot = solve_least_squares([[r[0], r[1]] for r in rows], shoots)
    # ONE shared int8 scale for all 42 weights -> keeps the policy at 46 bytes
    q_all, scale = quantise(weights + shot)
    qw, qs = q_all[: len(weights)], q_all[len(weights):]

    data: Dict[str, Any] = {
        "classes": CLASSES,
        "features": FEATURE_NAMES,
        "weights": qw,
        "shoot": qs,
        "scale": round(scale, 9),
        "temp": DECISION_TEMP,
        "gain": DEFAULT_GAIN,
        "jitter": BASE_JITTER,
    }
    tiny = TinyBrain(data)
    metrics = verify(tiny, rows, logits, shoots)
    data.update(metrics)
    data["bytes"] = tiny.nbytes

    print("\n--- VERIFICATION: 46-byte policy vs the analytic teacher ---")
    print(f"argmax agreement : {metrics['agreement'] * 100:.2f}%")
    print(f"max |delta p|    : {metrics['max_prob_error']:.5f}")
    print(f"mean |delta p|   : {metrics['mean_prob_error']:.5f}")
    print(f"calib. drift : {metrics['calibration_drift']:.5f}  (vs teacher confidence)")
    print(f"shoot urgency MAE: {metrics['shoot_mae']:.5f}")
    print(f"int8 scale       : {scale:.6f}")

    here = os.path.dirname(os.path.abspath(__file__))
    with open(os.path.join(here, "brain_weights.json"), "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2)

    weights_str = ",".join(str(v) for v in qw)
    shoot_str = ",".join(str(v) for v in qs)
    ts = f"""// GENERATED by server/train_brain.py - do not edit by hand.
//
// THE ENTIRE ENEMY DECISION POLICY:
//   {len(qw)} int8 move weights + {len(qs)} int8 shoot weights + 1 f32 scale
//   = {tiny.nbytes} bytes  (that's the whole "AI", derived in closed form)
//
// features: {', '.join(FEATURE_NAMES)}

export interface TinyBrainData {{
    classes: string[];
    features: string[];
    weights: number[];   // {len(CLASSES)} x {NFEAT}, row-major
    shoot: number[];     // [bias, far]
    scale: number;
    temp: number;
    gain: number;
    jitter: number;
    agreement: number;
    max_prob_error: number;
    calibration_drift: number;
    shoot_mae: number;
    bytes: number;
}}

export const TINY_BRAIN: TinyBrainData = {{
    classes: {json.dumps(CLASSES)},
    features: {json.dumps(FEATURE_NAMES)},
    weights: [{weights_str}],
    shoot: [{shoot_str}],
    scale: {round(scale, 9)},
    temp: {DECISION_TEMP},
    gain: {DEFAULT_GAIN},
    jitter: {BASE_JITTER},
    agreement: {metrics['agreement']},
    max_prob_error: {metrics['max_prob_error']},
    calibration_drift: {metrics['calibration_drift']},
    shoot_mae: {metrics['shoot_mae']},
    bytes: {tiny.nbytes}
}};
"""
    ts_path = os.path.join(here, "..", "client", "src", "ai", "tinyBrainWeights.ts")
    with open(ts_path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(ts)

    print("\nwrote server/brain_weights.json")
    print("wrote client/src/ai/tinyBrainWeights.ts")
    print(f"\nRUNTIME POLICY SIZE: {tiny.nbytes} bytes "
          f"({len(qw) + len(qs)} int8 + 1 x f32 scale)")
    print("=" * 64)


if __name__ == "__main__":
    main()