"""Derive the 1KB orthogonal-context-gated brain in closed form.

For each context partition we solve an independent 16-column OLS per action.
Because the context is a hard one-hot gate, the teacher is exactly linear
inside every partition, so this is a *solvable* problem, not an approximation.

Run: python derive_kb1k.py
Writes: kb1k_weights.json  +  ../client/src/ai/kb1kWeights.ts
"""
from __future__ import annotations

import json
import os
import random
import sys
from typing import Dict, List

import kb1k as K

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

SAMPLES_PER_CTX = 900
RIDGE = 1e-9


def random_obs(rng: random.Random, ctx: int, role: int) -> K.UnitObs:
    """Sample a plausible basis vector for a given context partition."""
    hp_self = rng.uniform(0.05, 1.0)
    hp_target = rng.uniform(0.05, 1.0)
    d_self = rng.uniform(20.0, 720.0)
    danger = rng.uniform(0.0, 1.0)
    x = K.basis(
        d_self=d_self, hp_self=hp_self, d_target=d_self * rng.uniform(0.7, 1.3),
        hp_target=hp_target, side=rng.uniform(-1.0, 1.0),
        danger=danger, incoming=rng.uniform(0.0, 1.0),
        ally_support=rng.uniform(0.0, 1.0), band=rng.uniform(0.0, 1.0),
        last_off=1.0 if rng.random() > 0.5 else 0.0,
        commit=rng.uniform(0.0, 20.0), edge=rng.uniform(0.0, 1.0),
    )
    o = K.UnitObs(x, role, ctx)
    return o


def derive():
    rng = random.Random(2024)
    blocks: List[List[List[float]]] = []      # [ctx][action][feature]
    per_ctx_agree: List[float] = []
    per_ctx_maxdp: List[float] = []

    for ctx in range(K.NCTX):
        rows_X: List[List[float]] = []
        rows_roles: List[int] = []
        rows_logits: List[List[float]] = []
        for _ in range(SAMPLES_PER_CTX):
            role = rng.randrange(K.NARCH)
            o = random_obs(rng, ctx, role)
            # teacher includes the archetype prior, exactly as at runtime
            tl = K.teacher_logits(o)
            ab = K.archetype_bias(role)
            rows_X.append(o.x)
            rows_roles.append(role)
            rows_logits.append(tl)             # bias applied separately below

        # solve each action against the pure feature logits
        action_w: List[List[float]] = []
        for a in range(K.NACT):
            y = [r[a] for r in rows_logits]
            action_w.append(K.solve_ls(rows_X, y, RIDGE))
        blocks.append(action_w)

        # verify this partition: runtime logits = W.f + arch_bias[role]
        agree = 0
        max_dp = 0.0
        for i in range(0, len(rows_X)):
            role = rows_roles[i]
            ab = K.archetype_bias(role)
            pred = []
            for a in range(K.NACT):
                v = ab[a]
                for f in range(K.NF):
                    v += action_w[a][f] * rows_X[i][f]
                pred.append(v)
            # compare against the FULL teacher (features + same archetype prior),
            # since the runtime applies the prior too
            t_full = [rows_logits[i][a] + ab[a] for a in range(K.NACT)]
            ps = K.softmax(pred)
            ts = K.softmax(t_full)
            ti = max(range(K.NACT), key=lambda k: ts[k])
            pi = max(range(K.NACT), key=lambda k: ps[k])
            agree += 1 if ti == pi else 0
            max_dp = max(max_dp, max(abs(ps[k] - ts[k]) for k in range(K.NACT)))
        per_ctx_agree.append(agree / len(rows_X))
        per_ctx_maxdp.append(max_dp)

    q_weights, scales = K.quantise_per_feature(blocks)

    # archetype bias (hand-set prior, quantised on the base scale)
    flat_arch: List[float] = []
    for r in range(K.NARCH):
        flat_arch.extend(K.archetype_bias(r))
    q_arch, arch_scale = K.quantise_flat(flat_arch)
    scales[0] = arch_scale

    # gates: thresholds as int8 with fixed code-resident scale
    gate_vals = K.default_thresholds()
    q_gates = [max(-127, min(127, int(round(v / K.THRESH_SCALE)))) for v in gate_vals * K.NCTX]

    # utilities: one OLS over all contexts (context-independent head)
    all_X: List[List[float]] = []
    all_U: List[List[float]] = []
    for ctx in range(K.NCTX):
        for _ in range(200):
            o = random_obs(rng, ctx, rng.randrange(K.NARCH))
            all_X.append(o.x)
            all_U.append(K.teacher_utils(o))
    util_w = [K.solve_ls(all_X, [u[k] for u in all_U], RIDGE) for k in range(K.NUTIL)]
    q_util, util_scale = K.quantise_flat([v for row in util_w for v in row])
    while len(scales) < K.NSCALES:
        scales.append(util_scale)

    data = {
        "weights": q_weights,
        "arch": q_arch,
        "gates": q_gates,
        "util": q_util,
        "scales": [round(s, 9) for s in scales],
        "features": K.FEATURE_NAMES,
        "contexts": K.CONTEXTS,
        "tactics": [t[0] for t in K.TACTICS],
        "archetypes": K.ARCHETYPES,
        "thresh_scale": K.THRESH_SCALE,
        "hysteresis_s": K.HYSTERESIS_S,
    }

    brain = K.KB1K(data)
    data["payload_bytes"] = brain.payload_bytes
    data["state_bytes"] = K.STATE_BYTES
    data["verified"] = {
        "per_context_agreement": [round(a, 4) for a in per_ctx_agree],
        "per_context_max_prob_error": [round(d, 5) for d in per_ctx_maxdp],
        "mean_agreement": round(sum(per_ctx_agree) / len(per_ctx_agree), 4),
        "max_prob_error": round(max(per_ctx_maxdp), 5),
    }
    return data, brain


def export_ts(data: Dict[str, Any], path: str) -> None:
    w = data["weights"]
    # pack as context -> action -> feature rows for readability
    rows = []
    for ctx in range(K.NCTX):
        block = []
        for a in range(K.NACT):
            off = (ctx * K.NACT + a) * K.NF
            block.append(w[off:off + K.NF])
        rows.append(block)
    def fmt(rows):
        return "[" + ",".join(
            "[" + ",".join("[" + ",".join(str(v) for v in r) + "]" for r in ctx) + "]"
            for ctx in rows) + "]"
    ts = f"""// GENERATED by server/derive_kb1k.py - do not edit by hand.
//
// ORTHOGONAL CONTEXT GATING — {data['payload_bytes']} bytes of policy
//   move      {K.NACT} actions x {K.NF} features x {K.NCTX} contexts = {K.NACT*K.NF*K.NCTX} B (int8)
//   archetype {K.NACT} actions x {K.NARCH} archetypes            = {K.NACT*K.NARCH} B (int8)
//   gates     {K.NCTX} contexts x 4 triggers                     = {K.NCTX*4} B (int8)
//   utility   {K.NUTIL} targets x {K.NF} features               = {K.NUTIL*K.NF} B (int8)
//   scales    {K.NSCALES} f32                                  = {K.NSCALES*4} B
// contexts: {', '.join(K.CONTEXTS)}   (deterministic + hysteretic gate)
// verified: {data['verified']['mean_agreement']*100:.1f}% argmax agreement per context

export const KB1K_META = {{
    payloadBytes: {data['payload_bytes']},
    stateBytes: {data['state_bytes']},
    nfeat: {K.NF},
    nctx: {K.NCTX},
    nact: {K.NACT},
    narch: {K.NARCH},
    nutil: {K.NUTIL},
    threshScale: {data['thresh_scale']},
    hysteresis: {data['hysteresis_s']},
    features: {json.dumps(K.FEATURE_NAMES)},
    contexts: {json.dumps(K.CONTEXTS)},
    tactics: {json.dumps([t[0] for t in K.TACTICS])},
    archetypes: {json.dumps(K.ARCHETYPES)},
    agreement: {data['verified']['mean_agreement']},
    maxProbError: {data['verified']['max_prob_error']}
}} as const;

// weights[ctx][action][feature] — int8, dequantise with scales[feature]
export const KB1K_W = {fmt(rows)};
export const KB1K_ARCH = {json.dumps(data['arch'])};
export const KB1K_GATES = {json.dumps(data['gates'])};
export const KB1K_UTIL = {json.dumps(data['util'])};
export const KB1K_SCALES = {json.dumps(data['scales'])};
"""
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(ts)


def main() -> None:
    data, brain = derive()
    here = os.path.dirname(os.path.abspath(__file__))

    print("=" * 70)
    print("KB-1K — deriving an orthogonal-context-gated policy in closed form")
    print("=" * 70)
    print(f"basis      : {K.NF} features {K.FEATURE_NAMES}")
    print(f"gate       : {K.NCTX} contexts {K.CONTEXTS} (hard one-hot + hysteresis)")
    print(f"actions    : {K.NACT} tactics")
    print(f"method     : OLS per (context, action) partition, ridge={RIDGE}")

    v = data["verified"]
    print("\n--- VERIFICATION (per context partition) ---")
    for i, ctx in enumerate(K.CONTEXTS):
        print(f"  {ctx:9s} argmax agreement {v['per_context_agreement'][i]*100:6.2f}%   "
              f"max |Δp| {v['per_context_max_prob_error'][i]:.5f}")
    print(f"  mean agreement {v['mean_agreement']*100:.2f}%")

    print("\n--- MEMORY MAP ---")
    print(f"  move weights   {K.NACT*K.NF*K.NCTX:5d} B   ({K.NACT} actions x {K.NF} features x {K.NCTX} contexts)")
    print(f"  archetype bias {K.NACT*K.NARCH:5d} B   ({K.NACT} actions x {K.NARCH} archetypes)")
    print(f"  context gates  {K.NCTX*4:5d} B   ({K.NCTX} contexts x 4 triggers)")
    print(f"  utility        {K.NUTIL*K.NF:5d} B   ({K.NUTIL} targets x {K.NF} features)")
    print(f"  scales        {K.NSCALES*4:5d} B   ({K.NSCALES} f32)")
    print(f"  {'-'*46}")
    print(f"  PAYLOAD       {brain.payload_bytes:5d} B   "
          f"({100.0*brain.payload_bytes/1024:.1f}% of 1 KB)")
    print(f"  state budget  {K.STATE_BYTES:5d} B   (hysteresis timer, last tactic, commit)")
    print(f"  TOTAL         {brain.payload_bytes + K.STATE_BYTES:5d} B")
    assert brain.payload_bytes <= 1024, "over budget!"

    with open(os.path.join(here, "kb1k_weights.json"), "w", encoding="utf-8") as fh:
        json.dump(data, fh)
    export_ts(data, os.path.join(here, "..", "client", "src", "ai", "kb1kWeights.ts"))
    print("\nwrote kb1k_weights.json")
    print("wrote client/src/ai/kb1kWeights.ts")
    print("=" * 70)


if __name__ == "__main__":
    main()