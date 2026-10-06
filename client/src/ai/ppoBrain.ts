// The PPO students, running in the browser so the bake-off is playable.
// Pure-Python-trained weights (server/train_ppo.py) - no numpy/torch anywhere.
// This exists to be SWITCHED ON and observed losing to the 46-byte policy.

import {
    PPO_HIDDEN, PPO_W1, PPO_B1, PPO_W2, PPO_B2
} from './ppoMlpWeights';

const D = 8;

function softmax(z: number[]): number[] {
    let m = -Infinity;
    for (const v of z) if (v > m) m = v;
    let s = 0;
    const e = z.map((v) => Math.exp(v - m));
    for (const v of e) s += v;
    return e.map((v) => v / s);
}

/** MLP forward pass: 8 -> 16 tanh -> 5. Returns the action distribution. */
export function ppoDecide(f: number[]): { choice: number; probs: number[] } {
    const h = new Array<number>(PPO_HIDDEN);
    for (let j = 0; j < PPO_HIDDEN; j++) {
        let s = PPO_B1[j];
        const row = PPO_W1[j];
        for (let c = 0; c < D; c++) s += row[c] * f[c];
        h[j] = Math.tanh(s);
    }
    const logits: number[] = [];
    for (let i = 0; i < 5; i++) {
        let s = PPO_B2[i];
        const row = PPO_W2[i];
        for (let j = 0; j < PPO_HIDDEN; j++) s += row[j] * h[j];
        logits.push(s);
    }
    const ps = softmax(logits);
    let best = 0;
    for (let i = 1; i < ps.length; i++) if (ps[i] > ps[best]) best = i;
    return { choice: best, probs: ps };
}