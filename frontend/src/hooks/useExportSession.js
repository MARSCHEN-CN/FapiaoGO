import { useSyncExternalStore } from 'react'
import { subscribe, getActiveSession, clearActiveSession } from '../stores/ExportSessionStore'

/**
 * Export session subscription hook (Phase 5-4-3).
 *
 * Thin React binding over ExportSessionStore. Components that only need to
 * clean up export state (e.g. App.jsx ExportProgressModal onCancel/onClose)
 * consume this hook instead of importing the store directly, preserving the
 * Component → Hook → Store layering used by Import/Print pipelines.
 *
 * The export session is the single source of truth for export state; this
 * hook exposes it read-only plus a `clearExportSession` action.
 */
export function useExportSession() {
  const session = useSyncExternalStore(subscribe, getActiveSession)

  const clearExportSession = () => clearActiveSession()

  return { session, clearExportSession }
}
