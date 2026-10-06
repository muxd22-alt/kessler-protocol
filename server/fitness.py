"""Pre-registered multi-objective fitness for the bake-off.

The problem this solves: with a single scalar (raw damage, or win rate) any
comparison is a strawman. An agent that only strafes wins on damage and loses
everywhere else; an agent that only retreats wins on survival and does nothing.
So we score THREE axes and explicitly penalise one-dimensional play.

Fitness = w_d * (THRUP / THRUP_max)
        + w_w * (PROG  / PROG_max)
        + w_s * (RETAIN/ RETAIN_max)
        - lambda * Var(THRUP, PROG, RETAIN)      (population variance)

  THRUP  raw damage throughput, log-compressed: log(1 + dps) normalised by the
         damage specialist (STRF). The log curve stops dps-padding from paying
         off super-linearly.
  PROG   objective completion as a CONTINUOUS fraction of the player's hull
         removed - not a binary win flag - so incremental progress is rewarded
         even in states that end in a loss.
  RETAIN retention / resource management: fraction of the enemy's own hull left.

Each axis is normalised by the specialist constant that maximises it, so the
three specialists each score ~1.0 on one axis and less elsewhere. That makes the
variance term meaningful: a balanced agent lands near (0.8, 0.8, 0.8) and pays
almost nothing, a specialist pays a lot.

Survival floor: an agent whose mean retention falls below T_MIN_SURV is
disqualified outright - that removes "suicidal high-damage loops" no matter how
good their damage number looks.

All constants are fixed BEFORE any student is evaluated.
"""
from __future__ import annotations

import math
from typing import Dict, List, Tuple

# ---- pre-registered constants (do not tune per-candidate) ------------------
W_DAMAGE = 0.35
W_WIN = 0.40
W_SURVIVAL = 0.25
LAMBDA_VAR = 0.15
T_MIN_SURV = 0.20

# specialist constants used to derive the normalisers
SPECIALISTS = {"STRF": 1, "ADV": 0, "RET": 4}


def throughput(damage_dealt: float, steps: float) -> float:
    """Damage per second, log-compressed (log1p so padding cannot dominate)."""
    dps = damage_dealt / max(steps, 1.0) * 60.0
    return math.log1p(dps)


def completion(damage_dealt: float, player_hp: float) -> float:
    """Continuous objective progress: fraction of the player's hull removed."""
    return damage_dealt / max(player_hp, 1.0)


def retention(enemy_hp: float, enemy_max_hp: float) -> float:
    """Resource management: fraction of the enemy's own hull still intact."""
    return max(0.0, enemy_hp) / max(enemy_max_hp, 1.0)


class FitnessScorer:
    """Turns raw episode stats into the multi-objective score."""

    def __init__(self, thrup_max: float, prog_max: float, retain_max: float,
                 player_hp: float = 60.0, enemy_hp: float = 80.0):
        self.thrup_max = max(thrup_max, 1e-6)
        self.prog_max = max(prog_max, 1e-6)
        self.retain_max = max(retain_max, 1e-6)
        self.player_hp = player_hp
        self.enemy_hp = enemy_hp

    @classmethod
    def from_specialists(cls, runs: Dict[str, List[dict]],
                         player_hp: float = 60.0, enemy_hp: float = 80.0) -> "FitnessScorer":
        """Derive the normalisers from the three specialist constants."""
        best_t = max(throughput(r["damage_dealt"], r["steps"]) for r in runs["STRF"])
        best_p = max(completion(r["damage_dealt"], player_hp) for r in runs["ADV"])
        best_r = max(retention(r["ehp"], enemy_hp) for r in runs["RET"])
        return cls(best_t, best_p, best_r, player_hp, enemy_hp)

    def axes(self, runs: List[dict]) -> Tuple[float, float, float]:
        n = len(runs)
        thr = sum(throughput(r["damage_dealt"], r["steps"]) for r in runs) / n / self.thrup_max
        prg = sum(completion(r["damage_dealt"], self.player_hp) for r in runs) / n / self.prog_max
        ret = sum(retention(r["ehp"], self.enemy_hp) for r in runs) / n / self.retain_max
        return thr, prg, ret

    def score(self, runs: List[dict]) -> Dict[str, float]:
        n = len(runs)
        thr, prg, ret = self.axes(runs)
        mean = (thr + prg + ret) / 3.0
        var = ((thr - mean) ** 2 + (prg - mean) ** 2 + (ret - mean) ** 2) / 3.0
        fitness_v = W_DAMAGE * thr + W_WIN * prg + W_SURVIVAL * ret - LAMBDA_VAR * var
        mean_ret = sum(r["ehp"] for r in runs) / n / self.enemy_hp
        disqualified = mean_ret < T_MIN_SURV
        return {
            "thrup": round(thr, 4),
            "prog": round(prg, 4),
            "retain": round(ret, 4),
            "variance": round(var, 5),
            "fitness": round(-1.0 if disqualified else fitness_v, 4),
            "disqualified": disqualified,
            "win_rate": round(sum(r["won"] for r in runs) / n, 4),
            "mean_damage": round(sum(r["damage_dealt"] for r in runs) / n, 2),
            "mean_retention": round(mean_ret, 4),
        }