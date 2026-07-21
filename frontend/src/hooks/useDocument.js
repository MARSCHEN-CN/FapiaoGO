/**
 * useDocument — 响应式获取 InvoiceDocument
 *
 * 职责：
 *   通过 useSyncExternalStore 订阅 DocumentStore，
 *   当 Document 注册/更新/移除时自动触发组件重渲染。
 *   是 DisplayAdapter / DocumentViewer 接入 DocumentStore 的唯一 React 入口。
 *
 * 为什么需要：
 *   DocumentStore 是模块级 Map（纯数据层），不是 React state。
 *   直接在渲染期读取 getDocument() 无法在后续注册时触发重渲染
 *   （典型场景：预览先于解析完成显示，docId 已存在但 Document 稍后才注册）。
 *
 * 所有权：
 *   由 DisplayAdapter / App.jsx 调用。
 *   依赖 stores/DocumentStore 的 subscribe 契约。
 *
 * @module hooks/useDocument
 */

import { useSyncExternalStore } from 'react'
import { subscribe, getDocument } from '../stores/DocumentStore'

/**
 * 响应式读取指定 docId 的 InvoiceDocument。
 *
 * @param {string|null} docId - 文档 ID（identity.docId 或兼容 docId）
 * @returns {import('../models/InvoiceDocument').InvoiceDocument|null}
 *   已注册返回 Document 实例；未注册或 docId 为空返回 null。
 */
export function useDocument(docId) {
  return useSyncExternalStore(
    subscribe,
    () => getDocument(docId),
    () => null,
  )
}
