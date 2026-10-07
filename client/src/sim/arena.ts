// Seeded procedural arena generation.
//
// Everything in an arena descends from ONE 32-bit seed, and the arena is
// point-symmetric so neither team gets a positional advantage — an unfair map
// would silently corrupt every win-rate number we publish.
//
// Fairness rule: every feature is emitted either AT the centre or as a
// mirror pair (x, y) <-> (W-x, H-y). There is no third option. That is enforced
// structurally in genPairs() below rather than checked afterwards, because a
// post-hoc assertion is exactly the kind of thing that gets forgotten.
//
// Mirror of server/arena.py. Golden vectors in test/golden_arenas.json assert
// both builds produce identical hashes.

import { PCG32, hashCombine, fbm2 } from './prng';

export const ARENA_W = 1600;
export const ARENA_H = 1000;
export const CENTER_X = ARENA_W / 2;
export const CENTER_Y = ARENA_H / 2;

export interface Well { x: number; y: number; mass: number; drift: number; dir: number }
export interface Rock { x: number; y: number; r: number }
export interface Pulsar { x: number; y: number; period: number; damage: number }
export interface Wormhole { ax: number; ay: number; bx: number; by: number }
export interface Arena {
    seed: number;
    wells: Well[];
    rocks: Rock[];
    pulsar: Pulsar | null;
    wormholes: Wormhole[];
    spawnA: [number, number][];
    spawnB: [number, number][];
    mutators: string[];
    hash: number;
}

export const MUTATORS = ['DOUBLE_G', 'FAST_PULSAR', 'THIN_HULLS', 'RICH_ASTEROIDS'] as const;

/** Emit a feature and its point-symmetry partner. The only way to place things. */
function genPairs<T>(rng: PCG32, count: number, make: (rng: PCG32) => T,
                      mirror: (t: T) => T): T[] {
    const out: T[] = [];
    for (let i = 0; i < count; i++) {
        const a = make(rng);
        out.push(a);
        out.push(mirror(a));
    }
    return out;
}

export function generateArena(seedInput: number): Arena {
    const seed = seedInput >>> 0;
    const rng = new PCG32(seed);

    // ── Gravity wells: 0-2 pairs, plus an optional central well ────────────
    const wells: Well[] = [];
    const wellPairs = rng.int(3);                    // 0,1,2 pairs
    const pairWells = genPairs<Well>(
        rng, wellPairs,
        () => ({
            x: rng.range(260, ARENA_W - 260),
            y: rng.range(200, ARENA_H - 200),
            mass: rng.range(500, 2000),              // integer mass
            drift: rng.range(0, 20),                 // integer drift
            dir: rng.range(0, 359)
        }),
        (w) => ({ x: ARENA_W - w.x, y: ARENA_H - w.y, mass: w.mass, drift: w.drift, dir: (w.dir + 180) % 360 })
    );
    wells.push(...pairWells);
    if (rng.chance(35)) {
        wells.push({ x: CENTER_X, y: CENTER_Y, mass: rng.range(700, 2600), drift: rng.range(0, 12), dir: 0 });
    }

    // ── Asteroid fields: integer-lattice fBm clusters, thresholded ─────────
    // Build each field ONCE, then mirror the finished rock list. Sampling the
    // lattice from a mirrored field centre yields different noise (and the
    // sequential radius draws differ too), which breaks symmetry.
    const rocks: Rock[] = [];
    const fieldCount = rng.range(1, 4);
    const density = rng.range(10, 60) / 100;          // 0.10 .. 0.60
    for (let f = 0; f < fieldCount; f++) {
        const cx = rng.range(200, ARENA_W - 200);
        const cy = rng.range(160, ARENA_H - 160);
        const rad = rng.range(120, 300);
        const amp = rng.range(40, 110);
        const fieldRocks: Rock[] = [];
        for (let gx = 0; gx < 14; gx++) {
            for (let gy = 0; gy < 9; gy++) {
                const px = cx - rad + (gx * rad * 2) / 13;
                const py = cy - rad + (gy * rad * 2) / 8;
                const n = fbm2(seed ^ 0x1b873593, gx * 0.55 + cx * 0.01, gy * 0.55 + cy * 0.01);
                const dx = (px - cx) / rad;
                const dy = (py - cy) / rad;
                const fall = Math.max(0, 1 - (dx * dx + dy * dy));
                // both factors are in [0,1], so density is a clean threshold on
                // (1 - density): 0.10 -> sparse field, 0.60 -> dense
                if (n * fall > 1 - density) {
                    fieldRocks.push({ x: Math.round(px), y: Math.round(py), r: rng.range(14, 14 + amp) });
                }
            }
        }
        rocks.push(...fieldRocks);
        for (const r of fieldRocks) rocks.push({ x: ARENA_W - r.x, y: ARENA_H - r.y, r: r.r });
    }

    // ── Pulsar: centre only (a mirrored pair would be two pulsars) ─────────
    let pulsar: Pulsar | null = null;
    if (rng.chance(50)) {
        pulsar = {
            x: CENTER_X,
            y: CENTER_Y,
            period: rng.range(70, 190),                // ticks
            damage: rng.range(6, 16)
        };
    }

    // ── Wormholes: paired endpoints, always crossing the symmetry axis ─────
    const wormholes: Wormhole[] = [];
    const whPairs = rng.int(3);
    for (let i = 0; i < whPairs; i++) {
        const ax = rng.range(240, CENTER_X - 120);
        const ay = rng.range(180, ARENA_H - 180);
        wormholes.push({ ax, ay, bx: ARENA_W - ax, by: ARENA_H - ay });
    }

    // ── Spawns: fixed mirror anchors, jittered but symmetric ───────────────
    const spawnA: [number, number][] = [];
    const spawnB: [number, number][] = [];
    const spawnJitter = rng.range(0, 60);
    for (let i = 0; i < 3; i++) {
        const y = 260 + i * 240 + rng.int(spawnJitter + 1);
        const x = 150 + rng.int(spawnJitter + 1);
        spawnA.push([x, y]);
        spawnB.push([ARENA_W - x, ARENA_H - y]);
    }

    // ── Mutators: 0-2 rule tweaks ─────────────────────────────────────────
    const mutators: string[] = [];
    const mutCount = rng.int(3);
    for (let i = 0; i < mutCount; i++) {
        const m = MUTATORS[rng.int(MUTATORS.length)];
        if (!mutators.includes(m)) mutators.push(m);
    }

    const arena: Arena = {
        seed, wells, rocks, pulsar, wormholes, spawnA, spawnB, mutators, hash: 0
    };
    arena.hash = hashArena(arena);
    return arena;
}

/**
 * FNV-1a over the arena's INTEGER fields in a fixed order.
 *
 * Floats are deliberately excluded: hashing a float would bake in
 * last-bit formatting differences between platforms. Every quantity that
 * matters to gameplay is an integer by construction.
 */
export function hashArena(a: Arena): number {
    const v: number[] = [a.seed, a.wells.length, a.rocks.length, a.pulsar ? 1 : 0, a.wormholes.length];
    for (const w of a.wells) v.push(w.x | 0, w.y | 0, w.mass | 0, w.drift | 0, w.dir | 0);
    for (const r of a.rocks) v.push(r.x | 0, r.y | 0, r.r | 0);
    if (a.pulsar) v.push(a.pulsar.x | 0, a.pulsar.y | 0, a.pulsar.period | 0, a.pulsar.damage | 0);
    for (const h of a.wormholes) v.push(h.ax | 0, h.ay | 0, h.bx | 0, h.by | 0);
    for (const s of a.spawnA) v.push(s[0] | 0, s[1] | 0);
    for (const s of a.spawnB) v.push(s[0] | 0, s[1] | 0);
    for (const m of a.mutators) { for (let i = 0; i < m.length; i++) v.push(m.charCodeAt(i)); }
    return hashCombine(v, 0x4b455353);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Map-agnostic sensing.
//
//  "Distance to well A" means nothing on a procedurally generated map, so no
//  feature may reference a named landmark. The brain only ever sees:
//    · the pull of the NEAREST well (magnitude + direction, not its identity)
//    · 8 fixed ray casts (distance to the nearest obstacle in each direction)
//  Navigation stays out of the brain: it picks an intent, a flow field executes it.
// ─────────────────────────────────────────────────────────────────────────────

export const RAY_DIRS: [number, number][] = [
    [1, 0], [0.7071, 0.7071], [0, 1], [-0.7071, 0.7071],
    [-1, 0], [-0.7071, -0.7071], [0, -1], [0.7071, -0.7071]
];
export const RAY_MAX = 520;

export interface Sensors {
    rays: number[];      // 8 normalised clearances in [0,1]
    wellPull: number;    // signed pull of the nearest well, [-1,1]
    wellDx: number;      // unit vector toward that well
    wellDy: number;
    objDx: number;       // unit vector toward the objective
    objDy: number;
}

/** Nearest-obstacle distance along a ray, against rocks only. */
function castRay(x: number, y: number, dx: number, dy: number, rocks: Rock[]): number {
    let best = RAY_MAX;
    for (const r of rocks) {
        const ex = r.x - x;
        const ey = r.y - y;
        const proj = ex * dx + ey * dy;
        if (proj <= 0) continue;
        const perp2 = ex * ex + ey * ey - proj * proj;
        const rr = r.r + 6;
        if (perp2 >= rr * rr) continue;
        const back = Math.sqrt(Math.max(0, rr * rr - perp2));
        const hit = proj - back;
        if (hit > 0 && hit < best) best = hit;
    }
    return Math.min(best, RAY_MAX);
}

/** The 8-ray + nearest-well observation. Map-agnostic by construction. */
export function senseArena(a: Arena, x: number, y: number, objX: number, objY: number): Sensors {
    const rays: number[] = [];
    for (const [dx, dy] of RAY_DIRS) {
        rays.push(castRay(x, y, dx, dy, a.rocks) / RAY_MAX);
    }
    let bestD = Infinity;
    let bw: Well | null = null;
    for (const w of a.wells) {
        const d = Math.hypot(w.x - x, w.y - y);
        if (d < bestD) { bestD = d; bw = w; }
    }
    let pull = 0, wx = 0, wy = 0;
    if (bw) {
        const inv = 1 / Math.max(bestD, 1);
        wx = (bw.x - x) * inv;
        wy = (bw.y - y) * inv;
        // normalise mass into a signed pull around a nominal 1400
        pull = Math.max(-1, Math.min(1, (bw.mass - 1400) / 1100));
    }
    const od = Math.hypot(objX - x, objY - y) || 1;
    return { rays, wellPull: pull, wellDx: wx, wellDy: wy, objDx: (objX - x) / od, objDy: (objY - y) / od };
}

/** Gravity acceleration at a point, from all wells. Deterministic float math. */
export function gravityAt(a: Arena, x: number, y: number, scale = 1): { ax: number; ay: number } {
    let ax = 0, ay = 0;
    for (const w of a.wells) {
        const dx = w.x - x;
        const dy = w.y - y;
        const d2 = Math.max(dx * dx + dy * dy, 900);   // soften singularity
        const d = Math.sqrt(d2);
        const g = (w.mass / 1000) * 90000 / d2;
        ax += (dx / d) * g;
        ay += (dy / d) * g;
    }
    if (a.mutators.includes('DOUBLE_G')) { ax *= 2; ay *= 2; }
    return { ax: ax * scale, ay: ay * scale };
}

/** Is this point inside a rock? */
export function inRock(a: Arena, x: number, y: number, pad = 0): Rock | null {
    for (const r of a.rocks) {
        const dx = x - r.x, dy = y - r.y;
        const rr = r.r + pad;
        if (dx * dx + dy * dy <= rr * rr) return r;
    }
    return null;
}
