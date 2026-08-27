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
 *   4. 幂等 —— 无状态，全靠目标存在性判断；重复启动第二次起全 skip / no-op
 *   5. 白名单冻结（blob_storage 已确认 = Chromium 内部 → 排除）
 *   6. 结果写 DATA_ROOT/.migration.log
 *   7. 失败不退出 —— 调用方自行决定（DATA_ROOT 不可写已在 bootstrap 报错退出）
 */

const path = require('path')
const fs = require('fs')

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
 * @returns {{source, target, migrated: string[], skipped: string[], failed: Array<{item, error}>, completed: boolean}}
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

  result.completed = true
  return result
}

module.exports = { migrateLegacyBusinessData, FILE_WHITELIST, DIR_WHITELIST }
