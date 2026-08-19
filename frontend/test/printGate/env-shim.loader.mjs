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
// 使用：node --loader ./env-shim.loader.mjs --test <test-file>
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
