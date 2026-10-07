// ../test/golden_arenas.test.ts
var import_node_fs = require("node:fs");
var import_node_path = require("node:path");

// src/sim/prng.ts
var MUL = 1664525;
var INC = 1013904223;
var FNV_OFFSET = 2166136261;
var FNV_PRIME = 16777619;
function hash32(h, v) {
  let x = (h ^ v >>> 0) >>> 0;
  x = Math.imul(x, FNV_PRIME) >>> 0;
  return x >>> 0;
}
function hashCombine(values, seed = 0) {
  let h = (FNV_OFFSET ^ seed >>> 0) >>> 0;
  for (let i = 0; i < values.length; i++) h = hash32(h, values[i] | 0);
  return h >>> 0;
}
function latticeHash(seed, ix, iy) {
  let h = (seed ^ 2654435769) >>> 0;
  h = hash32(h, ix | 0);
  h = hash32(h, iy | 0);
  h ^= h >>> 15;
  h = Math.imul(h, 2246822519) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 3266489917) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}
var PCG32 = class {
  state;
  constructor(seed) {
    let s = seed >>> 0 ^ 625341585;
    s = Math.imul(s, 2246822519) >>> 0;
    s = (s ^ s >>> 15) >>> 0;
    this.state = (s || 1) >>> 0;
    this.nextU32();
  }
  nextU32() {
    this.state = Math.imul(this.state, MUL) + INC >>> 0;
    const xorshifted = (this.state >>> 18 ^ this.state) >>> 27 >>> 0;
    const rot = this.state >>> 28;
    return (xorshifted >>> rot | xorshifted << (-rot & 31)) >>> 0;
  }
  /** Uniform integer in [0, n). Rejection-free (modulo bias < 2^-32 for n << 2^32). */
  int(n) {
    return this.nextU32() % n;
  }
  /** Uniform integer in [lo, hi] inclusive. */
  range(lo, hi) {
    return lo + this.int(hi - lo + 1);
  }
  /** Uniform in [0,1) built from integer bits only. */
  unit() {
    return this.nextU32() / 4294967296;
  }
  pick(arr) {
    return arr[this.int(arr.length)];
  }
  chance(pct) {
    return this.int(100) < pct;
  }
};
function smooth(t) {
  return t * t * (3 - 2 * t);
}
function valueNoise(seed, x, y) {
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
function fbm2(seed, x, y) {
  return 0.65 * valueNoise(seed, x, y) + 0.35 * valueNoise(seed ^ 1542469173, x * 2.13, y * 2.13);
}

// src/sim/arena.ts
var ARENA_W = 1600;
var ARENA_H = 1e3;
var CENTER_X = ARENA_W / 2;
var CENTER_Y = ARENA_H / 2;
var MUTATORS = ["DOUBLE_G", "FAST_PULSAR", "THIN_HULLS", "RICH_ASTEROIDS"];
function genPairs(rng, count, make, mirror) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const a = make(rng);
    out.push(a);
    out.push(mirror(a));
  }
  return out;
}
function generateArena(seedInput) {
  const seed = seedInput >>> 0;
  const rng = new PCG32(seed);
  const wells = [];
  const wellPairs = rng.int(3);
  const pairWells = genPairs(
    rng,
    wellPairs,
    () => ({
      x: rng.range(260, ARENA_W - 260),
      y: rng.range(200, ARENA_H - 200),
      mass: rng.range(500, 2e3),
      // integer mass
      drift: rng.range(0, 20),
      // integer drift
      dir: rng.range(0, 359)
    }),
    (w) => ({ x: ARENA_W - w.x, y: ARENA_H - w.y, mass: w.mass, drift: w.drift, dir: (w.dir + 180) % 360 })
  );
  wells.push(...pairWells);
  if (rng.chance(35)) {
    wells.push({ x: CENTER_X, y: CENTER_Y, mass: rng.range(700, 2600), drift: rng.range(0, 12), dir: 0 });
  }
  const rocks = [];
  const fieldCount = rng.range(1, 4);
  const density = rng.range(10, 60) / 100;
  for (let f = 0; f < fieldCount; f++) {
    const cx = rng.range(200, ARENA_W - 200);
    const cy = rng.range(160, ARENA_H - 160);
    const rad = rng.range(120, 300);
    const amp = rng.range(40, 110);
    const fieldRocks = [];
    for (let gx = 0; gx < 14; gx++) {
      for (let gy = 0; gy < 9; gy++) {
        const px = cx - rad + gx * rad * 2 / 13;
        const py = cy - rad + gy * rad * 2 / 8;
        const n = fbm2(seed ^ 461845907, gx * 0.55 + cx * 0.01, gy * 0.55 + cy * 0.01);
        const dx = (px - cx) / rad;
        const dy = (py - cy) / rad;
        const fall = Math.max(0, 1 - (dx * dx + dy * dy));
        if (n * fall > 1 - density) {
          fieldRocks.push({ x: Math.round(px), y: Math.round(py), r: rng.range(14, 14 + amp) });
        }
      }
    }
    rocks.push(...fieldRocks);
    for (const r of fieldRocks) rocks.push({ x: ARENA_W - r.x, y: ARENA_H - r.y, r: r.r });
  }
  let pulsar = null;
  if (rng.chance(50)) {
    pulsar = {
      x: CENTER_X,
      y: CENTER_Y,
      period: rng.range(70, 190),
      // ticks
      damage: rng.range(6, 16)
    };
  }
  const wormholes = [];
  const whPairs = rng.int(3);
  for (let i = 0; i < whPairs; i++) {
    const ax = rng.range(240, CENTER_X - 120);
    const ay = rng.range(180, ARENA_H - 180);
    wormholes.push({ ax, ay, bx: ARENA_W - ax, by: ARENA_H - ay });
  }
  const spawnA = [];
  const spawnB = [];
  const spawnJitter = rng.range(0, 60);
  for (let i = 0; i < 3; i++) {
    const y = 260 + i * 240 + rng.int(spawnJitter + 1);
    const x = 150 + rng.int(spawnJitter + 1);
    spawnA.push([x, y]);
    spawnB.push([ARENA_W - x, ARENA_H - y]);
  }
  const mutators = [];
  const mutCount = rng.int(3);
  for (let i = 0; i < mutCount; i++) {
    const m = MUTATORS[rng.int(MUTATORS.length)];
    if (!mutators.includes(m)) mutators.push(m);
  }
  const arena = {
    seed,
    wells,
    rocks,
    pulsar,
    wormholes,
    spawnA,
    spawnB,
    mutators,
    hash: 0
  };
  arena.hash = hashArena(arena);
  return arena;
}
function hashArena(a) {
  const v = [a.seed, a.wells.length, a.rocks.length, a.pulsar ? 1 : 0, a.wormholes.length];
  for (const w of a.wells) v.push(w.x | 0, w.y | 0, w.mass | 0, w.drift | 0, w.dir | 0);
  for (const r of a.rocks) v.push(r.x | 0, r.y | 0, r.r | 0);
  if (a.pulsar) v.push(a.pulsar.x | 0, a.pulsar.y | 0, a.pulsar.period | 0, a.pulsar.damage | 0);
  for (const h of a.wormholes) v.push(h.ax | 0, h.ay | 0, h.bx | 0, h.by | 0);
  for (const s of a.spawnA) v.push(s[0] | 0, s[1] | 0);
  for (const s of a.spawnB) v.push(s[0] | 0, s[1] | 0);
  for (const m of a.mutators) {
    for (let i = 0; i < m.length; i++) v.push(m.charCodeAt(i));
  }
  return hashCombine(v, 1262834515);
}

// ../test/golden_arenas.test.ts
var goldenPath = (0, import_node_path.resolve)(process.cwd(), "golden_arenas.json");
var golden = JSON.parse((0, import_node_fs.readFileSync)(goldenPath, "utf-8"));
var failures = 0;
console.log("KB arena determinism \u2014 TS generator vs golden vectors (from Python)");
console.log("-".repeat(64));
console.log(`${"seed".padStart(11)} ${"golden".padStart(12)} ${"ts".padStart(12)}  result`);
for (const v of golden.vectors) {
  const a = generateArena(v.seed);
  const ok = a.hash === v.hash;
  if (!ok) failures++;
  console.log(
    `${String(v.seed).padStart(11)} ${String(v.hash >>> 0).padStart(12)} ${String(a.hash >>> 0).padStart(12)}  ${ok ? "OK" : "MISMATCH"}`
  );
  if (!ok) {
    console.log(`   golden wells=${v.hash} ts wells=${a.wells.length} rocks=${a.rocks.length}`);
  }
}
var twice = generateArena(48213).hash === generateArena(48213).hash;
if (!twice) {
  failures++;
  console.log("FAIL: generator is not deterministic for a repeated seed");
} else {
  console.log("\nrepeat-seed determinism: OK");
}
console.log("-".repeat(64));
if (failures > 0) {
  console.error(`FAIL: ${failures} golden vector mismatch(es)`);
  process.exit(1);
}
console.log(`OK: all ${golden.vectors.length} golden vectors reproduce exactly`);
