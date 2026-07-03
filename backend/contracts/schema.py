from dataclasses import dataclass, field
from typing import List, Union, Literal, Any


@dataclass
class RegexValidator:
    type: Literal["regex"] = "regex"
    pattern: str = ""
    message: str = ""


@dataclass
class RangeValidator:
    type: Literal["range"] = "range"
    min: Any = None
    max: Any = None
    message: str = ""


ValidatorRule = Union[RegexValidator, RangeValidator]


@dataclass
class FieldDefinition:
    """Schema field definition (from canonical Schema Registry)."""
    id: str
    type: Literal["string", "number", "date", "currency"]
    required: bool = False
    validators: List[ValidatorRule] = field(default_factory=list)


@dataclass
class Schema:
    """Versioned schema that templates must reference."""
    schema_id: str
    version: int
    name: str
    fields: List[FieldDefinition] = field(default_factory=list)
