"""
DecisionRouter — route invoices by extraction quality.
PASS/WARN → export_ready
FAIL     → review_queue (人工审核)
"""

import json
import os
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional


class DecisionRouter:
    """
    Route extracted fields based on validator_status.
    Stores routing decisions in JSON files under database/review_queue/.
    """

    def __init__(self, store_dir: str | None = None):
        if store_dir is None:
            base = Path(__file__).resolve().parent.parent
            store_dir = str(base / "database" / "review_queue")
        self.store_dir = Path(store_dir)
        self.store_dir.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        # 文件名索引（惰性构建）
        self._file_name_index: Dict[str, str] = {}  # {file_name_lower: record_id}
        self._index_built: bool = False

    def route(
        self,
        fields: List[Any],
        correlation_id: str,
        document_id: str,
        file_name: str = "",
    ) -> Dict[str, Any]:
        """
        Route based on validator_status of extracted fields.

        Args:
            fields: List[ExtractedField] or list of dicts with 'validator_status' and 'field_id'
            correlation_id: request correlation ID
            document_id: document hash ID
            file_name: original file name

        Returns:
            {"status": "export_ready" | "review_queue" | "exception_queue",
             "reason": "...",
             "failed_fields": [...]}
        """
        # Detect if fields is ExtractedField objects or plain dicts
        fail_names: List[str] = []
        all_fields: List[Dict[str, Any]] = []
        for field in fields:
            if hasattr(field, 'validator_status'):
                # ExtractedField object
                f_id = field.field_id
                status = field.validator_status
                val = field.value
                all_fields.append({"field_id": f_id, "value": val, "status": status})
                if status == "FAIL":
                    fail_names.append(f_id)
            elif isinstance(field, dict):
                f_id = field.get("field_id", "")
                status = field.get("validator_status", "")
                all_fields.append(field)
                if status == "FAIL":
                    fail_names.append(f_id)

        if fail_names:
            self._write_review_queue(
                correlation_id, document_id, file_name, all_fields, fail_names
            )
            return {
                "status": "review_queue",
                "reason": f"存在校验失败字段: {fail_names}",
                "failed_fields": fail_names,
            }

        self._write_export_ready(correlation_id, document_id, file_name, all_fields)
        return {
            "status": "export_ready",
            "reason": "所有字段 PASS/WARN",
            "failed_fields": [],
        }

    def route_exception(
        self,
        correlation_id: str,
        document_id: str,
        file_name: str = "",
        reason: str = "",
    ) -> Dict[str, Any]:
        """Route a document that failed before extraction (e.g. template miss)."""
        self._write_exception_queue(correlation_id, document_id, file_name, reason)
        return {
            "status": "exception_queue",
            "reason": reason or "未知异常",
            "failed_fields": [],
        }

    # ── Storage ────────────────────────────────────────────────────────

    def _write_export_ready(
        self, correlation_id: str, document_id: str,
        file_name: str, fields: List[Dict],
    ) -> str:
        record = {
            "id": f"{document_id}_{correlation_id}",
            "correlation_id": correlation_id,
            "document_id": document_id,
            "file_name": file_name,
            "status": "export_ready",
            "field_count": len(fields),
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        return self._save_record(record, "export_ready")

    def _write_review_queue(
        self, correlation_id: str, document_id: str,
        file_name: str, fields: List[Dict], fail_names: List[str],
    ) -> str:
        record = {
            "id": f"{document_id}_{correlation_id}",
            "correlation_id": correlation_id,
            "document_id": document_id,
            "file_name": file_name,
            "extracted_fields": json.dumps(fields, ensure_ascii=False, default=str),
            "fail_reasons": json.dumps(fail_names, ensure_ascii=False),
            "status": "pending",
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        return self._save_record(record, "review_queue")

    def _write_exception_queue(
        self, correlation_id: str, document_id: str,
        file_name: str, reason: str,
    ) -> str:
        record = {
            "id": f"{document_id}_{correlation_id}",
            "correlation_id": correlation_id,
            "document_id": document_id,
            "file_name": file_name,
            "reason": reason,
            "status": "pending",
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        return self._save_record(record, "exception_queue")

    def _save_record(self, record: dict, subdir: str) -> str:
        dir_path = self.store_dir / subdir
        dir_path.mkdir(parents=True, exist_ok=True)
        file_path = dir_path / f"{record['id']}.json"
        with self._lock:
            file_path.write_text(
                json.dumps(record, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            # 同步更新文件名索引（仅对 review_queue）
            if subdir == "review_queue" and self._index_built:
                file_name = record.get("file_name", "")
                if file_name:
                    key = file_name.strip().lower()
                    self._file_name_index[key] = record["id"]
        return str(file_path)

    # ── Query API ──────────────────────────────────────────────────────

    def list_review_queue(self, status: str = "pending") -> List[Dict]:
        """List review queue entries, optionally filtered by status."""
        dir_path = self.store_dir / "review_queue"
        if not dir_path.exists():
            return []
        results: List[Dict] = []
        for f in sorted(dir_path.glob("*.json"), reverse=True):
            try:
                record = json.loads(f.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError):
                continue
            if status and record.get("status") != status:
                continue
            results.append(record)
        return results

    def _build_file_name_index(self) -> None:
        """构建文件名索引（惰性构建，首次查询时调用）"""
        if self._index_built:
            return
        
        dir_path = self.store_dir / "review_queue"
        if not dir_path.exists():
            self._index_built = True
            return
        
        with self._lock:
            self._file_name_index.clear()
            for f in dir_path.glob("*.json"):
                try:
                    record = json.loads(f.read_text(encoding="utf-8"))
                    file_name = record.get("file_name", "")
                    if file_name:
                        # 统一使用 strip + lower 作为索引键
                        key = file_name.strip().lower()
                        self._file_name_index[key] = f.stem  # f.stem = record_id
                except (json.JSONDecodeError, OSError):
                    continue
            self._index_built = True

    def get_review_by_id(self, record_id: str) -> Optional[Dict]:
        """直接读取单个审核记录（按 ID，O(1) 复杂度）"""
        file_path = self.store_dir / "review_queue" / f"{record_id}.json"
        if not file_path.exists():
            return None
        try:
            return json.loads(file_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return None

    def get_review_by_file_name(self, file_name: str) -> Optional[Dict]:
        """按文件名查找审核记录（使用索引，O(1) 复杂度）"""
        # 确保索引已构建（内部已加锁）
        self._build_file_name_index()

        # 索引读取在锁保护下进行，防止 TOCTOU 竞态
        # （_save_record 写入时可能在另一个线程中更新索引）
        key = file_name.strip().lower()
        with self._lock:
            record_id = self._file_name_index.get(key)
        if not record_id:
            return None

        # 通过 ID 直接读取
        return self.get_review_by_id(record_id)

    def resolve_review(
        self, record_id: str, corrected_fields: Dict[str, Any] = None
    ) -> bool:
        """Mark a review queue entry as resolved."""
        dir_path = self.store_dir / "review_queue"
        file_path = dir_path / f"{record_id}.json"
        if not file_path.exists():
            return False
        with self._lock:
            try:
                record = json.loads(file_path.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError):
                return False
            record["status"] = "resolved"
            record["resolved_at"] = datetime.now(timezone.utc).isoformat()
            if corrected_fields:
                record["corrected_fields"] = corrected_fields
            file_path.write_text(
                json.dumps(record, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
        return True

    def list_exception_queue(self, status: str = "pending") -> List[Dict]:
        dir_path = self.store_dir / "exception_queue"
        if not dir_path.exists():
            return []
        results: List[Dict] = []
        for f in sorted(dir_path.glob("*.json"), reverse=True):
            try:
                record = json.loads(f.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError):
                continue
            if status and record.get("status") != status:
                continue
            results.append(record)
        return results
