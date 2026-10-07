"""Line-for-line mirror of client/src/sim/prng.ts.

If these two ever disagree, the golden vectors in test/golden_arenas.json fail.
Keep them edited together.

Determinism rules (load-bearing):
  1. All draws come from PCG32 (integer generator). No float state.
  2. No math.sin / fract hashing — those differ across JS, Python and C#.
  3. Noise corners are integer hashes; only interpolation uses float ops
     (IEEE-754 identical in every language).
  4. Arenas are reduced to an integer hash and asserted against the TS build.
"""
from __future__ import annotations

import math
from typing import List, Sequence, TypeVar

MUL = 1664525
INC = 1013904223
FNV_OFFSET = 2166136261
FNV_PRIME = 16777619
MASK = 0xFFFFFFFF

T = TypeVar("T")


def _u32(v: int) -> int:
    return v & MASK


def _imul(a: int, b: int) -> int:
    """32-bit signed multiply, matching JavaScript's Math.imul."""
    return _u32((a | 0) * (b | 0))


def hash32(h: int, v: int) -> int:
    return _imul((h ^ _u32(v)) & MASK, FNV_PRIME)


def hash_combine(values: Sequence[int], seed: int = 0) -> int:
    h = _u32(FNV_OFFSET ^ _u32(seed))
    for v in values:
        h = hash32(h, int(v))
    return h


def lattice_hash(seed: int, ix: int, iy: int) -> int:
    h = _u32(seed ^ 0x9E3779B9)
    h = hash32(h, ix)
    h = hash32(h, iy)
    h ^= h >> 15
    h = _imul(h, 2246822519)
    h ^= h >> 13
    h = _imul(h, 3266489917)
    h ^= h >> 16
    return h & MASK


class PCG32:
    """PCG-XSH-RR 32-bit, identical draw order to the TypeScript version."""

    __slots__ = ("state",)

    def __init__(self, seed: int) -> None:
        s = _u32(_u32(seed) ^ 0x2545F491)
        s = _imul(s, 2246822519)
        s = _u32(s ^ (s >> 15))
        self.state = s if s else 1
        self.next_u32()  # discard one output so state != seed

    def next_u32(self) -> int:
        self.state = _u32(_imul(self.state, MUL) + INC)
        xorshifted = _u32(_u32(_u32(self.state >> 18) ^ self.state) >> 27)
        rot = self.state >> 28
        # (x >>> rot) | (x << ((-rot) & 31)), all in uint32 space
        left = _u32(xorshifted << ((-rot) & 31))
        return _u32((xorshifted >> rot) | left)

    def int(self, n: int) -> int:
        return self.next_u32() % n

    def rng(self, lo: int, hi: int) -> int:
        return lo + self.int(hi - lo + 1)

    def unit(self) -> float:
        return self.next_u32() / 4294967296.0

    def pick(self, arr: Sequence[T]) -> T:
        return arr[self.int(len(arr))]

    def chance(self, pct: int) -> bool:
        return self.int(100) < pct


def _smooth(t: float) -> float:
    return t * t * (3.0 - 2.0 * t)


def value_noise(seed: int, x: float, y: float) -> float:
    ix = math.floor(x)
    iy = math.floor(y)
    fx = x - ix
    fy = y - iy
    c00 = lattice_hash(seed, int(ix), int(iy)) / 4294967296.0
    c10 = lattice_hash(seed, int(ix) + 1, int(iy)) / 4294967296.0
    c01 = lattice_hash(seed, int(ix), int(iy) + 1) / 4294967296.0
    c11 = lattice_hash(seed, int(ix) + 1, int(iy) + 1) / 4294967296.0
    u = _smooth(fx)
    v = _smooth(fy)
    a = c00 + (c10 - c00) * u
    b = c01 + (c11 - c01) * u
    return a + (b - a) * v


def fbm2(seed: int, x: float, y: float) -> float:
    return 0.65 * value_noise(seed, x, y) + 0.35 * value_noise(seed ^ 0x5BF03635, x * 2.13, y * 2.13)
