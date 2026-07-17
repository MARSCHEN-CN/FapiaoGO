# Update Architecture (V17)

## Design principle

**一套更新逻辑。Channel 与 Source 解耦。**

```
                UpdateManager
                      │
       ┌──────────────┴──────────────┐
       │                             │
  ChannelResolver              SourceResolver
       │                             │
       ▼                             ▼
  stable / rc / dev          Official / Enterprise
       │                             │
       └──────────────┬──────────────┘
                      ▼
               UpdateService
                      │
                      ▼
             electron-updater
```

## Components

### UpdateManager (`electron/update/UpdateManager.js`)
Orchestrator. Reads config → resolves channel + source → combines URL → calls UpdateService.
Manages fallback: if primary source fails, tries fallback source.

### ChannelResolver (`electron/update/ChannelResolver.js`)
Channel name → URL path. Currently:
| Channel | Path |
|---------|------|
| stable | `/stable/` |
| rc | `/rc/` |
| dev | `/dev/` |

Adding a new channel (nightly, beta) changes ONLY this file.

### SourceResolver (`electron/update/SourceResolver.js`)
Config → base URL. Supports:
- **official**: `https://update.fapiaogo.com` (default, hardcoded)
- **enterprise**: URL from config, or **DNS auto-detect** (`update.company.local`)
  — deploy the app on any internal network, if `update.company.local` resolves,
  it automatically uses the enterprise update server. Zero config for end users.

### UpdateService (`electron/update/UpdateService.js`)
Thin wrapper around `electron-updater`. No config, no resolution logic.
Only: setFeedURL + checkForUpdates + download + install.
Also handles periodic check (every 6h) and user-facing dialogs.

## Config

```json
{
    "updateChannel": "stable",
    "updateSource": "official",
    "enterpriseUpdateUrl": "",
    "fallbackSource": "official"
}
```

## Sources

| Source | Mechanism |
|--------|-----------|
| official | Hardcoded URL: `https://update.fapiaogo.com` |
| enterprise | Config `enterpriseUpdateUrl`, or **DNS auto-detect** |

## Channels

| Channel | Use case |
|---------|----------|
| stable | Production users |
| rc | Testing / QA |
| dev | Internal development |

## Fallback

If primary source fails (network unreachable, DNS timeout, etc.),
UpdateManager automatically tries `fallbackSource`. Typical setups:
- Enterprise + official fallback
- Official + enterprise mirror fallback
- Any combination
