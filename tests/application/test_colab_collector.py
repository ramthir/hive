import asyncio
from unittest.mock import AsyncMock

import pytest
from src.application.colab.collector import ColabCollector, RuntimeFeed

SESSION = {'name': 'test', 'runtime_id': 'runtime-1'}
SNAPSHOT = {'stats': {'cpu_count': 2}, 'processes': [{'pid': 1}]}


def make_collector(**kwargs):
    return ColabCollector(sessions=AsyncMock(return_value=[SESSION]),
                          kernel_state=AsyncMock(return_value='idle'),
                          collect=AsyncMock(return_value=SNAPSHOT), **kwargs)


@pytest.mark.asyncio
@pytest.mark.parametrize('state', ['busy', 'unknown', None])
async def test_busy_or_unknown_kernel_never_submits_code_and_retains_cache(state):
    collector = make_collector()
    collector.kernel_state.return_value = state
    feed = RuntimeFeed(SESSION)
    feed.data.update(SNAPSHOT, last_updated='earlier')
    await collector.refresh(feed)
    collector.collect.assert_not_awaited()
    assert feed.data['status'] == 'waiting'
    assert feed.data['stats'] == SNAPSHOT['stats']
    assert feed.data['last_updated'] == 'earlier'


@pytest.mark.asyncio
async def test_timeout_does_not_requeue_until_nonexecuting_check_reports_idle():
    collector = make_collector()
    collector.collect.side_effect = [TimeoutError(), SNAPSHOT]
    collector.kernel_state.side_effect = ['idle', 'busy', 'unknown', 'idle']
    feed = RuntimeFeed(SESSION)
    await collector.refresh(feed)
    assert feed.data['status'] == 'paused'
    await collector.refresh(feed)
    await collector.refresh(feed)
    assert collector.collect.await_count == 1
    await collector.refresh(feed)
    assert collector.collect.await_count == 2
    assert feed.data['status'] == 'ready'


@pytest.mark.asyncio
async def test_multiple_viewers_share_one_worker_and_last_disconnect_stops_it():
    collector = make_collector(interval=100, grace=.01)
    try:
        async with collector.subscribe(SESSION) as first:
            await first.get()
            async with collector.subscribe(SESSION) as second:
                await second.get()
                data = await asyncio.wait_for(first.get(), 1)
                assert data['status'] == 'ready'
                assert (await second.get())['stats'] == SNAPSHOT['stats']
                collector.collect.assert_awaited_once()
                worker = collector.feeds['runtime-1'].task
            assert not worker.done()
        await asyncio.sleep(.03)
        assert worker.done()
        assert collector.payload(collector.feeds['runtime-1'])['stats'] == SNAPSHOT['stats']
    finally:
        await collector.shutdown()


@pytest.mark.asyncio
async def test_grace_reconnect_reuses_worker_and_sends_cached_result():
    collector = make_collector(interval=100, grace=.05)
    try:
        async with collector.subscribe(SESSION) as queue:
            await queue.get()
            await asyncio.wait_for(queue.get(), 1)
            worker = collector.feeds['runtime-1'].task
        async with collector.subscribe(SESSION) as queue:
            assert (await queue.get())['stats'] == SNAPSHOT['stats']
            assert collector.feeds['runtime-1'].task is worker
            assert collector.feeds['runtime-1'].stop is None
    finally:
        await collector.shutdown()


@pytest.mark.asyncio
async def test_runtime_identity_isolates_cache_and_inactive_runtime_never_executes():
    collector = make_collector()
    old = RuntimeFeed({'name': 'test', 'runtime_id': 'old-runtime'})
    await collector.refresh(old)
    assert old.data['status'] == 'inactive'
    collector.collect.assert_not_awaited()
    collector.feeds['old-runtime'] = old
    assert SESSION['runtime_id'] not in collector.feeds  # another runtime never gets the old one's data


@pytest.mark.asyncio
async def test_slow_subscribers_only_keep_latest_update_and_failed_probe_preserves_data():
    collector = make_collector()
    feed = RuntimeFeed(SESSION)
    queue = asyncio.Queue(maxsize=1)
    feed.viewers.add(queue)
    await collector.refresh(feed)
    collector._publish(feed, status='waiting', message='busy')
    assert queue.qsize() == 1
    assert (await queue.get())['status'] == 'waiting'
    collector.collect.side_effect = ValueError('invalid snapshot')
    with pytest.raises(ValueError):
        await collector.refresh(feed)
    assert feed.data['stats'] == SNAPSHOT['stats']


@pytest.mark.asyncio
async def test_shutdown_cancels_active_collection_and_cleans_up_all_workers():
    started, cancelled = asyncio.Event(), asyncio.Event()
    collector = make_collector()

    async def collect(_name):
        started.set()
        try:
            await asyncio.Future()
        finally:
            cancelled.set()

    collector.collect = collect
    async with collector.subscribe(SESSION):
        await started.wait()
        await collector.shutdown()
        assert cancelled.is_set()
        assert collector.feeds == {}


@pytest.mark.asyncio
async def test_reconnect_during_cancellation_restarts_collection_after_cleanup():
    collector = make_collector(interval=100, grace=100)
    try:
        async with collector.subscribe(SESSION) as first:
            await first.get()
            await asyncio.wait_for(first.get(), 1)
        feed = collector.feeds['runtime-1']
        feed.stop.cancel()
        collector._stop(feed)
        old = feed.task
        async with collector.subscribe(SESSION):
            await asyncio.sleep(.01)
            assert old.cancelled()
            assert feed.task is not old
            assert collector.collect.await_count == 2
    finally:
        await collector.shutdown()
