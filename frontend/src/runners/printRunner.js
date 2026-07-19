/**
 * printRunner — 打印执行器
 *
 * 负责批量打印任务的执行编排：
 *   1. 遍历任务队列
 *   2. 调用外部 render 函数获取渲染数据
 *   3. 调用 PrintService 执行打印
 *   4. 收集并返回 PrintResult[]
 *
 * 不负责：
 *   ❌ UI 状态（setPrinting / setProgress / modals）
 *   ❌ React state / hooks
 *   ❌ 任务创建（PrintTask 由调用方提供）
 *
 * @module runners/printRunner
 */

/**
 * 批量源打印（source mode）：逐个文件直送 Sumatra。
 *
 * @param {object[]} tasks - PrintTask 数组
 * @param {Function} printFn - 打印函数：async (task, context) => PrintResult
 * @param {object} context - 传递给 printFn 的上下文
 * @param {AbortSignal} [context.signal] - 取消信号
 * @returns {Promise<object[]>} PrintResult[]
 */
export async function runSourcePrintTasks(tasks, printFn, context = {}) {
  const { signal } = context
  const results = []

  for (const task of tasks) {
    if (signal?.aborted) break

    try {
      const result = await printFn(task, context)
      results.push(result)
    } catch (err) {
      results.push({
        taskId: task.id ?? task.fileId ?? 'unknown',
        success: false,
        status: 'failed',
        error: err?.message || '打印异常',
      })
    }
  }

  return results
}

/**
 * 批量合并打印（merged mode）：渲染所有 → 一次性发送打印。
 *
 * 流程：
 *   1. 分批渲染（控制并发，避免内存峰值）
 *   2. 收集所有渲染数据
 *   3. 全部渲染完成后，一次性调用 merged print
 *
 * @param {object[]} tasks - PrintTask 数组
 * @param {Function} renderFn - 渲染函数：async (task) => { data: Uint8Array } | null
 * @param {Function} mergedPrintFn - 合并打印函数：async (images, context) => PrintResult
 * @param {object} context
 * @param {number} [context.batchSize=3] - 渲染批次大小
 * @param {AbortSignal} [context.signal] - 取消信号
 * @returns {Promise<{ results: object[], mergedResult: object|null }>}
 */
export async function runMergedPrintTasks(tasks, renderFn, mergedPrintFn, context = {}) {
  const { signal, batchSize = 3 } = context
  const results = []
  const allRenderedData = []

  const taskQueue = [...tasks]

  while (taskQueue.length > 0 && !signal?.aborted) {
    const batch = taskQueue.splice(0, batchSize)
    const batchResults = await Promise.all(
      batch.map(task => renderFn(task, context))
    )

    for (let i = 0; i < batchResults.length; i++) {
      const renderResult = batchResults[i]
      if (renderResult?.data) {
        results.push({
          taskId: batch[i].id ?? batch[i].fileId ?? 'unknown',
          success: true,
          status: 'rendered',
        })
        allRenderedData.push(renderResult.data)
      } else {
        results.push({
          taskId: batch[i].id ?? batch[i].fileId ?? 'unknown',
          success: false,
          status: 'failed',
          error: '渲染失败',
        })
      }
    }
  }

  // 所有渲染完成后，一次性发送合并打印
  let mergedResult = null
  if (allRenderedData.length > 0 && !signal?.aborted) {
    mergedResult = await mergedPrintFn(allRenderedData, context)
  }

  return { results, mergedResult }
}
