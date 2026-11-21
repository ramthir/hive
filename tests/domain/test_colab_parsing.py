import pytest

from src.domain.colab.errors import ColabCliError
from src.domain.colab.parsing import (
    parse_processes_output,
    parse_sessions_output,
    parse_stats_output,
    parse_usage_output,
    validate_session_name,
)


def test_parse_usage_output():
    raw = (
        "Current balance: 499.98 compute units\n"
        "Usage rate: 0.08/hr\n"
        "Active assignments: 1\n"
    )
    parsed = parse_usage_output(raw)
    assert parsed == {
        "balance": 499.98,
        "balance_unit": "compute units",
        "usage_rate": 0.08,
        "usage_rate_unit": "/hr",
        "active_assignments": 1,
    }


def test_parse_usage_output_rejects_unparseable_text():
    with pytest.raises(ColabCliError):
        parse_usage_output("unexpected output")


def test_parse_sessions_output_empty_and_active():
    assert parse_sessions_output("[colab] No active sessions found on server.\n") == []
    raw = "[sentinel-run] m-s-usc1b5-j0y512soilak | Hardware: CPU | Shape: Standard | Variant: DEFAULT\n"
    assert parse_sessions_output(raw) == [
        {
            "name": "sentinel-run",
            "runtime_id": "m-s-usc1b5-j0y512soilak",
            "hardware": "CPU",
            "shape": "Standard",
            "variant": "DEFAULT",
        }
    ]


def test_parse_exec_stats_without_gpu():
    raw = """===CORES===
2
===UPTIME===
 04:44:25 up 18 min,  0 user,  load average: 1.14, 0.73, 0.38
===CPU===
%Cpu(s): 65.0 us, 35.0 sy,  0.0 ni,  0.0 id,  0.0 wa,  0.0 hi,  0.0 si,  0.0 st
===MEM===
              total        used        free      shared  buff/cache   available
Mem:          12978        1331        8806           2        3174       11264
Swap:             0           0           0
===DISK===
Filesystem      1M-blocks  Used Available Use% Mounted on
overlay           231219M  216M   231003M   1% /
===GPU===
"""
    stats = parse_stats_output(raw)
    assert stats["cpu_count"] == 2
    assert stats["cpu_percent"] == 100.0
    assert stats["uptime"] == "18 min"
    assert stats["load_average"] == {"1min": 1.14, "5min": 0.73, "15min": 0.38}
    assert stats["memory"] == {"used_gb": 1.3, "total_gb": 12.7, "percent": 10.3}
    assert stats["disk"] == {"used_gb": 0.2, "total_gb": 225.8, "percent": 1.0}
    assert stats["gpu"] == []


def test_parse_exec_stats_with_gpu():
    raw = """===CORES===
4
===UPTIME===
 05:10:00 up  1:15,  1 user,  load average: 0.50, 0.40, 0.30
===CPU===
%Cpu(s): 20.0 us,  5.0 sy,  0.0 ni, 75.0 id,  0.0 wa,  0.0 hi,  0.0 si,  0.0 st
===MEM===
Mem:          16384        4096        8192           0        4096       12288
===DISK===
Filesystem      1M-blocks  Used Available Use% Mounted on
overlay           102400M 10240M   92160M  10% /
===GPU===
Tesla T4, 42, 4096, 15360
"""
    stats = parse_stats_output(raw)
    assert stats["cpu_count"] == 4
    assert stats["cpu_percent"] == 25.0
    assert stats["gpu"] == [
        {
            "name": "Tesla T4",
            "utilization_percent": 42.0,
            "memory_used_mb": 4096.0,
            "memory_total_mb": 15360.0,
            "memory_percent": 26.7,
        }
    ]


def test_validate_session_name_rejects_unsafe_values():
    assert validate_session_name("sentinel-run") == "sentinel-run"
    for bad in ("", "bad session", "../etc", "a;rm -rf /", "sentinel-run\n"):
        with pytest.raises(ValueError):
            validate_session_name(bad)


def test_parse_processes_output():
    raw = """  PID %CPU %MEM   RSS     ELAPSED COMMAND         COMMAND
  123 65.0  4.2 131072     18:05 python3         python3 -m sentinel.cli --bundle foo.tar.gz
   42  0.5  0.3  10240     20:10 node            node server.js
"""
    procs = parse_processes_output(raw)
    assert len(procs) == 2
    assert procs[0] == {
        "pid": 123,
        "name": "python3",
        "cmdline": "-m sentinel.cli --bundle foo.tar.gz",
        "command": "python3 -m sentinel.cli --bundle foo.tar.gz",
        "running_for": "18:05",
        "cpu_percent": 65.0,
        "mem_percent": 4.2,
        "mem": "128.0 MB",
        "status": "running",
    }
    assert procs[1]["mem"] == "10.0 MB"
