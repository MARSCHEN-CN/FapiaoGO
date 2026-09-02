#!/usr/bin/env node
/**
 * PERF-WHITE-1 开工前自检（Preflight）
 *
 * 用途：在打开 Electron 之前，一次性确认「三件套」里的前两件（后端 5000 / Vite 5173）
 *      已就绪，避免导入跑到一半才发现后端没起、白跑一轮。
 *
 * 用法：
 *   node outputs/perf-white1-preflight.mjs
 *
 * 退出码：
 *   0 = 全部就绪，可以 npm start
 *   1 = 有服务未就绪（输出里会明确告知该开哪个终端）
 *
 * 零依赖，只用 Node 内置 http 模块。
 */

import { request as httpRequest } from 'node:http'

const TARGETS = [
  {
    name: '后端 Flask',
    url: 'http://127.0.0.1:5000/',
    hint: 'cd E:\\print706; backend\\venv\\Scripts\\python.exe backend/app.py',
    // 后端「已就绪」有两种情况：你自己起的 dev 后端，或残留的生产版 FapiaoGO。
    // 后者会让 dev 前端绕过你可控的后端，必须提示排查。
    staleRisk: true,
  },
  {
    name: 'Vite dev server',
    url: 'http://localhost:5173/index.html',
    hint: 'cd E:\\print706\\frontend; npm run dev',
  },
]

function probe(url, timeoutMs = 3000) {
  return new Promise((resolve) => {
    let settled = false
    const done = (ok, detail) => {
      if (settled) return
      settled = true
      resolve({ ok, detail })
    }
    let req
    try {
      req = httpRequest(url, { method: 'GET', timeout: timeoutMs }, (res) => {
        // 任意 HTTP 状态码都算「服务在」——Flask 对 / 返回 404 也说明进程活着
        res.resume()
        done(true, `HTTP ${res.statusCode}`)
      })
    } catch (e) {
      return done(false, e.message)
    }
    req.on('timeout', () => {
      req.destroy()
      done(false, '连接超时')
    })
    req.on('error', (e) => done(false, e.code || e.message))
    req.end()
  })
}

async function main() {
  console.log('=== PERF-WHITE-1 开工前自检 ===\n')
  let allOk = true

  for (const t of TARGETS) {
    const r = await probe(t.url)
    const mark = r.ok ? '[OK]  ' : '[FAIL]'
    console.log(`${mark} ${t.name.padEnd(16)} ${t.url}`)
    console.log(`        ${r.detail}`)
    if (!r.ok) {
      allOk = false
      console.log(`        -> 请在独立终端执行: ${t.hint}`)
    }
    if (t.staleRisk && r.ok) {
      console.log('        [!] 5000 端口已被占用。若这不是你刚启动的 dev 后端，')
      console.log('            极可能是后台残留的生产版 FapiaoGO / server.exe。')
      console.log('            建议：任务管理器结束 FapiaoGO.exe 与 server.exe，再手动起 dev 后端，')
      console.log('            确保整条链路是你可控的开发版。')
      console.log('')
    }
    console.log('')
  }

  if (allOk) {
    console.log('全部就绪。现在可以启动 Electron：')
    console.log('  cd E:\\print706; npm start')
    console.log('\n提示：确认没有生产版 FapiaoGO.exe 在后台抢 5000 端口。')
    process.exit(0)
  } else {
    console.log('有服务未就绪。按上面的提示开对应终端，出现启动完成后再跑一次本脚本。')
    process.exit(1)
  }
}

main().catch((e) => {
  console.error('自检脚本异常:', e)
  process.exit(1)
})
