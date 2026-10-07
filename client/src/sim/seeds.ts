// Procedural arena: seed resolution + the held-out split.
//
// A seed in the URL (#seed=48213) is the whole interface. Visitors can share a
// map, and the "unseen map" badge is honest because the held-out set is fixed
// and generated from a seed the trainer never consumes.

import { generateArena, type Arena } from './arena';

/** Seeds the champion was developed/evaluated against. */
export const TRAIN_SEEDS: number[] = [
    48213, 1337, 90210, 5, 61803, 271828, 777, 424242, 31337, 161803,
    8675309, 112358, 99991, 60684, 14142, 31415, 27182, 8080, 1234567, 987654
];

/** Reserved. Never trained on, never tuned on. */
export const HELDOUT_SEEDS: number[] = [
    48214, 1338, 90211, 6, 61804, 271829, 778, 424243, 31338, 161804,
    8675310, 112359, 99992, 60685, 14143, 31416, 27183, 8081, 1234568, 987655
];

export function isHeldOut(seed: number): boolean {
    return HELDOUT_SEEDS.indexOf(seed >>> 0) >= 0;
}

/** Read #seed= from the URL, or fall back to a random one. */
export function seedFromLocation(): { seed: number; fromUrl: boolean } {
    try {
        const m = /[#&]seed=(\d+)/.exec(window.location.hash + window.location.search);
        if (m) {
            const v = Number.parseInt(m[1], 10);
            if (Number.isFinite(v) && v >= 0) return { seed: v >>> 0, fromUrl: true };
        }
    } catch {
        /* no window (tests) */
    }
    return { seed: (Math.random() * 4294967295) >>> 0, fromUrl: false };
}

export function pushSeedToUrl(seed: number): void {
    try {
        const next = `#seed=${seed >>> 0}`;
        if (window.location.hash !== next) {
            window.history.replaceState(null, '', next);
        }
    } catch {
        /* ignore */
    }
}

export function newSeed(): number {
    return (Math.random() * 4294967295) >>> 0;
}

/** Load an arena and record how it should be labelled in the HUD. */
export function loadArena(seed: number): { arena: Arena; seen: boolean } {
    const arena = generateArena(seed);
    const seen = TRAIN_SEEDS.indexOf(seed >>> 0) >= 0;
    pushSeedToUrl(seed);
    return { arena, seen };
}
