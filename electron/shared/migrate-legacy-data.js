'use strict'

/**
 * migrateLegacyBusinessData.js — 旧数据安全迁移（DATA-PATH Contract v1.1，DP-2E）
 *
 * 把旧版本（< DATA-PATH）写在 %APPDATA%\FapiaoGO\ 的业务数据复制到 DATA_ROOT。
 *
 * 冻结规则：
 *   1. copy 不 move —— 源数据永久保留，迁移失败可重跑
 *   2. 目标已存在 → skip（新数据优先，绝不覆盖）
 *   3. 逐项 try/catch —— 单文件失败不中断整体
 *   4. 一次性迁移 —— 成功后写 legacyRoot/.migration_done 标记，后续启动直接跳过。
 *      标记放在 legacyRoot（而非 dataRoot），因为用户删 dataRoot 想重置时不
 *      会碰到 AppData 旧路径，确保"删 database/ = 全新开始"语义成立。
 *   5. 白名单冻结（blob_storage 已确认 = Chromium 内部 → 排除）
 *   6. 结果写 DATA_ROOT/.migration.log
 *   7. 失败不退出 —— 调用方自行决定（DATA_ROOT 不可写已在 bootstrap 报错退出）
 */

const path = require('path')
const fs = require('fs')

const DONE_MARKER = '.migration_done'

// 业务数据白名单（冻结；blob_storage = Chromium 内部临时存储，禁止迁移）
const FILE_WHITELIST = [
  'invoices.oplog',
  'invoices.json',
  'invoice_import_history.json',
  'Settings.json',
  'DocFacts.json',
  'config.json',
  'parse_jobs.json',
  'parse_jobs.json.oplog',
]

const DIR_WHITELIST = [
  'paper-registry',
  'printer-cache',
  'logs',
  '.ocr_cache',
]

function _copyFile(src, dst, fsImpl) {
  return fsImpl.copyFileSync(src, dst)
}

/**
 * 执行一次迁移。
 * @param {string} legacyRoot 旧数据根（%APPDATA%\FapiaoGO，DP-2E-1 捕获）
 * @param {string} dataRoot   目标 DATA_ROOT
 * @param {object} [opts] { fsImpl?, logger? }
 * @returns {{source, target, migrated: string[], skipped: string[], failed: Array<{item, error}>, completed: boolean, skippedByMarker?: boolean}}
 */
function migrateLegacyBusinessData(legacyRoot, dataRoot, opts = {}) {
  const fsImpl = opts.fsImpl || fs
  const log = opts.logger || ((msg) => { if (opts.verbose) console.log('[MIGRATE]', msg) })

  const result = {
    source: legacyRoot || '',
    target: dataRoot || '',
    migrated: [],
    skipped: [],
    failed: [],
    completed: false,
  }

  if (!legacyRoot || !dataRoot) return result
  if (!fsImpl.existsSync(legacyRoot)) return result // 旧根不存在 → 无数据可迁
  if (legacyRoot === dataRoot) return result        // 同路径（dev）→ no-op

  // ── 一次性迁移闸门 ──────────────────────────────────────────
  // 标记放在 legacyRoot（AppData 旧路径）而不是 dataRoot，
  // 因为 dataRoot 就是用户可能删除来做"重置"的地方。
  // 标记在删不到的位置，才能保证"删 database/ = 全新开始"。
  if (fsImpl.existsSync(path.join(legacyRoot, DONE_MARKER))) {
    log(`[SKIP] migration already completed (${DONE_MARKER} found in legacy root)`)
    result.completed = true
    result.skippedByMarker = true
    return result
  }

  const items = [
    ...FILE_WHITELIST.map(f => ({ rel: f, kind: 'file' })),
    ...DIR_WHITELIST.map(d => ({ rel: d, kind: 'dir' })),
  ]

  for (const item of items) {
    const src = path.join(legacyRoot, item.rel)
    const dst = path.join(dataRoot, item.rel)
    try {
      if (!fsImpl.existsSync(src)) continue // 源不存在 → 跳过（不记 skipped）
      if (fsImpl.existsSync(dst)) {         // 目标已存在 → 不覆盖
        result.skipped.push(item.rel)
        log(`[SKIP] ${item.rel} exists`)
        continue
      }
      if (item.kind === 'dir') {
        fsImpl.mkdirSync(dst, { recursive: true })
        for (const f of fsImpl.readdirSync(src)) {
          const s = path.join(src, f)
          if (!fsImpl.statSync(s).isFile()) continue
          _copyFile(s, path.join(dst, f), fsImpl)
        }
        result.migrated.push(item.rel + '/')
        log(`[OK] ${item.rel}/ copied`)
      } else {
        fsImpl.mkdirSync(path.dirname(dst), { recursive: true })
        _copyFile(src, dst, fsImpl)
        result.migrated.push(item.rel)
        log(`[OK] ${item.rel} copied`)
      }
    } catch (e) {
      result.failed.push({ item: item.rel, error: e && e.message ? e.message : String(e) })
      log(`[FAIL] ${item.rel}: ${e && e.message}`)
    }
  }

  // 迁移日志
  try {
    const lines = [
      `# migration ${new Date().toISOString()}`,
      `source: ${result.source}`,
      `target: ${result.target}`,
      ...result.migrated.map(x => `[OK] ${x}`),
      ...result.skipped.map(x => `[SKIP] ${x} exists`),
      ...result.failed.map(x => `[FAIL] ${x.item}: ${x.error}`),
      result.failed.length ? 'migration completed with errors' : 'migration completed',
    ]
    fsImpl.appendFileSync(path.join(dataRoot, '.migration.log'), lines.join('\n') + '\n', 'utf8')
  } catch (e) {
    result.failed.push({ item: '.migration.log', error: e && e.message ? e.message : String(e) })
  }

  // ── 完成标记（一次性迁移闸门的另一半） ────────────────────────
  // 写在 legacyRoot：下次启动发现标记 → 整段迁移逻辑直接跳过。
  // 即使本次没有任何文件需要 migrate（全 skipped），也写标记 ——
  // 说明"旧路径里已经没有什么值得搬的了"，同样阻止后续重跑。
  try {
    fsImpl.writeFileSync(
      path.join(legacyRoot, DONE_MARKER),
      `migrated at ${new Date().toISOString()}\nmigrated: ${result.migrated.length} items, skipped: ${result.skipped.length}\n`,
      'utf8'
    )
    log(`[MARK] ${DONE_MARKER} written to legacy root (one-time migration complete)`)
  } catch (e) {
    // 标记写失败不阻塞 —— 下次还能再迁（保守正确）
    log(`[WARN] failed to write ${DONE_MARKER}: ${e && e.message}`)
  }

  result.completed = true
  return result
}

module.exports = { migrateLegacyBusinessData, FILE_WHITELIST, DIR_WHITELIST }
