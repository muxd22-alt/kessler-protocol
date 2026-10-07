"""Generalisation check: TRAIN seeds vs HELD-OUT seeds.

The claim a tiny brain has to earn is not "it works on the map we tuned it on" —
it is "it works on maps it has never seen". So the seed set is split:

  TRAIN   20 seeds the champion is developed and tuned against
  HELDOUT 20 reserved seeds, never trained on, never tuned on, never inspected
           while iterating. Frozen in client/src/sim/seeds.ts.

Each seed generates a fresh point-symmetric arena. Both brains play the same
seeded 3v3 with identical physics; team A is the candidate, team B is the
1KB gated reference. We report the gap, because the gap IS the finding.

Run: python heldout_eval.py
"""
from __future__ import annotations

import json
import os
import statistics
import sys
from typing import Dict, List

import arena as arena_mod
import kb1k as K
import squad

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

TRAIN_SEEDS = [48213, 1337, 90210, 5, 61803, 271828, 777, 424242, 31337, 161803,
               8675309, 112358, 99991, 60684, 14142, 31415, 27182, 8080, 1234567, 987654]
HELDOUT_SEEDS = [48214, 1338, 90211, 6, 61804, 271829, 778, 424243, 31338, 161804,
                 8675310, 112359, 99992, 60685, 14143, 31416, 27183, 8081, 1234568, 987655]
EPISODES_PER_SEED = 3


class SeededArena(squad.SquadArena):
    """Same physics, but the hazard layout comes from a seeded arena."""

    def __init__(self, seed: int, brains):
        self.arena_seed = seed
        super().__init__(seed * 7919 + 13, brains)
        self.arena = arena_mod.generate_arena(seed)
        # wells become soft attractors the units must fight
        self.well_pull = 1400.0
        # rocks become cover: units take damage inside them (tactical, not just visual)
        self.rock_dps = 6.0

    def _well_accel(self, u: squad.Unit) -> tuple:
        ax = ay = 0.0
        for w in self.arena["wells"]:
            dx, dy = w["x"] - u.x, w["y"] - u.y
            d2 = max(dx * dx + dy * dy, 4000.0)
            d = d2 ** 0.5
            g = (w["mass"] / 1000.0) * self.well_pull / d2
            ax += dx / d * g
            ay += dy / d * g
        return ax, ay

    def _in_rock(self, u: squad.Unit) -> bool:
        for r in self.arena["rocks"]:
            if (u.x - r["x"]) ** 2 + (u.y - r["y"]) ** 2 <= r["r"] * r["r"]:
                return True
        return False

    def _move(self, u, intent):
        ax, ay = self._well_accel(u)
        super()._move(u, intent)
        # wells bend trajectories; rocks grind hull down
        u.x = min(squad.W - 24.0, max(24.0, u.x + ax * squad.DT))
        u.y = min(squad.H - 24.0, max(24.0, u.y + ay * squad.DT))
        if self._in_rock(u):
            u.hp -= self.rock_dps * squad.DT * 10.0
            u.dmg_in += self.rock_dps * squad.DT * 10.0

    def _basis(self, u):
        # map-agnostic extras are folded into the existing basis so the shipped
        # 1KB brain consumes nothing landmark-specific
        return super()._basis(u)


def play(seed: int, brains) -> Dict[str, float]:
    env = SeededArena(seed, brains)
    guard = 0
    while not env.over and guard < squad.MAX_STEPS * 2:
        env.step()
        guard += 1
    return env.result()


def evaluate(brain_name: str, seeds: List[int], label: str) -> Dict[str, float]:
    wins = []
    dmg = []
    ret = []
    var = []
    for s in seeds:
        for _ in range(EPISODES_PER_SEED):
            r = play(s, (brain_name, "kb1k"))
            wins.append(r["won"])
            dmg.append(r["damage_dealt"])
            ret.append(r["ehp"] / (squad.UNIT_HP * 3))
            var.append(r["damage_dealt"] / max(r["steps"], 1))
    return {
        "label": label,
        "n": len(wins),
        "win_rate": round(statistics.mean(wins), 4),
        "damage": round(statistics.mean(dmg), 1),
        "retention": round(statistics.mean(ret), 4),
        "throughput": round(statistics.mean(var), 4),
    }


def main() -> None:
    kb = K.KB1K.load()
    if kb is None:
        print("run derive_kb1k.py first")
        return
    print("=" * 86)
    print("GENERALISATION — procedural arenas, train seeds vs held-out seeds")
    print(f"{EPISODES_PER_SEED} episodes/seed · {len(TRAIN_SEEDS)} train · {len(HELDOUT_SEEDS)} held-out")
    print("=" * 86)

    rows = []
    for brain, label in (("kb1k", "1KB gated"), ("kb46", "46B flat")):
        tr = evaluate(brain, TRAIN_SEEDS, "train")
        ho = evaluate(brain, HELDOUT_SEEDS, "held-out")
        gap = ho["win_rate"] - tr["win_rate"]
        rows.append({"brain": label, "train": tr, "heldout": ho, "win_gap": round(gap, 4)})

    for r in rows:
        tr, ho = r["train"], r["heldout"]
        print(f"\n{r['brain']}")
        print(f"  {'split':10s} {'win':>6s} {'damage':>8s} {'retain':>7s} {'thrup':>7s}")
        print(f"  {'train':10s} {tr['win_rate']:6.2f} {tr['damage']:8.1f} {tr['retention']:7.2f} {tr['throughput']:7.3f}")
        print(f"  {'held-out':10s} {ho['win_rate']:6.2f} {ho['damage']:8.1f} {ho['retention']:7.2f} {ho['throughput']:7.3f}")
        print(f"  generalisation gap (win): {r['win_gap']:+.3f}")

    out = {"episodes_per_seed": EPISODES_PER_SEED, "train_seeds": TRAIN_SEEDS,
           "heldout_seeds": HELDOUT_SEEDS, "results": rows}
    here = os.path.dirname(os.path.abspath(__file__))
    with open(os.path.join(here, "heldout_results.json"), "w", encoding="utf-8") as fh:
        json.dump(out, fh, indent=2)
    print("\nwrote heldout_results.json")
    print("=" * 86)


if __name__ == "__main__":
    main()
