# Import State Model v2 — Design

> **This document defines the target state model for FapiaoGO's import pipeline.**
> Do not implement without design review.
>
> Part of the architecture convergence series:
> - Import Pipeline Contract v1.1 (docs/architecture/import-pipeline-v1.md)
> - V16 Render State Model
> - **This doc: Import State Model v2**
>
> Status: **Design freeze — not yet implemented**

## Motivation

Current `files[]` single-array model carries **six lifetimes**:

```javascript
files[0] {
  // 1. File metadata    — immutable after import
  name, path, fileFormat,
  // 2. Parse status      — changes ~5 times per file
  status,
  // 3. Parse result      — set once at parse completion
  amount, invoiceNumber, invoiceType, invoiceDate,
  // 4. Progress          — ephemeral, per-import-session
  // 5. Selection         — UI transient
  // 6. Preview identity  — navigation state
}
```

Problems:
- **Ownership unclear**: Who owns status? Who owns result? Both live in same object.
- **Invalidation over-broad**: A status-only update copies all 6 concerns.
- **Lifetime mismatch**: File metadata lives forever; progress is ephemeral; they share the same array slot.
- **No lifecycle hooks**: Task completion is conflated with state update.

**Core problem**: `files[]` is a UI rendering concern, not a domain model. It's being used as both.

---

## 1. Ownership Rules

### Rule 1 — One Concern, One Owner

Every piece of data has exactly one owner. No object serves multiple concerns.

| Concern | Owner | Consumer |
|---------|-------|----------|
| File identity (name, path, format) | `FileRegistry` | UI list, preview, print |
| Parse task lifecycle | `TaskRegistry` | Worker pool, progress bar |
| Parse result (invoice fields) | `DocumentState` | Invoice detail, export, preview |
| Import progress | `ProgressStore` | Progress bar |
| UI selection / preview identity | React state (transient) | Sidebar, ActionBar, PreviewCanvas |

### Rule 2 — No Worker Writes to UI State

Workers write to `TaskRegistry` and `DocumentState`. Only `BatchUIUpdater` writes to React state.

```
Worker
    ↓
TaskRegistry (Map<FileId, TaskStatus>)
DocumentState (Map<FileId, ParseResult>)
    ↓
BatchUIUpdater (snapshot → setFiles)
```

### Rule 3 — Lifecycle Separation

```
            created     mutated     destroyed
            ───────     ───────     ─────────
FileRegistry  import      never      file removed
TaskRegistry  job start   per-step   job complete
DocumentState parse done  retry      file removed
ProgressStore import start per-event import complete
UI state      per action  per action page navigation
```

### Rule 4 — Unidirectional Data Flow

```
FileRegistry ──→ TaskRegistry ──→ DocumentState
     │                │                │
     │                │                │
     └────────────────┴────────────────┘
                      │
                      v
               BatchUIUpdater
                      │
                      v
               React (snapshot only)
```

No downstream layer writes to an upstream layer's state.

---

## 2. State Objects

### FileRegistry

```typescript
interface FileRecord {
  id: string
  name: string
  path: string | null
  size: number | null
  format: 'pdf' | 'ofd' | 'image'
  source: 'dialog' | 'folder' | 'native-drop' | 'browser-drag'
  createdAt: number
}

type FileRegistry = Map<FileId, FileRecord>
```

**FileId vs React key**: `FileRecord.id` is the domain identity. React's `files[].key` is a separate concern for UI reconciliation. They MAY be the same value but MUST NOT be treated as interchangeable in domain logic.

**Invariant**: `FileRegistry` is append-only. Records are never mutated (metadata is immutable after creation).

### TaskRegistry

```typescript
interface ParseTask {
  id: string
  fileId: string
  status: TaskStatus
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
  error: string | null
}

type TaskStatus = 'queued' | 'reading' | 'parsing' | 'done' | 'failed' | 'cancelled'

type TaskRegistry = Map<TaskId, ParseTask>
```

**Transitions:**

```
 queued → reading → parsing → done
                              → failed
                              → cancelled
```

**Invariant**: Tasks are created by `TaskScheduler`, consumed by `ResultCollector`. Workers never touch `TaskRegistry` directly (they return results).

### DocumentState

```typescript
interface DocumentState {
  fileId: string
  invoiceType: string
  invoiceNumber: string
  amount: string
  invoiceDate: string
  newName: string
  parseMethod: string
  fileFormat: string
  previewImage: string | null
  invoiceFields: Record<string, unknown>
  lineItems: unknown[]
  rawText: string
  searchText: string
  // merge metadata (set by split pipeline)
  docId: string | null
  pageNum: number | null
}

type DocumentStore = Map<FileId, DocumentState>
```

**Invariant**: `DocumentState` is created once at parse completion. On retry, the entire record is replaced (no partial updates). This guarantees that downstream consumers always see a consistent document.

### ProgressStore

```typescript
interface ProgressSnapshot {
  total: number
  queued: number
  reading: number
  parsing: number
  completed: number
  failed: number
}
```

**Progress is telemetry, not a business entity.**
- Ephemeral: created when import starts, destroyed on completion.
- Write-only: only `StreamConsumer` writes to it.
- Does NOT trigger `setFiles`. Only triggers `ProgressBar` re-render.

---

## 3. Lifecycle

```
User drops files
    │
    v
FileRegistry.set(fileId, FileRecord)     ← identity created
    │
    v
TaskRegistry.set(taskId, ParseTask{queued})  ← task created
    │
    ├── [queued → reading → parsing]     ← status transitions
    │
    ├── [success]
    │       ↓
    │   DocumentState.set(fileId, result) ← document created
    │   TaskRegistry.set(taskId, {done})
    │       ↓
    │   TaskRegistry.delete(taskId)       ← task disposed
    │
    └── [failure]
            ↓
        TaskRegistry.set(taskId, {failed})
        TaskRegistry.delete(taskId)       ← task still disposed
            ↓
        (retry: new task created)
```

### When is data destroyed?

| Data | Destroy trigger |
|------|----------------|
| FileRecord | File removed by user |
| ParseTask | Task completes (success or terminal failure) |
| DocumentState | File removed (or re-parsed) |
| ProgressSnapshot | Import session ends (all files processed or error) |
| UI selection | User clicks another file or clears selection |

---

## 4. Data Flow

```
             ┌──────────────────┐
             │  FileResolver    │  ← Phase 1a
             │  resolve(path)   │
             └────────┬─────────┘
                      │
                      v
             ┌──────────────────┐
             │  FileRegistry    │
             │  create Record   │
             └────────┬─────────┘
                      │
                      v
             ┌──────────────────┐
             │  TaskScheduler   │  ← Phase 1b
             │  submitTasks()   │
             └────────┬─────────┘
                      │
          ┌───────────┴───────────┐
          │                       │
          v                       v
   ┌──────────┐           ┌──────────────┐
   │ Workers  │           │StreamConsumer│
   │ (pool)   │           │ (SSE events) │
   └────┬─────┘           └──────┬───────┘
        │                        │
        ├── result ────┐  ┌──────┘ progress
        │              │  │
        v              v  v
   ┌──────────┐  ┌──────────────┐
   │Document  │  │ProgressStore │
   │State     │  │ (ephemeral)  │
   └────┬─────┘  └──────┬───────┘
        │               │
        └───────┬───────┘
                │
                v
        ┌──────────────┐
        │BatchUIUpdater│  ← exists (Commit 2a)
        │ (snapshot)   │
        └──────┬───────┘
               │
               v
        ┌──────────────┐
        │  React       │
        │  (read-only) │
        └──────────────┘
```

---

## 5. Migration Plan

Follow the same small-commit discipline as Phase 0/0.5.

### Phase 1a — FileResolver

**Files:** `frontend/src/services/import/fileResolver.js`

**Changes:**
- Extract `FileResolver` as a standalone module
- Unified `resolve(fileInput) → Promise<File | null>` interface
- Consolidate three entry points (dialog, folder, native-drop) to use the same resolver

**Verification:**
- All three paths produce identical File objects for the same file
- No change to downstream logic (PlaceholderGenerator, workers unchanged)

### Phase 1b — TaskRegistry

**Files:** `frontend/src/services/import/taskRegistry.js`

**Changes:**
- Extract `splitQueue`/`parseQueue`/worker lifecycle into `TaskRegistry`
- `TaskRegistry.submit(FileRecord[]) → Task[]`
- `TaskRegistry.onStatusChange(id, status)` — triggers `BatchUIUpdater` via `queueUpdate`

**Verification:**
- Parse concurrency unchanged (2 workers)
- Split concurrency unchanged (4 workers)
- All status transitions match VALID_TRANSITION rules
- ProgressStore updates independently

### Phase 1c — Normalized File State

**Files:** `frontend/src/contexts/FileContext.jsx` (rewrite)

**Changes:**
- `filesById`: `Map<FileId, FileRecord>`
- `fileOrder`: `FileId[]`
- React still consumes a flat array from `BatchUIUpdater`, but writes go through the Registry

**Verification:**
- All existing consumers see the same snapshot shape
- `removeFile` becomes O(1): `filesById.delete(id); fileOrder.splice(idx, 1)`
- Status updates become O(1): no array copy

### Phase 1d — Delta Stats

**Files:** `frontend/src/contexts/FileContext.jsx`

**Changes:**
- Replace `files.reduce()` with delta-based stats
- `statsCache.apply({oldStatus, newStatus, oldAmount, newAmount})`

**Verification:**
- `totalAmount` matches `files.reduce()` result after every operation
- `printableCount` matches
- `failedFilesCount` matches

---

## 6. Forbidden Dependencies

### ❌ A — Worker holds reference to React state

```javascript
// ❌ Worker has direct access to setFiles or file state
function parseWorker() {
  const [files, setFiles] = useState()  // never
}
```

Worker receives `FileId`, returns result. Registry handles the rest.

### ❌ B — DocumentState depends on TaskRegistry

```javascript
// ❌ Document querying task status
document.invoiceNumber  // should not check task.status
```

DocumentState is created when parse completes. It does not track the parse process.

### ❌ C — UI reads FileRegistry or TaskRegistry directly

```javascript
// ❌ React component accessing registry directly
const status = taskRegistry.get(fileId).status
```

React reads `ImportSnapshot` (a flattened array), not the underlying registry.

### ❌ D — ProgressStore written from multiple sources

```javascript
// ❌ Progress updated from both SSE and worker callbacks
progressStore.increment()  // worker path
progressStore.increment()  // SSE path
```

Only `StreamConsumer` writes to `ProgressStore`. Workers return individual results.

### ❌ E — Simultaneous migration of all stores

Each Phase 1a/1b/1c/1d is an independent commit. Never combine them.
Mixing FileResolver + TaskRegistry in one commit creates an unbounded diff.

---

## Migration Checklist

Before Phase 1a begins, verify:

- [ ] `FileResolver` has no side effects (no state, no React hooks)
- [ ] All three entry points (dialog, folder, native-drop) pass through `FileResolver`
- [ ] `processPdfFile` receives File object (not null) after resolver — no `/split_pdf 400` regression
- [ ] `PlaceholderGenerator` unchanged (still `file: f.file || null`)
- [ ] `BatchUIUpdater` unchanged (still `queueUpdate → flushUpdates`)
- [ ] `ProgressStore` doesn't trigger `setFiles` (Commit 2b guarantee preserved)
- [ ] No new state management library introduced (Zustand / Jotai / Redux)
- [ ] Git diff per commit: < 100 lines changed

## Frozen

This design is frozen after architectural review. Changes require a new version.

Phase 1 implementation commits follow this document, not the other way around.
