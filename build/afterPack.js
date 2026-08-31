// SIZE-2 P1 体积优化：afterPack 钩子
// 在 electron-builder 生成 win-unpacked 后、压缩/安装器打包前执行，
// 删除「运行时确定不加载」的 Electron 内置冗余文件。
//
// 删除依据（只读审计 2026-08-31，outputs/SIZE-2-readonly-audit.md）：
// 1. LICENSES.chromium.html（~20MB）— 纯法律文本，应用运行零引用。
//    NSIS/zip 目标不受影响（仅 Squirrel.Windows 安装器模板引用它，本项目不用该目标）。
// 2. dxcompiler.dll（~25MB）+ dxil.dll（~1.5MB）— 仅 Dawn/WebGPU 加载。
//    前端零 WebGL/WebGPU（全部 getContext('2d')，无 three.js），electron/main.js 无 GPU 配置，
//    运行时不加载。若未来引入 WebGL/WebGPU，需恢复此文件。
//
// 安全设计：文件不存在时静默跳过；删除失败仅告警不中断打包。
// 红线：绝不触碰 libGLESv2/libEGL（ANGLE 合成必需）、d3dcompiler_47（P2 待真机验证）、
// vk_swiftshader/vulkan-1（P2 待真机验证）、icudtl.dat/resources.pak/ffmpeg.dll。

const fs = require('fs')
const path = require('path')

exports.default = async function afterPack(context) {
  const appOutDir = context.appOutDir
  if (!appOutDir) {
    console.error('[afterPack] 未获取 appOutDir，跳过')
    return
  }

  const targets = ['LICENSES.chromium.html', 'dxcompiler.dll', 'dxil.dll']

  for (const name of targets) {
    const p = path.join(appOutDir, name)
    try {
      if (fs.existsSync(p)) {
        const size = fs.statSync(p).size
        fs.unlinkSync(p)
        console.log(`[afterPack] 已删除 ${name} (-${(size / 1048576).toFixed(1)}MB)`)
      } else {
        console.log(`[afterPack] ${name} 不存在，跳过（Electron 版本可能已不再携带）`)
      }
    } catch (err) {
      // 删除失败不应中断整个打包流程（保守策略）
      console.error(`[afterPack] 删除 ${name} 失败: ${err.message}`)
    }
  }
}
