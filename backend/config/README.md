# Feature Flags

`FeatureFlags` reads configuration from `config/features.yml` first, then allows environment variables to override individual flags.

## Available flags

- `USE_VNEXT_PIPELINE`
- `VNEXT_USE_TEXT_CLEANER`
- `VNEXT_USE_GEOMETRY_ANALYZER`
- `VNEXT_USE_NEW_FIELD_EXTRACTOR`
- `VNEXT_USE_FIELD_VALIDATOR`
- `VNEXT_USE_DECISION_ROUTER`
- `VNEXT_USE_LEARNING_LOOP`

## Resolution rules

1. `config/features.yml` provides the default values.
2. Environment variables override matching flag names.
3. When `USE_VNEXT_PIPELINE` is `false`, all fine-grained flags are treated as disabled.
