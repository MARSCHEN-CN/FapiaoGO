export type ImportSessionStatus =
  | 'created'
  | 'splitting'
  | 'queued'
  | 'processing'
  | 'completed'
  | 'cancelled'
  | 'failed'

export interface ImportSession {
  id: string
  status: ImportSessionStatus

  total: number
  completed: number

  createdAt: number
}

const validTransitions: Record<ImportSessionStatus, ImportSessionStatus[]> = {
  created: ['splitting', 'cancelled', 'failed'],
  splitting: ['queued', 'cancelled', 'failed'],
  queued: ['processing', 'cancelled', 'failed'],
  processing: ['completed', 'cancelled', 'failed'],
  completed: [],
  cancelled: [],
  failed: [],
}

export function assertCanTransition(current: ImportSessionStatus, next: ImportSessionStatus): void {
  if (!validTransitions[current].includes(next)) {
    throw new Error(`Invalid state transition: ${current} → ${next}`)
  }
}

export function isTerminal(status: ImportSessionStatus): boolean {
  return ['completed', 'cancelled', 'failed'].includes(status)
}