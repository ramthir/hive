import os

import pytest

from src.infrastructure.system.monitor import ContainerMonitor, human_bytes, human_duration


def cgroup(tmp_path, **files):
    for name, text in files.items():
        (tmp_path / name.replace("__", ".")).write_text(text)
    return tmp_path


def test_human_units():
    assert [human_bytes(n) for n in (0, 512, 2048, 5 * 1024**3)] == ["0 B", "512 B", "2.0 KB", "5.0 GB"]
    assert human_bytes(1536 * 1024**2, 0) == "2 GB" and human_bytes(1536 * 1024**2) == "1.5 GB"
    assert [human_duration(s) for s in (5, 130, 3700, 90000)] == ["5s", "2m", "1h 1m", "1d 1h"]


def test_memory_is_the_cgroup_use_against_its_limit_without_reclaimable_cache(tmp_path):
    cg = cgroup(tmp_path, memory__max=str(1024**3), memory__current=str(600 * 1024**2),
                memory__stat="anon 1\ninactive_file %d\n" % (100 * 1024**2))
    mem = ContainerMonitor(tmp_path, cg)._memory()
    assert mem["limit_bytes"] == 1024**3
    assert mem["used_bytes"] == 500 * 1024**2
    assert mem["percent_used"] == pytest.approx(48.8, abs=0.1)


def test_no_memory_limit_falls_back_to_the_host_total(tmp_path):
    mem = ContainerMonitor(tmp_path, cgroup(tmp_path, memory__max="max", memory__current="1000"))._memory()
    assert mem["limit_bytes"] > 1000


def test_cpu_limit_comes_from_the_quota(tmp_path):
    assert ContainerMonitor(tmp_path, cgroup(tmp_path, cpu__max="150000 100000"))._cpu_limit() == 1.5
    assert ContainerMonitor(tmp_path, cgroup(tmp_path, cpu__max="max 100000"))._cpu_limit() >= 1


def test_cpu_percent_is_the_usage_delta_over_the_limit(tmp_path):
    cg = cgroup(tmp_path, cpu__max="200000 100000", cpu__stat="usage_usec 1000000\n")
    monitor = ContainerMonitor(tmp_path, cg)
    assert monitor._container_cpu() == 0  # no interval yet
    monitor._cpu_sample = (monitor._cpu_sample[0] - 2.0, 1_000_000)  # pretend the last reading was 2 s ago
    (cg / "cpu.stat").write_text("usage_usec 1800000\n")  # 0.8 CPU-s in 2 s on 2 CPUs = 20%
    assert monitor._container_cpu() == pytest.approx(20, abs=1)


def test_rapid_cpu_polls_do_not_starve_the_baseline_sample(tmp_path, monkeypatch):
    from src.infrastructure.system import monitor as monitor_module

    cg = cgroup(tmp_path, cpu__max="100000 100000", cpu__stat="usage_usec 1000000\n")
    clock = [100.0]
    monkeypatch.setattr(monitor_module.time, "monotonic", lambda: clock[0])
    monitor = ContainerMonitor(tmp_path, cg)
    assert monitor._container_cpu() == 0.0
    # Rapid calls under 0.5 s keep the original baseline instead of resetting it every call.
    clock[0] = 100.3
    (cg / "cpu.stat").write_text("usage_usec 1150000\n")
    assert monitor._container_cpu() == 0.0
    clock[0] = 100.6
    (cg / "cpu.stat").write_text("usage_usec 1300000\n")  # 0.3 CPU-s over 0.6 s on 1 CPU = 50%
    assert monitor._container_cpu() == pytest.approx(50.0, abs=0.5)


def test_stats_describe_this_process_and_the_notes_disk(tmp_path):
    stats = ContainerMonitor(tmp_path, tmp_path / "none").stats()
    assert stats["app"]["pid"] == os.getpid()
    assert stats["processes"]["total"] >= 1 and stats["processes"]["threads"] >= 1
    assert 0 <= stats["memory"]["percent_used"] <= 100


def test_storage_is_home_notes_and_downloads_without_overlap(tmp_path):
    home = tmp_path / "home"
    (home / "Workspace" / "notes" / ".git").mkdir(parents=True)
    (home / "Downloads").mkdir()
    (home / "a.bin").write_bytes(b"x" * 100)
    (home / "Workspace" / "notes" / "n.md").write_bytes(b"x" * 50)
    (home / "Workspace" / "notes" / ".git" / "o").write_bytes(b"x" * 50)
    (home / "Downloads" / "d.iso").write_bytes(b"x" * 300)
    storage = ContainerMonitor(home / "Workspace" / "notes", tmp_path / "none", home=home).measure_storage()
    assert storage["used_bytes"] == 500  # the home folder once, not home + notes + downloads
    assert (storage["home"], storage["notes"], storage["downloads"]) == ("100 B", "100 B", "300 B")
    assert (storage["home_percent"], storage["notes_percent"], storage["downloads_percent"]) == (20.0, 20.0, 60.0)


def test_a_notes_dir_outside_home_is_added_not_lost(tmp_path):
    home, notes = tmp_path / "home", tmp_path / "elsewhere"
    home.mkdir(); notes.mkdir()
    (home / "a").write_bytes(b"x" * 10)
    (notes / "n.md").write_bytes(b"x" * 30)
    storage = ContainerMonitor(notes, tmp_path / "none", home=home).measure_storage()
    assert (storage["used_bytes"], storage["notes"], storage["home"]) == (40, "30 B", "10 B")


def test_storage_is_measured_in_the_background_and_then_cached(tmp_path):
    import time
    (tmp_path / "f").write_bytes(b"x" * 10)
    monitor = ContainerMonitor(tmp_path, tmp_path / "none", home=tmp_path)
    first = monitor.storage()
    assert first == {"pending": True} or first["used_bytes"] == 10
    deadline = time.time() + 5
    while monitor.storage().get("pending") and time.time() < deadline:
        time.sleep(0.02)
    assert monitor.storage()["used_bytes"] == 10


def test_process_page_sorts_pages_and_includes_this_process(tmp_path):
    monitor = ContainerMonitor(tmp_path)
    page = monitor.process_page(page_size=100, sort="mem_percent")
    assert os.getpid() in [p["pid"] for p in page["processes"]]
    assert page["total"] == len(page["processes"]) or page["total_pages"] > 1
    mem = [p["mem_percent"] for p in page["processes"]]
    assert mem == sorted(mem, reverse=True)
    assert monitor.process_page(page=999, page_size=1)["page"] == monitor.process_page(page_size=1)["total_pages"]


def test_process_page_rejects_bad_options(tmp_path):
    with pytest.raises(ValueError):
        ContainerMonitor(tmp_path).process_page(sort="name")


def test_a_sparse_file_counts_what_it_holds_not_its_holes(tmp_path):
    home = tmp_path / "home"
    home.mkdir()
    with open(home / "disk.img", "wb") as f:
        f.truncate(50 * 1024 * 1024)  # 50 MB of holes
    (home / "a").write_bytes(b"x" * 10)
    storage = ContainerMonitor(tmp_path / "none", tmp_path / "none2", home=home).measure_storage()
    assert storage["used_bytes"] < 1024 * 1024


def test_a_hardlinked_file_is_counted_once(tmp_path):
    home = tmp_path / "home"
    home.mkdir()
    (home / "one").write_bytes(b"x" * 100)
    os.link(home / "one", home / "two")
    (home / "other").write_bytes(b"x" * 40)
    storage = ContainerMonitor(tmp_path / "none", tmp_path / "none2", home=home).measure_storage()
    assert storage["used_bytes"] == 140


def test_a_pid_the_kernel_reuses_gets_a_fresh_handle(tmp_path, monkeypatch):
    from src.infrastructure.system import monitor as monitor_module

    class Proc:
        def __init__(self, pid, started):
            self.pid, self.started, self.primed = pid, started, 0

        def __eq__(self, other):  # psutil compares the pid and the creation time
            return isinstance(other, Proc) and (self.pid, self.started) == (other.pid, other.started)

        def cpu_percent(self, interval=None):
            self.primed += 1
            return 0.0

        def memory_percent(self):
            return 1.0

    old, other, reused = Proc(5, 100), Proc(6, 100), Proc(5, 200)
    batches = [[old, other], [old, other], [reused, other]]
    monkeypatch.setattr(monitor_module.psutil, "process_iter", lambda: iter(batches.pop(0)))
    monitor = ContainerMonitor(tmp_path, tmp_path / "none", home=tmp_path)
    monitor._sample()
    monitor._sample()
    assert old.primed == 2 and other.primed == 2  # primed once, then read on the next sweep: never double-sampled in one sweep
    monitor._sample()
    assert monitor._handles[5] is reused and reused.primed == 1  # the new process was primed without an immediate noisy read
    assert monitor._handles[6] is other


def test_the_disk_is_the_filesystem_the_home_folder_is_on(tmp_path):
    disk = ContainerMonitor(tmp_path, tmp_path / "none", home=tmp_path).disk()
    assert disk["total_bytes"] > 0 and 0 <= disk["percent_used"] <= 100
    assert disk["free"] == human_bytes(disk["free_bytes"])
    assert ContainerMonitor(tmp_path, tmp_path / "none", home=tmp_path / "missing").disk() is None


@pytest.mark.parametrize("args,expected", [
    (["/home/r/Workspace/hive/.venv/bin/python", "main.py"], "hive"),
    (["/srv/app/env/bin/python", "run.py"], "app"),
    (["/usr/bin/python3", "/opt/tools/venv/bin/tool"], "tools"),
    (["/usr/bin/python3", "script.py"], None),
    (["python", "main.py"], None),
    (["/usr/bin/python3", "-c", "/home/x/venv/bin/y"], None),
    ([], None),
])
def test_the_project_comes_from_the_virtual_environment_in_the_command(args, expected):
    from src.infrastructure.system.monitor import project_from_cmdline
    assert project_from_cmdline(args) == expected


def test_the_project_falls_back_to_the_working_folder(tmp_path):
    from src.infrastructure.system.monitor import project_from_cwd
    repo = tmp_path / "work" / "acme"
    (repo / "src").mkdir(parents=True)
    (repo / ".git").mkdir()
    loose = tmp_path / "scratch"
    loose.mkdir()
    assert project_from_cwd(str(repo / "src")) == "acme"
    assert project_from_cwd(str(loose)) is None
    assert project_from_cwd(str(loose), name_folder=True) == "scratch"  # a coding agent's folder names its project
    assert project_from_cwd("/") is None


def test_process_rows_carry_a_project_key(tmp_path):
    page = ContainerMonitor(tmp_path).process_page(page_size=100)
    assert all("project" in p for p in page["processes"])
