// env-shim.loader.mjs — Node ESM loader hook (test-only infrastructure).
//
// 背景：前端 src/config.js 使用 `import.meta.env`（Vite 注入的全局）。在 plain Node
// 下 `import.meta.env` 为 undefined，导致 `import.meta.env.BASE_URL` 抛 TypeError。
// 这会使依赖 config.js 的源码模块（previewState.js / RenderLayoutFactory.js /
// renderDraw.js 等）在 `node --test` 下无法加载。
//
// 本项目自己的 src/layout/renderLayoutFactorySlot.test.js 注释已确认此技术债
// （“config.js 依赖 import.meta.env，需 shim”）。本 loader 将源码中所有
// `import.meta.env` 中性替换为 `({})`，使测试可加载真实生产者，且不修改任何
// 生产源码。仅作用于测试加载期，不改变被测模块的运行时语义（config 仅用于常量，
// 测试断言不依赖其值）。
//
// 另处理两类 Vite-only 语法（renderers.js 等 consumer 链引入）：
//   · `?url`/`?raw` 等资源查询后缀（如 'pdfjs-dist/build/pdf.worker.min.mjs?url'）
//     → 解析为虚拟空模块（默认导出空字符串）。Node 无法解析这些后缀，且被测路径
//     （OFD/image raster）不会真正消费 worker 资源。
//   · extensionless 相对导入（如 './config'、'./layout'）→ 若磁盘存在对应
//     `.js` 文件则补扩展名（Vite 默认补全，Node ESM 不补）。
//
// 使用：node --loader ./env-shim.loader.mjs --test <test-file>
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const QUERY_OR_HASH_RE = /[?#]/
const HAS_EXT_RE = /\.[a-zA-Z0-9]+$/

export async function resolve(specifier, context, nextResolve) {
  // 1) Vite 资源查询后缀 → 虚拟空模块（默认导出空字符串）
  if (QUERY_OR_HASH_RE.test(specifier) && !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(specifier)) {
    const base = specifier.split(/[?#]/)[0]
    if (!base.startsWith('node:') && !base.startsWith('/')) {
      return { url: 'data:text/javascript,export default ""', shortCircuit: true }
    }
  }
  // 2) extensionless 相对导入 → 磁盘存在对应 .js 则补扩展名
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && context.parentURL) {
    const pathPart = specifier.split(/[?#]/)[0]
    if (!HAS_EXT_RE.test(pathPart)) {
      const candidate = new URL(pathPart + '.js', context.parentURL)
      if (existsSync(fileURLToPath(candidate))) {
        return { url: candidate.href, shortCircuit: true }
      }
    }
  }
  return nextResolve(specifier, context)
}

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context)
  if (result.format === 'module' && result.source != null) {
    const src =
      typeof result.source === 'string'
        ? result.source
        : result.source.toString('utf8')
    if (src.includes('import.meta.env')) {
      const patched = src.replaceAll('import.meta.env', '({})')
      return { format: 'module', source: patched, shortCircuit: true }
    }
  }
  return result
}
