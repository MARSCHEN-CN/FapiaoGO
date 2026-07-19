# Phase 2-0 — Import Pipeline Ownership Audit

> **Read-only audit. No code changes.**
> Use this document to plan Phase 2 implementation.

## Current File: `frontend/src/hooks/useFileOps.js`

Current line count: **~827 lines**

## Remaining Responsibilities

### Category A: React Layer (must stay) — ~60 lines

| Lines | Responsibility | Status |
|-------|---------------|--------|
| 28-32 | React state: importing, parsing, parseProgress, isNativeDragActive | ✅ Required |
| 34-38 | settingsRef sync | ✅ Required |
| 40-85 | BatchUIUpdater (flushUpdates, scheduleFlush, queueUpdate) | ⏳ Could extract to service |
| 88-98 | TASK_STATUS enum | 💭 Could move to constants |

### Category B: Entry Handlers (UI orchestration) — ~135 lines

| Lines | Handler | Delegates to |
|-------|---------|-------------|
| 691-726 | handleNativeDrop | FileResolver (resolveFile), processFilesForAddition |
| 728-745 | handleNativeDragOver/Leave | setIsNativeDragActive |
| 750-776 | onDrop (react-dropzone) | processFilesForAddition |
| 781-796 | handleOpenDialog | FileResolver (resolveFile), processFilesForAddition |
| 801-816 | handleOpenFolder | FileResolver (resolveFile), processFilesForAddition |

✅ **Correct ownership**: Handlers only discover files, delegate reading to FileResolver, delegate processing to processFilesForAddition.

### Category C: Orchestrator (processFilesForAddition) — ~250 lines

| Lines | Step | Delegates to |
|-------|------|-------------|
| 447-456 | Step 1: Placeholder generation | `createPlaceholders()` |
| 462-472 | replaceWithItems (inline) | `setFiles()` directly |
| 478-481 | Queue init | `TaskScheduler.createQueues()/enqueueSplit()` |
| 484-486 | Progress counters | local refs |
| 489-591 | parseWorker (inline function) | `FileResolver.resolveFile()`, `TaskScheduler.dequeueParse()` |
| 594-654 | splitWorker (inline function) | `processPdfFile()`, `TaskScheduler.dequeueSplit()` |
| 657-665 | Worker start | inline for-loop |
| 667-670 | Await all workers | inline |
| 672-685 | Post-processing: sort + duplicates | `detectDuplicateInvoices()`, `applySort()` |

⚠️ **Main remaining consolidation target**: `parseWorker` and `splitWorker` are still inline functions inside `processFilesForAddition`. They could be extracted as runner functions passed to `TaskScheduler`.

### Category D: Batch Parser (parseFilesBatch) — ~135 lines

| Lines | Step | Delegates to |
|-------|------|-------------|
| 107-118 | File preparation | `FileResolver.resolveFile()` |
| 120-126 | FormData construction | inline (required, format-specific) |
| 128-135 | Status set to uploading | `setFiles()` |
| 137-151 | SSE consumption | `StreamConsumer.consumeBatchStream()` + `TaskRegistry` |
| 153-237 | Result processing | inline (parse result mapping to UI state) |

⚠️ Result processing (lines 153-237) is tightly coupled to `files[]` array shape. This is the largest remaining block that depends on the current `files[]` data structure.

### Category E: Fallback Parser (parseFiles) — ~190 lines

| Lines | Step | Delegates to |
|-------|------|-------------|
| 244-247 | Reset state | `setParsing()`, `setParseProgress()` |
| 259-278 | Try batch, fallback to concurrent | `parseFilesBatch()`, refs |
| 281-417 | Concurrent per-file parse | `FileResolver.resolveFile()`, `fetch()`, `setFiles()` |
| 419-432 | Post-process + reset | inline |

⚠️ This is the most dense section. The concurrent per-file parse loop (lines 281-417) mixes file reading, fetch, retry, status updates, and progress tracking in a single function.

## Ownership Summary

| Concern | Owner | Status |
|---------|-------|--------|
| File reading | `FileResolver` | ✅ Migrated |
| Task lifecycle | `TaskRegistry` | ✅ Migrated |
| SSE consumption | `StreamConsumer` | ✅ Migrated |
| Queue management | `TaskScheduler` | ✅ Migrated |
| Batch UI sync | inline (BatchUIUpdater) | ⏳ Could extract |
| Result processing | inline (parseFilesBatch) | ⏳ Phase 2 target |
| Worker execution | inline (parseWorker/splitWorker) | ⏳ Phase 2 target |
| Fallback concurrent parse | inline (parseFiles) | ⏳ Phase 2 target |
| Placeholder generation | `createPlaceholders()` | ✅ Extracted |
| Entry handlers | inline | ✅ Correct (orchestration only) |
| React state binding | inline | ✅ Required (React layer) |

## Phase 2 Targets (sorted by effort/impact)

| Priority | Target | Effort | Impact | Approach |
|----------|--------|--------|--------|----------|
| P1 | Extract parseWorker as TaskScheduler runner | Small | Medium | Move inline worker to runner function |
| P2 | Extract splitWorker as TaskScheduler runner | Small | Medium | Same pattern as above |
| P3 | Introduce ImportSession model | Large | High | Single root object for import session |
| P4 | Extract parseFilesBatch result mapping | Medium | Medium | Decouple parse result from setFiles shape |
| P5 | Extract fallback parseFiles retry logic | Medium | Low | Currently used only on batch failure |
| P6 | Extract BatchUIUpdater to separate module | Small | Low | Could live with flushUpdates in hook |

## Estimated After Phase 2

```
useFileOps.js: ~350 lines (down from ~827)
services/: ~5 modules (up from 4)
```

## Completed (Phase 0/1)

| Concern | Removed from useFileOps | Transferred to |
|---------|------------------------|----------------|
| IPC read-file (entry) | ~80 lines | FileResolver |
| IPC read-file (worker) | ~60 lines | FileResolver |
| SSE read + parse | ~50 lines | StreamConsumer |
| Task lifecycle | ~30 lines | TaskRegistry |
| splitQueue management | ~20 lines | TaskScheduler |
| parseQueue management | ~20 lines | TaskScheduler |
| Placeholder creation | ~15 lines | placeholderGenerator |
| IPC read for native drop | ~25 lines | FileResolver (73187379 fix) |

**Net: ~300 lines removed from useFileOps.js.**
