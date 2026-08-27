/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  UserPaperStore — User-Defined Paper Persistence                ║
 * ║                                                                  ║
 * ║  Contract: USER_PAPER_CONTRACT.md (Section 2.3, 4)              ║
 * ║  Location: DATA_ROOT/paper-registry/  (Contract v1.1, 跟程序走)  ║
 * ║                                                                  ║
 * ║  Rules:                                                          ║
 * ║  - Not source-controlled (in DATA_ROOT)                           ║
 * ║  - Survives app restart and update                               ║
 * ║  - Editable through future Settings UI                           ║
 * ║  - Atomic writes (write temp + rename)                           ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

'use strict'

const fs = require('fs')
const path = require('path')
const { app } = require('electron')
const { getDataRoot } = require('./data-root')

// ─── Constants ───────────────────────────────────────────────────

const FILE_NAME = 'user-papers.json'
const STORAGE_VERSION = 1

const MIN_WIDTH_MM = 50
const MAX_WIDTH_MM = 1000
const MIN_HEIGHT_MM = 50
const MAX_HEIGHT_MM = 1000
const MAX_LABEL_LENGTH = 100

// ─── Helpers ─────────────────────────────────────────────────────

function getStorageDir() {
  return path.join(getDataRoot(), 'paper-registry')
}

function getStoragePath() {
  return path.join(getStorageDir(), FILE_NAME)
}

/**
 * Ensure the storage directory and file exist.
 * Called on every load() to recover from manual deletion.
 */
function ensureStorage() {
  const dir = getStorageDir()
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  const filePath = getStoragePath()
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify({ version: STORAGE_VERSION, papers: [] }, null, 2), 'utf-8')
  }
}

// ─── ID Generation ───────────────────────────────────────────────

let _lastIdTimestamp = 0

/**
 * Generate a unique paper ID.
 * Format: user_<epochMs>
 * Collision-safe: retries with +1ms if called in same millisecond.
 */
function generatePaperId() {
  let ts = Date.now()
  // Prevent collision within the same millisecond
  if (ts <= _lastIdTimestamp) {
    ts = _lastIdTimestamp + 1
  }
  _lastIdTimestamp = ts
  return `user_${ts}`
}

// ─── Read / Write ────────────────────────────────────────────────

/**
 * Read user papers from disk.
 * @returns {object} { papers: Array, version: number }
 */
function readStore() {
  ensureStorage()
  const filePath = getStoragePath()
  try {
    const raw = fs.readFileSync(filePath, 'utf-8')
    const data = JSON.parse(raw)
    if (!data || typeof data !== 'object') {
      console.warn('[UserPaperStore] Corrupted data: not an object. Resetting.')
      return { papers: [], version: STORAGE_VERSION }
    }
    if (!Array.isArray(data.papers)) {
      console.warn('[UserPaperStore] Corrupted data: papers is not an array. Resetting.')
      return { papers: [], version: STORAGE_VERSION }
    }
    return data
  } catch (err) {
    console.warn(`[UserPaperStore] Failed to read: ${err.message}. Resetting.`)
    return { papers: [], version: STORAGE_VERSION }
  }
}

/**
 * Write user papers to disk (atomic).
 * Writes to temp file first, then renames to target.
 */
function writeStore(papers) {
  ensureStorage()
  const filePath = getStoragePath()
  const tmpPath = filePath + '.tmp'
  const data = JSON.stringify({ version: STORAGE_VERSION, papers }, null, 2)
  fs.writeFileSync(tmpPath, data, 'utf-8')
  fs.renameSync(tmpPath, filePath)
}

// ─── Validation ──────────────────────────────────────────────────

/**
 * Validate a paper object against frozen contract rules.
 *
 * @param {object} paper - Partial paper to validate
 * @param {Set<string>} existingIds - Current paper IDs for duplicate check
 * @param {boolean} isUpdate - true if updating existing paper
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validatePaper(paper, existingIds, isUpdate) {
  const errors = []

  // id
  if (!isUpdate) {
    // New paper: id must be present and valid format
    if (!paper.id) {
      errors.push('id is required')
    } else if (!/^user_\d+$/.test(paper.id)) {
      errors.push('id must match pattern: user_<timestamp>')
    } else if (existingIds.has(paper.id)) {
      errors.push(`id "${paper.id}" already exists`)
    }
  }
  // For updates: id validation (including duplicate check on potential id change)
  // is handled by the caller (UserPaperStore.update), since the caller knows
  // the original id and can correctly build existingIds without the original.

  // label
  if (paper.label === undefined || paper.label === null) {
    if (!isUpdate) errors.push('label is required')
  } else {
    if (typeof paper.label !== 'string') {
      errors.push('label must be a string')
    } else {
      const trimmed = paper.label.trim()
      if (trimmed.length === 0) {
        errors.push('label cannot be empty')
      } else if (trimmed.length > MAX_LABEL_LENGTH) {
        errors.push(`label too long (max ${MAX_LABEL_LENGTH} characters)`)
      }
    }
  }

  // widthMM
  if (paper.widthMM === undefined || paper.widthMM === null) {
    if (!isUpdate) errors.push('widthMM is required')
  } else {
    if (typeof paper.widthMM !== 'number' || isNaN(paper.widthMM)) {
      errors.push('widthMM must be a number')
    } else if (paper.widthMM < MIN_WIDTH_MM) {
      errors.push(`widthMM too small (minimum ${MIN_WIDTH_MM}mm)`)
    } else if (paper.widthMM > MAX_WIDTH_MM) {
      errors.push(`widthMM too large (maximum ${MAX_WIDTH_MM}mm)`)
    }
  }

  // heightMM
  if (paper.heightMM === undefined || paper.heightMM === null) {
    if (!isUpdate) errors.push('heightMM is required')
  } else {
    if (typeof paper.heightMM !== 'number' || isNaN(paper.heightMM)) {
      errors.push('heightMM must be a number')
    } else if (paper.heightMM < MIN_HEIGHT_MM) {
      errors.push(`heightMM too small (minimum ${MIN_HEIGHT_MM}mm)`)
    } else if (paper.heightMM > MAX_HEIGHT_MM) {
      errors.push(`heightMM too large (maximum ${MAX_HEIGHT_MM}mm)`)
    }
  }

  return { valid: errors.length === 0, errors }
}

// ─── UserPaperStore API ─────────────────────────────────────────

const UserPaperStore = {
  /** Constants exposed for consumers */
  MIN_WIDTH_MM,
  MAX_WIDTH_MM,
  MIN_HEIGHT_MM,
  MAX_HEIGHT_MM,
  MAX_LABEL_LENGTH,

  generatePaperId,

  validatePaper,

  /**
   * Load all user papers from disk.
   * Called once at app startup.
   * Returns empty array if file does not exist or is corrupt.
   *
   * @returns {Promise<Array>}
   */
  async load() {
    const store = readStore()
    // Filter out entries with invalid structure
    const valid = store.papers.filter(p => {
      if (!p || typeof p !== 'object') return false
      if (!p.id || !p.label) return false
      if (typeof p.widthMM !== 'number' || typeof p.heightMM !== 'number') return false
      return true
    })
    if (valid.length !== store.papers.length) {
      console.warn(`[UserPaperStore] Filtered ${store.papers.length - valid.length} invalid paper(s)`)
      // Save cleaned data
      writeStore(valid)
    }
    return valid
  },

  /**
   * Persist a new user paper.
   *
   * @param {object} paper - { id, label, widthMM, heightMM, createdAt, updatedAt }
   * @returns {Promise<{ valid: boolean, errors: string[] }>}
   */
  async create(paper) {
    const store = readStore()
    const existingIds = new Set(store.papers.map(p => p.id))

    const validation = validatePaper(paper, existingIds, false)
    if (!validation.valid) {
      return validation
    }

    const newPaper = {
      id: paper.id,
      label: paper.label.trim(),
      widthMM: paper.widthMM,
      heightMM: paper.heightMM,
      source: 'user',
      createdAt: paper.createdAt || new Date().toISOString(),
      updatedAt: paper.updatedAt || new Date().toISOString(),
    }

    store.papers.push(newPaper)
    writeStore(store.papers)
    return { valid: true, errors: [] }
  },

  /**
   * Update an existing user paper.
   *
   * @param {string} id
   * @param {object} changes - { label?, widthMM?, heightMM? }
   * @returns {Promise<{ valid: boolean, errors: string[] }>}
   */
  async update(id, changes) {
    const store = readStore()
    const idx = store.papers.findIndex(p => p.id === id)
    if (idx === -1) {
      return { valid: false, errors: [`Paper "${id}" not found`] }
    }

    const existing = store.papers[idx]
    const merged = { ...existing, ...changes, id }

    const existingIds = new Set(store.papers.filter(p => p.id !== id).map(p => p.id))
    const validation = validatePaper(merged, existingIds, true)
    if (!validation.valid) {
      return validation
    }

    store.papers[idx] = {
      ...existing,
      ...changes,
      id, // id cannot be changed
      updatedAt: new Date().toISOString(),
    }

    writeStore(store.papers)
    return { valid: true, errors: [] }
  },

  /**
   * Delete a user paper by id.
   * Idempotent — succeeds silently if id does not exist.
   *
   * @param {string} id
   * @returns {Promise<void>}
   */
  async delete(id) {
    const store = readStore()
    const filtered = store.papers.filter(p => p.id !== id)
    if (filtered.length !== store.papers.length) {
      writeStore(filtered)
    }
    // Idempotent: if id not found, do nothing (no error)
  },
}

module.exports = UserPaperStore
