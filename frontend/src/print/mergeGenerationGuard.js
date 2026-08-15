// Merge Final Artifact — Generation Ownership 原语（从 usePrint.prepareMergeArtifacts 抽取）
//
// 单一权威源：每次「真实 generation」调用 begin() 原子自增，取得唯一 myGeneration；
// 仅 isCurrent(myGeneration) 为 true（即该 generation 仍是最新）时，usePrint 才允许
// commit mergeArtifacts。被覆盖的旧 generation 即使晚完成也被 isCurrent
// 拒绝 —— 从而同时保护两个 state，防止异步竞态下旧 render 覆盖新 Artifact，或被拒的迟到
// generation 提前清除 loading 指示（F4-A/B/C、F5 硬 Gate）。
//
// 设计纪律：
//   - 不依赖 React state，因此不受异步 render 时序影响；纯函数式，可被 node 直接单元测试。
//   - begin() 与 isCurrent() 必须成对使用：commit 前用 isCurrent 校验，绝不能只检查一次就结束。
//   - 覆盖整个 async 生命周期（入口取号 → 每次 commit 前校验），而非只包住调用入口。

export function createGenerationGuard(initial = 0) {
  let current = initial
  const guard = {
    // 取号：原子自增，返回本 generation 唯一 id。每次「真实 generation」仅消耗一个序号。
    begin() {
      current += 1
      return current
    },
    // 判定：gen 是否仍为最新 generation（最新者才被允许 commit）。
    isCurrent(gen) {
      return gen === current
    },
    // 只读当前最新 generation（调试 / 测试用）。
    get current() {
      return current
    },
  }
  return guard
}
