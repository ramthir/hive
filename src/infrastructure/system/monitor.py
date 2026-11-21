"""What is running in this container: cgroup-aware CPU/memory stats and a page of processes (psutil).

Inside Docker `psutil` sees the container's own PID namespace, so the process list is the container's. CPU and memory
are read from the cgroup (v2, then v1) so the numbers are the container's use against its limit, not the host's.
"""
from __future__ import annotations

import os
import shutil
import threading
import time
from pathlib import Path

import psutil

CGROUP = Path("/sys/fs/cgroup")
SNAPSHOT_TTL = 2.0  # seconds: concurrent requests share one process sweep, which keeps cpu_percent deltas meaningful
MAX_COMMAND = 120
STORAGE_TTL = 300.0  # seconds: walking the home folder takes seconds and its size moves slowly


def _read(path: Path) -> str | None:
    try:
        return path.read_text().strip()
    except OSError:
        return None


def _int(text: str | None) -> int | None:
    try:
        return int(text) if text is not None else None
    except ValueError:  # cgroup v2 writes "max" for no limit
        return None


def human_bytes(value: float, decimals: int = 1) -> str:
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if value < 1024 or unit == "TB":
            return f"{value:.0f} {unit}" if unit == "B" else f"{value:.{decimals}f} {unit}"
        value /= 1024
    return "0 B"


def human_duration(seconds: float) -> str:
    seconds = max(0, int(seconds))
    days, rest = divmod(seconds, 86400)
    hours, rest = divmod(rest, 3600)
    minutes = rest // 60
    if days:
        return f"{days}d {hours}h"
    if hours:
        return f"{hours}h {minutes}m"
    return f"{minutes}m" if minutes else f"{seconds}s"


class ContainerMonitor:
    def __init__(self, data_dir: Path | str | None = None, cgroup: Path = CGROUP,
                 home: Path | str | None = None, downloads: Path | str | None = None) -> None:
        self.data_dir = Path(data_dir) if data_dir else Path("/")
        self.home = Path(home) if home else Path.home()
        self.downloads = Path(downloads) if downloads else self.home / "Downloads"
        self.cgroup = cgroup
        self._lock = threading.Lock()
        self._handles: dict[int, psutil.Process] = {}
        self._snapshot: tuple[float, list[tuple[float, float, int, psutil.Process]]] | None = None
        self._cpu_sample: tuple[float, int] | None = None  # (monotonic, cgroup usage_usec)
        self._cpu_percent = 0.0
        self._storage: tuple[float, dict] | None = None
        self._storage_busy = False

    # --- cgroup ---------------------------------------------------------------------------------------------------
    def _cpu_usage_usec(self) -> int | None:
        stat = _read(self.cgroup / "cpu.stat")
        if stat:  # v2
            for line in stat.splitlines():
                if line.startswith("usage_usec "):
                    return int(line.split()[1])
        ns = _int(_read(self.cgroup / "cpuacct" / "cpuacct.usage"))  # v1
        return ns // 1000 if ns is not None else None

    def _cpu_limit(self) -> float:
        """CPUs the container may use: cpu.max quota/period, else every CPU the host shows."""
        quota = _read(self.cgroup / "cpu.max")
        if quota:
            first, _, period = quota.partition(" ")
            if first != "max" and period.isdigit() and int(period):
                return int(first) / int(period)
        q = _int(_read(self.cgroup / "cpu" / "cpu.cfs_quota_us"))
        p = _int(_read(self.cgroup / "cpu" / "cpu.cfs_period_us"))
        if q and q > 0 and p:
            return q / p
        return float(psutil.cpu_count() or 1)

    def _container_cpu(self) -> float:
        """Percent of the CPU limit used since the previous call (the first call has no interval: it reports 0)."""
        usage, now = self._cpu_usage_usec(), time.monotonic()
        if usage is None:
            return psutil.cpu_percent(interval=None)
        previous, self._cpu_sample = self._cpu_sample, (now, usage)
        if previous is None or now - previous[0] < 0.5:
            return self._cpu_percent
        elapsed = (now - previous[0]) * 1_000_000 * self._cpu_limit()
        self._cpu_percent = max(0.0, min(100.0, (usage - previous[1]) / elapsed * 100)) if elapsed else 0.0
        return self._cpu_percent

    def _memory(self) -> dict:
        total = psutil.virtual_memory().total
        limit = _int(_read(self.cgroup / "memory.max")) or _int(_read(self.cgroup / "memory" / "memory.limit_in_bytes"))
        if not limit or limit >= total:  # "max", or a v1 sentinel larger than the host
            limit = total
        used = _int(_read(self.cgroup / "memory.current")) or _int(_read(self.cgroup / "memory" / "memory.usage_in_bytes"))
        if used is None:
            used = psutil.virtual_memory().used
        else:  # the page cache is reclaimable: `docker stats` leaves it out too
            for line in (_read(self.cgroup / "memory.stat") or "").splitlines():
                if line.startswith("inactive_file "):
                    used = max(0, used - int(line.split()[1]))
        return {"used": human_bytes(used), "total": human_bytes(limit), "used_bytes": used, "limit_bytes": limit,
                "percent_used": round(used / limit * 100, 1) if limit else 0.0}

    # --- storage --------------------------------------------------------------------------------------------------
    def measure_storage(self) -> dict:
        """Home, Notes and Downloads in one walk. Notes and Downloads usually sit inside the home folder, so Home is
        what is left of it: the three never overlap and add up to the home folder."""
        sizes = _bucket_sizes(self.home, {"notes": self.data_dir, "downloads": self.downloads})
        total = sum(sizes.values())
        pct = lambda n: round(n / total * 100, 1) if total else 0.0  # noqa: E731
        return {"used": human_bytes(total), "used_bytes": total,
                **{name: human_bytes(sizes[name], 0) for name in ("home", "notes", "downloads")},
                **{f"{name}_percent": pct(sizes[name]) for name in ("home", "notes", "downloads")}}

    def storage(self) -> dict:
        """The last measurement. A stale or missing one is measured again in the background, so a request never waits
        on the walk; before the first measurement finishes the answer is `{"pending": True}`."""
        with self._lock:
            fresh = self._storage and time.monotonic() - self._storage[0] < STORAGE_TTL
            if not fresh and not self._storage_busy:
                self._storage_busy = True
                threading.Thread(target=self._refresh_storage, daemon=True, name="storage-walk").start()
            return self._storage[1] if self._storage else {"pending": True}

    def _refresh_storage(self) -> None:
        try:
            result = self.measure_storage()
            with self._lock:
                self._storage = (time.monotonic(), result)
        finally:
            with self._lock:
                self._storage_busy = False

    def disk(self) -> dict | None:
        """The filesystem the home folder lives on: the storage card shows what is free on it, not only how the home folder splits."""
        try:
            usage = shutil.disk_usage(self.home)
        except OSError:
            return None
        return {"total": human_bytes(usage.total), "used": human_bytes(usage.used), "free": human_bytes(usage.free),
                "total_bytes": usage.total, "free_bytes": usage.free,
                "percent_used": round(usage.used / usage.total * 100, 1) if usage.total else 0.0}

    # --- stats ----------------------------------------------------------------------------------------------------
    def stats(self) -> dict:
        with self._lock:
            cpu = self._container_cpu()
        limit = self._cpu_limit()
        try:
            load = os.getloadavg()
        except OSError:
            load = (0.0, 0.0, 0.0)
        procs = list(psutil.process_iter(["num_threads", "status"]))
        threads = sum(p.info.get("num_threads") or 0 for p in procs)
        me = psutil.Process()
        try:
            started = psutil.Process(1).create_time()  # PID 1 is the container's entrypoint
        except (psutil.Error, OSError):
            started = me.create_time()
        with me.oneshot():
            app = {"pid": me.pid, "rss": human_bytes(me.memory_info().rss), "rss_bytes": me.memory_info().rss,
                   "threads": me.num_threads(), "open_files": _count(me.num_fds),
                   "uptime": human_duration(time.time() - me.create_time())}
        return {
            "cpu": {"percent": round(cpu, 1), "limit": round(limit, 2), "cores": psutil.cpu_count() or 1},
            "memory": self._memory(),
            "load_average": dict(zip(("1min", "5min", "15min"), (round(v, 2) for v in load))),
            "processes": {"total": len(procs), "running": sum(1 for p in procs if p.info.get("status") == psutil.STATUS_RUNNING),
                          "threads": threads},
            "storage": self.storage(),
            "disk": self.disk(),
            "uptime": human_duration(time.time() - started),
            "uptime_s": int(time.time() - started),
            "in_container": Path("/.dockerenv").exists() or _read(Path("/proc/1/cgroup")) not in (None, "0::/"),
            "app": app,
        }

    # --- processes ------------------------------------------------------------------------------------------------
    def _sample(self):
        seen = set()
        for p in psutil.process_iter():
            seen.add(p.pid)
            # A new process, or a pid the kernel has handed to another one: a stale handle would give the old one's deltas.
            known = self._handles.get(p.pid)
            if known is None or known != p:
                self._handles[p.pid] = p
                try:
                    p.cpu_percent(interval=None)  # primes the delta: the first reading would be 0
                except psutil.Error:
                    pass
        for pid in set(self._handles) - seen:
            del self._handles[pid]
        rows = []
        for pid, proc in list(self._handles.items()):
            try:
                rows.append((proc.cpu_percent(interval=None), proc.memory_percent(), pid, proc))
            except psutil.Error:
                continue
        return rows

    def process_page(self, page: int = 1, page_size: int = 10, sort: str = "cpu_percent", direction: str = "desc") -> dict:
        if page < 1 or not 1 <= page_size <= 100 or sort not in ("cpu_percent", "mem_percent") or direction not in ("asc", "desc"):
            raise ValueError("Invalid process pagination or sorting options")
        with self._lock:
            now = time.monotonic()
            if self._snapshot is None or now - self._snapshot[0] >= SNAPSHOT_TTL:
                self._snapshot = (now, self._sample())
            rows = list(self._snapshot[1])
        index, sign = (0 if sort == "cpu_percent" else 1), (-1 if direction == "desc" else 1)
        rows.sort(key=lambda r: (sign * r[index], r[2]))
        while True:
            total = len(rows)
            total_pages = max(1, -(-total // page_size))
            current = min(page, total_pages)
            out, gone = [], set()
            for cpu, mem, pid, proc in rows[(current - 1) * page_size:current * page_size]:
                try:
                    out.append(describe(cpu, mem, pid, proc))
                except psutil.Error:  # exited since the sweep: drop it and re-cut the page
                    gone.add(pid)
            if not gone:
                return {"processes": out, "total": total, "page": current, "page_size": page_size, "total_pages": total_pages}
            rows = [r for r in rows if r[2] not in gone]


def _bucket_sizes(home: Path, named: dict[str, Path]) -> dict[str, int]:
    """Bytes under `home`, each file counted once: in the named folder it sits in, else in "home". A named folder
    outside `home` is walked on its own. Links are not followed."""
    sizes = {"home": 0, **{name: 0 for name in named}}
    where = {os.path.normpath(path): name for name, path in named.items()}
    roots = [(os.path.normpath(home), "home")]
    roots += [(path, name) for path, name in where.items() if not (path == roots[0][0] or path.startswith(roots[0][0] + os.sep))]
    stack = list(roots)
    linked: set[tuple[int, int]] = set()  # (device, inode) of hardlinked files already counted
    while stack:
        directory, bucket = stack.pop()
        bucket = where.get(directory, bucket)
        try:
            with os.scandir(directory) as it:
                for entry in it:
                    try:
                        if entry.is_dir(follow_symlinks=False):
                            stack.append((os.path.normpath(entry.path), bucket))
                        elif entry.is_file(follow_symlinks=False):
                            sizes[bucket] += _disk_size(entry.stat(follow_symlinks=False), linked)
                    except OSError:
                        continue
        except OSError:
            continue
    return sizes


def _disk_size(info: os.stat_result, linked: set[tuple[int, int]]) -> int:
    """What a file costs on disk: its size, but never more than the blocks it holds (a sparse file is mostly holes), and a
    hardlinked file only the first time it is met."""
    if info.st_nlink > 1:
        identity = (info.st_dev, info.st_ino)
        if identity in linked:
            return 0
        linked.add(identity)
    blocks = getattr(info, "st_blocks", None)
    return min(info.st_size, blocks * 512) if blocks is not None else info.st_size


def _count(fn) -> int | None:
    try:
        return fn()
    except (psutil.Error, OSError, AttributeError):
        return None


def describe(cpu: float, mem: float, pid: int, proc: psutil.Process) -> dict:
    with proc.oneshot():
        name = proc.name()
        try:
            args = proc.cmdline()
        except psutil.AccessDenied:
            args = []
        command = " ".join(args[1:] if args and os.path.basename(args[0]) in (name, "") else args)
        if len(command) > MAX_COMMAND:
            command = command[:MAX_COMMAND - 1] + "…"
        return {"pid": pid, "name": name, "cmdline": command, "status": proc.status(),
                "cpu_percent": round(cpu, 1), "mem_percent": round(mem, 1), "mem": human_bytes(proc.memory_info().rss),
                "threads": proc.num_threads(), "running_for": human_duration(time.time() - proc.create_time())}
