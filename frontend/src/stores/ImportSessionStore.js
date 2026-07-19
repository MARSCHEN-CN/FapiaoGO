import { assertCanTransition, isTerminal } from '../contracts/import'

class ImportSessionStore {
  constructor() {
    this.sessions = new Map()
    this.listeners = new Set()
  }

  createSession(total) {
    const id = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    const session = {
      id,
      status: 'created',
      createdAt: Date.now(),
      records: [],
      progress: {
        total,
        queued: 0,
        processing: 0,
        completed: 0,
        failed: 0,
        cancelled: 0,
      },
    }
    this.sessions.set(id, session)
    this.notify()
    return session
  }

  updateSessionStatus(sessionId, status) {
    const session = this.sessions.get(sessionId)
    if (!session) return

    if (isTerminal(session.status)) {
      return
    }

    assertCanTransition(session.status, status)
    session.status = status
    this.notify()
  }

  addRecords(sessionId, records) {
    const session = this.sessions.get(sessionId)
    if (!session) return

    session.records = [...session.records, ...records]
    this.notify()
  }

  replaceRecords(sessionId, records) {
    const session = this.sessions.get(sessionId)
    if (!session) return

    session.records = records
    this.notify()
  }

  updateRecordStatus(sessionId, recordId, status) {
    const session = this.sessions.get(sessionId)
    if (!session) return

    const record = session.records.find((r) => r.id === recordId)
    if (record) {
      record.status = status
      this.notify()
    }
  }

  updateProgress(sessionId, progress) {
    const session = this.sessions.get(sessionId)
    if (!session) return

    if (progress.total !== undefined) {
      session.progress.total = progress.total
    }
    if (progress.queued !== undefined) {
      session.progress.queued = progress.queued
    }
    if (progress.processing !== undefined) {
      session.progress.processing = progress.processing
    }
    if (progress.completed !== undefined) {
      session.progress.completed = progress.completed
    }
    if (progress.failed !== undefined) {
      session.progress.failed = progress.failed
    }
    if (progress.cancelled !== undefined) {
      session.progress.cancelled = progress.cancelled
    }
    this.notify()
  }

  incrementProgress(sessionId, type) {
    const session = this.sessions.get(sessionId)
    if (!session) return

    switch (type) {
      case 'completed':
        session.progress.completed = Math.min(session.progress.completed + 1, session.progress.total)
        break
      case 'failed':
        session.progress.failed += 1
        break
      case 'queued':
        session.progress.queued += 1
        break
      case 'processing':
        session.progress.processing += 1
        break
      case 'cancelled':
        session.progress.cancelled += 1
        break
    }
    this.notify()
  }

  getSession(sessionId) {
    return this.sessions.get(sessionId)
  }

  deleteSession(sessionId) {
    this.sessions.delete(sessionId)
    this.notify()
  }

  subscribe(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  notify() {
    this.listeners.forEach((listener) => listener())
  }
}

export const importSessionStore = new ImportSessionStore()

export function createImportSession(total) {
  return importSessionStore.createSession(total)
}

export function addFilesToSession(sessionId, records) {
  importSessionStore.addRecords(sessionId, records)
}

export function replaceFileItems(sessionId, records) {
  importSessionStore.replaceRecords(sessionId, records)
}

export function updateProgress(sessionId, progress) {
  importSessionStore.updateProgress(sessionId, progress)
}

export function updateSessionStatus(sessionId, status) {
  importSessionStore.updateSessionStatus(sessionId, status)
}

export function updateFileStatus(sessionId, fileId, status) {
  importSessionStore.updateRecordStatus(sessionId, fileId, status)
}

export function addResult(sessionId, result) {
  const session = importSessionStore.getSession(sessionId)
  if (!session) return

  const record = session.records.find((r) => r.id === result.key)
  if (record) {
    Object.assign(record, result)
    importSessionStore.notify()
  }
}