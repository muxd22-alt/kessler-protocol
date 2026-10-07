// KB-1K — Orthogonal Context Gating, Unity Burst reference implementation.
//
// Credit: this blueprint and the C# below were supplied by the technique's
// author. The running game in this repo uses the TypeScript port in
// client/src/ai/kb1k.ts (same weights, same gate, same 16-feature basis); this
// file is kept verbatim so Unity/Burst users have a drop-in reference.
//
// Why the gate is additive-and-one-hot rather than a tanh layer: a nonlinear
// activation BETWEEN layers would break the property that makes this provable —
// that the teacher is exactly linear inside each context partition, so the
// weights are recoverable by ordinary least squares with no learning at all.
// Because the context is a hard mutually-exclusive state, y = W · (X ⊗ C) is
// just a different 16x12 weight block per context, and every decision stays
// exactly attributable by linear attribution over the active block.

using Unity.Collections;
using Unity.Mathematics;
using System.Runtime.InteropServices;

namespace Kessler
{
    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    public unsafe struct GatedBrain1KB
    {
        // ── 1 KB payload ───────────────────────────────────────────────────
        public fixed sbyte Weights[768];        // W_move : 12 actions x 16 features x 4 contexts
        public fixed sbyte ArchetypeBiases[48]; // B_arch : 12 actions x 4 archetypes
        public fixed sbyte TargetWeights[48];   // W_target : 3 targets x 16 features
        public fixed float Scales[16];          // f32 dequantisers, indexed by feature

        // ── state (the remaining ~76 B of the budget) ──────────────────────
        public int LastContext;
        public float ContextTimer;

        /// <summary>
        /// Evaluates the 1KB brain for the active context. Returns the tactical
        /// index (0-11). O(12 x 16) — sub-microsecond, no allocation, no GC.
        /// </summary>
        public int Evaluate(float* basis16, int archetypeIdx, float deltaTime, float contextPressure)
        {
            // 1. Deterministic context gate with hysteresis (no network decides it)
            int context = DetermineContext(contextPressure, deltaTime);

            // 2. Locate this context's 16x12 slice and the archetype prior
            int contextOffset = context * 16 * 12;
            int biasOffset = archetypeIdx * 12;

            int bestAction = 0;
            float maxScore = float.MinValue;

            // 3. The linear pass — provable, exactly like the 46-byte version
            for (int a = 0; a < 12; a++)
            {
                float actionScore = 0f;
                int actionOffset = contextOffset + (a * 16);

                for (int f = 0; f < 16; f++)
                {
                    float weight = Weights[actionOffset + f] * Scales[f];
                    actionScore += basis16[f] * weight;
                }

                actionScore += ArchetypeBiases[biasOffset + a] * Scales[0];
                if (actionScore > maxScore)
                {
                    maxScore = actionScore;
                    bestAction = a;
                }
            }

            return bestAction;
        }

        /// <summary>
        /// Hard, mutually-exclusive context with a 0.5 s lock so the gate cannot
        /// stutter. Thresholds live in the 16-byte gate payload.
        /// </summary>
        private int DetermineContext(float pressure, float dt)
        {
            ContextTimer -= dt;
            if (ContextTimer > 0f) return LastContext;

            int newContext;
            if (pressure > 0.18f)      newContext = 3;   // RETREAT
            else if (pressure > 0.05f) newContext = 2;   // HOLD
            else if (pressure < -0.05f) newContext = 1;  // FLANK
            else                       newContext = 0;   // ADVANCE

            if (newContext != LastContext)
            {
                LastContext = newContext;
                ContextTimer = 0.5f;
            }
            return LastContext;
        }
    }
}
