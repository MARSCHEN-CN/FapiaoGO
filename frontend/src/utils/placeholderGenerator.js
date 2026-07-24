/**
 * PlaceholderGenerator — 为导入文件生成占位项
 *
 * 职责：
 *   - id 生成（generateFileKey）
 *   - metadata 提取（name, path, fileFormat, searchText）
 *   - 文件内容懒加载支持（file: f.file || null）
 *
 * 不负责：
 *   ❌ IPC 文件读取
 *   ❌ 去重逻辑
 *   ❌ setFiles
 *   ❌ 任务调度
 *
 * 这是 Import Pipeline Contract v1.1 (docs/architecture/import-pipeline-v1.md)
 * 指定的 PlaceholderGenerator 职责。
 */

import { generateFileKey } from './fileHelpers'
import { getFileFormat, buildSearchText } from '../utils'

/**
 * @typedef {Object} FileInput
 * @property {string} name - 文件名
 * @property {string} [path] - 文件路径（dialog/folder 来源）
 * @property {File|null} [file] - 浏览器 File 对象（drag 来源）
 */

/**
 * @typedef {Object} FilePlaceholder
 * @property {string} key - 唯一标识
 * @property {string} name - 文件名
 * @property {string|null} path - 文件路径
 * @property {File|null} file - 文件内容（懒加载时为 null）
 * @property {'uploading'} status - 初始状态
 * @property {string} fileFormat - 文件格式
 * @property {string} searchText - 预计算搜索文本
 */

/**
 * 为导入文件生成占位项。
 * 纯函数：不读取文件、不调度任务、不操作 React 状态。
 *
 * @param {FileInput[]} files
 * @returns {FilePlaceholder[]}
 */
export function createPlaceholders(files) {
  return files.map((f) => ({
    key: generateFileKey(f.name),
    name: f.name,
    path: f.path,
    // lazy file loading: browser drag 有 File，dialog/folder 路径为 null
    // 解析阶段等下游在需要时通过 printPath / path 读取
    file: f.file || null,
    status: 'uploading',
    fileFormat: getFileFormat(f.name),
    searchText: buildSearchText({ name: f.name }),
  }))
}
