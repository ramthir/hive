"""One bounded collector per runtime, shared by visible SSE subscribers."""
import asyncio
import logging
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import datetime, timezone

logger = logging.getLogger(__name__)


@dataclass
class RuntimeFeed:
    session: dict
    data: dict = field(default_factory=lambda: {
        'status': 'loading', 'stats': None, 'processes': [], 'last_updated': None,
        'message': '',
    })
    viewers: set = field(default_factory=set)
    task: asyncio.Task | None = None
    stop: asyncio.TimerHandle | None = None


class ColabCollector:
    def __init__(self, *, sessions, kernel_state, collect, interval=30, grace=10):
        self.sessions = sessions
        self.kernel_state = kernel_state
        self.collect = collect
        self.interval = interval
        self.grace = grace
        self.feeds = {}

    @staticmethod
    def payload(feed):
        return {**feed.data, 'session': feed.session}

    def _publish(self, feed, **values):
        feed.data = {**feed.data, **values}
        for queue in tuple(feed.viewers):
            if queue.full():
                queue.get_nowait()
            queue.put_nowait(self.payload(feed))

    @asynccontextmanager
    async def subscribe(self, session):
        runtime_id = session['runtime_id']
        feed = self.feeds.setdefault(runtime_id, RuntimeFeed(session))
        feed.session = session
        if feed.data.get('status') == 'inactive':
            feed.data = {**feed.data, 'status': 'loading', 'message': ''}
        if feed.stop:
            feed.stop.cancel()
            feed.stop = None
        queue = asyncio.Queue(maxsize=1)
        feed.viewers.add(queue)
        queue.put_nowait(self.payload(feed))
        if feed.task is None or feed.task.done():
            self._start(feed)
        try:
            yield queue
        finally:
            feed.viewers.discard(queue)
            if not feed.viewers:
                feed.stop = asyncio.get_running_loop().call_later(self.grace, self._stop, feed)

    def _start(self, feed):
        task = asyncio.create_task(self._run(feed))
        feed.task = task

        def finished(completed):
            # A viewer can return while the no-viewer cancellation is cleaning up.
            if feed.task is completed and completed.cancelled() and feed.viewers:
                self._start(feed)

        task.add_done_callback(finished)

    def _stop(self, feed):
        feed.stop = None
        if not feed.viewers and feed.task and not feed.task.done():
            feed.task.cancel()
        if not feed.viewers and feed.data.get('status') == 'inactive':
            self.feeds.pop(feed.session['runtime_id'], None)

    async def refresh(self, feed):
        """Never send execution while state is busy, unknown, or unavailable."""
        active = await self.sessions()
        matched = next((s for s in active if s['runtime_id'] == feed.session['runtime_id']), None)
        if matched is None:
            self._publish(feed, status='inactive', message='This Colab runtime is no longer active.')
            return
        feed.session = matched
        state = await self.kernel_state(matched['name'], matched['runtime_id'])
        if state != 'idle':
            self._publish(feed, status='waiting', message=(
                'Notebook kernel is busy; monitoring is paused. Showing the last collected data.'
                if state == 'busy' else 'Kernel availability is unknown; monitoring is paused.'
            ))
            return
        try:
            snapshot = await self.collect(matched['name'])
        except TimeoutError:
            self._publish(feed, status='paused', message='Status collection timed out. Waiting for an idle kernel before retrying.')
            return
        self._publish(feed, status='ready', message='', stats=snapshot['stats'],
                      processes=snapshot['processes'], last_updated=datetime.now(timezone.utc).isoformat())

    async def _run(self, feed):
        logger.info('colab.collector.started', extra={'runtime_id': feed.session['runtime_id']})
        try:
            while True:
                try:
                    await self.refresh(feed)
                except asyncio.CancelledError:
                    raise
                except Exception:
                    # Do not log upstream credentials, raw URLs or CLI error output.
                    logger.warning('colab.collector.failed', extra={'runtime_id': feed.session['runtime_id']})
                    self._publish(feed, status='unavailable', message='Unable to collect Colab status. Monitoring will check kernel availability before retrying.')
                await asyncio.sleep(self.interval)
        finally:
            logger.info('colab.collector.stopped', extra={'runtime_id': feed.session['runtime_id']})

    async def shutdown(self):
        tasks = []
        for feed in self.feeds.values():
            if feed.stop:
                feed.stop.cancel()
            if feed.task and not feed.task.done():
                feed.task.cancel()
                tasks.append(feed.task)
        for feed in self.feeds.values():
            feed.viewers.clear()
        await asyncio.gather(*tasks, return_exceptions=True)
        self.feeds.clear()
