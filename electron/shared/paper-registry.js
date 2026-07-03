/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  PAPER REGISTRY — Single Source of Truth                        ║
 * ║                                                                  ║
 * ║  All paper size definitions in the system originate here.        ║
 * ║  No widthMM / heightMM / label values may exist outside this     ║
 * ║  file. Any consumer that needs paper data must import from here. ║
 * ║                                                                  ║
 * ║  To add a new paper size, edit this file only.                   ║
 * ║  All consumers (preview, print, UI) will automatically adapt.    ║
 * ║                                                                  ║
 * ║  System papers:  source-controlled, immutable at runtime         ║
 * ║  User papers:    stored in app.getPath('userData'), mutable      ║
 * ║  Effective:      computed = system + user, never persisted       ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

'use strict'

// ─── System Papers ────────────────────────────────────────────────

const SYSTEM_PAPERS = [
  { id: 'A4',            label: 'A4',                  widthMM: 210,   heightMM: 297,   source: 'system' },
  { id: 'A5',            label: 'A5',                  widthMM: 148,   heightMM: 210,   source: 'system' },
  { id: 'A3',            label: 'A3',                  widthMM: 297,   heightMM: 420,   source: 'system' },
  { id: 'Letter',        label: 'Letter',              widthMM: 215.9, heightMM: 279.4, source: 'system' },
  { id: 'Voucher240x140',label: '凭证纸',    widthMM: 240,   heightMM: 140,   source: 'system' },
  // Runtime custom paper: selector only, no widthMM/heightMM
  { id: 'Custom',        label: '自定义尺寸',           widthMM: 0,     heightMM: 0,     source: 'system' },
]

// ─── Compatibility / UI Views ──────────────────────────────────────

// PAPER_REGISTRY: array for UI consumers (frontend)
const PAPER_REGISTRY = SYSTEM_PAPERS

// PAPER_SIZE_MAP: object form for backward compatibility
const PAPER_SIZE_MAP = Object.fromEntries(
  SYSTEM_PAPERS.filter(p => p.widthMM > 0).map(p => [p.id, { widthMM: p.widthMM, heightMM: p.heightMM }])
)

// PAPER_LABEL_MAP: label lookup
const PAPER_LABEL_MAP = Object.fromEntries(
  SYSTEM_PAPERS.map(p => [p.id, p.label])
)

// ─── Effective Registry Builder ────────────────────────────────────

/**
 * Build effective registry from system papers + user papers.
 *
 * Rules (from USER_PAPER_CONTRACT.md):
 * - System papers always first, in defined order
 * - User papers sorted by createdAt DESC
 * - User papers with duplicate ids (matching system ids) are silently dropped
 * - Invalid user papers (failed validation) are silently dropped
 *
 * @param {Array} userPapers - from UserPaperStore.load()
 * @returns {Array} effectivePapers
 */
function buildEffectiveRegistry(userPapers) {
  const systemIds = new Set(SYSTEM_PAPERS.map(p => p.id))

  // Filter valid, non-duplicate user papers
  const validUserPapers = (userPapers || []).filter(p => {
    if (!p || typeof p !== 'object') return false
    if (!p.id || !p.label) return false
    if (typeof p.widthMM !== 'number' || typeof p.heightMM !== 'number') return false
    if (p.widthMM < 50 || p.widthMM > 1000) return false
    if (p.heightMM < 50 || p.heightMM > 1000) return false
    // Drop user papers whose id conflicts with system papers
    if (systemIds.has(p.id)) {
      console.warn(`[PaperRegistry] Dropping user paper "${p.id}": conflicts with system paper`)
      return false
    }
    return true
  })

  // Sort by createdAt DESC (newest first)
  const sortedUserPapers = [...validUserPapers].sort((a, b) => {
    const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0
    const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0
    return bTime - aTime
  })

  // Ensure all papers have source field
  const systemWithSource = SYSTEM_PAPERS.map(p => ({
    ...p,
    source: 'system',
  }))

  return [...systemWithSource, ...sortedUserPapers]
}

/**
 * Rebuild compatibility maps from effective registry.
 *
 * @param {Array} effectivePapers - from buildEffectiveRegistry()
 * @returns {{ sizeMap: object, labelMap: object }}
 */
function buildCompatibilityMaps(effectivePapers) {
  const sizeMap = {}
  const labelMap = {}
  for (const p of effectivePapers) {
    sizeMap[p.id] = { widthMM: p.widthMM, heightMM: p.heightMM }
    labelMap[p.id] = p.label
  }
  return { sizeMap, labelMap }
}

module.exports = {
  // System papers (immutable)
  SYSTEM_PAPERS,

  // UI registry array for frontend
  PAPER_REGISTRY,

  // Backward-compatible maps
  PAPER_SIZE_MAP,
  PAPER_LABEL_MAP,

  // Effective registry builder (system + user)
  buildEffectiveRegistry,
  buildCompatibilityMaps,
}
