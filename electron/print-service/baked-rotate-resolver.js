'use strict';

/**
 * baked-rotate-resolver.js — Baked Real Paper Artifact → Sumatra rotate 映射
 *
 * ⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️
 * 状态：EXPERIMENTAL / UNVERIFIED（2026-08-15）
 *   本模块的 baked-rotate mapping 实施已被 E3 PostScript 实机证据击穿：
 *   假设 "landscape baked × landscape paper → rotate=90"（E1 用某个"横向纸型"实测），
 *   但 PostScript 实机证明该规则 ≠ 正确（仍需再顺时针 90° 才正确）。
 *
 *   根因（用户裁决）：**"横向纸型"作为二值抽象维度不足以决定 Sumatra rotate**。
 *   Sumatra 对 paper=PostScript 的实际纸张定义/方向处理与 E1 所用的"横向纸型"具体命令
 *   不等价——Sumatra/驱动层的 command semantics 是 per-paper-type 的精确语义，
 *   不可用 `paperTypeOrientation ∈ {portrait, landscape}` 二值抽象替代。
 *
 *   当前处置：
 *     - OsLauncherBridge.toSumatraArgs **已回滚**，contentRotation=0 无论 baked 与否
 *     - 模块保留作为实验性产物，便于 E3+ 取证（rotate=0/90/270 在 PostScript 下的
 *       实机物理方向）后，按更精确的实机 command semantics 重写映射
 *     - 不要在未获新实机证据前重新接入本模块
 *
 *   证据链：
 *     - .workbuddy/R2.3-A.3-Content-Rotation-vs-C2-Command-Mapping-Forensics.md §E3
 *     - _r22_e1/README-E3.md（PostScript 实机取证材料，待用户执行）
 * ⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️
 */

/**
 * 实验性映射（未验证，**当前未接入生产**）：
 *
 * | pdfOrientation | paperTypeOrientation | rotate | 状态 |
 * |----------------|--------------------|-------:|------|
 * | landscape      | portrait(A4)       |   0    | E1 A4 行1 ✅ |
 * | landscape      | landscape          |   90   | E3 PostScript ❌（假设被击穿）|
 * | portrait       | *                  |   0    | 未实机，保持现状（不宣称）|
 *
 * 与 C-2 16-case 的关系（语义隔离，不可混用数值）：
 *   - C-2 16-case（sumatra-command-resolver.js）：适用 **Source Invoice PDF**（fit 旋转语义）
 *   - 本表（实验性）：适用 **Baked Real Paper Artifact PDF**，但 rotate 维度必须是 per-paper-type
 *     的实机 command semantics，**不可**用 paperTypeOrientation 二值抽象替代
 *
 * @param {'portrait'|'landscape'} pdfOrientation      baked PDF 页面方向（MediaBox 判定）
 * @param {'portrait'|'landscape'} paperTypeOrientation 纸型固有方向（getPaperShapeOrientation）
 * @returns {0|90|180|270} Sumatra rotate 参数（未知组合一律 0）
 */
function resolveBakedRotate(pdfOrientation, paperTypeOrientation) {
  const pdf = pdfOrientation === 'landscape' ? 'landscape' : 'portrait';
  const paper = paperTypeOrientation === 'landscape' ? 'landscape' : 'portrait';
  // E3 PostScript 实机击穿（2026-08-15）："landscape × landscape → 90" 不是普适规则。
  // 本分支保留作为代码逻辑但不参与生产决策。
  if (pdf === 'landscape' && paper === 'landscape') return 90;
  // landscape × portrait → 0（E1 A4 行1 实证）；portrait × * → 0（未实机，保持现状）
  return 0;
}

module.exports = { resolveBakedRotate };