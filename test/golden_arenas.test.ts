// Golden arena vectors — cross-language determinism test.
//
// server/gen_golden.py writes test/golden_arenas.json from the Python generator.
// This test re-generates every vector with the TypeScript generator and asserts
// the hashes match. A mismatch means the browser would play different maps than
// the headless trainer evaluated — the exact silent desync this exists to stop.
//
// Run:  npm run test:golden     (bundles this with esbuild, then runs it on node)

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { generateArena } from '../client/src/sim/arena';

const goldenPath = resolve(process.cwd(), 'golden_arenas.json');

interface Golden {
    vectors: { seed: number; hash: number; asymmetries: number }[];
}

const golden = JSON.parse(readFileSync(goldenPath, 'utf-8')) as Golden;
let failures = 0;

console.log('KB arena determinism — TS generator vs golden vectors (from Python)');
console.log('-'.repeat(64));
console.log(`${'seed'.padStart(11)} ${'golden'.padStart(12)} ${'ts'.padStart(12)}  result`);

for (const v of golden.vectors) {
    const a = generateArena(v.seed);
    const ok = a.hash === v.hash;
    if (!ok) failures++;
    console.log(
        `${String(v.seed).padStart(11)} ${String(v.hash >>> 0).padStart(12)} ` +
        `${String(a.hash >>> 0).padStart(12)}  ${ok ? 'OK' : 'MISMATCH'}`
    );
    if (!ok) {
        console.log(`   golden wells=${v.hash} ts wells=${a.wells.length} rocks=${a.rocks.length}`);
    }
}

// Determinism within the language too: same seed twice must be identical.
const twice = generateArena(48213).hash === generateArena(48213).hash;
if (!twice) {
    failures++;
    console.log('FAIL: generator is not deterministic for a repeated seed');
} else {
    console.log('\nrepeat-seed determinism: OK');
}

console.log('-'.repeat(64));
if (failures > 0) {
    console.error(`FAIL: ${failures} golden vector mismatch(es)`);
    process.exit(1);
}
console.log(`OK: all ${golden.vectors.length} golden vectors reproduce exactly`);
