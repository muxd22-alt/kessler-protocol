// Integer-only deterministic randomness.
//
// DETERMINISM RULES (these are load-bearing, not stylistic):
//   1. Every random draw goes through PCG32, an integer generator. No
//      Math.random(), no float accumulation of state.
//   2. No Math.sin/fract/cos hashing ("classic" procedural-gen tricks). Those
//      differ between JS engines, Python and C#, and desync silently.
//   3. Noise is integer-lattice value noise: the lattice corners are produced by
//      an integer hash, and only the interpolation uses float ops (which are
//      IEEE-754 identical in JS/Python/C#).
//   4. Every generated arena is reduced to an integer hash. Golden vectors in
//      test/golden_arenas.json assert the TS and Python builds agree, so a
//      mismatch is a failing test instead of a mysterious desync.
//
// server/pcg.py is a line-for-line mirror of this file.

const MUL = 1664525;
const INC = 1013904223;
const FNV_OFFSET = 2166136261;
const FNV_PRIME = 16777619;

/** FNV-1a over one uint32. Chain with more values to hash a whole struct. */
export function hash32(h: number, v: number): number {
    let x = (h ^ (v >>> 0)) >>> 0;
    x = Math.imul(x, FNV_PRIME) >>> 0;
    return x >>> 0;
}

export function hashCombine(values: ArrayLike<number>, seed = 0): number {
    let h = (FNV_OFFSET ^ (seed >>> 0)) >>> 0;
    for (let i = 0; i < values.length; i++) h = hash32(h, values[i] | 0);
    return h >>> 0;
}

/** Mix a 2D integer lattice coordinate into a uint32 (deterministic anywhere). */
export function latticeHash(seed: number, ix: number, iy: number): number {
    let h = (seed ^ 0x9e3779b9) >>> 0;
    h = hash32(h, ix | 0);
    h = hash32(h, iy | 0);
    // final avalanche so neighbouring cells decorrelate
    h ^= h >>> 15;
    h = Math.imul(h, 2246822519) >>> 0;
    h ^= h >>> 13;
    h = Math.imul(h, 3266489917) >>> 0;
    h ^= h >>> 16;
    return h >>> 0;
}

/** PCG-XSH-RR 32-bit. Small, fast, and trivially portable. */
export class PCG32 {
    private state: number;

    constructor(seed: number) {
        // mix the seed so nearby seeds produce unrelated streams
        let s = (seed >>> 0) ^ 0x2545f491;
        s = Math.imul(s, 2246822519) >>> 0;
        s = (s ^ (s >>> 15)) >>> 0;
        this.state = (s || 1) >>> 0;
        this.nextU32(); // discard one output so state != seed
    }

    nextU32(): number {
        this.state = (Math.imul(this.state, MUL) + INC) >>> 0;
        const xorshifted = (((this.state >>> 18) ^ this.state) >>> 27) >>> 0;
        const rot = this.state >>> 28;
        return ((xorshifted >>> rot) | (xorshifted << ((-rot) & 31))) >>> 0;
    }

    /** Uniform integer in [0, n). Rejection-free (modulo bias < 2^-32 for n << 2^32). */
    int(n: number): number {
        return this.nextU32() % n;
    }

    /** Uniform integer in [lo, hi] inclusive. */
    range(lo: number, hi: number): number {
        return lo + this.int(hi - lo + 1);
    }

    /** Uniform in [0,1) built from integer bits only. */
    unit(): number {
        return this.nextU32() / 4294967296;
    }

    pick<T>(arr: T[]): T {
        return arr[this.int(arr.length)];
    }

    chance(pct: number): boolean {
        return this.int(100) < pct;
    }
}

function smooth(t: number): number {
    return t * t * (3 - 2 * t);
}

/**
 * Integer-lattice value noise in [0,1]. Corners are integer hashes; only the
 * bilinear blend uses floats (IEEE-754 identical everywhere).
 */
export function valueNoise(seed: number, x: number, y: number): number {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const c00 = latticeHash(seed, ix, iy) / 4294967296;
    const c10 = latticeHash(seed, ix + 1, iy) / 4294967296;
    const c01 = latticeHash(seed, ix, iy + 1) / 4294967296;
    const c11 = latticeHash(seed, ix + 1, iy + 1) / 4294967296;
    const u = smooth(fx);
    const v = smooth(fy);
    const a = c00 + (c10 - c00) * u;
    const b = c01 + (c11 - c01) * u;
    return a + (b - a) * v;
}

/** Two-octave fBm on the integer lattice. Still fully deterministic. */
export function fbm2(seed: number, x: number, y: number): number {
    return 0.65 * valueNoise(seed, x, y) + 0.35 * valueNoise(seed ^ 0x5bf03635, x * 2.13, y * 2.13);
}
