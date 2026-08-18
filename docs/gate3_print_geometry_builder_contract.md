# Gate 3 — PrintGeometryBuilder Boundary Contract (APPROVED WITH AMENDMENTS)

> **Gate 3 Design-Freeze Draft** — appendix to `docs/print_auto_rotation_contract_v1.md` (v1.0 FINAL, frozen) and `docs/preview_geometry_builder_boundary_contract.md` (Gate 2, frozen).
> **Does NOT modify v1.0 FINAL nor the Gate 2 contract.** This document is the **design draft** for Gate 3 only. **Status: APPROVED WITH AMENDMENTS (2026-08-18) — three amendments applied: D2 wording softened to "ownership migration, Gate 5 cleanup"; new B-10 (RenderCommand rotation ownership); new B-11 (Preview/Print rotation independence during Gate 3). Gate 3-0 Build Prep PASSED (2026-08-18); two reviewer addenda locked: (1) buildRenderCommand 4th param = PrintGeometry OBJECT not bare number (§7.2/§8.4/B-10a); (2) B-10a Factory no re-normalize + G3-B-13 guard + R6 case. Entering Gate 3-1.**
>
> Gate 2 verdict: **PASS ✅** (commit chain `5552375 → 7ce5d09 → c4c20cd → 06b284a → 8cd223b → 6689a61`). Gate 3 enters **Design Review** only; pipeline code stays frozen.

---

## 0. Review verdict carried in

- **Gate 2 PASS** confirmed: `usePreview` second orientation algorithm eliminated; `PreviewGeometryBuilder` consumes `PrintAutoRotationPolicy` (B-7); `renderCommand.paperLandscape` (Site B) untouched; `documentState` rotation not fed back (INV-D4-1).
- **Gate 3 risk class is higher than Gate 2** (per reviewer): Gate 2 = preview *identity* only; Gate 3 = print *output geometry* (what is rendered / printed / emitted to Sumatra). A wrong rotation here changes the physical page. Hence design-first, build-after-approval.
- **Frozen layers Gate 3 must NOT re-open** (carried from Gate 1/2 freeze + contract X-1):
  - `PrintAutoRotationPolicy.js` — decision domain, untouched.
  - `PreviewGeometryBuilder.js` — preview domain, untouched.
  - `layout/RotationResolver.js` (`resolveContentPlacement`) — **separate Viewer/PrintPreview domain** (layoutRotation ∈ {0,−90}); NOT Gate 3's concern; its *input* `contentRotation` may change, its *logic* does not.
  - `renderMultipleItemsToCanvas`, `detectOrientation.js:5-6` guard, `createPlacement`/`SlotLayout`/`composePlacement` (geometry owners), `SingleFileRenderCommand.js` (single-file PREVIEW producer), `execution-truth-resolver.js` (32-case Sumatra executor Truth, G2-R2 frozen).

---

## 1. Motivation (source-grounded)

Gate 2 removed the *second orientation-decision algorithm* from `usePreview`. Gate 3 removes the *second rotation-decision algorithm* from the **print / RenderCommand** path.

Today the final `RenderCommand.contentRotation` (what Renderer / Canvas / Print / Sumatra consume) is derived from **three** independent origins, none of which is `PrintAutoRotationPolicy`:

| Site | Code | Rotation origin |
|------|------|-----------------|
| `RenderLayoutFactory.js:149-151` | `contentRotation = normalizeRotation(documentState?.contentRotation ?? documentState?.rotation ?? 0)` | Factory internal fallback — reads `documentState` rotation field directly |
| `usePreview.js:584` | `buildRenderCommand(paperLayout, { ...documentStateRef.current, contentRotation: previewRotation })` | `previewRotation = fileRotations[previewFile?.key] \|\| 0` (L574) — **user rotation only, no auto** |
| `usePrint.js:479` | `const contentRotation = fileRotations[f.key] \|\| 0` → `resolveContentPlacement({ contentRotation, ... })` | `fileRotations` (user rotation only) into `RotationResolver` domain |

Consequences:
1. **No auto-rotation reaches the printed page.** All three sources carry *user* rotation only; `autoRotation` from `PrintAutoRotationPolicy` is never applied to `RenderCommand`. The Print Auto Rotation Contract's central behavior (content-direction → paper-direction auto-align) is therefore **not yet in effect** for print output.
2. **Three derivations, one logical value.** This is the same "second/third algorithm" smell Gate 2 eliminated in preview. Gate 3 collapses them to ONE decision owner.
3. **Feedback-loop risk (INV-D4-1 at print layer).** `RenderLayoutFactory.js:149-151` reads `documentState.rotation/contentRotation` as its rotation source. If Gate 3 feeds `effectiveRotation` *back into* `documentState`, the loop re-opens on the print side. Builder output is strictly downstream (B-3, inherited).

---

## 2. Target call graph (per reviewer D1/D2/D3)

```
                         RawGeometry (content px + paper orientation + userRotation)
                                          │
                                          ▼
                          PrintAutoRotationPolicy   (Geometry Layer, pure, frozen)
                                          │
                         ┌────────────────┴────────────────┐
                         │                                  │
              PreviewGeometryBuilder              PrintGeometryBuilder   (Gate 2 ✅)        (Gate 3 NEW)
                         │                                  │
            effectiveRotation (preview)        effectiveRotation (print)  ← single decision, same Policy
                         │                                  │
                  usePreview.js                   usePrint.js / buildRenderCommand
                         │                                  │
                 Renderer / Canvas                 RenderCommand → Canvas / Sumatra / PDF
```

**Reviewer D1 — do NOT share the Builder:**
- `PreviewGeometryBuilder` serves *display identity / cache identity / container geometry*.
- `PrintGeometryBuilder` serves *paper geometry / slot geometry / media box / printer transform* semantics.
- They share **only** `PrintAutoRotationPolicy`. No shared Builder base, no reuse of `buildPreviewGeometry` inside print. Two separate pure functions.

**Reviewer D2 — who owns final rotation? → A: `PrintGeometryBuilder` → `RenderCommand`.**
- `buildRenderCommand` (the RenderCommand Factory) MUST consume `printGeometry.effectiveRotation` as its rotation source.
- The historical `documentState.contentRotation ?? documentState.rotation` derivation inside the factory is transitioned to a **migration-only** backward-compat shim: **ownership** of the value moves from the factory to `PrintGeometryBuilder`. The shim is **not deleted in Gate 3** — cleanup is deferred to Gate 5.
- **Gate 3 changes ownership, not cleanup**: new production call sites MUST reach `printGeometry.effectiveRotation` directly and MUST NOT reach the shim; the shim remains unreachable from new paths until Gate 5 removes it.

**Reviewer D3 — `paperLandscape` ownership stays put:**
- `RenderLayoutFactory.js:153` `paperLandscape = paperOrientation === 'landscape'` (from `documentState.paperOrientation` Fact) is **unchanged**.
- `PrintGeometryBuilder` reads `requestedPaperGeometry.orientation` as *input* to compute `autoRotation`, but MUST NOT output `paperLandscape` as a decision. Paper direction is a physical constraint owned by the Factory, not by the rotation decision. (Same trap Gate 2 hit with `effectiveRotation → paperLandscape`; do not repeat.)

---

## 3. PrintGeometryBuilder interface (proposed)

```js
// frontend/src/geometry/PrintGeometryBuilder.js  (Gate 3, NEW — standalone, NOT reusing PreviewGeometryBuilder)
import { resolvePrintAutoRotation } from './PrintAutoRotationPolicy.js'

/**
 * @param {object} rawDocumentGeometry  { widthPx, heightPx }  — same raw px source as PreviewGeometryBuilder
 * @param {object} requestedPaperGeometry { orientation }       — from resolvePaper(paperSize, customPaper)
 * @param {object} userRotation         { degrees }            — fileRotations[f.key] || 0 (manual rotation, session authority)
 * @returns {PrintPlacementGeometry}
 *   {
 *     effectiveRotation,          // canonical clockwise {0,90,180,270}   (from Policy: autoRotation + userRotation)
 *     autoRotation,               // canonical clockwise, auto-only (INV-D4-1: computed once)
 *     sourceContentGeometry,      // { widthPx, heightPx, orientation } — pre-rotation content
 *     effectiveContentGeometry,   // { widthPx, heightPx, orientation } — post-rotation content (from Policy)
 *     sourceContentLandscape,     // boolean: pre-rotation content横置
 *     effectiveContentLandscape,  // boolean: post-rotation content横置
 *     // ⚠️ NO paperLandscape field — ownership stays with RenderLayoutFactory (D3).
 *   }
 */
export function buildPrintGeometry({ rawDocumentGeometry, requestedPaperGeometry, userRotation }) {
  const sourceContentGeometry = {
    widthPx: rawDocumentGeometry.widthPx,
    heightPx: rawDocumentGeometry.heightPx,
    orientation: rawDocumentGeometry.heightPx > rawDocumentGeometry.widthPx ? 'portrait' : 'landscape',
  }
  const sourceContentLandscape = rawDocumentGeometry.widthPx > rawDocumentGeometry.heightPx

  const targetPaperGeometry = { orientation: requestedPaperGeometry.orientation }

  // single decision exit: PrintAutoRotationPolicy (B-7 analog — Builder never re-computes ±90 / normalize)
  const { autoRotation, effectiveRotation, effectiveContentWidth, effectiveContentHeight } =
    resolvePrintAutoRotation({ sourceContentGeometry, targetPaperGeometry, userRotation: userRotation.degrees || 0 })

  const effectiveContentGeometry = {
    widthPx: effectiveContentWidth,
    heightPx: effectiveContentHeight,
    orientation: effectiveContentHeight > effectiveContentWidth ? 'portrait' : 'landscape',
  }
  const effectiveContentLandscape = effectiveContentWidth > effectiveContentHeight

  return {
    effectiveRotation,
    autoRotation,
    sourceContentGeometry,
    effectiveContentGeometry,
    sourceContentLandscape,
    effectiveContentLandscape,
    // D3: paperLandscape intentionally ABSENT — owned by RenderLayoutFactory (paperOrientation Fact).
  }
}
```

**Responsibilities**: content-rotation-in → rotation-out. **Non-responsibilities**: paper direction, renderer, canvas, pdf, image, persistence, any write-back, slot layout, media box assembly (those stay in their frozen owners; `effectiveContentGeometry` is *available* for a future placement-convergence sub-gate but Gate 3 touches only `contentRotation`).

---

## 4. Boundary invariants (Gate 3)

- **B-1 (call graph)**: `usePrint.js` / `buildRenderCommand` MUST NOT import or call `resolvePrintAutoRotation` / `PrintAutoRotationPolicy` directly. They import and call `buildPrintGeometry` only.
- **B-2 (pure transform, no state)**: `PrintGeometryBuilder` holds no state, caches nothing, writes back nothing (`documentState`, `fileRotations`, `DocFacts`, print model).
- **B-3 (no feedback loop / INV-D4-1 at print layer)**: Builder output is strictly downstream. `effectiveRotation` MUST NOT be written back into `documentState.rotation/contentRotation` or `fileRotations`. Forbidden reverse: `effectiveRotation → documentState`. (Contrast with preview: preview already isolates this; print must match.)
- **B-4 (renderer isolation)**: Renderer / Canvas / Sumatra receive only `RenderCommand.contentRotation` (= `effectiveRotation`); they never know auto-vs-user split (Policy already merged).
- **B-5 (single decision point)**: The scattered `contentRotation` derivations (`RenderLayoutFactory.js:149-151`, `usePreview.js:584`, `usePrint.js:479`) MUST collapse to `buildPrintGeometry(...).effectiveRotation` as the single source for the print RenderCommand. No other path may compute print rotation.
- **B-6 (canonical degrees)**: All rotation out of the Builder into `RenderCommand` MUST be canonical clockwise ∈ `{0,90,180,270}` (inherited INV-D4-3).
- **B-7 (single resolver / fixed output contract)**: `PrintGeometryBuilder` MUST NOT become a second resolver — no self-judged landscape/portrait, no self `±90` mapping, no self `normalizeRotation`. It returns its own named `PrintPlacementGeometry` object, NOT `resolvePrintAutoRotation(...)` verbatim.
- **B-8 (paperLandscape boundary, D3)**: `PrintGeometryBuilder` MUST NOT output `paperLandscape`, and `buildRenderCommand` MUST continue deriving `paperLandscape` from `paperOrientation` Fact (`RenderLayoutFactory.js:153`). `effectiveRotation` MUST NOT become a `paperLandscape` source anywhere.
- **B-9 (domain separation, X-1)**: `PrintGeometryBuilder` consumes `PrintAutoRotationPolicy` only. It MUST NOT call `RotationResolver.resolveContentPlacement` and MUST NOT duplicate its `layoutRotation` semantics. The print-plan layer (`resolveContentPlacement`) remains a separate frozen domain; Gate 3 changes only the *input* it receives (see §7.3 / §7.5), never its logic.
- **B-10 (RenderCommand rotation ownership)**: `RenderCommand.contentRotation` MUST originate from `PrintGeometry.effectiveRotation`. `RenderLayoutFactory` MUST NOT derive rotation from `documentState` fields. A legacy fallback may exist **only** during migration and MUST NOT be reachable from new production paths (per the D2 migration framing above). This is the print-layer analogue of B-7 (single resolver) and INV-D4-1 (no second decision point) — the core Gate 3 invariant.
- **B-10a (Factory consumes, does NOT interpret — Gate 3-0 reviewer addendum)**: `RenderLayoutFactory` MUST NOT accept any rotation value that requires interpretation — no `normalizeRotation(printGeometry.effectiveRotation)`, no `normalizeRotation(printGeometry.autoRotation + documentState.rotation)`, no raw degrees needing canonicalization. It may **only read** the canonical `{0,90,180,270}` result already produced by `PrintGeometryBuilder` via `resolvePrintAutoRotation`. The Builder canonicalizes; the Factory forwards. A second canonicalization = a second resolver (forbidden, see B-7). Therefore the `buildRenderCommand` seam receives the **whole `PrintGeometry` (or `resolvedPlacementGeometry`) object**, never a bare `contentRotation` number — a bare-number parameter weak-holds B-10 by implying the Factory still owns rotation (see §7.2 / §8 step 4).
- **B-11 (Preview/Print rotation independence during Gate 3)**: Gate 3 MUST NOT change preview rotation semantics. Preview user-intent rotation (`previewRotation` = `fileRotations`) remains owned by the preview pipeline until a separate **Gate 3-A** (Preview/Print visual convergence) handles it. Implementers MUST NOT "reuse `effectiveRotation`" inside `usePreview` simply because the field exists — preview and print rotation are intentionally decoupled in Gate 3, and are permitted to differ.

---

## 5. Acceptance matrix (Gate 3)

Reuse v1.0 FINAL **D3 4-cell** for `effectiveRotation`. Add:

- **G3-R1 (coordinate regression: print ≡ preview, same resolver)**: For identical `(rawDocumentGeometry, requestedPaperGeometry, userRotation)`, `buildPrintGeometry(...).effectiveRotation` MUST equal `buildPreviewGeometry(...).effectiveRotation`. Both consume `resolvePrintAutoRotation`; neither computes rotation independently. *(Satisfies the Gate 2 contract §5 "G2-Coordinate Regression" cross-link.)* **Test**: shared vector table drives both builders; assert equality across D3 4-cell × userRotation {0,90,180,270}.
- **G3-R2 (effectiveRotation = auto + user, not override)**: Landscape content `3508×2480` + A4 portrait + `userRotation=90` → `effectiveRotation = 270` (auto 270 + user 90 = 360 → 0? NO: auto=270, user=90 → 270+90=360 → 0; correct canonical). Assert `effectiveRotation = normalizeRotation(autoRotation + userRotation)` and that neither auto-wins nor user-replaces. (Mirror Gate 2 G2-R3.)
- **G3-R3 (RenderCommand boundary — no second resolver)**: After wiring, `buildRenderCommand(paperLayout, documentState, slot, { contentRotation: printGeometry.effectiveRotation })` produces `cmd.contentRotation === printGeometry.effectiveRotation`. **Static**: `buildRenderCommand` body contains **zero** references to `documentState?.contentRotation ?? documentState?.rotation` as the rotation source (replaced by the passed-in value). Grep for the old fallback pattern → 0 matches in the active path.
- **G3-R4 (paperLandscape unchanged, D3)**: `buildRenderCommand(...).paperLandscape === (paperOrientation === 'landscape')` for all orientations; `effectiveRotation` never influences `paperLandscape`. **Static + runtime**: grep `PrintGeometryBuilder` for `paperLandscape` → 0 matches; runtime assert `paperLandscape` independent of `effectiveRotation` across 4-cell × 2 paper orientations.
- **G3-R5 (no writeback / INV-D4-1)**: Builder output never assigned to `documentState.rotation/contentRotation` or `fileRotations` in `usePrint.js`. Static grep builder + usePrint for `documentState.*Rotation =|fileRotations[` → 0 matches on `effectiveRotation`.
- **G3-R6 (RotationResolver domain untouched, X-1)**: `layout/RotationResolver.js` byte-identical to pre-Gate-3 (frozen). Grep/compare: only its *callers' input argument* may change, not its source. (Verify via `git diff` review — zero-diff on the file.)
- **Visual / physical**: Re-print `26447000000943604784.ofd` (the regression file) → direction correct (content auto-aligns to paper), no timeout, no double-rotation.

---

## 6. Gate ordering (updated)

```
Gate 1  ✅ resolvePrintAutoRotation (pure)              commit 5552375
Gate 2  ✅ PreviewGeometryBuilder + usePreview identity  (7ce5d09 → c4c20cd → 06b284a → 8cd223b → 6689a61)
Gate 3  🔜 PrintGeometryBuilder + usePrint / buildRenderCommand convergence   (DESIGN APPROVED 2026-08-18; build pending)
Gate 3-A ⏸ Preview/Print visual convergence (preview contentRotation ← previewGeometry.effectiveRotation) — DEFERRED from Gate 3 per B-11
Gate 4  ⏸ Merge per-slot (V16 createPlacement) — consumes PrintGeometryBuilder for slot rotation
Gate 5  ⏸ LAST: relax detectOrientation.js:5-6 + regression (OFD guard 3/3, Gate A 77/77, new vectors)
```

**Do NOT delete the `disable-auto-rotation` guard (`detectOrientation.js:5-6`) until Gate 2/3/4 all consume the resolver and pass regression.**

---

## 7. Open design decisions (freeze before build)

### 7.1 Gate 3-D1 — Builder reuse → NO (CONFIRMED by reviewer)
`PrintGeometryBuilder` is a **separate** pure function from `PreviewGeometryBuilder`. Both consume `PrintAutoRotationPolicy`. No shared base, no `buildPreviewGeometry` call inside print.

### 7.2 Gate 3-D2 — RenderCommandFactory rotation ownership → A: PrintGeometryBuilder → RenderCommand (CONFIRMED by reviewer)
`buildRenderCommand` consumes `printGeometry.effectiveRotation`. It does NOT re-resolve from `documentState`. The historical `documentState`-based derivation becomes a migration-only shim whose **ownership** is transferred to `PrintGeometryBuilder`; Gate 3 does **not** delete the shim (cleanup is Gate 5's job). New call sites MUST NOT reach the shim.

**Seam interface (Gate 3-0 addendum)**: `buildRenderCommand`'s 4th parameter MUST be the `PrintGeometry` (or `resolvedPlacementGeometry`) **object**, not a bare `contentRotation` number. A bare `contentRotationOverride` parameter implies the Factory still owns rotation and invites a future `autoRotationOverride` / `finalRotationOverride` re-assembly layer — directly weakening B-10. The Factory reads `printGeometry.effectiveRotation` and forwards it (`contentRotation = printGeometry.effectiveRotation`); it MUST NOT re-normalize (B-10a).

### 7.3 Gate 3-D3 — paperLandscape ownership → RenderLayoutFactory (CONFIRMED by reviewer)
`paperLandscape` stays `paperOrientation === 'landscape'` (`RenderLayoutFactory.js:153`). `PrintGeometryBuilder` does not output it.

### 7.4 Sub-decision — preview `contentRotation` convergence (DEFERRED to Gate 3-A, per reviewer ❌)
Currently `usePreview.js:584` injects `contentRotation: previewRotation` (= `fileRotations`, user-only). Making **preview ≡ print** under the contract (auto-rotation visible in preview) would require passing `previewGeometry.effectiveRotation` into `buildRenderCommand`. **Reviewer verdict ❌ — NOT in Gate 3 main line.** `previewRotation` represents *user intent*; `effectiveRotation` represents *policy result* — different semantics. Changing it now mutates preview snapshot identity, render cache, rotation display, and user-rotation persistence assumptions: a **behavior change, not plumbing**. **Deferred to separate `Gate 3-A` (Preview/Print visual convergence).** Gate 3 keeps preview on the user-rotation path and print on the auto-rotation path; the two are permitted to differ until Gate 3-A (see B-11).

### 7.5 Sub-decision — print-plan layer (`resolveContentPlacement`) input (APPROVED into Gate 3, per reviewer ✅)
`usePrint.js:479` feeds `contentRotation = fileRotations[f.key]` into `RotationResolver.resolveContentPlacement` (frozen domain). This is a **print-pipeline ownership** problem (auto rotation never reaches the print-plan), not a UI behavior. **Reviewer verdict ✅ — approved into Gate 3.** The change is at the **caller only**:
```diff
-contentRotation = fileRotations[f.key] || 0
+contentRotation = printGeometry.effectiveRotation
```
`RotationResolver.resolveContentPlacement` *internal logic* stays frozen (B-9 / G3-R6 / X-1). This makes `PrintGeometryBuilder` the sole decision owner for the print-plan input (B-10).

---

## 8. Gate 3 Build Sequence & Constraints (proposed, pending approval)

Build order (mirrors Gate 2's proven sequence):

1. `PrintGeometryBuilder.js` pure function (no production wiring) — standalone, per §3.
2. Vector tests — explicit case matrix (mirrors reviewer Gate 3-2):\n   - **R1** 横票 `3508×2480` + A4 portrait → auto rotation 生效 (`effectiveRotation=270`)\n   - **R2** 竖票 `2480×3508` + A4 portrait → `effectiveRotation=0`\n   - **R3** 横票 + landscape paper → 不强制旋转 (`effectiveRotation=0`, autoRotation=0)\n   - **R4** `userRotation≠autoRotation` (横票+portrait, `userRotation=90`) → `normalize(270+90)=0` 正确（保留此易误判 case，Gate 2 已证）\n   - **R5** RenderCommand rotation ownership — Builder 输出成为 `effectiveRotation` 唯一来源（B-10）\n   - **R6** user cancel auto（Gate 3-0 新增必保留）：横票+portrait+`userRotation=90` → `autoRotation=270`, `effectiveRotation=normalize(270+90)=0`。**目的：防止实现者写成 `effectiveRotation=autoRotation`（auto 恒赢）或 `userRotation replaces autoRotation`（覆盖）**——验证 `effectiveRotation = normalize(autoRotation + userRotation)` 的**叠加**语义，而非覆盖。\n   另覆盖：G3-R1 (print≡preview 同 resolver) + G3-R4 (paperLandscape 边界, Builder 不输出) + G3-R5 (no writeback, 静态).
3. Static grep guards (Gate 3 Build-Time Guards G3-B-10 ~ G3-B-13):\n   - **G3-B-10** `RenderLayoutFactory` 禁新增 `documentState.contentRotation ?? documentState.rotation` 推导（落实 B-10）。\n   - **G3-B-11** Preview 禁 `effectiveRotation` 注入 `previewRotation`（落实 B-11）。\n   - **G3-B-12** `layout/RotationResolver.js` diff 必须为空（落实 G3-R6 / X-1）。\n   - **G3-B-13** grep `RenderLayoutFactory.js` 中 `normalizeRotation(`：除合法 import / helper 定义外，不允许出现**新的** rotation normalization（防 Factory 接 Builder 后再 normalize 一次 = 第二 resolver，B-10a）。
4. Wiring: `usePrint.js` / `buildRenderCommand` consume `printGeometry.effectiveRotation`. **Seam parameter = the `PrintGeometry` / `resolvedPlacementGeometry` object** (NOT a bare `contentRotation` number, per §7.2 / B-10a). Factory reads `printGeometry.effectiveRotation` and forwards — no re-normalize. **Print path wired first (Gate 3-4A); then print-plan caller (Gate 3-4B)**; do NOT wire both simultaneously (isolate diagnosis). The preview path stays on `previewRotation` (deferred to Gate 3-A, see B-11 / §7.4) — do NOT pass `effectiveRotation` into `usePreview` in Gate 3.

Allowed:
- ✅ 新增 `frontend/src/geometry/PrintGeometryBuilder.js`
- ✅ 新增 vector tests
- ✅ 修改 `usePrint.js` 接入口（仅消费 Builder 输出）
- ✅ 修改 `buildRenderCommand` 增加 `printGeometry` / `resolvedPlacementGeometry` 对象入参（消费 `Builder.effectiveRotation`；Factory 不 re-normalize，B-10a；历史 `documentState` fallback 降级为迁移期 shim，所有权移交 Builder，Gate 5 清理，Gate 3 不删）

Forbidden (unchanged from freeze):
- ❌ 修改 `PrintAutoRotationPolicy` 契约
- ❌ 修改 `PreviewGeometryBuilder`
- ❌ 修改 `layout/RotationResolver.js` 逻辑（仅可改其调用方传入的 contentRotation 实参）
- ❌ 修改 `renderMultipleItemsToCanvas` / renderer
- ❌ 删除 `detectOrientation.js` guard（Gate 5 才动）
- ❌ 修改 `execution-truth-resolver.js` / Sumatra 执行层（独立冻结层）
- ❌ 修改 `createPlacement` / `SlotLayout` / `composePlacement` / `SingleFileRenderCommand.js`

**Commit discipline**: one commit for the Builder + tests, one commit for the wiring (mirrors Gate 2's `c4c20cd` + `8cd223b` split). No amend, no Gate-4/guard mixing.

---

*Frozen references:* `docs/print_auto_rotation_contract_v1.md` (v1.0 FINAL, D1–D7, INV-D4-1/2/3, X-1); `docs/preview_geometry_builder_boundary_contract.md` (Gate 2); `frontend/src/geometry/PrintAutoRotationPolicy.js` (Gate 1, `5552375`); `frontend/src/geometry/PreviewGeometryBuilder.js` (Gate 2); `frontend/src/layout/RenderLayoutFactory.js:115-245` (RenderCommand Factory; `:149-151` rotation source, `:153` paperLandscape); `frontend/src/hooks/usePreview.js:574,584` (preview rotation source); `frontend/src/hooks/usePrint.js:479` (print-plan rotation source → `RotationResolver`); `frontend/src/layout/RotationResolver.js` (frozen print-plan domain); `frontend/src/print/*execution-truth-resolver*` (frozen Sumatra executor Truth).
