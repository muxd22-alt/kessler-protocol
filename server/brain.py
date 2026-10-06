"""Tiny decision brain — the smallest policy that can play this game.

Design note (this is the whole trick):
    The analytic "teacher" policy is *exactly linear* in a small hand-picked
    feature basis. That means it can be represented with a handful of int8
    weights instead of thousands of instructions. We choose the basis, then
    fit the weights, then throw the teacher away at runtime.

Feature basis (8 numbers, shared by the trainer, the server and the client):
    0 bias      1 far      2 tent_hi   3 tent_lo
    4 hurt      5 danger   6 pweak     7 sideC  (-1 enemy left of player, +1 right)

Everything the brain needs: 40 int8 weights for the 5 move intents
(adv / strf / flk_l / flk_r / ret) + 2 int8 weights for the shoot-urgency
scalar + one float32 quantisation scale  ->  46 bytes total.

This module has no third-party dependencies so it runs anywhere.
"""
from __future__ import annotations

import math
import random
from typing import Any, Dict, List, Optional, Sequence, Tuple

CLASSES = ["adv", "strf", "flk_l", "flk_r", "ret"]
NFEAT = 8
FEATURE_NAMES = ["bias", "far", "tent_hi", "tent_lo", "hurt", "danger", "pweak", "sideC"]

DECISION_TEMP = 0.45
DEFAULT_GAIN = 1.6
BASE_JITTER = 0.05


# ---------------------------------------------------------------------------
# State parsing (accepts the compact p/e/q schema)
# ---------------------------------------------------------------------------

def player_of(state: Dict[str, Any]) -> Tuple[float, float, float]:
    p = state.get("p", [320.0, 500.0, 1.0])
    try:
        return float(p[0]), float(p[1]), float(p[2])
    except (IndexError, TypeError, ValueError):
        return 320.0, 500.0, 1.0


def enemy_of(state: Dict[str, Any], eid: str) -> Tuple[float, float, float]:
    for row in state.get("e", []) or []:
        if isinstance(row, (list, tuple)) and len(row) >= 4 and str(row[0]) == eid:
            try:
                return float(row[1]), float(row[2]), float(row[3])
            except (TypeError, ValueError):
                break
    px, py, _ = player_of(state)
    return px, py - 200.0, 1.0


def proj_count(state: Dict[str, Any]) -> float:
    proj = state.get("proj", 0)
    if isinstance(proj, dict):
        proj = proj.get("count", 0)
    try:
        return float(proj or 0)
    except (TypeError, ValueError):
        return 0.0


def features_raw(px: float, py: float, php: float,
                 ex: float, ey: float, ehp: float, proj: float) -> List[float]:
    """The entire observation, compressed into 8 numbers (hot path, no dicts)."""
    far = min(math.hypot(px - ex, py - ey) / 700.0, 1.0)
    hurt = 1.0 - max(0.0, min(1.0, ehp))
    danger = min(proj / 14.0, 1.0)
    pweak = 1.0 - max(0.0, min(1.0, php))
    return [
        1.0,                                  # bias
        far,                                  # distance
        max(0.0, 2.0 * far - 1.0),            # tent_hi  (far side)
        max(0.0, 1.0 - 2.0 * far),            # tent_lo  (near side)
        hurt,                                 # own damage
        danger,                               # projectile density
        pweak,                                # player weakness
        1.0 if ex > px else -1.0,             # which flank we sit on
    ]


def features(state: Dict[str, Any], eid: str) -> List[float]:
    """Schema-aware wrapper around features_raw (mirrored in TS)."""
    px, py, php = player_of(state)
    ex, ey, ehp = enemy_of(state, eid)
    return features_raw(px, py, php, ex, ey, ehp, proj_count(state))


# ---------------------------------------------------------------------------
# Analytic teacher — the reference policy we distill into 46 bytes.
# Every term below is linear in the 8 features above (that is the proof).
# ---------------------------------------------------------------------------

# Teacher bias tuning, produced by tune_teacher.py against the multi-objective
# fitness (see bake_off.py). Overridable without editing code.
TEACHER_TUNE = {"adv": 0.0, "strf": 0.0, "ret": 0.0, "flk": 0.0}


def load_tune(path: str = "teacher_tune.json") -> Dict[str, float]:
    import json
    import os

    for cand in (path, os.path.join(os.path.dirname(__file__), path)):
        if os.path.isfile(cand):
            try:
                with open(cand, "r", encoding="utf-8") as fh:
                    data = json.load(fh)
                tune = data.get("tune", data)   # file nests biases under "tune"
                if isinstance(tune, dict):
                    for k in ("adv", "strf", "ret", "flk"):
                        if isinstance(tune.get(k), (int, float)):
                            TEACHER_TUNE[k] = float(tune[k])
            except Exception:
                pass
    return dict(TEACHER_TUNE)


def teacher_logits(state: Dict[str, Any], eid: str) -> List[float]:
    b, far, tent_hi, tent_lo, hurt, danger, pweak, sideC = features(state, eid)
    prox = b - far                       # 1 - far
    tent = b - tent_hi - tent_lo         # 1 - |2*far-1| / 2  -> closeness shape
    t = TEACHER_TUNE
    # Default posture is "close in and fight"; retreat is a last resort, and
    # strafing wins only when the sky is actually busy. These constants were
    # tuned against server/sim.py under a multi-objective fitness that rewards
    # damage, completion AND retention equally (bake_off.py).
    adv = 1.15 + 1.2 * prox - 1.1 * hurt - 0.8 * danger + t["adv"]
    strf = 0.78 + 0.9 * danger + 0.4 * tent + t["strf"]
    flk_l = 0.15 + 0.175 - 0.325 * sideC + 0.5 * far - 0.4 * danger + t["flk"]
    flk_r = 0.15 + 0.175 + 0.325 * sideC + 0.5 * far - 0.4 * danger + t["flk"]
    ret = -1.45 + 3.2 * hurt + 0.8 * danger + 0.6 * pweak + t["ret"]
    return [adv, strf, flk_l, flk_r, ret]


def teacher_shoot(state: Dict[str, Any], eid: str) -> float:
    b, far, tent_hi, tent_lo, hurt, danger, pweak, sideC = features(state, eid)
    prox = b - far
    return max(0.0, min(1.0, 0.25 + 0.65 * prox))


# ---------------------------------------------------------------------------
# Softmax helpers
# ---------------------------------------------------------------------------

def softmax(xs: Sequence[float], temp: float = DECISION_TEMP) -> List[float]:
    m = max(xs) if xs else 0.0
    ex = [math.exp((x - m) / max(temp, 1e-6)) for x in xs]
    s = sum(ex) or 1.0
    return [v / s for v in ex]


# ---------------------------------------------------------------------------
# The 46-byte policy
# ---------------------------------------------------------------------------

class TinyBrain:
    """int8 linear policy: 5 intents + 1 scalar from 8 features."""

    def __init__(self, data: Dict[str, Any]):
        self.raw: List[int] = [int(v) for v in data["weights"]]     # 40 move weights
        self.shot: List[int] = [int(v) for v in data.get("shoot", [0, 0])]
        self.scale: float = float(data["scale"])                    # dequant: w * scale
        self.classes: List[str] = list(data.get("classes", CLASSES))
        self.agreement: Optional[float] = data.get("agreement")
        self.max_dp: Optional[float] = data.get("max_prob_error")
        self.nbytes = len(self.raw) + len(self.shot) + 4             # weights + shoot + f32
        self._wf: Optional[List[List[float]]] = None

    def _w(self) -> List[List[float]]:
        """Dequantised float weights, cached (42 multiply-adds)."""
        if self._wf is None:
            s = self.scale
            n = len(self.classes)
            self._wf = [
                [self.raw[i * NFEAT + c] * s for c in range(NFEAT)]
                for i in range(n)
            ]
        return self._wf

    def logits(self, state: Dict[str, Any], eid: str) -> List[float]:
        f = features(state, eid)
        w = self._w()
        return [sum(w[i][c] * f[c] for c in range(NFEAT)) for i in range(len(w))]

    def decide(self, state: Dict[str, Any], eid: str,
               gain: float = DEFAULT_GAIN, noise: float = 0.0
               ) -> Tuple[str, float, Dict[str, float]]:
        raw = self.logits(state, eid)
        jit = (BASE_JITTER + noise * 0.35) if noise <= 0 else (0.25 + noise * 0.8)
        logits = [(v + random.gauss(0, jit)) * gain for v in raw]
        ps = softmax(logits)
        best = max(range(len(ps)), key=lambda i: ps[i])
        probs = {self.classes[i]: round(ps[i], 4) for i in range(len(ps))}
        return self.classes[best], round(ps[best], 4), probs

    def shoot(self, state: Dict[str, Any], eid: str, jit: Optional[float] = None,
              noise: float = 0.0) -> float:
        """Shoot urgency from the two int8 shoot weights on [bias, far]."""
        j = BASE_JITTER if jit is None else jit
        px, py, php = player_of(state)
        ex, ey, ehp = enemy_of(state, eid)
        b, far, *_ = features_raw(px, py, php, ex, ey, ehp, proj_count(state))
        v = (self.shot[0] * b + self.shot[1] * far) * self.scale
        if j > 0:
            v += random.gauss(0, j + noise * 0.25)
        return max(0.0, min(1.0, v))


def load_brain(path: str = "brain_weights.json") -> Optional[TinyBrain]:
    import json
    import os

    for cand in (path, os.path.join(os.path.dirname(__file__), path)):
        if os.path.isfile(cand):
            try:
                with open(cand, "r", encoding="utf-8") as fh:
                    data = json.load(fh)
                return TinyBrain(data)
            except Exception:
                return None
    return None