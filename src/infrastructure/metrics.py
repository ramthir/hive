"""Tiny thread-safe counters and timers, exposed at /api/metrics."""
from __future__ import annotations

import threading
import time
from contextlib import contextmanager


class Metrics:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._started = time.monotonic()
        self.counters: dict[str, int] = {}
        self.timings: dict[str, dict[str, float]] = {}

    def incr(self, name: str, by: int = 1) -> None:
        with self._lock:
            self.counters[name] = self.counters.get(name, 0) + by

    def observe(self, name: str, seconds: float) -> None:
        with self._lock:
            t = self.timings.setdefault(name, {"count": 0, "total_ms": 0.0, "last_ms": 0.0, "max_ms": 0.0})
            ms = seconds * 1000
            t["count"] += 1
            t["total_ms"] += ms
            t["last_ms"] = ms
            t["max_ms"] = max(t["max_ms"], ms)

    @contextmanager
    def time(self, name: str):
        start = time.perf_counter()
        try:
            yield
        finally:
            self.observe(name, time.perf_counter() - start)

    def snapshot(self) -> dict:
        with self._lock:
            timings = {
                k: {**v, "avg_ms": round(v["total_ms"] / v["count"], 2) if v["count"] else 0.0}
                for k, v in self.timings.items()
            }
            counters = dict(self.counters)
        return {"counters": counters, "timings": timings, "process": process_stats(self._started)}


def process_stats(started: float) -> dict:
    rss_kb = None
    try:  # current (not peak) resident memory on Linux
        with open("/proc/self/statm") as f:
            import os
            rss_kb = int(f.read().split()[1]) * os.sysconf("SC_PAGE_SIZE") // 1024
    except OSError:
        pass
    return {
        "uptime_s": round(time.monotonic() - started, 1),
        "cpu_s": round(time.process_time(), 3),  # user+system CPU of this process, all threads
        "rss_kb": rss_kb,
        "threads": threading.active_count(),
    }
