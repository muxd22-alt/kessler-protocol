// KB-1K — Orthogonal Context Gating, 948 bytes, running in the browser.
// Mirror of server/kb1k.py. Same weights, same gate, same 16-feature basis.
//
// The context is a hard, deterministic, hysteretic state (ADVANCE / FLANK /
// HOLD / RETREAT). Because it is one-hot, the policy stays strictly linear
// inside each partition — so the weights were recovered by OLS and remain
// exactly attributable, and every decision is explainable by linear
// attribution over the active 16x12 block.

import { KB1K_W, KB1K_ARCH, KB1K_GATES, KB1K_UTIL, KB1K_SCALES, KB1K_META } from './kb1kWeights';

export const META = KB1K_META;
export const NF = META.nfeat;
export const NCTX = META.nctx;
export const NACT = META.nact;
export const NARCH = META.narch;

export const CTX = { ADVANCE: 0, FLANK: 1, HOLD: 2, RETREAT: 3 } as const;

// tactic -> [intent, fires]  (mirrors server/kb1k.py::TACTICS)
export const TACTIC_INTENT = ['adv', 'strf', 'flk_l', 'flk_r', 'flk_l', 'flk_r', 'strf', 'ret', 'strf', 'strf', 'ret', 'ret'];
export const TACTIC_FIRES = [true, true, true, true, true, true, true, true, false, false, false, false];

/** Deterministic gate thresholds, dequantised from their int8 payload. */
function gateValue(i: number): number {
    return KB1K_GATES[i] * META.threshScale;
}
export const GATES = {
    retreatOn: gateValue(0),
    holdOn: gateValue(1),
    flankOff: gateValue(2)
};

/** Hysteretic context gate — the thing a flat linear policy cannot express. */
export function kb1kGate(pressure: number, last: number, timer: number, dt: number): { ctx: number; timer: number } {
    let t = timer - dt;
    if (t > 0) return { ctx: last, timer: t };
    let next: number = CTX.ADVANCE;
    if (pressure > GATES.retreatOn) next = CTX.RETREAT;
    else if (pressure > GATES.holdOn) next = CTX.HOLD;
    else if (pressure < GATES.flankOff) next = CTX.FLANK;
    if (next !== last) return { ctx: next, timer: META.hysteresis };
    return { ctx: last, timer: 0 };
}

/** The 16-number basis. Mirrors server/kb1k.py::basis exactly. */
export function kb1kBasis(
    dSelf: number, hpSelf: number, hpTarget: number,
    side: number, danger: number, incoming: number, allySupport: number,
    band: number, lastOff: boolean, commit: number, edge: number
): number[] {
    const far = Math.min(dSelf / 700, 1);
    return [
        1,
        far,
        Math.max(0, 1 - 2 * far),
        Math.max(0, 2 * far - 1),
        side > 0 ? 1 : -1,
        Math.min(Math.max(hpSelf, 0), 1),
        1 - Math.min(Math.max(hpSelf, 0), 1),
        Math.min(Math.max(hpTarget, 0), 1),
        1 - Math.min(Math.max(hpTarget, 0), 1),
        Math.min(Math.max(danger, 0), 1),
        Math.min(Math.max(incoming, 0), 1),
        Math.min(Math.max(allySupport, 0), 1),
        Math.min(Math.max(band, 0), 1),
        Math.min(Math.max(commit / 20, 0), 1),
        lastOff ? 1 : 0,
        Math.min(Math.max(edge, 0), 1)
    ];
}

/** One 16x12 block per context, sliced by the gate. Argmax over tactics. */
export function kb1kDecide(_x: number[], ctx: number, role: number, noise = 0): { choice: number; conf: number; probs: number[] } {
    const block = KB1K_W[ctx] as number[][];
    const abase = role * NACT;
    const jit = noise > 0 ? 0.25 + noise * 0.8 : 0.05;
    const z = new Array<number>(NACT);
    for (let a = 0; a < NACT; a++) {
        let v = KB1K_ARCH[abase + a] * KB1K_SCALES[0];
        const row = block[a];
        for (let f = 0; f < NF; f++) v += row[f] * KB1K_SCALES[f];
        z[a] = (v + (Math.random() + Math.random() + Math.random() - 1.5) * 0.816 * jit) * 1.6;
    }
    let m = -Infinity;
    for (const v of z) if (v > m) m = v;
    const e = z.map((v) => Math.exp((v - m) / 0.45));
    const sum = e.reduce((a, b) => a + b, 0) || 1;
    const probs = e.map((v) => v / sum);
    let best = 0;
    for (let i = 1; i < probs.length; i++) if (probs[i] > probs[best]) best = i;
    return { choice: best, conf: probs[best], probs };
}

/** 3 auxiliary outputs (fire urgency, focus, reposition priority). */
export function kb1kUtilities(_x: number[]): number[] {
    const out: number[] = [];
    for (let k = 0; k < META.nutil; k++) {
        let v = 0;
        for (let f = 0; f < NF; f++) v += KB1K_UTIL[k * NF + f] * KB1K_SCALES[f];
        out.push(Math.min(1, Math.max(0, v)));
    }
    return out;
}

/**
 * Tactical pressure: recent damage RECEIVED minus target weakness.
 * Positive -> HOLD/RETREAT, negative (an opening) -> FLANK, zero -> ADVANCE.
 */
export function kb1kPressure(dmgInRecent: number, hpTargetFrac: number): number {
    const taken = Math.min(dmgInRecent / 100, 1);
    const pweak = 1 - Math.min(Math.max(hpTargetFrac, 0), 1);
    return Math.min(1, Math.max(-1, taken - pweak));
}
