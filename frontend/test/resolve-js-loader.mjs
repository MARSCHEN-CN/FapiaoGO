/**
 * 测试用最小 ESM 适配 loader：让前端 src 模块可在裸 Node 下被 .mjs 契约测试直接 import。
 *
 * 做两件事：
 *  1) resolve：相对路径的 extensionless import 自动补 .js（Vite 下允许，Node ESM 不允许）。
 *  2) load：将源码中的 `import.meta.env` 重写为 `({})`。
 *     —— 前端 config.js 在 Vite 下依赖 import.meta.env，裸 Node 中 import.meta.env 为
 *        undefined 会抛 "Cannot read properties of undefined"。重写为 ({}) 后
 *        `?.VITE_BACKEND_URL` 与 `.BASE_URL` 均安全降级为 undefined，不依赖 Vite 运行时。
 *
 * 仅用于 `node` 直接跑 .mjs 契约测试，不影响 Vite 构建与任何 5.1b-3b 源码边界。
 *
 * 用法：node --loader ./test/resolve-js-loader.mjs test/xxx.test.mjs
 */
import { readFileSync } from 'node:fs'

export async function resolve(specifier, context, nextResolve) {
  const isRelative = specifier.startsWith('./') || specifier.startsWith('../')
  const hasExt = /\.[cm]?jsx?$/.test(specifier)
  if (isRelative && !hasExt) {
    try {
      return await nextResolve(specifier + '.js', context)
    } catch {
      // 回退到默认解析（让原生错误正常抛出）
    }
  }
  return nextResolve(specifier, context)
}

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context)
  if (
    result.format === 'module' &&
    typeof result.source !== 'undefined' &&
    (result.source.includes?.('import.meta.env') ??
      (typeof result.source === 'string' ? result.source.includes('import.meta.env') : false))
  ) {
    let src = result.source
    if (typeof src !== 'string') {
      src = new TextDecoder().decode(src)
    }
    src = src.replace(/import\.meta\.env/g, '({})')
    return { ...result, source: src }
  }
  return result
}
