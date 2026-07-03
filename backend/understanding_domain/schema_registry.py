import json
from pathlib import Path
from typing import List

from contracts.schema import (
    FieldDefinition,
    RangeValidator,
    RegexValidator,
    Schema,
    ValidatorRule,
)


class SchemaRegistry:
    """Load and query versioned Schema definitions from JSON files."""

    def __init__(self, schemas_dir: str | None = None) -> None:
        default_dir = Path(__file__).resolve().parent.parent / "schemas"
        self.schemas_dir = Path(schemas_dir) if schemas_dir is not None else default_dir
        self._schemas: dict[tuple[str, int], Schema] = {}
        self._load_schemas()

    def _load_schemas(self) -> None:
        if not self.schemas_dir.exists():
            return

        for schema_file in sorted(self.schemas_dir.glob("*.json")):
            with schema_file.open("r", encoding="utf-8") as file_obj:
                raw_schema = json.load(file_obj)
            schema = self._schema_from_dict(raw_schema)
            self._schemas[(schema.schema_id, schema.version)] = schema

    @staticmethod
    def _schema_from_dict(raw_schema: dict) -> Schema:
        fields = [
            FieldDefinition(
                id=field_data["id"],
                type=field_data["type"],
                required=field_data.get("required", False),
                validators=SchemaRegistry._parse_validators(
                    field_data.get("validators", [])
                ),
            )
            for field_data in raw_schema.get("fields", [])
        ]
        return Schema(
            schema_id=raw_schema["schema_id"],
            version=raw_schema["version"],
            name=raw_schema.get("name", ""),
            fields=fields,
        )

    @staticmethod
    def _parse_validators(raw_list: list) -> List[ValidatorRule]:
        result: List[ValidatorRule] = []
        for item in raw_list:
            vtype = item.get("type", "")
            if vtype == "regex":
                result.append(RegexValidator(
                    pattern=item.get("pattern", ""),
                    message=item.get("message", ""),
                ))
            elif vtype == "range":
                result.append(RangeValidator(
                    min=item.get("min"),
                    max=item.get("max"),
                    message=item.get("message", ""),
                ))
        return result

    def get_schema(self, schema_id: str, version: int) -> Schema:
        key = (schema_id, version)
        if key not in self._schemas:
            raise KeyError(f"Schema not found: {schema_id}@{version}")
        return self._schemas[key]

    def list_schemas(self) -> List[Schema]:
        return list(self._schemas.values())
