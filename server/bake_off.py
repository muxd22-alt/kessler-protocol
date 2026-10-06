"""THE BAKE-OFF: 46-byte closed-form policy vs pure-Python PPO.

Both students are scored with the pre-registered multi-objective fitness
(fitness.py) on identical seeds, against the same specialists used to build the
normalisers. Also measures what actually ships: policy size in bytes and
per-decision latency.

Run: python bake_off.py
"""
from __future__ import annotations

import json
import os
import statistics
import sys
import time
from typing import Callable, Dict, List

import brain
import fitness
import sim
import train_ppo

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

EVAL_SEEDS = list(range(200))
HERE = os.path.dirname(os.path.abspath(__file__))


# ---------------------------------------------------------------------------
# Candidate policies
# ---------------------------------------------------------------------------

def tiny_policy_factory(tiny: brain.TinyBrain) -> Callable:
    def policy(o, env):
        st = {"p": [env.px, env.py, env.php / sim.PLAYER_HP],
              "e": [["a", env.ex, env.ey, env.ehp / sim.ENEMY_HP]], "proj": env.proj}
        return brain.CLASSES.index(tiny.decide(st, "a", noise=0.0)[0])
    return policy


def ppo_policy_factory(pol) -> Callable:
    def policy(o, env):
        out = pol.forward(o)
        p = out[0]
        return max(range(len(p)), key=lambda i: p[i])
    return policy


def const_policy(i: int) -> Callable:
    return lambda o, env: i


def random_policy_factory(seed: int) -> Callable:
    import random as _r
    rng = _r.Random(seed)

    def policy(o, env):
        return rng.randrange(len(brain.CLASSES))
    return policy


# ---------------------------------------------------------------------------
# Latency
# ---------------------------------------------------------------------------

def measure_latency(fn, n: int = 20000) -> float:
    import random as _r
    rng = _r.Random(99)
    samples = []
    for _ in range(200):
        px, py = rng.uniform(0, 1000), rng.uniform(0, 700)
        samples.append([1.0, rng.uniform(0, 1), rng.uniform(0, 1), rng.uniform(0, 1),
                        rng.uniform(0, 1), rng.uniform(0, 1), rng.uniform(0, 1),
                        1.0 if rng.random() > 0.5 else -1.0])
    for s in samples[:200]:
        fn(s)
    t0 = time.perf_counter()
    for i in range(n):
        fn(samples[i % len(samples)])
    return (time.perf_counter() - t0) / n * 1e6   # microseconds


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    tiny = brain.load_brain()
    if tiny is None:
        print("run train_brain.py first")
        return

    ppo_mlp = train_ppo.MLPPolicy(0, 16)
    with open(os.path.join(HERE, "ppo_mlp.json"), "r", encoding="utf-8") as fh:
        d = json.load(fh)
    ppo_mlp.W1, ppo_mlp.b1 = d["params"][0], d["params"][1]
    ppo_mlp.W2, ppo_mlp.b2 = d["params"][2], d["params"][3]
    ppo_mlp.wv, ppo_mlp.bv = d["params"][4], d["params"][5][0]

    ppo_lin = train_ppo.LinearPolicy(0)
    with open(os.path.join(HERE, "ppo_linear.json"), "r", encoding="utf-8") as fh:
        d = json.load(fh)
    ppo_lin.W, ppo_lin.b = d["params"][0], d["params"][1]
    ppo_lin.wv, ppo_lin.bv = d["params"][2], d["params"][3][0]

    n_ppo_mlp = train_ppo.count_params(ppo_mlp.params())
    n_ppo_lin = train_ppo.count_params(ppo_lin.params())

    candidates = [
        # name, policy, bytes(f32), bytes(int8), latency_fn
        ("utility-46B (ours)", tiny_policy_factory(tiny), tiny.nbytes, tiny.nbytes,
         lambda f: tiny_policy_factory(tiny)(f, _DummyEnv())),
        ("ppo-linear", ppo_policy_factory(ppo_lin), n_ppo_lin * 4, n_ppo_lin,
         lambda f: ppo_policy_factory(ppo_lin)(f, _DummyEnv())),
        ("ppo-mlp", ppo_policy_factory(ppo_mlp), n_ppo_mlp * 4, n_ppo_mlp,
         lambda f: ppo_policy_factory(ppo_mlp)(f, _DummyEnv())),
        ("constant STRF", const_policy(1), 0, 0, None),
        ("constant ADV", const_policy(0), 0, 0, None),
        ("constant RET", const_policy(4), 0, 0, None),
        ("random", random_policy_factory(7), 0, 0, None),
    ]

    print("=" * 96)
    print("KESSLER BAKE-OFF  -  46-byte closed-form policy vs pure-python PPO")
    print(f"fitness: w_d={fitness.W_DAMAGE} w_w={fitness.W_WIN} w_s={fitness.W_SURVIVAL} "
          f"lambda={fitness.LAMBDA_VAR} floor={fitness.T_MIN_SURV}  |  {len(EVAL_SEEDS)} seeds")
    print("=" * 96)

    # specialists define the normalisers (same seeds)
    spec_runs = {k: [sim.rollout(const_policy(i), s) for s in EVAL_SEEDS]
                 for k, i in fitness.SPECIALISTS.items()}
    scorer = fitness.FitnessScorer.from_specialists(spec_runs, sim.PLAYER_HP, sim.ENEMY_HP)

    rows = []
    for name, pol, b32, b8, lat in candidates:
        runs = [sim.rollout(pol, s) for s in EVAL_SEEDS]
        sc = scorer.score(runs)
        sc["name"] = name
        sc["bytes_f32"] = b32
        sc["bytes_int8"] = b8
        if lat is not None:
            sc["latency_us"] = round(measure_latency(lat), 2)
        rows.append(sc)

    rows_sorted = sorted(rows, key=lambda r: -r["fitness"])
    hdr = (f"{'policy':18s} {'fitness':>8s} {'thrup':>6s} {'prog':>6s} {'retain':>7s} "
           f"{'var':>7s} {'win':>5s} {'dmg':>6s} {'bytes':>7s} {'us/dec':>7s}")
    print(hdr)
    print("-" * len(hdr))
    for r in rows_sorted:
        by = r["bytes_int8"] if r["bytes_int8"] else r["bytes_f32"]
        lat = f"{r['latency_us']:.2f}" if "latency_us" in r else "-"
        print(f"{r['name']:18s} {r['fitness']:+8.4f} {r['thrup']:6.2f} {r['prog']:6.2f} "
              f"{r['retain']:7.2f} {r['variance']:7.4f} {r['win_rate']:5.2f} "
              f"{r['mean_damage']:6.1f} {by:7d} {lat:>7s}")

    out = {
        "seeds": len(EVAL_SEEDS),
        "fitness_constants": {
            "w_damage": fitness.W_DAMAGE, "w_win": fitness.W_WIN,
            "w_survival": fitness.W_SURVIVAL, "lambda_var": fitness.LAMBDA_VAR,
            "survival_floor": fitness.T_MIN_SURV,
        },
        "tiny_brain": {"bytes": tiny.nbytes, "agreement": tiny.agreement,
                       "max_prob_error": tiny.max_dp},
        "ppo_mlp_params": n_ppo_mlp,
        "ppo_linear_params": n_ppo_lin,
        "results": rows,
    }
    with open(os.path.join(HERE, "bake_off.json"), "w", encoding="utf-8") as fh:
        json.dump(out, fh, indent=2)

    best = rows_sorted[0]
    ours = next(r for r in rows if r["name"].startswith("utility"))
    print("-" * len(hdr))
    print(f"\nbest: {best['name']} (fitness {best['fitness']:+.4f})")
    print(f"ours: utility-46B fitness {ours['fitness']:+.4f} at {tiny.nbytes} bytes")
    print(f"ppo-mlp params: {n_ppo_mlp} ({n_ppo_mlp * 4} B f32 / {n_ppo_mlp} B int8) "
          f"-> {n_ppo_mlp / max(tiny.nbytes, 1):.0f}x the policy we ship")
    print("\nwrote bake_off.json")
    print("=" * 96)


class _DummyEnv:
    px = py = 500.0
    ex = ey = 300.0
    php = sim.PLAYER_HP
    ehp = sim.ENEMY_HP
    proj = 2.0


if __name__ == "__main__":
    main()