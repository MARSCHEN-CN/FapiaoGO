# Update Architecture (V2 — 2026-07-17)

## Design principle

**Manager 是编排器，不读配置。Resolver 是纯函数。Provider 可插拔。Client 可替换。**

## Architecture

```
        ConfigService.load()
               │
     ┌─────────┴─────────┐
     │                   │
ChannelResolver    SourceProvider
(纯函数)            (可插拔)
     │                   │
     └─────────┬─────────┘
               │
         UpdateManager
         (编排器)
               │
               ▼
        IUpdateClient
               │
     ┌─────────┴─────────┐
     │                   │
ElectronUpdater    MockUpdater
(packaged)         (dev)
```

## Files

```
electron/
└── services/
    ├── ConfigService.js          ← 共享配置读写
    └── Update/
        ├── UpdateManager.js      ← 编排器
        ├── ChannelResolver.js    ← 纯函数：渠道名 → URL path
        ├── providers/
        │   ├── BaseProvider.js       ← 接口规范
        │   ├── OfficialProvider.js   ← 官方源
        │   └── EnterpriseProvider.js ← 企业源（含 DNS 自动发现）
        └── clients/
            ├── BaseClient.js            ← 接口规范
            ├── ElectronUpdaterClient.js ← 生产客户端
            └── MockUpdaterClient.js     ← 开发客户端
```

## Adding a new source (GitHub, Local, Mirror…)

1. Create `services/Update/providers/YourProvider.js`
2. Implement `resolve(channel)` → `{ url }`
3. Add case to `UpdateManager.createProvider()`

No other code changes. **Open/Closed Principle.**

## Adding a new client (HttpUpdater…)

1. Create `services/Update/clients/YourClient.js`
2. Implement `check(url)`, `download()`, `quitAndInstall()`
3. Pass to `UpdateManager` (inject via options or swap in main.js)

No other code changes.

## Config (`userData/config.json`)

```json
{
    "updateChannel": "stable",
    "updateSource": "official",
    "enterpriseUpdateUrl": "",
    "fallbackSource": "official"
}
```
