from __future__ import annotations

import json
import threading
from datetime import datetime, timezone
from pathlib import Path
from queue import Empty, Queue
from typing import Any, Dict, List, Optional


class AuditLogger:
    def __init__(self, file_path: str | None = None, max_queue_size: int = 1000):
        if file_path is None:
            base = Path(__file__).resolve().parent.parent
            file_path = str(base / "database" / "audit_events.json")

        self.file_path = Path(file_path)
        self.file_path.parent.mkdir(parents=True, exist_ok=True)
        
        self._file_lock = threading.Lock()
        self._events: List[Dict[str, Any]] = self._load_events_from_disk()
        
        self._dirty = False
        self._queue: Queue[Optional[Dict[str, Any]]] = Queue(maxsize=max_queue_size)
        self._stop_event = threading.Event()
        self._worker = threading.Thread(target=self._run, name="audit-logger", daemon=True)
        self._worker.start()

    def log_event(
        self,
        correlation_id: str,
        document_id: str,
        stage: str,
        details: Optional[Dict[str, Any]] = None,
        **extra: Any,
    ) -> None:
        payload_details = dict(details or {})
        reserved = {
            "timestamp": extra.pop("timestamp", datetime.now(timezone.utc).isoformat()),
            "status": extra.pop("status", "SUCCESS"),
            "input_hash": extra.pop("input_hash", ""),
            "output_hash": extra.pop("output_hash", ""),
            "context_snapshot": extra.pop("context_snapshot", None),
            "error_details": extra.pop("error_details", None),
            "start_time": extra.pop("start_time", None),
            "end_time": extra.pop("end_time", None),
        }
        context = extra.pop("context", None)
        if context and isinstance(context, dict):
            payload_details.update(context)
        payload_details.update(extra)
        event = {
            "correlation_id": correlation_id,
            "document_id": document_id,
            "stage": stage,
            "details": payload_details,
            **reserved,
        }
        self._queue.put(event)

    def get_events(self, correlation_id: str) -> List[Dict[str, Any]]:
        self.drain()
        with self._file_lock:
            events = list(self._events)
        return [event for event in events if event.get("correlation_id") == correlation_id]

    def drain(self, timeout: float = 5.0) -> None:
        self._queue.join()

    def close(self, timeout: float = 5.0) -> None:
        if self._stop_event.is_set():
            return
        self.drain(timeout=timeout)
        self._stop_event.set()
        self._queue.put(None)
        self._worker.join(timeout=timeout)
        with self._file_lock:
            if self._dirty:
                self._flush_to_disk_unlocked()

    def _run(self) -> None:
        while True:
            try:
                item = self._queue.get(timeout=0.1)
            except Empty:
                if self._stop_event.is_set():
                    with self._file_lock:
                        if self._dirty:
                            self._flush_to_disk_unlocked()
                    break
                continue

            if item is None:
                self._queue.task_done()
                with self._file_lock:
                    if self._dirty:
                        self._flush_to_disk_unlocked()
                break

            try:
                self._append_event(item)
            finally:
                self._queue.task_done()

    def _append_event(self, event: Dict[str, Any]) -> None:
        with self._file_lock:
            self._events.append(event)
            self._dirty = True
            self._flush_to_disk_unlocked()

    def _load_events_from_disk(self) -> List[Dict[str, Any]]:
        try:
            raw = self.file_path.read_text(encoding="utf-8").strip()
        except FileNotFoundError:
            return []
        if not raw:
            return []
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            return []
        return data if isinstance(data, list) else []

    def _flush_to_disk_unlocked(self) -> None:
        self.file_path.write_text(
            json.dumps(self._events, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        self._dirty = False
