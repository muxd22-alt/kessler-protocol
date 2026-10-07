"""KB-1K — Orthogonal Context Gating. 944-948 bytes, provable, zero learning.

Blueprint (thanks to the design supplied by the author of this technique):

  Orthogonal context gating instead of a nonlinear layer. The context is a hard,
  deterministic, hysteretic state (ADVANCE / FLANK / HOLD / RETREAT), treated as
  a one-hot vector and Kronecker-producted with the 16-feature basis:

      y = W . (X (x) C)

  For a fixed active context C this is just a different 16x12 weight block, so
  the policy stays STRICTLY LINEAR inside each partition and we can recover the
  weights with ordinary least squares per context. No SGD, no gradient, no
  network — and every decision remains exactly attributable to a linear
  attribution of the active block.

Memory map (int8 weights, f32 dequantisation scales):

    move weights   12 actions x 16 features x 4 contexts = 768 B
    archetype bias 12 actions x  4 archetypes            =  48 B
    context gates   4 contexts x  4 triggers             =  16 B
    utility         3 targets x 16 features              =  48 B
    scales         17 f32 (16 per-feature + 1 utility)   =  68 B
                                                          -------
                                                           948 B

  The remaining ~76 B of a 1 KB budget is left for STATE (hysteresis timers,
  last-tactic id, commit counter) rather than more weights — which is the point:
  some complexity belongs in memory, not in parameters.

Ported to TypeScript in client/src/ai/kb1k.ts and to C#/Unity Burst in
unity/GatedBrain1KB.cs. The reference implementation in this repo is TypeScript.
"""
from __future__ import annotations

import math
import random
from typing import Any, Dict, List, Optional, Sequence, Tuple

# ---------------------------------------------------------------------------
# TUNABLES — sizes are part of the memory map, so they are literals on purpose.
# ---------------------------------------------------------------------------

NF = 16          # basis features (per context block)
NCTX = 4         # orthogonal context partitions
NACT = 12        # tactics
NARCH = 4        # archetypes
NUTIL = 3        # utility outputs
NSCALES = 17     # 16 per-feature dequant scales + 1 utility scale

FEATURE_NAMES = [
    "bias", "far", "near", "farside", "side",
    "hp_self", "hurt", "hp_target", "pweak",
    "danger", "incoming", "ally_support", "band",
    "commit", "last_off", "edge",
]
assert len(FEATURE_NAMES) == NF

CONTEXTS = ["ADVANCE", "FLANK", "HOLD", "RETREAT"]
CTX_ADVANCE, CTX_FLANK, CTX_HOLD, CTX_RETREAT = 0, 1, 2, 3

TACTICS: List[Tuple[str, str, bool]] = [
    ("strike_adv", "adv", True),
    ("strike_strf", "strf", True),
    ("flank_l", "flk_l", True),
    ("flank_r", "flk_r", True),
    ("deep_l", "flk_l", True),
    ("deep_r", "flk_r", True),
    ("suppress", "strf", True),
    ("bait", "ret", True),
    ("orbit_l", "strf", False),
    ("orbit_r", "strf", False),
    ("guard", "ret", False),
    ("disengage", "ret", False),
]
ARCHETYPES = ["assault", "sniper", "warden", "phantom"]

HYSTERESIS_S = 0.5
DECISION_TEMP = 0.45
DEFAULT_GAIN = 1.6
BASE_JITTER = 0.05
THRESH_SCALE = 1.0 / 64.0   # gates are int8 with a fixed, code-resident scale

PAYLOAD_BYTES = (NACT * NF * NCTX) + (NACT * NARCH) + (NCTX * 4) + (NUTIL * NF) + (NSCALES * 4)
STATE_BYTES = 76   # hysteresis timer, last tactic, commit counter, bookkeeping


# ---------------------------------------------------------------------------
# Context gate — deterministic + hysteretic (this is the "gate")
# ---------------------------------------------------------------------------

def default_thresholds() -> List[float]:
    # 4 contexts x 4 triggers, laid out as [retreat_on, hold_on, flank_off, pad].
    # Tuned to the normalised pressure (dmg_in-dmg_out)/(30+total) used by the arena,
    # so the gate genuinely visits all four partitions instead of parking in one.
    return [0.18, 0.05, -0.05, 0.00]


def determine_context(pressure: float, last: int, timer: float, dt: float,
                      gates: Sequence[float]) -> Tuple[int, float]:
    """Hysteretic gate. Returns (context, timer).

    Pressure is the unit's LOCAL combat pressure: rising when it is being hit,
    falling when it is winning. Because each unit has its own pressure, a pinned
    unit can sit in HOLD while its unpressured ally sits in FLANK — the
    'pin and flank' manoeuvre emerges without any such behaviour being coded.
    """
    timer -= dt
    if timer > 0.0:
        return last, timer
    if pressure > gates[0]:
        new = CTX_RETREAT
    elif pressure > gates[1]:
        new = CTX_HOLD
    elif pressure < gates[2]:
        new = CTX_FLANK
    else:
        new = CTX_ADVANCE
    if new != last:
        return new, HYSTERESIS_S
    return last, 0.0


# ---------------------------------------------------------------------------
# The 16-number basis. Mirrored verbatim in TypeScript.
# ---------------------------------------------------------------------------

class UnitObs:
    __slots__ = ("x", "role", "ctx", "last_tactic", "commit")

    def __init__(self, x: List[float], role: int, ctx: int):
        self.x = x
        self.role = role
        self.ctx = ctx
        self.last_tactic = 0
        self.commit = 0.0


def basis(d_self, hp_self: float, d_target: float, hp_target: float,
          side: float, danger: float, incoming: float, ally_support: float,
          band: float, last_off: float, commit: float, edge: float) -> List[float]:
    far = min(d_self / 700.0, 1.0)
    return [
        1.0,                                     # bias
        far,
        max(0.0, 1.0 - 2.0 * far),               # near
        max(0.0, 2.0 * far - 1.0),               # farside
        1.0 if side > 0 else -1.0,
        max(0.0, min(1.0, hp_self)),
        1.0 - max(0.0, min(1.0, hp_self)),       # hurt
        max(0.0, min(1.0, hp_target)),
        1.0 - max(0.0, min(1.0, hp_target)),     # pweak (target is beatable)
        max(0.0, min(1.0, danger)),
        max(0.0, min(1.0, incoming)),
        max(0.0, min(1.0, ally_support)),
        max(0.0, min(1.0, band)),
        max(0.0, min(1.0, commit / 20.0)),
        1.0 if last_off else 0.0,
        max(0.0, min(1.0, edge)),
    ]


# ---------------------------------------------------------------------------
# Teacher — linear inside each context, different shape per context.
# ---------------------------------------------------------------------------

def teacher_logits(o: UnitObs) -> List[float]:
    """Reference policy. Strictly linear in the 16 features for a fixed context."""
    x = o.x
    far, near, farside, side = x[1], x[2], x[3], x[4]
    hp_self, hurt, hp_t, pweak = x[5], x[6], x[7], x[8]
    danger, incoming, support, band = x[9], x[10], x[11], x[12]
    commit, last_off, edge = x[13], x[14], x[15]
    c = o.ctx

    if c == CTX_ADVANCE:
        # healthy, winning: close the distance and shoot
        return [
            1.10 + 1.20 * (1 - far) - 1.20 * hurt - 0.60 * danger,   # strike_adv
            0.55 + 0.80 * danger + 0.35 * (1 - far) - 0.30 * hurt,  # strike_strf
            0.30 - 0.45 * side + 0.45 * far - 0.25 * danger,        # flank_l
            0.30 + 0.45 * side + 0.45 * far - 0.25 * danger,        # flank_r
            0.05 - 0.45 * side + 0.80 * far - 0.20 * danger,        # deep_l
            0.05 + 0.45 * side + 0.80 * far - 0.20 * danger,        # deep_r
            -0.15 + 0.60 * danger + 0.35 * support,                 # suppress
            0.05 - 0.45 * hurt + 0.40 * danger,                     # bait
            -0.70 + 0.30 * (1 - far) - 0.40 * danger,               # orbit_l
            -0.70 + 0.30 * (1 - far) - 0.40 * danger,               # orbit_r
            -0.35 + 1.50 * hurt + 0.30 * danger,                    # guard
            -0.55 + 2.30 * hurt + 0.50 * danger,                    # disengage
        ]
    if c == CTX_FLANK:
        # advantage but not safe: swing wide, keep firing, stay off the front line
        return [
            0.15 + 0.55 * (1 - far) - 0.90 * hurt - 0.50 * danger,   # strike_adv
            0.45 + 0.70 * danger + 0.30 * (1 - far),                # strike_strf
            0.95 - 0.30 * side + 0.55 * band - 0.30 * danger,        # flank_l
            0.95 + 0.30 * side + 0.55 * band - 0.30 * danger,        # flank_r
            0.80 - 0.25 * side + 0.70 * farside - 0.25 * danger,     # deep_l
            0.80 + 0.25 * side + 0.70 * farside - 0.25 * danger,     # deep_r
            0.35 + 0.55 * danger + 0.30 * support,                   # suppress
            0.25 - 0.35 * hurt + 0.45 * danger,                       # bait
            -0.10 + 0.60 * band + 0.35 * support - 0.30 * danger,    # orbit_l
            -0.10 + 0.60 * band + 0.35 * support - 0.30 * danger,    # orbit_r
            -0.55 + 1.20 * hurt + 0.25 * edge,                       # guard
            -0.60 + 2.00 * hurt + 0.40 * danger,                      # disengage
        ]
    if c == CTX_HOLD:
        # under fire: hold the firing band, do not overextend, trade efficiently
        return [
            -0.55 + 0.75 * band - 1.00 * hurt - 0.55 * danger,       # strike_adv
            0.35 + 0.70 * danger + 0.60 * band - 0.45 * hurt,        # strike_strf
            0.05 + 0.40 * band - 0.35 * side - 0.30 * danger,        # flank_l
            0.05 + 0.40 * band + 0.35 * side - 0.30 * danger,        # flank_r
            -0.25 + 0.50 * band - 0.25 * side - 0.25 * danger,       # deep_l
            -0.25 + 0.50 * band + 0.25 * side - 0.25 * danger,       # deep_r
            0.85 + 0.75 * danger + 0.45 * support,                    # suppress
            -0.10 + 0.35 * band - 0.35 * hurt,                        # bait
            0.55 + 0.55 * band + 0.30 * support - 0.25 * danger,     # orbit_l
            0.55 + 0.55 * band + 0.30 * support - 0.25 * danger,     # orbit_r
            -0.15 + 1.30 * hurt + 0.45 * edge,                       # guard
            -0.45 + 2.10 * hurt + 0.40 * danger,                     # disengage
        ]
    # CTX_RETREAT — break contact, shoot while withdrawing
    return [
        -0.95 + 0.35 * band - 1.30 * hurt - 0.70 * danger,          # strike_adv
        -0.35 + 0.45 * danger + 0.30 * band - 0.70 * hurt,          # strike_strf
        -0.25 + 0.30 * band - 0.35 * side - 0.35 * danger,          # flank_l
        -0.25 + 0.30 * band + 0.35 * side - 0.35 * danger,          # flank_r
        -0.45 + 0.35 * band - 0.25 * side - 0.30 * danger,          # deep_l
        -0.45 + 0.35 * band + 0.25 * side - 0.30 * danger,          # deep_r
        0.35 + 0.60 * danger + 0.30 * support,                      # suppress
        0.75 + 0.40 * danger - 0.30 * hurt,                         # bait
        0.15 + 0.45 * band + 0.25 * support - 0.30 * danger,        # orbit_l
        0.15 + 0.45 * band + 0.25 * support - 0.30 * danger,        # orbit_r
        0.20 + 1.10 * hurt + 0.55 * edge,                            # guard
        1.05 + 1.30 * hurt + 0.45 * danger + 0.35 * edge,           # disengage
    ]


def archetype_bias(role: int) -> List[float]:
    b = [0.0] * NACT
    if role == 0:        # assault: forward pressure, finishes wounded targets
        b[0] += 0.75; b[2] += 0.25; b[3] += 0.25; b[4] += 0.15; b[5] += 0.15
    elif role == 1:      # sniper: holds the band, suppresses, minimal exposure
        b[1] += 0.55; b[6] += 0.95; b[8] += 0.25; b[9] += 0.25
    elif role == 2:      # warden: body-blocks, guards, disengages last
        b[1] += 0.20; b[10] += 1.05; b[11] += 0.35; b[7] += 0.20
    else:                # phantom: orbits at range, baits, vanishes when hurt
        b[8] += 0.85; b[9] += 0.85; b[7] += 0.60; b[6] += 0.20
    return b


def teacher_utils(o: UnitObs) -> List[float]:
    x = o.x
    fire = 0.20 + 0.70 * (1 - x[1]) - 0.55 * x[6] + 0.35 * x[9]
    focus = 0.50 + 0.60 * x[8] + 0.40 * x[11] - 0.35 * x[1]
    repos = 0.30 + 0.55 * x[10] + 0.45 * x[12] - 0.40 * x[7]
    return [max(0.0, min(1.0, v)) for v in (fire, focus, repos)]


# ---------------------------------------------------------------------------
# Closed-form derivation: OLS per (context, action) partition
# ---------------------------------------------------------------------------

def solve_ls(A: List[List[float]], y: List[float], ridge: float = 1e-9) -> List[float]:
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
            fq = M[r][col]
            if fq == 0.0:
                continue
            for j in range(col, d):
                M[r][j] -= fq * M[col][j]
            v[r] -= fq * v[col]
    return v


def quantise_per_feature(blocks: List[List[List[float]]]) -> Tuple[List[int], List[float]]:
    """blocks[ctx][action][feature] -> int8 with one scale per FEATURE.

    A per-feature scale (rather than a single global one) matches the reference
    implementation, which dequantises as Weights[i] * Scales[f].
    """
    scales: List[float] = []
    for f in range(NF):
        m = 0.0
        for ctx in blocks:
            for a in range(NACT):
                m = max(m, abs(ctx[a][f]))
        scales.append(m / 127.0 if m > 0 else 1.0)
    q: List[int] = []
    for ctx in blocks:
        for a in range(NACT):
            for f in range(NF):
                s = scales[f]
                q.append(0 if s == 0 else max(-127, min(127, int(round(ctx[a][f] / s)))))
    return q, scales


def quantise_flat(flat: List[float]) -> Tuple[List[int], float]:
    m = max(abs(v) for v in flat) or 1.0
    s = m / 127.0
    return [max(-127, min(127, int(round(v / s)))) for v in flat], s


def softmax(xs: Sequence[float], temp: float = DECISION_TEMP) -> List[float]:
    m = max(xs) if xs else 0.0
    e = [math.exp((x - m) / max(temp, 1e-6)) for x in xs]
    s = sum(e) or 1.0
    return [v / s for v in e]


# ---------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------

class KB1K:
    """948 bytes of policy + a little state. Slices one 16x12 block per context."""

    def __init__(self, data: Dict[str, Any]):
        self.w = [int(v) for v in data["weights"]]           # NCTX*NACT*NF
        self.arch = [int(v) for v in data["arch"]]           # NARCH*NACT
        self.gates = [int(v) for v in data["gates"]]         # NCTX*4
        self.util = [int(v) for v in data["util"]]           # NUTIL*NF
        self.scales = [float(s) for s in data["scales"]]     # NSCALES
        self.verified = data.get("verified", {})
        self.payload_bytes = (len(self.w) + len(self.arch) + len(self.gates)
                              + len(self.util) + 4 * len(self.scales))

    def gate_values(self) -> List[float]:
        return [v * THRESH_SCALE for v in self.gates]

    def logits(self, x: Sequence[float], ctx: int, role: int) -> List[float]:
        sc = self.scales
        base = ctx * NACT * NF
        abase = role * NACT
        out = []
        for a in range(NACT):
            off = base + a * NF
            v = self.arch[abase + a] * sc[0]
            for f in range(NF):
                v += self.w[off + f] * sc[f]
            out.append(v)
        return out

    def decide(self, x: Sequence[float], ctx: int, role: int,
               gain: float = DEFAULT_GAIN, noise: float = 0.0):
        jit = (0.25 + noise * 0.8) if noise > 0 else BASE_JITTER
        raw = self.logits(x, ctx, role)
        ps = softmax([(v + random.gauss(0, jit)) * gain for v in raw], DECISION_TEMP)
        best = max(range(NACT), key=lambda i: ps[i])
        return best, round(ps[best], 4), {TACTICS[i][0]: round(ps[i], 4) for i in range(NACT)}

    def utilities(self, x: Sequence[float], noise: float = 0.0) -> List[float]:
        out = []
        for k in range(NUTIL):
            off = k * NF
            v = 0.0
            for f in range(NF):
                v += self.util[off + f] * self.scales[f]
            v += random.gauss(0, BASE_JITTER * 0.5 + noise * 0.2)
            out.append(max(0.0, min(1.0, v)))
        return out

    @staticmethod
    def load(path: str = "kb1k_weights.json") -> Optional["KB1K"]:
        import json
        import os
        for cand in (path, os.path.join(os.path.dirname(__file__), path)):
            if os.path.isfile(cand):
                try:
                    with open(cand, "r", encoding="utf-8") as fh:
                        return KB1K(json.load(fh))
                except Exception:
                    return None
        return None
