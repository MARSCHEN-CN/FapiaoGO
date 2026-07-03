import json
import os
import threading
from typing import List, Optional

from contracts.template import ExtractionRule, Template, ValidationRule


class TemplateRepository:
    def __init__(self, templates_dir: str):
        self._templates_dir = templates_dir
        self._templates: dict = {}
        self._active: dict = {}
        self._lock = threading.Lock()
        self._load_all(templates_dir)

    def _load_all(self, dir_path: str):
        if not os.path.isdir(dir_path):
            return
        new_templates: dict = {}
        new_active: dict = {}
        for file_name in os.listdir(dir_path):
            if file_name.endswith(".json"):
                try:
                    with open(os.path.join(dir_path, file_name), "r", encoding="utf-8") as file_obj:
                        data = json.load(file_obj)
                except (OSError, json.JSONDecodeError):
                    continue
                template = Template(
                    template_id=data["template_id"],
                    version=data["version"],
                    status=data["status"],
                    schema_id=data["schema_id"],
                    schema_version=data["schema_version"],
                    fingerprint=data.get("fingerprint", {}),
                    extraction_rules=[ExtractionRule(**rule) for rule in data.get("extraction_rules", [])],
                    validation_rules=[ValidationRule(**rule) for rule in data.get("validation_rules", [])],
                    match_key=data.get("match_key", ""),
                )
                key = (template.template_id, template.version)
                new_templates[key] = template
                if template.status == "ACTIVE":
                    if (
                        template.template_id not in new_active
                        or new_active[template.template_id] < template.version
                    ):
                        new_active[template.template_id] = template.version
        self._templates = new_templates
        self._active = new_active

    def get_active_template(self, template_id: str) -> Optional[Template]:
        version = self._active.get(template_id)
        if version:
            return self._templates.get((template_id, version))
        return None

    def get_all_templates(self) -> List[Template]:
        return list(self._templates.values())

    def reload(self) -> bool:
        """热重载：重新读取模板目录下所有 JSON 文件并更新内部缓存。
        
        线程安全：使用写锁保护，不影响正在进行的读取操作。
        重载失败时保留旧缓存，不抛异常。
        
        Returns:
            True 表示重载成功，False 表示失败（旧缓存保留）。
        """
        try:
            with self._lock:
                saved_templates = dict(self._templates)
                saved_active = dict(self._active)
                try:
                    self._load_all(self._templates_dir)
                    return True
                except Exception:
                    self._templates = saved_templates
                    self._active = saved_active
                    return False
        except Exception:
            return False
