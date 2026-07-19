export type ImportTaskStatus = 'pending' | 'running' | 'paused' | 'cancelled' | 'completed'

export interface ImportTaskManager {
  taskId: string
  status: ImportTaskStatus
  abortController: AbortController

  cancel(): void
  pause(): void
  resume(): void
  isCancelled(): boolean
  isPaused(): boolean
  getSignal(): AbortSignal
}

export class ImportTaskManagerImpl implements ImportTaskManager {
  readonly taskId: string
  status: ImportTaskStatus
  abortController: AbortController

  constructor(taskId: string) {
    this.taskId = taskId
    this.status = 'pending'
    this.abortController = new AbortController()
  }

  start(): void {
    this.status = 'running'
  }

  cancel(): void {
    this.status = 'cancelled'
    this.abortController.abort()
  }

  pause(): void {
    if (this.status === 'running') {
      this.status = 'paused'
    }
  }

  resume(): void {
    if (this.status === 'paused') {
      this.status = 'running'
      this.abortController = new AbortController()
    }
  }

  isCancelled(): boolean {
    return this.status === 'cancelled'
  }

  isPaused(): boolean {
    return this.status === 'paused'
  }

  getSignal(): AbortSignal {
    return this.abortController.signal
  }
}