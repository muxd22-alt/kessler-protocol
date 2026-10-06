"""Headless arena that mirrors the shipped game's enemy dynamics.

Used by the PPO bake-off so every brain is measured in the *same* world with
the *same* scripted player. Deterministic per seed for fair comparison.

Steering constants are copied from client/src/scenes/GameScene.ts.
"""
from __future__ import annotations

import math
import random
from typing import Any, Dict, List, Optional, Tuple

W, H = 1000.0, 700.0
DT = 1.0 / 30.0
SUBSTEPS = 4                      # micro-steps per decision
DECISION_EVERY = 5                # ~150 ms cadence like the real game
MAX_STEPS = 300   # frozen: part of the arena definition, set BEFORE teacher tuning

SPEED = {"adv": 150.0, "strf": 118.0, "flk_l": 132.0, "flk_r": 132.0, "ret": 165.0}
ACTIONS = ["adv", "strf", "flk_l", "flk_r", "ret"]

PLAYER_HP = 60.0
ENEMY_HP = 80.0
BULLET_SPEED = 400.0
# The enemy must be able to WIN a straight fight, otherwise "retreat and camp"
# dominates every objective and the multi-objective fitness measures nothing.
# Firing is balanced so that closing in is rewarded, but only while dodging.
ENEMY_BULLET_DAMAGE = 14.0
PLAYER_BULLET_DAMAGE = 6.0


class Arena:
    """One enemy vs one scripted player."""

    __slots__ = ("rng", "px", "py", "php", "pvx", "pvy", "ex", "ey", "evx", "evy", "ehp",
                 "t", "step_i", "bullets", "e_fire", "p_fire", "over", "won",
                 "damage_dealt", "damage_taken", "proj", "e_seed")

    def __init__(self, seed: int = 0):
        self.rng = random.Random(seed)
        self.e_seed = seed
        self.reset()

    # -- lifecycle ----------------------------------------------------------
    def reset(self) -> None:
        self.px = self.rng.uniform(300.0, 700.0)
        self.py = self.rng.uniform(420.0, 640.0)
        self.php = PLAYER_HP
        self.pvx = self.pvy = 0.0
        self.ex = self.rng.uniform(120.0, 880.0)
        self.ey = -40.0
        self.evx = self.evy = 0.0
        self.ehp = ENEMY_HP
        self.t = 0
        self.step_i = 0
        self.bullets: List[List[float]] = []
        self.e_fire = 0
        self.p_fire = 0
        self.over = False
        self.won = False
        self.damage_dealt = 0.0
        self.damage_taken = 0.0
        self.proj = 0.0

    # -- observation --------------------------------------------------------
    def observe(self) -> List[float]:
        from brain import features_raw
        return features_raw(self.px, self.py, self.php / PLAYER_HP,
                           self.ex, self.ey, self.ehp / ENEMY_HP, self.proj)

    def state_dict(self) -> Dict[str, Any]:
        return {
            "p": [round(self.px, 1), round(self.py, 1), round(self.php / PLAYER_HP, 3)],
            "e": [["a", round(self.ex, 1), round(self.ey, 1), round(self.ehp / ENEMY_HP, 3)]],
            "proj": round(self.proj, 2),
        }

    # -- dynamics -----------------------------------------------------------
    def step(self, action: int) -> Tuple[List[float], float, bool, Dict[str, float]]:
        intent = ACTIONS[action]
        speed = SPEED[intent]
        reward = 0.0
        prev_dealt = self.damage_dealt
        prev_taken = self.damage_taken

        for _ in range(SUBSTEPS):
            self.t += DT
            self._steer(intent, speed)
            self._player_script()
            self._bullets()
            self.proj = float(len(self.bullets))
            if self.over:
                break

        dist = math.hypot(self.px - self.ex, self.py - self.ey)
        # Reward is a dense surrogate of the three evaluation axes (fitness.py):
        #   completion -> damage dealt (dominant; killing must pay)
        #   retention  -> damage taken (punished, but no per-step "time alive"
        #                 bonus, which would reward camping instead of skill)
        #   engagement -> hold a firing range instead of drifting away
        reward += (self.damage_dealt - prev_dealt)
        reward -= 0.5 * (self.damage_taken - prev_taken)
        band = 1.0 - min(abs(dist - 300.0) / 300.0, 1.0)
        reward += 0.10 * band

        self.step_i += 1
        if self.php <= 0.0:
            self.over = True
            self.won = True
            reward += 4.0
        elif self.ehp <= 0.0 or self.step_i >= MAX_STEPS:
            self.over = True
            reward += (2.0 if self.ehp <= 0.0 else -1.0)
        return self.observe(), reward, self.over, self.info()

    def info(self) -> Dict[str, float]:
        return {
            "won": 1.0 if self.won else 0.0,
            "damage_dealt": self.damage_dealt,
            "damage_taken": self.damage_taken,
            "steps": float(self.step_i),
            "php": self.php,
            "ehp": self.ehp,
        }

    # -- pieces -------------------------------------------------------------
    def _steer(self, intent: str, speed: float) -> None:
        dx, dy = self.px - self.ex, self.py - self.ey
        d = math.hypot(dx, dy) or 1.0
        nx, ny = dx / d, dy / d
        if intent == "adv":
            tx, ty = nx * speed, ny * speed
        elif intent == "strf":
            side = 1.0 if self.ex < self.px else -1.0
            tx, ty = -ny * speed * side + nx * speed * 0.3, nx * speed * side + ny * speed * 0.3
        elif intent == "flk_l":
            tx, ty = -ny * speed - nx * speed * 0.25, nx * speed - ny * speed * 0.25
        elif intent == "flk_r":
            tx, ty = ny * speed - nx * speed * 0.25, -nx * speed - ny * speed * 0.25
        else:  # ret - matches GameScene: back off vertically, damp lateral
            tx, ty = 0.0, -speed * 1.1
            self.evx *= 0.94
        k = 0.28
        self.evx += (tx - self.evx) * k
        self.evy += (ty - self.evy) * k
        self.ex = min(W - 20.0, max(20.0, self.ex + self.evx * DT))
        self.ey = min(H - 20.0, max(-60.0, self.ey + self.evy * DT))

        # enemy fires with lead, so lateral movement genuinely dodges
        dist = math.hypot(self.px - self.ex, self.py - self.ey)
        self.e_fire -= DT
        if self.e_fire <= 0.0 and dist < 460.0:
            self.e_fire = 0.30 + 0.55 * (dist / 460.0)
            sp = BULLET_SPEED
            tof = dist / sp
            ax, ay = self.px + self.pvx * tof, self.py + self.pvy * tof
            adx, ady = ax - self.ex, ay - self.ey
            ad = math.hypot(adx, ady) or 1.0
            self.bullets.append([self.ex, self.ey, adx / ad * sp, ady / ad * sp, 0.0])

    def _player_script(self) -> None:
        """Deterministic dodging player, identical for every brain."""
        dx, dy = self.ex - self.px, self.ey - self.py
        d = math.hypot(dx, dy) or 1.0
        nx, ny = dx / d, dy / d
        side = 1.0 if (self.step_i % 40) < 20 else -1.0
        sp = 170.0
        tx = -nx * sp + -ny * sp * 0.6 * side
        ty = -ny * sp + nx * sp * 0.6 * side
        k = 0.3
        nx_px = min(W - 20.0, max(20.0, self.px + tx * DT))
        ny_py = min(H - 20.0, max(60.0, self.py + ty * DT))
        self.pvx = (nx_px - self.px) / DT
        self.pvy = (ny_py - self.py) / DT
        self.px, self.py = nx_px, ny_py

        self.p_fire -= DT
        if self.p_fire <= 0.0:
            self.p_fire = 0.55
            sp = BULLET_SPEED * 1.2
            dist = math.hypot(self.ex - self.px, self.ey - self.py)
            tof = dist / sp
            ax, ay = self.ex + self.evx * tof, self.ey + self.evy * tof
            ex_, ey_ = ax - self.px, ay - self.py
            ed = math.hypot(ex_, ey_) or 1.0
            # player aim carries a little jitter so fights aren't degenerate
            j = self.rng.uniform(-0.04, 0.04)
            self.bullets.append([self.px, self.py,
                                 (ex_ / ed) * sp + j * sp, (ey_ / ed) * sp - j * sp, 1.0])

    def _bullets(self) -> None:
        alive: List[List[float]] = []
        for b in self.bullets:
            b[0] += b[2] * DT
            b[1] += b[3] * DT
            if b[4] > 0.5:      # player bullet -> enemy
                if math.hypot(b[0] - self.ex, b[1] - self.ey) < 26.0:
                    self.ehp -= PLAYER_BULLET_DAMAGE
                    self.damage_taken += PLAYER_BULLET_DAMAGE
                    continue
            else:               # enemy bullet -> player
                if math.hypot(b[0] - self.px, b[1] - self.py) < 24.0:
                    self.php -= ENEMY_BULLET_DAMAGE
                    self.damage_dealt += ENEMY_BULLET_DAMAGE
                    continue
            if -60 < b[0] < W + 60 and -60 < b[1] < H + 60:
                alive.append(b)
        self.bullets = alive


def rollout(policy_fn, seed: int, steps: int = MAX_STEPS) -> Dict[str, float]:
    """Run one episode with a policy_fn(obs, env) -> action."""
    env = Arena(seed)
    total = 0.0
    for _ in range(steps):
        if env.over:
            break
        a = policy_fn(env.observe(), env)
        _, r, done, _info = env.step(a)
        total += r
        if done:
            break
    info = env.info()
    info["return"] = total
    return info