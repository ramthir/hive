import importlib.util
from pathlib import Path

from src.domain.agents.usage import CollectError
from tests.agent_reports import envelope

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "agents_collect.py"
spec = importlib.util.spec_from_file_location("agents_collect", SCRIPT)
agents_collect = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agents_collect)


class Good:
    def collect(self, now):
        return envelope(now, since=now.replace(day=1).strftime("%Y-%m-%d"))


class Broken:
    def collect(self, now):
        raise CollectError("ccusage exited 1: boom")


def test_it_writes_the_report_and_says_what_it_found(tmp_path, capsys):
    out = tmp_path / "agents" / "usage.json"
    assert agents_collect.main(["--output", str(out)], collector=Good()) == 0
    assert out.exists() and "claude" in capsys.readouterr().out


def test_a_failure_exits_1_with_the_reason_and_writes_nothing(tmp_path, capsys):
    out = tmp_path / "usage.json"
    assert agents_collect.main(["--output", str(out)], collector=Broken()) == 1
    assert "boom" in capsys.readouterr().err and not out.exists()
