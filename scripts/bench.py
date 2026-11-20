"""Measure what the notes app costs on a copy of a real notes repo.

    uv run python scripts/bench.py /path/to/COPY-of-notes [--idle 20] [--with-hook]

Always point it at a COPY: it edits files and makes commits. (`git clone ~/Workspace/notes /tmp/x` is enough.)
The same numbers are live at GET /api/metrics while the app runs.
"""
import argparse
import os
import subprocess
import time
from pathlib import Path

from fastapi.testclient import TestClient

from src.api.main import create_app


def cpu(client):
    return client.get("/api/metrics").json()["process"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("notes_copy")
    ap.add_argument("--idle", type=int, default=20, help="seconds to measure idle CPU")
    ap.add_argument("--burst", type=int, default=100, help="files to modify at once")
    ap.add_argument("--saves", type=int, default=10)
    ap.add_argument("--no-watch", action="store_true", help="baseline: run without the file watcher")
    ap.add_argument("--with-hook", action="store_true", help="keep the repo's pre-commit hook (prettier!) active")
    a = ap.parse_args()
    root = Path(a.notes_copy).expanduser().resolve()
    if not a.with_hook:
        os.environ["GIT_CONFIG_COUNT"] = "1"
        os.environ["GIT_CONFIG_KEY_0"] = "core.hooksPath"
        os.environ["GIT_CONFIG_VALUE_0"] = "/dev/null"

    with TestClient(create_app(root, watch=not a.no_watch)) as c:
        notes = c.get("/api/notes", params={"limit": 1000}).json()
        m = c.get("/api/metrics").json()
        print(f"notes: {len(notes)}   cold index build: {m['timings']['index_rebuild']['last_ms']:.0f} ms   "
              f"rss: {m['process']['rss_kb'] / 1024:.0f} MB   threads: {m['process']['threads']}")

        before = cpu(c)
        time.sleep(a.idle)
        after = cpu(c)
        used = after["cpu_s"] - before["cpu_s"]
        print(f"idle {a.idle}s with watcher {"off" if a.no_watch else "on"}: {used * 1000:.0f} ms CPU ({used / a.idle * 100:.2f}% of one core)")

        time.sleep(1)  # let the watcher register with the kernel before changing files
        slugs = [n["slug"] for n in notes[: a.burst]]
        m0 = c.get("/api/metrics").json()
        cpu0, t0 = m0["process"]["cpu_s"], time.perf_counter()
        for s in slugs:  # simulate `git pull` touching many files (no content change that the app has to understand)
            p = root / f"{s}.md"
            p.write_text(p.read_text() + "\n<!-- zzbenchmarkmarkzz -->\n")
        seen = None
        while time.perf_counter() - t0 < 15:
            seen = c.get("/api/notes", params={"q": "zzbenchmarkmarkzz", "limit": 1000}).json()
            if len(seen) >= len(slugs):
                break
            time.sleep(0.05)
        elapsed = time.perf_counter() - t0
        m1 = c.get("/api/metrics").json()
        print(f"burst of {len(slugs)} edited files: consistent after {elapsed * 1000:.0f} ms, "
              f"{m1['counters'].get('watcher_batches', 0) - m0['counters'].get('watcher_batches', 0)} watcher batch(es), "
              f"{m1['timings']['index_rebuild']['count'] - m0['timings']['index_rebuild']['count']} index rebuild(s), "
              f"{(m1['process']['cpu_s'] - cpu0) * 1000:.0f} ms CPU")
        subprocess.run(["git", "-C", str(root), "checkout", "-q", "--", "."], check=False)

        lat = []
        for i in range(a.saves):
            n = notes[i]
            t = time.perf_counter()
            r = c.put(f"/api/notes/{n['slug']}", json={"tags": n["tags"], "content": f"bench save {i} {time.time_ns()}\n"})
            lat.append((time.perf_counter() - t) * 1000)
            assert r.status_code == 200, r.text
        lat.sort()
        mm = c.get("/api/metrics").json()["timings"]["git_commit"]
        print(f"save latency over {a.saves} saves ({'with' if a.with_hook else 'without'} pre-commit hook): "
              f"median {lat[len(lat) // 2]:.0f} ms, max {lat[-1]:.0f} ms (git commit avg {mm['avg_ms']:.0f} ms)")
        end = c.get("/api/metrics").json()["process"]
        print(f"final: rss {end['rss_kb'] / 1024:.0f} MB, total CPU {end['cpu_s']:.1f} s over {end['uptime_s']:.0f} s uptime")


if __name__ == "__main__":
    main()
