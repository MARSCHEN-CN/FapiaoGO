/**
 * previewScheduler.js — Preview Scheduler 决策层纯函数
 *
 * 依据：PreviewScheduler-Contract-v2.md（唯一实施依据）
 *
 * 职责边界：
 *   本模块是「决策层」，只做状态机的纯计算，不含任何 React/异步副作用。
 *   React 执行层（usePreview.js 的 handlePreview/doLoadPreview）只消费本模块返回值，不自行推导。
 *   本模块不 import React、不 import usePreview，保证 Node --test 可直接加载。
 *
 * 三层模型（Contract v2 §1）：
 *   - Transaction { key, version, snapshot }                             selection ownership
 *   - Execution   { id, key, version, phase, consumingSnapshot }          snapshot consumer ownership
 *   - refresh     = 更新 transaction.snapshot，再决定 execution 如何消费
 *
 * freshness 唯一基准：execution.consumingSnapshot（vs transaction.snapshot）。
 * loading loop 统一走 resolveBoundary + advanceExecution（advanceLoadingStep），
 * 不再依赖 shouldReload 局部变量（消除 W1 双轨）。
 *
 * invariant（Contract v2 §2，INV-PS1~PS11）：
 *   INV-PS1  version 只表 selection supersession
 *   INV-PS2  refresh 不得 resurrect 旧 selection
 *   INV-PS3  显式点击一律 select（含同 key）
 *   INV-PS6  只有 snapshot 稳定才 commit
 *   INV-PS7  Latest Snapshot Eventually Commits
 *   INV-PS8  Ownership ≠ Execution
 *   INV-PS9  Single Execution Per Transaction
 *   INV-PS10 Restart Does Not Fork Execution
 *   INV-PS11 Commit Requires Fresh Consumption
 *
 * @module utils/previewScheduler
 */

/**
 * Preview Transaction 结构。
 * @typedef {Object} PreviewTransaction
 * @property {string} key      - 当前 selection 的 canonical key
 * @property {number} version  - 该 selection 的 supersession token
 * @property {*}      snapshot - 当前最新的 fileObj 快照
 */

/**
 * 三态决策：根据当前 transaction + 事件，返回新状态与应执行的动作。
 *
 * @param {PreviewTransaction|null} transaction - 当前 transaction（可能 null）
 * @param {number} version - 当前 version 计数器
 * @param {{intent: 'select'|'refresh'|'invalidate', key?: string, snapshot?: *}} event
 * @returns {{
 *   version: number,
 *   transaction: PreviewTransaction|null,
 *   action: 'start'|'merge'|'ignore'|'invalidate'
 * }}
 *   - start      新 selection，应 ++version 并开始新加载
 *   - merge      同 key refresh，更新 snapshot，不 ++version、不新建请求
 *   - ignore     stale refresh，忽略（不 ++version、不覆盖当前）
 *   - invalidate 失效，++version，transaction=null
 */
export function resolvePreviewTransition(transaction, version, event) {
  const { intent, key, snapshot } = event || {}

  if (intent === 'invalidate') {
    return { version: version + 1, transaction: null, action: 'invalidate' }
  }

  if (intent === 'select') {
    // INV-PS3：显式点击（含同 key）一律 supersession
    const nextVersion = version + 1
    return {
      version: nextVersion,
      transaction: { key, version: nextVersion, snapshot },
      action: 'start',
    }
  }

  if (intent === 'refresh') {
    // INV-PS2：refresh 只能更新当前同 key transaction
    if (transaction && transaction.key === key && transaction.version === version) {
      return {
        version, // 不 ++version（INV-PS1）
        transaction: { ...transaction, snapshot },
        action: 'merge',
      }
    }
    // stale refresh 或 null transaction → ignore，不 resurrect 旧 selection
    return { version, transaction, action: 'ignore' }
  }

  // 未知 intent：保守视为 ignore，不改变任何状态
  return { version, transaction, action: 'ignore' }
}

/**
 * Ownership 判定（INV-PS5）：异步边界后确认当前 transaction 仍属于本次请求。
 *
 * @param {PreviewTransaction|null} transaction
 * @param {number} version - 本次请求启动时的 version
 * @param {string} key      - 本次请求的 key
 * @returns {boolean} 若 transaction 仍是同 key、同 version，返回 true
 */
export function ownsTransaction(transaction, version, key) {
  return !!(transaction && transaction.key === key && transaction.version === version)
}

/**
 * Snapshot 晋升判定（INV-PS6 / §4）：
 * 当前 transaction 的 snapshot 是否已在「本次加载期间」被替换。
 *
 * @deprecated v2 起 loading loop 的 freshness 唯一基准是 execution.consumingSnapshot，
 *   统一走 resolveBoundary + advanceLoadingStep；本函数仅保留为底层 snapshot 变化检测
 *   （测试 T3/T8 仍引用），不再作为 loading loop 的 freshness 真相。
 *
 * @param {PreviewTransaction|null} transaction
 * @param {*} snapshotAtStart - 本次 loadFilePreview 启动时捕获的 snapshot
 * @returns {boolean} 引用变化则返回 true（需 reload 最新 snapshot）
 */
export function shouldReload(transaction, snapshotAtStart) {
  return !!(transaction && transaction.snapshot !== snapshotAtStart)
}

/**
 * 旧语义（仅用于 TDD Red 阶段证明根因，实施 Step 3 后不再引用）：
 * 当前 doLoadPreview 的缺陷 = 任何 handlePreview 调用都 ++version，
 * 把「同 key 晋升」误当成「新 selection」，导致 effect-2/effect-3 双触发互相 supersede。
 *
 * @deprecated 仅供 previewScheduler.test.js 的「旧实现红」断言使用
 */
export function legacyResolvePreviewTransition(transaction, version, event) {
  const { key, snapshot } = event || {}
  if (event?.intent === 'invalidate') {
    return { version: version + 1, transaction: null, action: 'invalidate' }
  }
  const nextVersion = version + 1
  return {
    version: nextVersion,
    transaction: { key, version: nextVersion, snapshot },
    action: 'start',
  }
}

// ════════════════════════════════════════════════════════════
// v2 — Execution 层决策（Contract v2 §3.2）
// ════════════════════════════════════════════════════════════

/**
 * Preview Execution 结构（Contract v2 §1.2）：
 * @typedef {Object} PreviewExecution
 * @property {string} id               - execution identity
 * @property {string} key              - 绑定的 selection key
 * @property {number} version          - 绑定的 supersession token
 * @property {'loading'|'post-load'|'committing'} phase - 当前阶段
 * @property {*} consumingSnapshot     - 本 execution 当前正在 load / 处理的 snapshot
 */

/**
 * resolveRefreshExecution — refresh（merge）时决定 execution 该做什么（INV-PS7/PS8/PS9）。
 *
 * 前置：resolvePreviewTransition 已判定 action==='merge'（transaction 匹配并已更新 snapshot）。
 * 返回 executionAction：
 *   - 'update-snapshot'   execution 在 loading，snapshot 更新后由 shouldReload 消费（W1）
 *   - 'restart-required'  execution 存在但已过 loading（post-load/committing），需回到 load 循环（W2/W3/W4）
 *   - 'start-execution'   execution 不存在（idle）或绑定已失效 → 启动唯一新 execution（W5）
 *   - 'ignore'            transaction 不匹配（stale refresh，防御，正常不会到达）
 *
 * INV-PS9：execution 存在且绑定同一 (key, version) 时，永不返回 'start-execution'，
 *   保证同一 transaction 下最多一个有效 execution。
 *
 * @param {PreviewTransaction|null} transaction
 * @param {PreviewExecution|null} execution
 * @param {{key?: string, snapshot?: *}} event
 * @returns {'update-snapshot'|'restart-required'|'start-execution'|'ignore'}
 */
export function resolveRefreshExecution(transaction, execution, event) {
  const { key } = event || {}
  if (!transaction || transaction.key !== key) {
    return 'ignore'
  }
  if (!execution) {
    return 'start-execution'
  }
  if (execution.key !== key || execution.version !== transaction.version) {
    // execution 绑定的是别的 selection / 已被 supersede → 视为无有效 execution
    return 'start-execution'
  }
  // execution 绑定同一 (key, version)：单一 owner，不重复启动（INV-PS9）
  if (execution.phase === 'loading') {
    return 'update-snapshot'
  }
  return 'restart-required'
}

/**
 * resolveBoundary — execution 在 await 边界后的统一决策（INV-PS5 + INV-PS7）。
 *
 * 每个异步安全边界（loadFilePreview / loadDocFacts / saveDocFacts / commit 前）统一调用，
 * 一次同时表达 ownership 与 snapshot freshness 两个判定，替代散落的独立检查：
 *   - 'abort'    ownership 失效（transaction 为 null / 已 supersede / 已 invalidate）→ 退出，禁止 commit
 *   - 'restart'  ownership 有效但 snapshot 已变 → 回到 load 循环用最新 snapshot 重消费（W2/W3/W4）
 *   - 'continue' ownership 有效 + snapshot 新鲜 → 继续
 *
 * @param {PreviewTransaction|null} transaction
 * @param {PreviewExecution|null} execution
 * @returns {'continue'|'restart'|'abort'}
 */
export function resolveBoundary(transaction, execution) {
  if (!transaction || !execution) {
    return 'abort'
  }
  if (execution.key !== transaction.key || execution.version !== transaction.version) {
    return 'abort'
  }
  if (execution.consumingSnapshot !== transaction.snapshot) {
    return 'restart'
  }
  return 'continue'
}

/**
 * advanceExecution — execution 在 boundary 判定后的状态转换（INV-PS10）。
 *
 * 冻结语义（Contract v2 §Execution Transition）：
 *   - 'abort'    → 返回 null（terminated）
 *   - 'restart'  → 由【当前 execution 自己】回到 loading，id 不变，重新消费最新 snapshot。
 *                  绝不 fork 出第二个 execution（INV-PS10）。
 *   - 'continue' → execution 原样返回（phase 由执行层按实际完成阶段推进）。
 *
 * @param {PreviewExecution|null} execution
 * @param {'continue'|'restart'|'abort'} boundary - resolveBoundary 的结果
 * @param {*} latestSnapshot - transaction.snapshot（restart 时要重新消费的最新快照）
 * @returns {PreviewExecution|null}
 */
export function advanceExecution(execution, boundary, latestSnapshot) {
  if (!execution) {
    return null
  }
  if (boundary === 'abort') {
    return null
  }
  if (boundary === 'restart') {
    // INV-PS10：restart 由当前 execution 自己完成，id 不变，回 loading，消费最新 snapshot
    return { ...execution, phase: 'loading', consumingSnapshot: latestSnapshot }
  }
  // continue：execution 原样（phase 推进由执行层按实际边界管理）
  return execution
}

/**
 * advanceLoadingStep — loading loop 单轮 load 返回后的状态推进（Direction Y）。
 *
 * loading loop 每轮（执行层）：
 *   1. loadedFile = await loadFilePreview(execution.consumingSnapshot)
 *   2. step = advanceLoadingStep(transaction, execution)
 *
 * consumingSnapshot 是唯一 freshness 基准；本函数统一 resolveBoundary + advanceExecution，
 * 消除 W1 双轨（旧 promotion loop 用 shouldReload 局部变量、post-load 用 resolveBoundary）。
 *
 * 返回：
 *   - { action: 'terminate', execution: null }      ownership 失效（supersede/invalidate）
 *   - { action: 'next-iteration', execution }       snapshot 变了 → 同 id 回 loading，consumingSnapshot 晋升为最新
 *   - { action: 'post-load', execution }            snapshot 新鲜 → 结束 loading，进入 post-load
 *
 * @param {PreviewTransaction|null} transaction
 * @param {PreviewExecution|null} execution
 * @returns {{action:'terminate'|'next-iteration'|'post-load', execution: PreviewExecution|null}}
 */
export function advanceLoadingStep(transaction, execution) {
  const boundary = resolveBoundary(transaction, execution)
  if (boundary === 'abort') {
    return { action: 'terminate', execution: null }
  }
  if (boundary === 'restart') {
    return {
      action: 'next-iteration',
      execution: advanceExecution(execution, 'restart', transaction.snapshot),
    }
  }
  // continue：结束 loading，进入 post-load
  return {
    action: 'post-load',
    execution: { ...execution, phase: 'post-load' },
  }
}

/**
 * 旧语义（仅供 TDD Red 阶段证明 Step 3 merge 缺陷，实施 v2 后不再引用）：
 * refresh 只更新 transaction.snapshot、从不启动/重启 execution —— 导致 idle refresh（W5）
 * 时 snapshot 无人消费，OFD 占位空壳永不晋升为富态。
 *
 * @deprecated 仅供 previewScheduler.test.js 的「旧实现红」断言使用
 */
export function legacyResolveRefreshExecution(transaction, execution, event) {
  const { key } = event || {}
  if (!transaction || transaction.key !== key) {
    return 'ignore'
  }
  // 旧语义：无论 execution 是否存在，都只更新 snapshot，不启动也不重启
  return 'merge-only'
}

/**
 * P4 — Preview Transaction Ownership Contract（2026-08-23 冻结，Step P4）
 *
 * 背景（[PREVIEW FLOW] 运行时铁证，OFD 展示区卡 Loading 的最终根因）：
 *   导入后旧裸 previewFile（占位对象，key=2327e901 无 instanceId）的 render effect
 *   触发 clearCommitted()，无条件清 previewTransactionRef + previewExecutionRef +
 *   ++previewVersionRef —— 把新 handlePreview（富 execution，v7/v9，instanceId=81ecd8a8）
 *   的 transaction 一起取消（日志：v9 superseded 但无 v10 START）→ 富对象永不 commit →
 *   Display lookup 回退旧 key → miss → 永久 Loading。
 *
 * 契约（用户冻结）：
 *   - 旧 render 的 cleanup 不能拥有新 transaction 的取消权。
 *   - clearCommitted 只能清理属于「当前 committed preview」的 transaction。
 *   - 真正 supersede（新 select 覆盖旧 select）仍必须取消旧 execution（Scheduler 语义不变）。
 *
 * 决策：
 *   - 无 transaction            → 'clear'（无 execution 可杀，幂等安全）
 *   - transaction.version !== committedVersion（或从未 commit）→ 'preserve-transaction'
 *       旧 committed preview 无权取消更新版本的在途 execution；调用方只清旧展示帧，
 *       保留 transaction/execution 与 version 守卫。
 *   - transaction.version === committedVersion → 'clear'（当前 committed preview 自己的 cleanup）
 *
 * @param {Object} params
 * @param {Object|null} params.transaction - 当前 preview transaction（含 version）
 * @param {number|null} params.committedVersion - 最近一次 commit 的 execution.version
 * @returns {{action: 'clear'|'preserve-transaction'}}
 */
export function resolveCommittedClear({ transaction, committedVersion }) {
  if (!transaction) return { action: 'clear' }
  if (committedVersion == null || transaction.version !== committedVersion) {
    return { action: 'preserve-transaction' }
  }
  return { action: 'clear' }
}

/**
 * 旧语义复刻（仅供 P4-1-RED 测试证明缺陷，不用于生产）。
 * 无条件清 transaction（复刻 clearCommitted 改造前的行为）。
 *
 * @deprecated 仅供 previewScheduler.test.js 的「旧实现红」断言使用
 */
export function legacyResolveCommittedClear() {
  return { action: 'clear' }
}
