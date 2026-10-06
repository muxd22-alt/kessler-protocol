"""HTTP benchmark against a RUNNING server (python main.py in another terminal).

Usage:  python benchmark.py [--n 100]
Sends the compact p/e/q schema the game client actually uses.
"""
import json
import sys
import time
import urllib.request

URL = "http://127.0.0.1:8088/v1/systemone"


def post(payload: dict) -> dict:
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(URL, data=data, headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read().decode("utf-8"))


def benchmark(n: int = 100):
    try:
        health_req = urllib.request.Request("http://127.0.0.1:8088/health", method="GET")
        with urllib.request.urlopen(health_req, timeout=5) as resp:
            print("Server:", resp.read().decode("utf-8"))
    except Exception as exc:
        print(f"Server not reachable at {URL} — start it first:  python main.py\n({exc})")
        sys.exit(1)

    state = {
        "p": [320, 500, 0.8],
        "e": [[f"e{i}", 80 + i * 60, 100 + (i % 3) * 40, 1.0] for i in range(8)],
        "proj": 6,
    }
    q: dict = {}
    for i in range(8):
        q[f"e{i}_t"] = ["p", "proj", "ret"]
        q[f"e{i}_m"] = ["adv", "strf", "flk_l", "flk_r", "ret"]
        q[f"e{i}_s"] = "noul"

    lat = []
    for _ in range(n):
        t = time.perf_counter()
        res = post({"state": state, "q": q})
        lat.append((time.perf_counter() - t) * 1000)
        assert "a" in res and len(res["a"]) == 24, f"bad response: {res}"

    lat.sort()
    p50 = lat[len(lat) // 2]
    p95 = lat[int(len(lat) * 0.95)]
    p99 = lat[int(len(lat) * 0.99)]
    print(f"\nBatch (24 decisions) over HTTP x{n}:")
    print(f"  P50: {p50:.2f} ms   P95: {p95:.2f} ms   P99: {p99:.2f} ms")
    print(f"  Throughput: {(n * 24) / (sum(lat) / 1000):,.0f} decisions/sec")


if __name__ == "__main__":
    count = 100
    if "--n" in sys.argv:
        try:
            count = int(sys.argv[sys.argv.index("--n") + 1])
        except (IndexError, ValueError):
            pass
    benchmark(count)
