"""Pure-Python PPO vs the 46-byte closed-form policy. No numpy, no torch.

Trains two policies on exactly the same observation (the 8 features the
shipped brain uses) and the same reward, in the same headless arena:

  · ppo-linear : 8 -> 5 policy, linear critic        (54 params)
  · ppo-mlp    : 8 -> 16 tanh -> 5, linear-on-trunk critic (246 params)

Then bake_off.py measures them against the 46-byte policy and the constant
baselines on identical seeds, and reports size / speed / win rate / return.

Run:  python train_ppo.py            (a few minutes, pure stdlib)
"""
from __future__ import annotations

import json
import math
import os
import random
import sys
import time
from typing import Any, Dict, List, Tuple

import sim
from brain import CLASSES, NFEAT

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

# PPO hyper-parameters
N_ENVS = 8
T = 48
UPDATES = 2000
GAMMA = 0.95
LAM = 0.95
CLIP = 0.2
LR = 3e-3
EPOCHS = 3
MINIBATCH = 64
ENT_COEF = 0.01
VF_COEF = 0.5
A = len(CLASSES)
D = NFEAT


# ---------------------------------------------------------------------------
# Policies
# ---------------------------------------------------------------------------

def _softmax(z: List[float]) -> List[float]:
    m = max(z)
    e = [math.exp(v - m) for v in z]
    s = sum(e)
    return [v / s for v in e]


class LinearPolicy:
    """pi = W f + b ;  V = wv . f + bv   (tiny, 54 params)"""
    name = "ppo-linear"
    hidden = 0

    def __init__(self, seed: int):
        rng = random.Random(seed)
        self.W = [[rng.uniform(-0.3, 0.3) for _ in range(D)] for _ in range(A)]
        self.b = [0.0] * A
        self.wv = [rng.uniform(-0.1, 0.1) for _ in range(D)]
        self.bv = 0.0

    def params(self) -> List[List[float]]:
        return [self.W, self.b, self.wv, [self.bv]]

    def forward(self, f: List[float]) -> Tuple[List[float], float]:
        logits = [sum(self.W[i][c] * f[c] for c in range(D)) + self.b[i] for i in range(A)]
        v = sum(self.wv[c] * f[c] for c in range(D)) + self.bv
        return _softmax(logits), v

    def backward(self, f, dlogits, dv, grads):
        gW, gb, gwv, gbv = grads
        for i in range(A):
            gb[i] += dlogits[i]
            gi = dlogits[i]
            if gi:
                row = self.W[i]
                grow = gW[i]
                for c in range(D):
                    grow[c] += gi * f[c]
        for c in range(D):
            gwv[c] += dv * f[c]
        gbv[0] += dv


class MLPPolicy:
    """pi = softmax(W2 tanh(W1 f + b1) + b2) ;  V = wv . h + bv"""
    name = "ppo-mlp"

    def __init__(self, seed: int, hidden: int = 16):
        self.H = hidden
        rng = random.Random(seed)
        s1 = math.sqrt(1.0 / D)
        s2 = math.sqrt(1.0 / hidden)
        self.W1 = [[rng.uniform(-s1, s1) for _ in range(D)] for _ in range(hidden)]
        self.b1 = [0.0] * hidden
        self.W2 = [[rng.uniform(-s2, s2) for _ in range(hidden)] for _ in range(A)]
        self.b2 = [0.0] * A
        self.wv = [rng.uniform(-s2, s2) for _ in range(hidden)]
        self.bv = 0.0

    def params(self) -> List[List[float]]:
        return [self.W1, self.b1, self.W2, self.b2, self.wv, [self.bv]]

    def forward(self, f):
        h = []
        for j in range(self.H):
            s = self.b1[j]
            row = self.W1[j]
            for c in range(D):
                s += row[c] * f[c]
            h.append(math.tanh(s))
        logits = []
        for i in range(A):
            s = self.b2[i]
            row = self.W2[i]
            for j in range(self.H):
                s += row[j] * h[j]
            logits.append(s)
        v = self.bv
        for j in range(self.H):
            v += self.wv[j] * h[j]
        return _softmax(logits), v, h

    def backward(self, f, dlogits, dv, grads, h=None):
        gW1, gb1, gW2, gb2, gwv, gbv = grads
        dh = [0.0] * self.H
        for i in range(A):
            gb2[i] += dlogits[i]
            gi = dlogits[i]
            if gi:
                row, grow = self.W2[i], gW2[i]
                for j in range(self.H):
                    grow[j] += gi * h[j]
                    dh[j] += gi * row[j]
        gbv[0] += dv          # bias is added ONCE, not per hidden unit
        for j in range(self.H):
            gwv[j] += dv * h[j]
            g = dh[j] * (1.0 - h[j] * h[j])
            gb1[j] += g
            row, grow = self.W1[j], gW1[j]
            if g:
                for c in range(D):
                    grow[c] += g * f[c]


def zeros_like(x):
    if isinstance(x, list):
        return [zeros_like(i) for i in x]
    return 0.0


def iter_idx(x, prefix=()):
    """Yield index paths of every float leaf (handles nested lists)."""
    if isinstance(x, list):
        for i, v in enumerate(x):
            yield from iter_idx(v, prefix + (i,))
    else:
        yield prefix


def get_leaf(x, path):
    for i in path:
        x = x[i]
    return x


def set_leaf(x, path, val):
    for i in path[:-1]:
        x = x[i]
    x[path[-1]] = val


def count_params(params) -> int:
    return sum(1 for _ in iter_idx(params))


class Adam:
    """Adam over an arbitrarily nested parameter structure."""

    def __init__(self, params, lr: float):
        self.params = params
        self.lr = lr
        self.m = zeros_like(params)
        self.v = zeros_like(params)
        self.t = 0
        self.b1, self.b2, self.eps = 0.9, 0.999, 1e-8

    def step(self, grads, clip: float = 0.5):
        # global grad-norm clipping keeps PPO stable without extra tuning
        gn = math.sqrt(sum(get_leaf(grads, p) ** 2 for p in iter_idx(grads)))
        scale = 1.0 if gn <= clip else clip / (gn + 1e-8)
        self.t += 1
        bc1 = 1 - self.b1 ** self.t
        bc2 = 1 - self.b2 ** self.t
        for path in iter_idx(self.params):
            g = get_leaf(grads, path) * scale
            m = self.b1 * get_leaf(self.m, path) + (1 - self.b1) * g
            v = self.b2 * get_leaf(self.v, path) + (1 - self.b2) * g * g
            set_leaf(self.m, path, m)
            set_leaf(self.v, path, v)
            set_leaf(self.params, path,
                     get_leaf(self.params, path) - self.lr * (m / bc1) / (math.sqrt(v / bc2) + self.eps))


# ---------------------------------------------------------------------------
# PPO
# ---------------------------------------------------------------------------

def minibatches(n: int, rng) -> List[List[int]]:
    idx = list(range(n))
    rng.shuffle(idx)
    return [idx[s:s + MINIBATCH] for s in range(0, n, MINIBATCH)]


def train(policy, seed: int = 0, verbose: bool = True) -> Dict[str, Any]:
    rng = random.Random(seed + 7)
    params = policy.params()
    opt = Adam(params, LR)
    envs = [sim.Arena(rng.randrange(1 << 30)) for _ in range(N_ENVS)]
    obs = [e.observe() for e in envs]
    cur_ret = [0.0] * N_ENVS
    ep_returns = []
    curve = []

    for upd in range(1, UPDATES + 1):
        # Keep per-env time axes separate: [t][env]. Flattening across envs
        # would make GAE treat unrelated trajectories as one rollout.
        o_buf = [[None] * N_ENVS for _ in range(T)]
        a_buf = [[0] * N_ENVS for _ in range(T)]
        lp_buf = [[0.0] * N_ENVS for _ in range(T)]
        r_buf = [[0.0] * N_ENVS for _ in range(T)]
        d_buf = [[0.0] * N_ENVS for _ in range(T)]
        v_buf = [[0.0] * N_ENVS for _ in range(T + 1)]

        for t in range(T):
            for i, env in enumerate(envs):
                if env.over:
                    obs[i] = env.observe()
                p, v = policy.forward(obs[i])[:2]
                a = rng.choices(range(A), weights=p, k=1)[0]
                o_buf[t][i] = obs[i]
                a_buf[t][i] = a
                lp_buf[t][i] = math.log(max(p[a], 1e-9))
                v_buf[t][i] = v
                o, r, done, _ = env.step(a)
                obs[i] = o
                r_buf[t][i] = r
                # terminal flag belongs to the transition we just took
                d_buf[t][i] = 1.0 if done else 0.0
                cur_ret[i] += r
                if done:
                    ep_returns.append(cur_ret[i])
                    cur_ret[i] = 0.0
                    env.reset()
                    obs[i] = env.observe()
        # bootstrap values for the final observation of each env
        for i, env in enumerate(envs):
            v_buf[T][i] = policy.forward(obs[i])[1]

        # GAE(lambda), per env
        adv = [[0.0] * N_ENVS for _ in range(T)]
        last = [0.0] * N_ENVS
        for t in reversed(range(T)):
            for i in range(N_ENVS):
                next_nonterm = 0.0 if (t + 1 == T or d_buf[t + 1][i] > 0.5) else 1.0
                delta = r_buf[t][i] + GAMMA * v_buf[t + 1][i] * next_nonterm - v_buf[t][i]
                last[i] = delta + GAMMA * LAM * next_nonterm * last[i]
                adv[t][i] = last[i]
                if d_buf[t][i] > 0.5:
                    last[i] = 0.0

        flat_o = [o_buf[t][i] for t in range(T) for i in range(N_ENVS)]
        flat_a = [a_buf[t][i] for t in range(T) for i in range(N_ENVS)]
        flat_lp = [lp_buf[t][i] for t in range(T) for i in range(N_ENVS)]
        flat_v = [v_buf[t][i] for t in range(T) for i in range(N_ENVS)]
        flat_adv = [adv[t][i] for t in range(T) for i in range(N_ENVS)]
        flat_ret = [flat_adv[k] + flat_v[k] for k in range(len(flat_adv))]

        mu = sum(flat_adv) / len(flat_adv)
        sd = math.sqrt(sum((a - mu) ** 2 for a in flat_adv) / len(flat_adv)) + 1e-8
        flat_adv = [(a - mu) / sd for a in flat_adv]

        # policy update
        for _ in range(EPOCHS):
            grads = zeros_like(params)
            for s in minibatches(len(flat_o), rng):
                for i in s:
                    out = policy.forward(flat_o[i])
                    p, v = out[0], out[1]
                    h = out[2] if len(out) > 2 else None
                    A_i = flat_adv[i]
                    a_i = flat_a[i]
                    pa = max(p[a_i], 1e-9)
                    ratio = pa / math.exp(flat_lp[i])
                    # d/dz of -ratio*A  =  ratio*A*(p_k - delta_ak)
                    if (ratio > 1 + CLIP and A_i > 0) or (ratio < 1 - CLIP and A_i < 0):
                        dlog = [0.0] * A          # clipped: no policy gradient
                    else:
                        dlog = [ratio * A_i * (p[k] - (1.0 if k == a_i else 0.0))
                                for k in range(A)]
                    # entropy bonus is never clipped
                    ent = -sum(pk * math.log(max(pk, 1e-9)) for pk in p)
                    for k in range(A):
                        dlog[k] += ENT_COEF * p[k] * (math.log(max(p[k], 1e-9)) + ent)
                    dv = VF_COEF * 2.0 * (v - flat_ret[i])
                    if h is None:
                        policy.backward(flat_o[i], dlog, dv, grads)
                    else:
                        policy.backward(flat_o[i], dlog, dv, grads, h)
            opt.step(grads)

        recent = ep_returns[-40:]
        curve.append(sum(recent) / len(recent) if recent else 0.0)
        if verbose and (upd % 100 == 0 or upd == 1):
            mr = sum(recent) / len(recent) if recent else 0.0
            print(f"  update {upd:3d}/{UPDATES}  episodes={len(ep_returns):4d}  "
                  f"mean return(last 40) = {mr:8.2f}")
    return {"curve": [round(c, 2) for c in curve], "episodes": len(ep_returns)}


# ---------------------------------------------------------------------------
# Export
# ---------------------------------------------------------------------------

def export(policy, path_json: str, path_ts: str, meta: Dict[str, Any]) -> None:
    p = policy.params()
    with open(path_json, "w", encoding="utf-8") as fh:
        json.dump({"kind": policy.name, "params": p, "meta": meta}, fh, indent=2)

    def arr(rows):
        return "[" + ",".join("[" + ",".join(f"{v:.6f}" for v in r) + "]" for r in rows) + "]"

    if isinstance(policy, MLPPolicy):
        body = (f"export const PPO_HIDDEN = {policy.H};\n"
                f"export const PPO_W1 = {arr(policy.W1)};\n"
                f"export const PPO_B1 = {arr([policy.b1])}[0];\n"
                f"export const PPO_W2 = {arr(policy.W2)};\n"
                f"export const PPO_B2 = {arr([policy.b2])}[0];\n"
                f"export const PPO_WV = {arr([policy.wv])}[0];\n"
                f"export const PPO_BV = {policy.bv:.6f};\n")
    else:
        body = (f"export const PPO_HIDDEN = 0;\n"
                f"export const PPO_W1 = [];\n"
                f"export const PPO_B1 = [];\n"
                f"export const PPO_W2 = {arr(policy.W2 if hasattr(policy, 'W2') else policy.W)};\n"
                f"export const PPO_B2 = {arr([policy.b2 if hasattr(policy, 'b2') else policy.b])}[0];\n"
                f"export const PPO_WV = {arr([policy.wv if hasattr(policy, 'wv') else policy.wv])}[0];\n"
                f"export const PPO_BV = {policy.bv:.6f};\n")
    ts = ("// GENERATED by server/train_ppo.py - do not edit by hand.\n"
          "// Pure-Python PPO (no numpy/torch) trained in server/sim.py.\n"
          f"// {policy.name}: {meta['params']} params\n\n"
          + body
          + f"\nexport const PPO_META = {json.dumps(meta)};\n")
    with open(path_ts, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(ts)


def main() -> None:
    here = os.path.dirname(os.path.abspath(__file__))
    client_ai = os.path.join(here, "..", "client", "src", "ai")
    for name, make in (("mlp", lambda: MLPPolicy(11)),
                       ("linear", lambda: LinearPolicy(12))):
        pol = make()
        n_params = count_params(pol.params())
        print("=" * 64)
        print(f"training {pol.name}  ({n_params} params, pure python PPO)")
        print("=" * 64)
        t_start = time.perf_counter()
        stats = train(pol, seed=11 if name == "mlp" else 12)
        elapsed = time.perf_counter() - t_start
        meta = {
            "name": pol.name,
            "params": n_params,
            "features": D,
            "actions": A,
            "updates": UPDATES,
            "env_steps": N_ENVS * T * UPDATES,
            "episodes": stats["episodes"],
            "final_return": stats["curve"][-1] if stats["curve"] else 0.0,
            "curve": stats["curve"],
            "train_seconds": round(elapsed, 1),
        }
        export(pol, os.path.join(here, f"ppo_{name}.json"),
               os.path.join(client_ai, f"ppo{name.capitalize()}Weights.ts"), meta)
        print(f"  -> {meta['params']} params, final mean return {meta['final_return']}")
        print(f"  wrote ppo_{name}.json and client/src/ai/ppo{name.capitalize()}Weights.ts")
        print()


if __name__ == "__main__":
    main()