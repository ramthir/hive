"""The `colab` CLI runner and the fixed probes: what is sent, what is accepted, and how failures end."""
import types
from pathlib import Path

import pytest

from src.domain.colab.errors import ColabBusyError, ColabCliError
from src.infrastructure.colab import cli as colab_cli

_STATS_OUTPUT = '''===CORES===
2
===UPTIME===
 04:44:25 up 18 min, 0 users, load average: 1.14, 0.73, 0.38
===CPU===
%Cpu(s): 25.0 us, 75.0 id
===MEM===
Mem: 16384 4096 8192 0 4096 12288
===DISK===
Filesystem 1M-blocks Used Available Use% Mounted on
overlay 102400M 10240M 92160M 10% /
===GPU===
'''
_PROCESS_OUTPUT = 'PID %CPU %MEM RSS ELAPSED COMMAND COMMAND\n123 25.0 2.0 1024 01:00 python python train.py\n'


def test_resolve_colab_bin_falls_back_to_local_bin(monkeypatch, tmp_path):
    monkeypatch.delenv("COLAB_CLI_BIN", raising=False)
    monkeypatch.setattr(colab_cli.shutil, "which", lambda _name: None)
    local_bin = tmp_path / ".local" / "bin"
    local_bin.mkdir(parents=True)
    fake_colab = local_bin / "colab"
    fake_colab.write_text("#!/bin/sh\n")
    fake_colab.chmod(0o755)
    monkeypatch.setattr(colab_cli.Path, "home", lambda: tmp_path)
    assert colab_cli._resolve_colab_bin() == str(fake_colab)


@pytest.mark.asyncio
async def test_run_colab_command_raises_busy_on_429(monkeypatch):
    class FakeProc:
        returncode = 1

        async def communicate(self):
            return (
                b"",
                b"colab exec failed: HTTP 429",
            )

    async def fake_exec(*_args, **_kwargs):
        return FakeProc()

    monkeypatch.setattr(colab_cli, "_resolve_colab_bin", lambda: "colab")
    monkeypatch.setattr(colab_cli.asyncio, "create_subprocess_exec", fake_exec)
    with pytest.raises(ColabBusyError):
        await colab_cli.run_colab_command(["exec", "-s", "sentinel-run"])


def _fake_cli(monkeypatch, stdout=b"", stderr=b"", code=1):
    class FakeProc:
        returncode = code

        async def communicate(self, *_):
            return stdout, stderr

    async def fake_exec(*_args, **kwargs):
        fake_exec.kwargs = kwargs
        return FakeProc()
    monkeypatch.setattr(colab_cli, "_resolve_colab_bin", lambda: "colab")
    monkeypatch.setattr(colab_cli.asyncio, "create_subprocess_exec", fake_exec)
    return fake_exec


@pytest.mark.asyncio
async def test_a_cli_with_no_login_says_so_without_the_google_link_and_is_never_answered(monkeypatch):
    prompt = (b"To authorize colab-cli, visit this URL in any browser:\n\n  https://accounts.google.com/o/oauth2/auth?client_id=1&state=secret\n\n"
              b"After approving, Google will display an authorization code.\nEnter the authorization code: ")
    fake = _fake_cli(monkeypatch, stdout=prompt, stderr=b"[colab] Warning: failed to fetch compute-unit info: EOF when reading a line")
    with pytest.raises(ColabCliError) as error:
        await colab_cli.run_colab_command(["usage"])
    assert str(error.value) == colab_cli.SIGN_IN_MESSAGE and "http" not in str(error.value)
    assert fake.kwargs["stdin"] == colab_cli.asyncio.subprocess.DEVNULL  # the prompt gets end-of-file, not an answer


@pytest.mark.asyncio
async def test_sign_in_is_detected_even_when_the_cli_exits_cleanly(monkeypatch):
    _fake_cli(monkeypatch, stdout=b"Enter the authorization code: ", code=0)
    with pytest.raises(ColabCliError, match="not signed in"):
        await colab_cli.run_colab_command(["sessions"])


@pytest.mark.asyncio
async def test_other_cli_errors_lose_their_links_and_are_cut_short(monkeypatch):
    _fake_cli(monkeypatch, stderr=b"request to https://colab.example/api?token=abc failed\n" + b"x" * 500)
    with pytest.raises(ColabCliError) as error:
        await colab_cli.run_colab_command(["usage"])
    text = str(error.value)
    assert "<link>" in text and "token=abc" not in text and "\n" not in text and len(text) < 360 and text.endswith("…")


def _framed(output):
    return f'{colab_cli._PROBE_START}\n{output}{colab_cli._PROBE_END}\n'


@pytest.mark.asyncio
@pytest.mark.parametrize('gpu', ['', 'Tesla T4, 42, 4096, 15360\n'])
async def test_stats_and_processes_use_stdin_exec_never_ssh(monkeypatch, gpu):
    import subprocess
    from types import SimpleNamespace

    calls = []
    remote_calls = []

    def remote_run(argv, **kwargs):
        remote_calls.append((argv, kwargs))
        return SimpleNamespace(stdout=_STATS_OUTPUT + gpu + '===PROCESSES===\n' + _PROCESS_OUTPUT)

    monkeypatch.setattr(subprocess, 'run', remote_run)

    async def run(args, timeout, *, input_text):
        import contextlib
        import io
        calls.append((args, timeout))
        # Execute the exact stdin source: framing and isolated globals are part of the contract.
        namespace = {'result': 'user data', 'subprocess': 'user data'}
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            exec(input_text, namespace)
        assert namespace['result'] == 'user data'
        assert namespace['subprocess'] == 'user data'
        return out.getvalue()

    monkeypatch.setattr(colab_cli, 'run_colab_command', run)
    snapshot = await colab_cli.collect_colab_snapshot('sentinel-run')
    stats, processes = snapshot['stats'], snapshot['processes']
    assert stats['cpu_count'] == 2
    assert stats['memory']['percent'] == 25.0
    assert bool(stats['gpu']) == bool(gpu)
    assert processes[0]['pid'] == 123
    assert len(calls) == 1
    assert all(args == ['exec', '-s', 'sentinel-run', '--timeout', '20'] and timeout == 25 for args, timeout in calls)
    assert all(argv[:2] == ['sh', '-c'] and kwargs['timeout'] == 12 and kwargs['check'] for argv, kwargs in remote_calls)


@pytest.mark.asyncio
@pytest.mark.parametrize('output', ['Traceback: kernel error', '===HIVE_PROBE_START===\npartial', _framed('nonsense\n'), _framed('PID %CPU %MEM RSS ELAPSED COMMAND COMMAND\ninvalid row\n')])
async def test_invalid_exec_results_are_errors(monkeypatch, output):
    async def run(*args, **kwargs):
        return output
    monkeypatch.setattr(colab_cli, 'run_colab_command', run)
    with pytest.raises(ColabCliError, match='Colab exec'):
        await colab_cli.collect_colab_snapshot('sentinel-run')


@pytest.mark.asyncio
async def test_invalid_session_does_not_invoke_exec(monkeypatch):
    from unittest.mock import AsyncMock
    run = AsyncMock()
    monkeypatch.setattr(colab_cli, 'run_colab_command', run)
    with pytest.raises(ValueError):
        await colab_cli.collect_colab_snapshot('bad;session')
    run.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize('mode', ['timeout', 'cancel', 'success', 'failure', 'missing'])
async def test_exec_subprocess_stdin_cleanup_and_errors(monkeypatch, mode):
    import asyncio

    class Proc:
        returncode = None if mode in ('timeout', 'cancel') else (1 if mode == 'failure' else 0)
        killed = False
        waited = False

        async def communicate(self, payload):
            assert payload == b'print(1)\n'
            if mode == 'cancel':
                raise asyncio.CancelledError()
            if mode == 'timeout':
                await asyncio.Future()
            return (b'result', b'command failed')

        def kill(self):
            self.killed = True

        async def wait(self):
            self.waited = True

    proc = Proc()

    async def spawn(*args, **kwargs):
        assert args == ('colab', 'exec', '-s', 'sentinel-run')
        assert kwargs['stdin'] == asyncio.subprocess.PIPE
        assert 'shell' not in kwargs
        if mode == 'missing':
            raise FileNotFoundError()
        return proc

    monkeypatch.setattr(colab_cli, '_resolve_colab_bin', lambda: 'colab')
    monkeypatch.setattr(colab_cli.asyncio, 'create_subprocess_exec', spawn)
    command = colab_cli.run_colab_command(['exec', '-s', 'sentinel-run'], timeout=.01, input_text='print(1)\n')
    if mode == 'success':
        assert await command == 'result'
    elif mode == 'cancel':
        with pytest.raises(asyncio.CancelledError):
            await command
    else:
        message = {'timeout': 'kernel may be busy', 'failure': 'command failed', 'missing': 'not installed'}[mode]
        with pytest.raises(ColabCliError, match=message):
            await command
    if mode in ('timeout', 'cancel'):
        assert proc.killed and proc.waited


@pytest.mark.asyncio
@pytest.mark.parametrize('output', [
    'broken stats\n===PROCESSES===\n' + _PROCESS_OUTPUT,
    _STATS_OUTPUT + '===PROCESSES===\nbroken processes\n',
])
async def test_an_invalid_snapshot_is_an_error(monkeypatch, output):
    from unittest.mock import AsyncMock
    monkeypatch.setattr(colab_cli, 'run_colab_command', AsyncMock(return_value=_framed(output)))
    with pytest.raises(ColabCliError):
        await colab_cli.collect_colab_snapshot('malformed-test')


@pytest.mark.asyncio
async def test_a_second_probe_of_the_same_runtime_is_refused_while_one_is_running(monkeypatch):
    import asyncio
    started, release = asyncio.Event(), asyncio.Event()

    async def run(args, **kwargs):
        started.set()
        await release.wait()
        return _framed(_STATS_OUTPUT + '===PROCESSES===\n' + _PROCESS_OUTPUT)

    monkeypatch.setattr(colab_cli, 'run_colab_command', run)
    first = asyncio.create_task(colab_cli.collect_colab_snapshot('busy-test'))
    await started.wait()
    with pytest.raises(ColabBusyError):
        await colab_cli.collect_colab_snapshot('busy-test')
    release.set()
    assert (await first)['stats']['cpu_count'] == 2


@pytest.mark.asyncio
async def test_callers_that_arrive_together_share_one_cli_run_and_its_answer_is_kept_briefly(monkeypatch):
    import asyncio
    runs = []

    async def read():
        runs.append(1)
        await asyncio.sleep(0.05)
        return {"balance": len(runs)}

    now = [100.0]
    monkeypatch.setattr(colab_cli, "time", types.SimpleNamespace(monotonic=lambda: now[0]))  # not time.monotonic itself: the event loop runs on it
    shared = colab_cli.SharedCall(read, ttl=10)
    first, second = await asyncio.gather(shared(), shared())
    assert first == second == {"balance": 1} and len(runs) == 1
    first["balance"] = 99  # callers get their own copy
    assert await shared() == {"balance": 1} and len(runs) == 1
    now[0] += 11
    assert await shared() == {"balance": 2} and len(runs) == 2


@pytest.mark.asyncio
async def test_a_failed_cli_run_is_shared_by_those_waiting_but_never_kept(monkeypatch):
    import asyncio
    calls = []

    async def read():
        calls.append(1)
        await asyncio.sleep(0.02)
        if len(calls) == 1:
            raise ColabCliError("colab usage timed out")
        return "ok"

    shared = colab_cli.SharedCall(read, ttl=10)
    results = await asyncio.gather(shared(), shared(), return_exceptions=True)
    assert [type(r) for r in results] == [ColabCliError, ColabCliError] and len(calls) == 1
    assert await shared() == "ok" and len(calls) == 2  # the next caller tries again at once


@pytest.mark.asyncio
async def test_a_caller_that_gives_up_does_not_cancel_the_run_the_others_wait_for():
    import asyncio

    async def read():
        await asyncio.sleep(0.05)
        return "done"

    shared = colab_cli.SharedCall(read, ttl=10)
    impatient = asyncio.create_task(shared())
    patient = asyncio.create_task(shared())
    await asyncio.sleep(0.01)
    impatient.cancel()
    assert await patient == "done"


def test_the_usage_and_session_reads_are_shared_calls():
    assert isinstance(colab_cli.get_colab_usage, colab_cli.SharedCall)
    assert isinstance(colab_cli.get_colab_sessions, colab_cli.SharedCall)
