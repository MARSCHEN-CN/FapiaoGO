import { DEFAULT_IMPORT_POLICY } from '../contracts/import'

class MaterializedFileStore {
  constructor() {
    this.store = new Map()
    this.sessionFiles = new Map()
  }

  acquire(sessionId, recordId, file) {
    const policy = DEFAULT_IMPORT_POLICY

    const sessionCurrent = this.sessionFiles.get(sessionId) || 0
    if (sessionCurrent >= policy.maxMaterializedFiles) {
      throw new Error(`Materialization limit reached: ${policy.maxMaterializedFiles}`)
    }

    const handle = {
      id: `${sessionId}:${recordId}`,
      sessionId,
      recordId,
      file,
      createdAt: Date.now(),
      released: false,
    }

    this.store.set(handle.id, handle)
    this.sessionFiles.set(sessionId, sessionCurrent + 1)

    return handle
  }

  release(handle) {
    if (handle.released) return

    handle.released = true

    const sessionId = handle.sessionId
    this.store.delete(handle.id)

    const current = this.sessionFiles.get(sessionId) || 0
    this.sessionFiles.set(sessionId, Math.max(0, current - 1))
  }

  cleanup(sessionId) {
    const handles = Array.from(this.store.values()).filter((h) => h.sessionId === sessionId)
    handles.forEach((h) => this.release(h))
    this.sessionFiles.delete(sessionId)
  }

  getCount(sessionId) {
    return this.sessionFiles.get(sessionId) || 0
  }
}

export const materializedFileStore = new MaterializedFileStore()