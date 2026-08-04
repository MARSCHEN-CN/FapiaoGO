#!/usr/bin/env pwsh
# A3-V2 helper (2026-08-04)
# 串起 rot0（自包含边距参考）+ rot90（几何验证）。
# 解决两件事：
#   1. PowerShell 续行符是反引号 ` 不是 \，本脚本内部无续行，避免解析错误。
#   2. 打印机名集中在 -Printer 参数，避免每条命令手写。
#
# 用法（在仓库根目录，PowerShell）：
#   .\scripts\verify_sumatra_v2.ps1 -Printer "Ghostscript PDF" -Python "C:/Program Files/Python312/python.exe"
#
# ⚠️ 关键前提：必须用一个「忠实自定义纸 + 静默」的虚拟 PDF writer。
#   - "Microsoft Print to PDF" 在 SumatraPDF CLI 下弹保存框且不保自定义纸 → 不可用。
#   - 推荐 Ghostscript PDF writer。
#   跑完看 V2-01 的 MediaBox：若不是 ~230×160mm(landscape,w>h)，说明 writer 归一化了纸，artifact 无效。

param(
  [string]$Printer = "Ghostscript PDF",
  [string]$Python  = "C:/Program Files/Python312/python.exe",
  [string]$Pdf     = "test_fixtures/25952000000127675627.pdf",
  [int]   $Rotation = 90
)

$ErrorActionPreference = 'Stop'

# 切到仓库根（脚本默认 Sumatra 路径 resources/sumatra/SumatraPDF.exe 相对 cwd）
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$repoRoot  = Resolve-Path (Join-Path $scriptDir '..')
Set-Location $repoRoot
Write-Host "▶ 仓库根: $repoRoot" -ForegroundColor Cyan

# 1) rot0 artifact（自包含边距参考）
Write-Host "`n=== [1/2] rot0 artifact ===" -ForegroundColor Yellow
node scripts/verify_sumatra_rotation.js --pdf $Pdf --rotation 0 --printer $Printer --out artifacts/sumatra_a1_rot0.pdf --python $Python
if (-not (Test-Path artifacts/sumatra_a1_rot0.pdf)) {
  Write-Warning "rot0 artifact 未生成（writer 可能弹框/未静默）。V2-02 将回退到 A3-3-3 C5 参考边距。"
}

# 2) rot90 几何验证
Write-Host "`n=== [2/2] rot90 verification ===" -ForegroundColor Yellow
node scripts/verify_sumatra_rotation.js --pdf $Pdf --rotation $Rotation --printer $Printer --out artifacts/sumatra_a1_rot90.pdf --rot0-out artifacts/sumatra_a1_rot0.pdf --python $Python
