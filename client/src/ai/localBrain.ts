// Local heuristic brain — a TypeScript twin of server/main.py::heuristic_choice.
// Used instantly when the decision server is unreachable, so the showcase
// stays intelligent offline. Same intent semantics:
//   move:   adv / strf / flk_l / flk_r / ret
//   target: p / proj / ret   ·   scalar: shoot-urgency in [0,1]

export interface BrainEnemy { id: string; x: number; y: number; hp01: number }
export interface BrainState {
    px: number; py: number; php01: number;
    enemies: BrainEnemy[];
    projCount: number;
    noise?: number;
}

export interface BrainAnswer {
    c: string; conf: number; p: Record<string, number>;
}

function softmax(xs: number[], temp = 0.45): number[] {
    const m = Math.max(...xs);
    const ex = xs.map((x) => Math.exp((x - m) / temp));
    const s = ex.reduce((a, b) => a + b, 0) || 1;
    return ex.map((v) => v / s);
}

// Difficulty retunes the BRAIN to match the server (see DIFF_PRESETS):
// easy = dazed/flat beliefs, hard = razor beliefs. Gameplay pressure
// (cadence/speed/fire) is applied by GameScene to match.
export type Difficulty = 'easy' | 'normal' | 'hard';
export const DIFF_AI: Record<Difficulty, { gain: number; noise: number }> = {
    easy: { gain: 0.7, noise: 0.70 },
    normal: { gain: 1.6, noise: 0.0 },
    hard: { gain: 2.4, noise: 0.0 }
};

// Defaults = normal. Keep in sync with server DECISION_GAIN.
const GAIN = 1.6;
const BASE_JITTER = 0.05;

const gauss = () => (Math.random() + Math.random() + Math.random() - 1.5) * 0.816;

export function scoreOptions(
    enemyId: string, options: string[], s: BrainState, gain: number = GAIN
): { choice: string; conf: number; probs: Record<string, number> } {
    const self = s.enemies.find((e) => e.id === enemyId) ?? s.enemies[0];
    const ex = self?.x ?? s.px, ey = self?.y ?? 0;
    const hp = self?.hp01 ?? 1;
    const dist = Math.hypot(s.px - ex, s.py - ey);
    const far = Math.min(dist / 700, 1);
    const hurt = 1 - Math.max(0, Math.min(1, hp));
    const danger = Math.min(s.projCount / 14, 1);
    const side = ex < s.px ? 1 : -1;
    const noiseAmp = BASE_JITTER + (s.noise ?? 0) * 0.35;

    const logits = options.map((raw) => {
        const o = raw.toLowerCase();
        let v: number;
        if (o === 'adv') v = 0.9 + 1.1 * (1 - far) - 1.4 * hurt - 0.9 * danger;
        else if (o === 'strf') v = 0.7 + 0.9 * danger + 0.4 * (1 - Math.abs(far - 0.5) * 2);
        else if (o === 'flk_l') v = 0.45 + (side < 0 ? 0.5 : -0.15) + 0.5 * far - 0.4 * danger;
        else if (o === 'flk_r') v = 0.45 + (side > 0 ? 0.5 : -0.15) + 0.5 * far - 0.4 * danger;
        else if (o === 'ret') v = -0.5 + 2.2 * hurt + 0.8 * danger + 0.6 * (1 - s.php01);
        else if (o === 'p') v = 1.0 - 0.7 * danger - 0.8 * hurt;
        else if (o === 'proj') v = -0.4 + 2.0 * danger;
        else v = 0.3;
        return v + gauss() * noiseAmp;
    });

    const ps = softmax(logits.map((x) => x * gain));
    let best = 0;
    ps.forEach((p, i) => { if (p > ps[best]) best = i; });
    const probs: Record<string, number> = {};
    options.forEach((o, i) => { probs[o] = +ps[i].toFixed(4); });
    return { choice: options[best], conf: +ps[best].toFixed(4), probs };
}

export function shootUrgency(enemyId: string, s: BrainState): number {
    const self = s.enemies.find((e) => e.id === enemyId);
    if (!self) return Math.random();
    const prox = 1 - Math.min(Math.hypot(s.px - self.x, s.py - self.y) / 700, 1);
    const n = 0.25 + 0.65 * prox + gauss() * (BASE_JITTER + (s.noise ?? 0) * 0.25);
    return Math.max(0, Math.min(1, n));
}
