"""Symmetrical 3v3 squad arena for the 46B vs 1KB bake-off.

Both teams have identical physics, weapons and health. The ONLY difference is
which brain drives them:

  'kb1k'  948-byte orthogonal-context-gated policy (4 contexts x 12 tactics)
  'kb46'  46-byte flat linear policy (1 context, 5 intents, no gate, no memory)
  'const' a single fixed tactic (upper-bound reference for one-dimensional play)

Each unit derives its OWN pressure from local damage flow, so a pinned unit can
sit in HOLD while an unpressured ally sits in FLANK. The 'pin and flank'
manoeuvre is never coded — it falls out of the per-unit gate plus the squad-wide
archetype priors.
"""
from __future__ import annotations

import math
import random
from typing import Any, Dict, List, Optional, Tuple

import kb1k as K

W, H = 1000.0, 700.0
DT = 1.0 / 30.0
SUBSTEPS = 3
MAX_STEPS = 420

UNIT_HP = 100.0
BULLET_SPEED = 380.0
HIT_DMG = 8.0
HIT_R = 20.0
FIRE_CD = 0.55
SPEED = {"adv": 150.0, "strf": 118.0, "flk_l": 132.0, "flk_r": 132.0, "ret": 165.0}

CTX_FROM_46B = K.CTX_ADVANCE   # a flat linear policy has no context axis


class Unit:
    __slots__ = ("team", "role", "x", "y", "vx", "vy", "hp", "tactic", "commit",
                 "ctx", "timer", "pressure", "dmg_in", "dmg_out", "fire", "kills", "shots")

    def __init__(self, team: int, role: int, x: float, y: float):
        self.team = team
        self.role = role
        self.x, self.y = x, y
        self.vx = self.vy = 0.0
        self.hp = UNIT_HP
        self.tactic = 0
        self.commit = 0.0
        self.ctx = K.CTX_ADVANCE
        self.timer = 0.0
        self.pressure = 0.0
        self.dmg_in = 0.0
        self.dmg_out = 0.0
        self.fire = 0.0
        self.kills = 0
        self.shots = 0


class SquadArena:
    def __init__(self, seed: int = 0, brains: Tuple[str, str] = ("kb1k", "kb46")):
        self.rng = random.Random(seed)
        self.brains = brains
        self.kb = K.KB1K.load()
        self.b46 = None
        try:
            import brain as b46mod
            self.b46 = b46mod.load_brain()
        except Exception:
            self.b46 = None
        self.gates = self.kb.gate_values() if self.kb else K.default_thresholds()
        self.reset()

    # -- lifecycle ---------------------------------------------------------
    def reset(self) -> None:
        r = self.rng
        self.units: List[Unit] = []
        roles = [0, 1, 2, 3]
        for i in range(3):
            self.units.append(Unit(0, roles[i % 4], 180.0 + i * 40.0, 250.0 + (i % 2) * 60.0))
            self.units.append(Unit(1, roles[(i + 1) % 4], 820.0 - i * 40.0, 450.0 - (i % 2) * 60.0))
        self.bullets: List[List[float]] = []
        self.t = 0
        self.step_i = 0
        self.over = False
        self.winner = -1
        self.ctx_counts = [0, 0, 0, 0]
        self.tactic_counts = [0] * K.NACT
        self._rand = random.Random(r.randrange(1 << 30))

    def team(self, t: int) -> List[Unit]:
        return [u for u in self.units if u.team == t]

    # -- observation -------------------------------------------------------
    def _nearest_enemy(self, u: Unit) -> Optional[Unit]:
        best, bd = None, 1e18
        for o in self.units:
            if o.team == u.team:
                continue
            d = (o.x - u.x) ** 2 + (o.y - u.y) ** 2
            if d < bd:
                bd, best = d, o
        return best

    def _ally_support(self, u: Unit) -> float:
        for a in self.units:
            if a.team == u.team and a is not u:
                d = math.hypot(a.x - u.x, a.y - u.y)
                if d < 240:
                    return 1.0 - d / 240.0
        return 0.0

    def _incoming(self, u: Unit) -> float:
        n = 0
        for b in self.bullets:
            if b[4] == u.team:           # bullet heading at us
                dx, dy = u.x - b[0], u.y - b[1]
                dd = math.hypot(dx, dy)
                if dd < 260:
                    sp = max(math.hypot(b[2], b[3]), 1e-6)
                    dot = (dx * b[2] + dy * b[3]) / max(dd, 1e-6) / sp
                    if dot > 0.85:
                        n += 1
        return min(n / 3.0, 1.0)

    def _danger(self, u: Unit) -> float:
        n = 0
        for o in self.units:
            if o.team != u.team and math.hypot(o.x - u.x, o.y - u.y) < 340:
                n += 1
        return min(n / 3.0, 1.0)

    def _basis(self, u: Unit) -> List[float]:
        tgt = self._nearest_enemy(u)
        d = math.hypot(tgt.x - u.x, tgt.y - u.y) if tgt else 600.0
        hp_t = (tgt.hp / UNIT_HP) if tgt else 1.0
        side = 1.0 if (tgt and tgt.x > u.x) else -1.0
        edge = min(u.x, u.y, W - u.x, H - u.y) / 120.0
        return K.basis(
            d_self=d, hp_self=u.hp / UNIT_HP, d_target=d, hp_target=hp_t, side=side,
            danger=self._danger(u), incoming=self._incoming(u),
            ally_support=self._ally_support(u),
            band=max(0.0, 1.0 - abs(d - 300.0) / 300.0),
            last_off=1.0 if (0 <= u.tactic < 7) else 0.0,
            commit=u.commit, edge=max(0.0, edge),
        )

    def _pressure(self, u: Unit) -> float:
        """Local tactical pressure, roughly [-1, +1].

        Positive = "I am being hurt right now"      -> HOLD / RETREAT
        Negative = "I have an opening" (target weak) -> FLANK
        ~zero    = "healthy, in contact"             -> ADVANCE

        Deliberately NOT a raw damage difference: a unit that merely dealt damage
        is trading, not winning. And ally proximity is NOT an opening (it belongs
        in the basis, informing tactics within a context) - otherwise every unit
        spawns adjacent and the gate parks in FLANK forever. Keying on recent
        damage RECEIVED minus target weakness is what makes all four partitions
        reachable.
        """
        tgt = self._nearest_enemy(u)
        pweak = (1.0 - tgt.hp / UNIT_HP) if tgt else 0.0
        taken = min(u.dmg_in / 100.0, 1.0)
        return max(-1.0, min(1.0, taken - pweak))

    # -- one decision ------------------------------------------------------
    def _decide(self, u: Unit) -> int:
        brain = self.brains[u.team]
        x = self._basis(u)
        if brain == "kb1k" and self.kb is not None:
            u.ctx, u.timer = K.determine_context(self._pressure(u), u.ctx, u.timer, DT, self.gates)
            idx, _, _ = self.kb.decide(x, u.ctx, u.role)
            return idx
        if brain == "kb1k_teacher" and self.kb is not None:
            # Unquantised reference so the bake-off can price int8 quantisation.
            # Must include the SAME archetype prior and temperature as the
            # shipped path, otherwise this row measures the wrong thing.
            u.ctx, u.timer = K.determine_context(self._pressure(u), u.ctx, u.timer, DT, self.gates)
            o = K.UnitObs(list(x), u.role, u.ctx)
            tl = K.teacher_logits(o)
            ab = K.archetype_bias(u.role)
            ps = K.softmax([tl[i] + ab[i] for i in range(K.NACT)], K.DECISION_TEMP)
            return max(range(K.NACT), key=lambda i: ps[i])
        if brain == "kb46" and self.b46 is not None:
            # Flat 5-intent brain: no context axis, no archetypes, no memory.
            # Feed it the same world through its own 8-feature basis and map
            # its chosen intent onto the nearest equivalent tactic.
            import brain as b46mod
            x = self._basis(u)
            tgt = self._nearest_enemy(u)
            f8 = b46mod.features_raw(
                u.x, u.y, u.hp / UNIT_HP,
                tgt.x if tgt else u.x, tgt.y if tgt else u.y - 300,
                (tgt.hp / UNIT_HP) if tgt else 1.0,
                self._danger(u) * 14.0)
            w = self.b46._w()
            logits = [sum(w[i][c] * f8[c] for c in range(b46mod.NFEAT))
                      for i in range(len(self.b46.classes))]
            idx = max(range(len(logits)), key=lambda i: logits[i])
            return {"adv": 0, "strf": 1, "flk_l": 2, "flk_r": 3, "ret": 11}[self.b46.classes[idx]]
        if isinstance(brain, int):
            return brain
        return self._rand.randrange(K.NACT)

    # -- simulation --------------------------------------------------------
    def step(self) -> None:
        for _ in range(SUBSTEPS):
            self.t += DT
            for u in self.units:
                if u.hp <= 0:
                    continue
                # recency memory: pressure reflects RECENT damage, so a unit that
                # breaks contact recovers instead of staying pinned forever
                u.dmg_in *= 0.995
                u.dmg_out *= 0.995
                idx = self._decide(u)
                name, intent, fires = K.TACTICS[idx]
                u.tactic = idx
                u.commit += 1.0
                self.ctx_counts[u.ctx] += 1
                self.tactic_counts[idx] += 1
                self._move(u, intent)
                u.fire -= DT
                if fires and u.fire <= 0:
                    tgt = self._nearest_enemy(u)
                    if tgt:
                        u.fire = FIRE_CD
                        u.shots += 1
                        dx, dy = tgt.x - u.x, tgt.y - u.y
                        dd = math.hypot(dx, dy) or 1.0
                        tof = dd / BULLET_SPEED
                        ax, ay = tgt.x + tgt.vx * tof, tgt.y + tgt.vy * tof
                        bdx, bdy = ax - u.x, ay - u.y
                        bd = math.hypot(bdx, bdy) or 1.0
                        j = self._rand.uniform(-0.05, 0.05)
                        self.bullets.append([u.x, u.y,
                                             bdx / bd * BULLET_SPEED + j * BULLET_SPEED,
                                             bdy / bd * BULLET_SPEED - j * BULLET_SPEED,
                                             u.team])
            self._bullets()
            if self._check_end():
                break
        self.step_i += 1
        if not self.over and self.step_i >= MAX_STEPS:
            self.over = True
            self.winner = -1

    def _move(self, u: Unit, intent: str) -> None:
        sp = SPEED[intent]
        tgt = self._nearest_enemy(u)
        if tgt is None:
            u.vx *= 0.9; u.vy *= 0.9
            return
        dx, dy = tgt.x - u.x, tgt.y - u.y
        d = math.hypot(dx, dy) or 1.0
        nx, ny = dx / d, dy / d
        if intent == "adv":
            tx, ty = nx * sp, ny * sp
        elif intent == "strf":
            s = 1.0 if u.x < tgt.x else -1.0
            tx, ty = -ny * sp * s + nx * sp * 0.3, nx * sp * s + ny * sp * 0.3
        elif intent == "flk_l":
            tx, ty = -ny * sp - nx * sp * 0.25, nx * sp - ny * sp * 0.25
        elif intent == "flk_r":
            tx, ty = ny * sp - nx * sp * 0.25, -nx * sp - ny * sp * 0.25
        else:
            tx, ty = -nx * sp * 1.05, -ny * sp * 1.05
        k = 0.26
        u.vx += (tx - u.vx) * k
        u.vy += (ty - u.vy) * k
        u.x = min(W - 24.0, max(24.0, u.x + u.vx * DT))
        u.y = min(H - 24.0, max(24.0, u.y + u.vy * DT))

    def _bullets(self) -> None:
        alive = []
        for b in self.bullets:
            b[0] += b[2] * DT
            b[1] += b[3] * DT
            hit = False
            for u in self.units:
                if u.hp <= 0 or u.team == b[4]:
                    continue
                if math.hypot(b[0] - u.x, b[1] - u.y) < HIT_R:
                    u.hp -= HIT_DMG
                    shooter_side = 1 - u.team
                    for s in self.units:
                        if s.team == shooter_side:
                            s.dmg_out += HIT_DMG
                            if u.hp <= 0:
                                s.kills += 1
                    u.dmg_in += HIT_DMG
                    hit = True
                    break
            if not hit and -60 < b[0] < W + 60 and -60 < b[1] < H + 60:
                alive.append(b)
        self.bullets = alive

    def _check_end(self) -> bool:
        a = [u.hp for u in self.units if u.team == 0 and u.hp > 0]
        b = [u.hp for u in self.units if u.team == 1 and u.hp > 0]
        if not a or not b:
            self.over = True
            hp_a = sum(a) if a else 0.0
            hp_b = sum(b) if b else 0.0
            self.winner = 0 if hp_a > hp_b else 1
            return True
        return False

    def result(self) -> Dict[str, float]:
        """Team-0 perspective, shaped for the pre-registered fitness."""
        mine = [u for u in self.units if u.team == 0]
        hp_left = sum(max(0.0, u.hp) for u in mine)
        dealt = sum(u.dmg_out for u in mine)
        killed = sum(1 for o in self.units if o.team == 1 and o.hp <= 0)
        enemies = sum(1 for o in self.units if o.team == 1)
        won = 1.0 if self.winner == 0 else 0.0
        return {
            "won": won,
            "damage_dealt": dealt,
            "damage_taken": 300.0 - hp_left,
            "steps": float(self.step_i),
            "ehp": hp_left,
            "kills": float(killed),
            "enemies": float(enemies),
            "ctx_mix": self.ctx_counts[:],
            "tactic_mix": self.tactic_counts[:],
        }


def rollout(brains: Tuple[Any, Any], seed: int) -> Dict[str, float]:
    env = SquadArena(seed, brains)
    while not env.over:
        env.step()
    return env.result()
