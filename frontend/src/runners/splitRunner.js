/**
 * splitRunner — 文件拆分执行器
 *
 * 职责：
 *   执行一次拆分任务：PDF → /split_pdf API → pages，或非 PDF → buildFileObj。
 *   不更新 UI 状态，不入队列。
 *
 * 调用方（orchestrator）负责：
 *   - 从队列取出任务
 *   - 调用 runSplitTask()
 *   - 根据结果执行 UI 更新（queueUpdate / replaceWithItems / enqueueParse）
 *
 * 允许调用：
 *   - processPdfFile()
 *   - buildFileObj()
 *
 * 禁止：
 *   - setFiles() / queueUpdate()
 *   - TaskScheduler 操作（enqueueParse 等）
 *   - 任何 React state
 *
 * @module runners/splitRunner
 */

import { buildFileObj, processPdfFile } from '../utils/fileHelpers'

/**
 * 执行单文件拆分。
 *
 * @param {Object} job - 拆分任务
 * @param {Object} job.p - 占位项
 * @param {Object} job.file - 原始文件输入
 * @returns {Promise<Object>} 拆分结果
 * @property {Array} result.toAdd - 拆分后生成的文件对象数组
 * @property {Array} [result.toParse] - 需要解析的文件（仅 PDF 拆分时有）
 * @property {boolean} result.isPDF - 是否是 PDF
 * @property {Object} [result.fileObj] - 非 PDF 时构建的文件对象
 * @throws {Error} 拆分失败
 */
export async function runSplitTask(job) {
  const { p, file: f } = job

  if (f.name.toLowerCase().endsWith('.pdf')) {
    const { toAdd, toParse: newToParse } = await processPdfFile(
      { file: p.file, name: f.name },
      () => f.path
    )
    return { toAdd, toParse: newToParse, isPDF: true }
  }

  // 非 PDF — 直接构建文件对象
  const fileObj = buildFileObj(p.file, f.name, f.path)
  return { fileObj, isPDF: false }
}
