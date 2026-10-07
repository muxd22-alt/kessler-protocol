"""Generate + verify golden arena vectors.

  python gen_golden.py          # regenerate test/golden_arenas.json
  python gen_golden.py --check  # verify (default; also run from CI)

Two jobs:
  1. Assert point symmetry holds for every generated arena. An asymmetric map
     would silently invalidate every win rate we publish.
  2. Pin seed -> arena hash. The TypeScript generator must reproduce these
     exactly; test/golden_arenas.test.ts checks that in the browser build. A
     JS/Python mismatch fails a test instead of desyncing quietly.
"""
from __future__ import annotations

import json
import os
import sys

import arena

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

SEEDS = [0, 1, 42, 1337, 48213, 99991, 2147483647, 31337, 777, 8675309]
HERE = os.path.dirname(os.path.abspath(__file__))
GOLDEN = os.path.join(HERE, "..", "test", "golden_arenas.json")


def build():
    out = {"note": "seed -> arena hash. TS must match; see gen_golden.py --check",
           "hash_fn": "FNV-1a over integer arena fields, seed 0x4B455353",
           "vectors": []}
    problems = 0
    for s in SEEDS:
        a = arena.generate_arena(s)
        rep = arena.symmetry_report(a)
        if rep["asymmetries"]:
            problems += 1
            print(f"  seed {s}: {rep['asymmetries']} ASYMMETRIES (of {rep['features']})")
        out["vectors"].append({
            "seed": a["seed"],
            "hash": a["hash"],
            "wells": len(a["wells"]),
            "rocks": len(a["rocks"]),
            "pulsar": 1 if a["pulsar"] else 0,
            "wormholes": len(a["wormholes"]),
            "mutators": a["mutators"],
            "asymmetries": rep["asymmetries"],
        })
    return out, problems


def main() -> None:
    check = "--check" in sys.argv
    out, problems = build()
    if problems:
        print(f"FAIL: {problems} seed(s) produced asymmetric arenas")
        if check:
            sys.exit(1)
        raise SystemExit(1)

    print(f"{'seed':>10s} {'hash':>12s} {'wells':>6s} {'rocks':>6s} {'puls':>5s} {'wh':>3s}  mutators")
    for v in out["vectors"]:
        print(f"{v['seed']:>10d} {v['hash']:>12d} {v['wells']:>6d} {v['rocks']:>6d} "
              f"{v['pulsar']:>5d} {v['wormholes']:>3d}  {','.join(v['mutators']) or '-'}")

    os.makedirs(os.path.dirname(GOLDEN), exist_ok=True)
    if check:
        if not os.path.isfile(GOLDEN):
            print("FAIL: no golden file — run without --check to create it")
            sys.exit(1)
        with open(GOLDEN, "r", encoding="utf-8") as fh:
            have = json.load(fh)
        want = {v["seed"]: v["hash"] for v in have["vectors"]}
        got = {v["seed"]: v["hash"] for v in out["vectors"]}
        bad = [s for s in want if want[s] != got.get(s)]
        if bad:
            for s in bad:
                print(f"  MISMATCH seed {s}: golden {want[s]} vs now {got.get(s)}")
            print(f"FAIL: {len(bad)} golden vector(s) changed")
            sys.exit(1)
        print("\nOK: all golden arena hashes reproduce + every arena is symmetric")
        return

    with open(GOLDEN, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(out, fh, indent=2)
        fh.write("\n")
    print(f"\nwrote {os.path.normpath(GOLDEN)} ({len(out['vectors'])} vectors, all symmetric)")


if __name__ == "__main__":
    main()
