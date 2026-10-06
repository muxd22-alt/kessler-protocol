// ─────────────────────────────────────────────────────────────────────────────
//  Local decision brain — TYPES + DIFFICULTY PRESETS + EXPLAINABILITY
//
//  The policy itself no longer lives here: it was distilled into 46 int8
//  weights (see tinyBrain.ts / server/brain.py). This file keeps only what the
//  UI needs — the observation type, the difficulty presets, and the signed
//  "why it chose" factors.
// ─────────────────────────────────────────────────────────────────────────────

export interface BrainEnemy { id: string; x: number; y: number; hp01: number }
export interface BrainState {
    px: number; py: number; php01: number;
    enemies: BrainEnemy[];
    projCount: number;
    noise?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Difficulty retunes the BRAIN (matches server DIFF_PRESETS): easy = dazed /
//  flat beliefs, hard = razor beliefs. Gameplay pressure (cadence / speed /
//  fire) is applied by GameScene to match.
// ─────────────────────────────────────────────────────────────────────────────

export type Difficulty = 'easy' | 'normal' | 'hard';

export const DIFF_AI: Record<Difficulty, { gain: number; noise: number }> = {
    easy: { gain: 0.7, noise: 0.70 },
    normal: { gain: 1.6, noise: 0.0 },
    hard: { gain: 2.4, noise: 0.0 }
};

// ─────────────────────────────────────────────────────────────────────────────
//  Explainability — WHY an enemy chose what it chose.
//  This is the core differentiator versus behavior trees: the system can show
//  its reasoning as magnitudes instead of "rule 7 fired".
//  impact: -1 (fully defensive) … +1 (fully aggressive)
// ─────────────────────────────────────────────────────────────────────────────

export interface Factor { label: string; detail: string; impact: number }

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

export function explainFactors(enemyId: string, s: BrainState): Factor[] {
    const self = s.enemies.find((e) => e.id === enemyId);
    if (!self) return [];
    const dist = Math.hypot(s.px - self.x, s.py - self.y);
    const far = clamp01(dist / 700);
    const hurt = 1 - clamp01(self.hp01);
    const danger = clamp01(s.projCount / 14);
    const side = self.x < s.px ? -1 : 1;
    return [
        { label: 'proximity', detail: `${Math.round(dist)}px · ${Math.round(far * 100)}% far`, impact: (1 - far) * 1.0 - 0.5 },
        { label: 'own hull', detail: `${Math.round(self.hp01 * 100)}%`, impact: -hurt },
        { label: 'threat density', detail: `${s.projCount} proj`, impact: danger * 0.8 },
        { label: 'flank bias', detail: side < 0 ? 'left of player' : 'right of player', impact: side * 0.5 },
        { label: 'player hull', detail: `${Math.round(s.php01 * 100)}%`, impact: -(1 - s.php01) * 0.6 }
    ];
}
