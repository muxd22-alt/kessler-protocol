"""Mirror of client/src/sim/arena.ts — same seed, same arena, same hash.

The golden vectors in test/golden_arenas.json assert this build and the
TypeScript build agree hash-for-hash. If someone changes one generator and not
the other, the test fails loudly instead of the headless trainer silently
evaluating different maps than the browser plays.
"""
from __future__ import annotations

from typing import Dict, List, Optional, Sequence, Tuple

from pcg import PCG32, hash_combine, fbm2

ARENA_W = 1600
ARENA_H = 1000
CENTER_X = ARENA_W // 2
CENTER_Y = ARENA_H // 2

MUTATORS = ["DOUBLE_G", "FAST_PULSAR", "THIN_HULLS", "RICH_ASTEROIDS"]


def _gen_pairs(rng: PCG32, count: int, make, mirror) -> List:
    out: List = []
    for _ in range(count):
        a = make(rng)
        out.append(a)
        out.append(mirror(a))
    return out


def generate_arena(seed_input: int) -> Dict:
    seed = seed_input & 0xFFFFFFFF
    rng = PCG32(seed)

    wells: List[Dict[str, int]] = []
    well_pairs = rng.int(3)
    pair_wells = _gen_pairs(
        rng, well_pairs,
        lambda r: {
            "x": r.rng(260, ARENA_W - 260),
            "y": r.rng(200, ARENA_H - 200),
            "mass": r.rng(500, 2000),
            "drift": r.rng(0, 20),
            "dir": r.rng(0, 359),
        },
        lambda w: {
            "x": ARENA_W - w["x"], "y": ARENA_H - w["y"],
            "mass": w["mass"], "drift": w["drift"], "dir": (w["dir"] + 180) % 360,
        },
    )
    wells.extend(pair_wells)
    if rng.chance(35):
        wells.append({"x": CENTER_X, "y": CENTER_Y, "mass": rng.rng(700, 2600),
                      "drift": rng.rng(0, 12), "dir": 0})

    rocks: List[Dict[str, int]] = []
    field_count = rng.rng(1, 4)
    density = rng.rng(10, 60) / 100.0
    # NOTE: build each field ONCE, then mirror the finished rock list. Sampling
    # the lattice from a mirrored field centre gives different noise (and the
    # sequential radius draws differ too), which breaks symmetry.
    for _ in range(field_count):
        cx = rng.rng(200, ARENA_W - 200)
        cy = rng.rng(160, ARENA_H - 160)
        rad = rng.rng(120, 300)
        amp = rng.rng(40, 110)
        field_rocks: List[Dict[str, int]] = []
        for gx in range(14):
            for gy in range(9):
                px = cx - rad + (gx * rad * 2) / 13.0
                py = cy - rad + (gy * rad * 2) / 8.0
                n = fbm2(seed ^ 0x1B873593, gx * 0.55 + cx * 0.01, gy * 0.55 + cy * 0.01)
                dx = (px - cx) / rad
                dy = (py - cy) / rad
                fall = max(0.0, 1.0 - (dx * dx + dy * dy))
                # both factors are in [0,1], so the density knob is a clean
                # threshold on (1 - density): 0.10 -> sparse, 0.60 -> dense
                if n * fall > 1.0 - density:
                    field_rocks.append({"x": int(round(px)), "y": int(round(py)),
                                        "r": rng.rng(14, 14 + amp)})
        rocks.extend(field_rocks)
        for r in field_rocks:
            rocks.append({"x": ARENA_W - r["x"], "y": ARENA_H - r["y"], "r": r["r"]})

    pulsar: Optional[Dict[str, int]] = None
    if rng.chance(50):
        pulsar = {"x": CENTER_X, "y": CENTER_Y,
                  "period": rng.rng(70, 190), "damage": rng.rng(6, 16)}

    wormholes: List[Dict[str, int]] = []
    for _ in range(rng.int(3)):
        ax = rng.rng(240, CENTER_X - 120)
        ay = rng.rng(180, ARENA_H - 180)
        wormholes.append({"ax": ax, "ay": ay, "bx": ARENA_W - ax, "by": ARENA_H - ay})

    spawn_a: List[List[int]] = []
    spawn_b: List[List[int]] = []
    spawn_jitter = rng.rng(0, 60)
    for i in range(3):
        y = 260 + i * 240 + rng.int(spawn_jitter + 1)
        x = 150 + rng.int(spawn_jitter + 1)
        spawn_a.append([x, y])
        spawn_b.append([ARENA_W - x, ARENA_H - y])

    mutators: List[str] = []
    for _ in range(rng.int(3)):
        m = MUTATORS[rng.int(len(MUTATORS))]
        if m not in mutators:
            mutators.append(m)

    arena = {
        "seed": seed, "wells": wells, "rocks": rocks, "pulsar": pulsar,
        "wormholes": wormholes, "spawnA": spawn_a, "spawnB": spawn_b,
        "mutators": mutators,
    }
    arena["hash"] = hash_arena(arena)
    return arena


def hash_arena(a: Dict) -> int:
    v: List[int] = [a["seed"], len(a["wells"]), len(a["rocks"]),
                    1 if a["pulsar"] else 0, len(a["wormholes"])]
    for w in a["wells"]:
        v.extend([w["x"], w["y"], w["mass"], w["drift"], w["dir"]])
    for r in a["rocks"]:
        v.extend([r["x"], r["y"], r["r"]])
    if a["pulsar"]:
        v.extend([a["pulsar"]["x"], a["pulsar"]["y"], a["pulsar"]["period"], a["pulsar"]["damage"]])
    for h in a["wormholes"]:
        v.extend([h["ax"], h["ay"], h["bx"], h["by"]])
    for s in a["spawnA"]:
        v.extend([s[0], s[1]])
    for s in a["spawnB"]:
        v.extend([s[0], s[1]])
    for m in a["mutators"]:
        for ch in m:
            v.append(ord(ch))
    return hash_combine(v, 0x4B455353)


def symmetry_report(a: Dict, tol: int = 0) -> Dict[str, int]:
    """Structural audit: every off-centre feature must have a mirror partner.

    We publish this because an asymmetric map would quietly invalidate every
    win rate in the README, and it is much cheaper to prove than to debug.
    """
    bad = 0
    for w in a["wells"]:
        # a centre feature is its own mirror partner, so it needs no partner
        if 2 * w["x"] == ARENA_W and 2 * w["y"] == ARENA_H:
            continue
        if not any(o["x"] == ARENA_W - w["x"] and o["y"] == ARENA_H - w["y"]
                   for o in a["wells"] if o is not w):
            bad += 1
    rockset = {(r["x"], r["y"], r["r"]) for r in a["rocks"]}
    for r in a["rocks"]:
        if (ARENA_W - r["x"], ARENA_H - r["y"], r["r"]) not in rockset:
            bad += 1
    for h in a["wormholes"]:
        if h["bx"] != ARENA_W - h["ax"] or h["by"] != ARENA_H - h["ay"]:
            bad += 1
    if a["pulsar"] and (a["pulsar"]["x"] != CENTER_X or a["pulsar"]["y"] != CENTER_Y):
        bad += 1
    for s1, s2 in zip(a["spawnA"], a["spawnB"]):
        if s2[0] != ARENA_W - s1[0] or s2[1] != ARENA_H - s1[1]:
            bad += 1
    return {"features": len(a["wells"]) + len(a["rocks"]) + len(a["wormholes"]) + 3, "asymmetries": bad}
