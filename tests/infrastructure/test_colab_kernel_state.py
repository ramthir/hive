import asyncio
import json
from pathlib import Path
from unittest.mock import AsyncMock

import httpx
import pytest
from src.infrastructure.colab import cli


@pytest.mark.asyncio
@pytest.mark.parametrize('state', ['busy', 'idle', 'starting'])
async def test_kernel_state_uses_only_read_only_authenticated_get(monkeypatch, tmp_path, state):
    folder = tmp_path / '.config/colab-cli'
    folder.mkdir(parents=True)
    folder.joinpath('sessions.json').write_text(json.dumps({'test': {
        'url': 'https://8080-runtime-1.region.prod.r.colab.dev', 'token': 'secret', 'kernel_id': 'kernel-1',
    }}))
    monkeypatch.setattr(Path, 'home', lambda: tmp_path)
    calls = []
    real_client = httpx.AsyncClient

    def handle(request):
        calls.append(request)
        assert request.method == 'GET'
        assert request.url.path == '/api/kernels/kernel-1'
        assert request.headers['X-Colab-Runtime-Proxy-Token'] == 'secret'
        return httpx.Response(200, json={'execution_state': state})

    monkeypatch.setattr(cli, 'run_colab_command', AsyncMock())
    monkeypatch.setattr(httpx, 'AsyncClient', lambda **kw: real_client(transport=httpx.MockTransport(handle), **kw))
    assert await cli.get_colab_kernel_state('test', 'runtime-1') == (state if state in ('busy', 'idle') else 'unknown')
    cli.run_colab_command.assert_not_awaited()
    assert len(calls) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize('url', [
    'http://8080-runtime-1.region.prod.r.colab.dev', 'https://example.com',
    'https://runtime-1.colab.dev.evil.example', 'https://user:pass@runtime-1.colab.dev',
    'https://other.colab.dev', 'https://runtime-1.colab.dev:8443',
])
async def test_untrusted_destinations_never_receive_credentials(monkeypatch, tmp_path, url):
    folder = tmp_path / '.config/colab-cli'
    folder.mkdir(parents=True)
    folder.joinpath('sessions.json').write_text(json.dumps({'test': {'url':url,'token':'secret','kernel_id':'k'}}))
    monkeypatch.setattr(Path, 'home', lambda: tmp_path)
    client = AsyncMock()
    monkeypatch.setattr(httpx, 'AsyncClient', client)
    assert await cli.get_colab_kernel_state('test', 'runtime-1') == 'unknown'
    client.assert_not_called()


@pytest.mark.asyncio
async def test_missing_credentials_fail_closed_without_exec(monkeypatch, tmp_path):
    monkeypatch.setattr(Path, 'home', lambda: tmp_path)
    assert await cli.get_colab_kernel_state('test', 'runtime-1') == 'unknown'


@pytest.mark.asyncio
@pytest.mark.parametrize('status', [302, 401, 503])
async def test_status_failures_and_redirects_do_not_execute_or_forward_credentials(monkeypatch, tmp_path, status):
    folder = tmp_path / '.config/colab-cli'
    folder.mkdir(parents=True)
    folder.joinpath('sessions.json').write_text(json.dumps({'test': {
        'url':'https://runtime-1.region.colab.dev','token':'secret','kernel_id':'kernel',
    }}))
    monkeypatch.setattr(Path, 'home', lambda: tmp_path)
    real_client = httpx.AsyncClient
    calls = []
    def handle(request):
        calls.append(request)
        return httpx.Response(status, headers={'location':'https://evil.example'})
    monkeypatch.setattr(httpx, 'AsyncClient', lambda **kw: real_client(transport=httpx.MockTransport(handle), **kw))
    assert await cli.get_colab_kernel_state('test','runtime-1') == 'unknown'
    assert len(calls) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize('cached_id', [None, ''])
@pytest.mark.parametrize('models, expected', [
    ([{'id': 'browser-kernel', 'execution_state': 'idle'}], 'idle'),
    ([{'id': 'browser-kernel', 'execution_state': 'busy'}], 'busy'),
    ([{'execution_state': 'idle'}, {'execution_state': 'busy'}], 'unknown'),
    ([{'execution_state': 'starting'}], 'unknown'),
    ({'execution_state': 'idle'}, 'unknown'),
    ([None], 'unknown'),
])
async def test_missing_kernel_id_discovers_existing_kernel_read_only(monkeypatch, tmp_path, cached_id, models, expected):
    folder = tmp_path / '.config/colab-cli'
    folder.mkdir(parents=True)
    folder.joinpath('sessions.json').write_text(json.dumps({'test': {
        'url': 'https://runtime-1.region.colab.dev', 'token': 'secret', 'kernel_id': cached_id,
    }}))
    monkeypatch.setattr(Path, 'home', lambda: tmp_path)
    real_client = httpx.AsyncClient
    calls = []

    def handle(request):
        calls.append(request)
        assert request.method == 'GET'
        assert request.url.path in ('/api/kernels', '/api/kernels/browser-kernel')
        assert request.headers['X-Colab-Runtime-Proxy-Token'] == 'secret'
        return httpx.Response(200, json=models if request.url.path == '/api/kernels' else models[0])

    monkeypatch.setattr(cli, 'run_colab_command', AsyncMock())
    monkeypatch.setattr(httpx, 'AsyncClient', lambda **kw: real_client(transport=httpx.MockTransport(handle), **kw))
    assert await cli.get_colab_kernel_state('test', 'runtime-1') == expected
    assert len(calls) == (2 if expected in ('idle', 'busy') else 1)
    cli.run_colab_command.assert_not_awaited()


@pytest.fixture(autouse=True)
def isolate_kernel_lifecycle(monkeypatch):
    monkeypatch.setattr(cli, '_kernel_start_attempts', set(), raising=False)
    monkeypatch.setattr(cli, '_kernel_bindings', {}, raising=False)
    monkeypatch.setattr(cli, '_probe_locks', {})


def configure_runtime(monkeypatch, tmp_path, handle, kernel_id=None):
    folder = tmp_path / '.config/colab-cli'
    folder.mkdir(parents=True)
    registry = folder / 'sessions.json'
    registry.write_text(json.dumps({'test': {
        'name': 'test', 'endpoint': 'runtime-1',
        'url': 'https://runtime-1.region.colab.dev', 'token': 'secret', 'kernel_id': kernel_id,
    }}))
    monkeypatch.setattr(Path, 'home', lambda: tmp_path)
    real_client = httpx.AsyncClient
    monkeypatch.setattr(httpx, 'AsyncClient', lambda **kw: real_client(transport=httpx.MockTransport(handle), **kw))
    return registry


@pytest.mark.asyncio
@pytest.mark.parametrize('state', ['idle', 'busy', 'starting'])
async def test_empty_runtime_starts_once_and_confirms_state(monkeypatch, tmp_path, state):
    calls = []
    created = False

    def handle(request):
        nonlocal created
        calls.append((request.method, request.url.path))
        assert request.headers['X-Colab-Runtime-Proxy-Token'] == 'secret'
        if request.method == 'POST':
            assert json.loads(request.content) == {'name': 'python3'}
            created = True
            return httpx.Response(201, json={'id': 'new-kernel', 'execution_state': 'idle'})
        if request.url.path == '/api/kernels':
            return httpx.Response(200, json=[{'id': 'new-kernel'}] if created else [])
        assert request.url.path == '/api/kernels/new-kernel'
        return httpx.Response(200, json={'id': 'new-kernel', 'execution_state': state})

    registry = configure_runtime(monkeypatch, tmp_path, handle)
    original = registry.read_bytes()
    results = await asyncio.gather(*(cli.get_colab_kernel_state('test', 'runtime-1') for _ in range(2)))
    assert results == [state if state in ('idle', 'busy') else 'unknown'] * 2
    assert calls.count(('POST', '/api/kernels')) == 1
    assert calls[:3] == [('GET', '/api/kernels'), ('POST', '/api/kernels'), ('GET', '/api/kernels/new-kernel')]
    assert registry.read_bytes() == original
    assert bool(cli._kernel_bindings) == (state == 'idle')


@pytest.mark.asyncio
@pytest.mark.parametrize('failure', ['timeout', 'cancel', 'redirect', 'error', 'malformed'])
async def test_uncertain_start_is_never_repeated(monkeypatch, tmp_path, failure):
    posts = []

    def handle(request):
        if request.method == 'GET':
            return httpx.Response(200, json=[])
        posts.append(request)
        if failure == 'timeout':
            raise httpx.ReadTimeout('timeout')
        if failure == 'cancel':
            raise asyncio.CancelledError()
        if failure == 'redirect':
            return httpx.Response(302, headers={'location': 'https://evil.example'})
        if failure == 'error':
            return httpx.Response(503)
        return httpx.Response(201, json={'execution_state': 'idle'})

    configure_runtime(monkeypatch, tmp_path, handle)
    if failure == 'cancel':
        with pytest.raises(asyncio.CancelledError):
            await cli.get_colab_kernel_state('test', 'runtime-1')
    else:
        assert await cli.get_colab_kernel_state('test', 'runtime-1') == 'unknown'
    assert await cli.get_colab_kernel_state('test', 'runtime-1') == 'unknown'
    assert len(posts) == 1
    assert not cli._kernel_bindings


@pytest.mark.asyncio
async def test_stale_cached_id_checks_list_before_starting(monkeypatch, tmp_path):
    calls = []

    def handle(request):
        calls.append((request.method, request.url.path))
        assert request.method == 'GET'
        if request.url.path.endswith('/old'):
            return httpx.Response(404)
        if request.url.path == '/api/kernels':
            return httpx.Response(200, json=[{'id': 'existing'}])
        return httpx.Response(200, json={'execution_state': 'idle'})

    configure_runtime(monkeypatch, tmp_path, handle, kernel_id='old')
    assert await cli.get_colab_kernel_state('test', 'runtime-1') == 'idle'
    assert cli._kernel_bindings['test']['kernel_id'] == 'existing'
    assert len(calls) == 3


@pytest.mark.asyncio
@pytest.mark.parametrize('cancel', [False, True])
async def test_probe_pins_checked_kernel_and_cleans_private_config(monkeypatch, tmp_path, cancel):
    def handle(request):
        if request.url.path == '/api/kernels':
            return httpx.Response(200, json=[{'id': 'existing'}])
        return httpx.Response(200, json={'execution_state': 'idle'})

    registry = configure_runtime(monkeypatch, tmp_path, handle)
    original = registry.read_bytes()
    assert await cli.get_colab_kernel_state('test', 'runtime-1') == 'idle'
    paths = []

    async def run(args, **kwargs):
        assert args[0] == '--config'
        path = Path(args[1])
        paths.append(path)
        record = json.loads(path.read_text())['test']
        assert record['kernel_id'] == 'existing'
        assert record['session_id'] is None
        assert path.stat().st_mode & 0o777 == 0o600
        assert path.parent.stat().st_mode & 0o777 == 0o700
        assert args[2:] == ['exec', '-s', 'test', '--timeout', '20']
        if cancel:
            raise asyncio.CancelledError()
        return cli._PROBE_START + '\nresult\n' + cli._PROBE_END

    monkeypatch.setattr(cli, 'run_colab_command', run)
    if cancel:
        with pytest.raises(asyncio.CancelledError):
            await cli._run_exec_probe('test', 'fixed probe')
    else:
        assert await cli._run_exec_probe('test', 'fixed probe') == 'result'
    assert paths and not paths[0].parent.exists()
    assert registry.read_bytes() == original


@pytest.mark.asyncio
@pytest.mark.parametrize('status', [302, 401, 503])
async def test_failed_kernel_list_never_creates_or_binds(monkeypatch, tmp_path, status):
    calls = []

    def handle(request):
        calls.append(request)
        assert request.method == 'GET'
        return httpx.Response(status, headers={'location': 'https://evil.example'})

    configure_runtime(monkeypatch, tmp_path, handle)
    assert await cli.get_colab_kernel_state('test', 'runtime-1') == 'unknown'
    assert len(calls) == 1
    assert not cli._kernel_start_attempts
    assert not cli._kernel_bindings
