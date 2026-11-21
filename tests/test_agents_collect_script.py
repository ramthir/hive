import importlib.util
from pathlib import Path

from src.domain.agents.usage import CollectError
from tests.agent_reports import envelope, quota_snapshot

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


class GoodQuota:
    def collect(self, now):
        return quota_snapshot(now, ok=("claude", "codex"))


class BrokenQuota:
    def collect(self, now):
        return {"schema_version": 9}


def run(args, **collectors):
    return agents_collect.main(args, usage_collector=collectors.get("usage", Good()), quota_collector=collectors.get("quota", GoodQuota()))


def test_it_writes_both_reports_into_the_folder_and_says_what_it_found(tmp_path, capsys):
    assert run(["--output", str(tmp_path)]) == 0
    out = capsys.readouterr().out
    assert (tmp_path / "usage.json").exists() and (tmp_path / "quota.json").exists()
    assert "claude" in out and "5h 40% used, 7d 29% used" in out and "antigravity: antigravity /usage printed no quota windows." in out


def test_one_report_can_be_asked_for_alone(tmp_path):
    assert run(["quota", "--output", str(tmp_path / "q.json")]) == 0
    assert (tmp_path / "q.json").exists() and not (tmp_path / "usage.json").exists()
    assert run(["usage", "--output", str(tmp_path / "u.json")]) == 0 and (tmp_path / "u.json").exists()


def test_a_failure_exits_1_with_the_reason_writes_nothing_and_does_not_stop_the_other_report(tmp_path, capsys):
    assert run(["--output", str(tmp_path)], usage=Broken()) == 1
    captured = capsys.readouterr()
    assert "agents-collect usage: ccusage exited 1: boom" in captured.err
    assert not (tmp_path / "usage.json").exists() and (tmp_path / "quota.json").exists()
    assert run(["quota", "--output", str(tmp_path / "bad.json")], quota=BrokenQuota()) == 1
    assert "unsupported schema" in capsys.readouterr().err
