"""
RenderQueue — priority-based task queue for rendering jobs.
Supports idle-callback and memory-pressure hooks.

Priority levels (lower number = higher priority):
    current    = 0   Active page (user is looking at it)
    next       = 1   Neighbor prefetch (page ±1)
    thumbnail  = 2   List thumbnail generation
    background = 3   Everything else
"""

import logging
import threading
import time
from dataclasses import dataclass, field
from typing import Callable, Dict, Optional

logger = logging.getLogger(__name__)

PRIORITY = {"current": 0, "next": 1, "thumbnail": 2, "background": 3}
PRIORITY_NAMES = {v: k for k, v in PRIORITY.items()}


@dataclass(order=True)
class QueueTask:
    """A render task in the priority queue. Sortable by (priority, enqueue_time)."""
    priority: int = PRIORITY["background"]
    enqueue_time: float = field(default_factory=time.time, compare=False)
    task_id: str = field(default="", compare=False)
    fn: Optional[Callable] = field(default=None, compare=False)
    args: tuple = field(default=(), compare=False)
    kwargs: dict = field(default_factory=dict, compare=False)


class RenderQueue:
    """
    Thread-safe priority queue for render jobs.

    Usage:
        q = RenderQueue(on_idle=lambda: prefetch_next())
        q.submit("current", engine.render, doc, preset, view_state, page)
    """

    MAX_QUEUE = 200

    def __init__(self, on_idle: Callable = None,
                 on_memory_pressure: Callable = None):
        self._on_idle = on_idle
        self._on_memory_pressure = on_memory_pressure
        self._lock = threading.Lock()
        self._pending = 0
        self._completed = 0
        self._background_paused = False

    # ── public ──────────────────────────────────────────────────

    def submit(self, priority: str, fn: Callable, *args, **kwargs) -> str:
        """
        Submit a render task. Runs immediately in a daemon thread.
        Returns task_id for tracking.
        """
        prio = PRIORITY.get(priority, PRIORITY["background"])

        if prio >= PRIORITY["background"] and self._background_paused:
            logger.debug("background tasks paused (memory-pressure), skipping")
            return ""

        task_id = _make_task_id(fn, args)
        task = QueueTask(priority=prio, task_id=task_id, fn=fn,
                         args=args, kwargs=kwargs)

        with self._lock:
            self._pending += 1

        t = threading.Thread(target=self._run_task, args=(task,), daemon=True)
        t.start()
        return task_id

    def on_idle(self):
        """Called when the renderer is idle (e.g. 300ms after first paint)."""
        logger.debug("RenderQueue idle callback triggered")
        if self._on_idle:
            try:
                self._on_idle()
            except Exception as e:
                logger.exception("on_idle callback error: %s", e)

    def on_memory_pressure(self):
        """Called when Electron reports memory pressure."""
        logger.info("memory-pressure received, pausing background + invoking handler")
        self._background_paused = True
        if self._on_memory_pressure:
            try:
                self._on_memory_pressure()
            except Exception as e:
                logger.exception("on_memory_pressure callback error: %s", e)

    def resume_background(self):
        """Resume background tasks after memory pressure subsides."""
        self._background_paused = False
        logger.debug("background tasks resumed")

    @property
    def stats(self) -> dict:
        with self._lock:
            return {
                "pending": self._pending,
                "completed": self._completed,
                "background_paused": self._background_paused,
            }

    # ── internal ────────────────────────────────────────────────

    def _run_task(self, task: QueueTask):
        try:
            task.fn(*task.args, **task.kwargs)
        except Exception as e:
            logger.exception("RenderQueue task %s failed: %s", task.task_id[:24], e)
        finally:
            with self._lock:
                self._pending = max(0, self._pending - 1)
                self._completed += 1


def _make_task_id(fn: Callable, args: tuple) -> str:
    """Generate a short task id for logging.

    Args may contain unhashable types (e.g. dict view-state), so we serialize
    with json (falling back to repr) instead of calling hash() directly.
    """
    import hashlib, json
    try:
        key = json.dumps(args, default=str, sort_keys=True)
    except (TypeError, ValueError):
        key = repr(args)
    raw = f"{fn.__name__ if hasattr(fn, '__name__') else str(fn)}:{key}"
    return hashlib.md5(raw.encode()).hexdigest()[:16]
