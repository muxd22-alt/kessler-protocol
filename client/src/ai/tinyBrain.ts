// The 46-byte decision policy, running in the browser.
// Mirror of server/brain.py::TinyBrain - keep the feature order in sync.
//
// 40 int8 move weights + 2 int8 shoot weights + 1 f32 scale = 46 bytes total.
// Inference is 42 multiply-adds plus a 5-way softmax.

import { TINY_BRAIN } from './tinyBrainWeights';
import type { BrainState } from './localBrain';

const NFEAT = 8;
const A = 5;

/** Pre-dequantised weights so the hot path is plain float math. */
const W: number[][] = (() => {
    const out: number[][] = [];
    for (let i = 0; i < A; i++) {
        const row: number[] = [];
        for (let c = 0; c < NFEAT; c++) row.push(TINY_BRAIN.weights[i * NFEAT + c] * TINY_BRAIN.scale);
        out.push(row);
    }
    return out;
})();

const SHOOT0 = TINY_BRAIN.shoot[0] * TINY_BRAIN.scale;
const SHOOT1 = TINY_BRAIN.shoot[1] * TINY_BRAIN.scale;

function softmax5(z: number[], temp: number): number[] {
    let m = -Infinity;
    for (const v of z) if (v > m) m = v;
    let sum = 0;
    const e = new Array<number>(5);
    for (let i = 0; i < 5; i++) { e[i] = Math.exp((z[i] - m) / temp); sum += e[i]; }
    for (let i = 0; i < 5; i++) e[i] /= sum;
    return e;
}

const gauss = () => (Math.random() + Math.random() + Math.random() - 1.5) * 0.816;

/**
 * The 8-number observation. Mirrors server/brain.py::features_raw exactly.
 *   0 bias   1 far   2 tent_hi   3 tent_lo   4 hurt   5 danger   6 pweak   7 sideC
 */
export function brainFeatures(s: BrainState, enemyId: string): number[] {
    const self = s.enemies.find((e) => e.id === enemyId) ?? s.enemies[0];
    const ex = self ? self.x : s.px;
    const ey = self ? self.y : s.py - 200;
    const ehp = self ? self.hp01 : 1;
    const far = Math.min(Math.hypot(s.px - ex, s.py - ey) / 700, 1);
    const hurt = 1 - Math.max(0, Math.min(1, ehp));
    const danger = Math.min(s.projCount / 14, 1);
    const pweak = 1 - Math.max(0, Math.min(1, s.php01));
    const f = new Array<number>(NFEAT);
    f[0] = 1;
    f[1] = far;
    f[2] = Math.max(0, 2 * far - 1);
    f[3] = Math.max(0, 1 - 2 * far);
    f[4] = hurt;
    f[5] = danger;
    f[6] = pweak;
    f[7] = ex > s.px ? 1 : -1;
    return f;
}

export interface TinyDecision { choice: string; conf: number; probs: Record<string, number> }

/** The shipped brain: 46 bytes of policy, ~40 multiply-adds per decision. */
export function brainDecide(f: number[], gain = TINY_BRAIN.gain, noise = 0): TinyDecision {
    const z = new Array<number>(5);
    const jit = noise > 0 ? 0.25 + noise * 0.8 : TINY_BRAIN.jitter;
    for (let i = 0; i < A; i++) {
        let v = 0;
        const row = W[i];
        for (let c = 0; c < NFEAT; c++) v += row[c] * f[c];
        z[i] = (v + gauss() * jit) * gain;
    }
    const ps = softmax5(z, TINY_BRAIN.temp);
    let best = 0;
    for (let i = 1; i < 5; i++) if (ps[i] > ps[best]) best = i;
    const probs: Record<string, number> = {};
    for (let i = 0; i < A; i++) probs[TINY_BRAIN.classes[i]] = +ps[i].toFixed(4);
    return { choice: TINY_BRAIN.classes[best], conf: +ps[best].toFixed(4), probs };
}

export function brainShoot(f: number[], noise = 0): number {
    const v = SHOOT0 * f[0] + SHOOT1 * f[1] + gauss() * (TINY_BRAIN.jitter + noise * 0.25);
    return Math.max(0, Math.min(1, v));
}

export const BRAIN_INFO = {
    bytes: TINY_BRAIN.bytes,
    weights: TINY_BRAIN.weights.length + TINY_BRAIN.shoot.length,
    agreement: TINY_BRAIN.agreement,
    maxProbError: TINY_BRAIN.max_prob_error,
    calibrationDrift: TINY_BRAIN.calibration_drift,
    shootMae: TINY_BRAIN.shoot_mae,
    features: TINY_BRAIN.features,
    decisionLabels: TINY_BRAIN.classes
};