import os
from pathlib import Path

import yaml


class FeatureFlags:
    USE_VNEXT_PIPELINE = "USE_VNEXT_PIPELINE"
    VNEXT_USE_GEOMETRY_ANALYZER = "VNEXT_USE_GEOMETRY_ANALYZER"
    VNEXT_USE_NEW_FIELD_EXTRACTOR = "VNEXT_USE_NEW_FIELD_EXTRACTOR"
    VNEXT_USE_FIELD_VALIDATOR = "VNEXT_USE_FIELD_VALIDATOR"
    VNEXT_USE_DECISION_ROUTER = "VNEXT_USE_DECISION_ROUTER"

    KNOWN_FLAGS = {
        USE_VNEXT_PIPELINE,
        VNEXT_USE_GEOMETRY_ANALYZER,
        VNEXT_USE_NEW_FIELD_EXTRACTOR,
        VNEXT_USE_FIELD_VALIDATOR,
        VNEXT_USE_DECISION_ROUTER,
    }

    _instance: "FeatureFlags | None" = None

    @classmethod
    def get_instance(cls) -> "FeatureFlags":
        """返回进程级单例，避免每次请求重新读取 YAML"""
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    def __init__(self, config_path: str | None = None):
        base = Path(__file__).resolve().parent.parent
        self.config_path = Path(config_path) if config_path else base / "config" / "features.yml"
        self._flags = self._load_flags()

    def _load_flags(self) -> dict[str, bool]:
        flags: dict[str, bool] = {flag: False for flag in self.KNOWN_FLAGS}
        if self.config_path.exists():
            with self.config_path.open("r", encoding="utf-8") as file_obj:
                raw = yaml.safe_load(file_obj) or {}
            for flag in self.KNOWN_FLAGS:
                if flag in raw:
                    flags[flag] = self._to_bool(raw[flag])

        for flag in self.KNOWN_FLAGS:
            env_value = os.getenv(flag)
            if env_value is not None:
                flags[flag] = self._to_bool(env_value)
        return flags

    def is_enabled(self, flag_name: str) -> bool:
        if flag_name not in self.KNOWN_FLAGS:
            return False
        if flag_name == self.USE_VNEXT_PIPELINE:
            return self._flags.get(flag_name, False)
        return self._flags.get(self.USE_VNEXT_PIPELINE, False) and self._flags.get(flag_name, False)

    @staticmethod
    def _to_bool(value) -> bool:
        if isinstance(value, bool):
            return value
        return str(value).strip().lower() in {"1", "true", "yes", "on"}
