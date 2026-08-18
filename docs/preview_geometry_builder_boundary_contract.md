# PreviewGeometryBuilder Boundary Contract

> **Gate 2 Implementation Appendix** to `docs/print_auto_rotation_contract_v1.md` (v1.0 FINAL, frozen).
> **Does NOT modify v1.0 FINAL.** This document is the design-freeze for Gate 2 only.
> Status: **APPROVED FOR GATE 2 BUILD** (after D2 amendment: §7.2 + B-3). No production code changed (`usePreview.js` / `PrintAutoRotationPolicy.js` untouched).

---

## 0. Review verdict carried in

- **Gate 1: PASS** — `resolvePrintAutoRotation` (commit `5552375`) is a pure transform in the Geometry Layer, holds no state, no third source of truth. Canonical clockwise `{0,90,180,270}` (INV-D4-3) is enforced at the Policy boundary.
- **Gate 2 rename accepted**: from "Preview Builder 接入 resolver" → **"PreviewGeometryBuilder 引入统一 Rotation Decision Adapter"**.
- **Gate ordering reaffirmed**: do NOT relax `detectOrientation.js:5-6` until Gate 2/3/4 all consume the resolver and pass regression.

---

## 1. Motivation (source-grounded)

`usePreview.js` currently contains **three independent orientation-decision points**, each mixing heterogeneous geometry sources:

| Site | Code | Inputs mixed |
|------|------|--------------|
| L684–687 | `isLandscape = contentOrient !== paperOrient` | `detectDocumentOrientation(previewFile)` (live file) + `paper.widthMM > paper.heightMM` (paper) |
| L1076–1088 | `swapped = ... docOrient !== paperOrient` | `documentStateRef.current?.pageOrientation` (persisted fact) + `paper` (paper) |
| L1576–1579 | `isLandscape = contentOrient !== paperOrient` (load path) | `detectDocumentOrientation(loadedFile)` + `paper` |

These compute the **same logical decision** (content-direction vs paper-direction → rotation/swap) from **different origins** (live file geometry vs persisted `documentStateRef.pageOrientation` vs `fileRotations`). This is exactly the "second algorithm" the repo has been eliminating (F4: "消除第二套算法").

**Feedback-loop risk (INV-D4-1 revival at preview layer):**
- L1643–1644 writes `contentRotation` / `rotation` into `documentStateRef.current`.
- L1077 then reads `documentStateRef.current?.pageOrientation` back for the container swap.

That is a write→read channel on geometry state. If Gate 2 calls `resolvePrintAutoRotation` and feeds its output back into `documentStateRef`, the loop re-opens: Preview state → auto rotation → changed content orientation → re-enter resolver → re-auto-rotate.

---

## 2. Target call graph (per review)

```
PrintAutoRotationPolicy            (Geometry Layer, pure transform)   [Gate 1, frozen]
        ▲
        │ consumed by
        │
PreviewGeometryBuilder            PrintGeometryBuilder               (Gate 2 NEW)      (Gate 3 NEW)
        ▲                              ▲
        │ consumes output              │ consumes output
        │                              │
usePreview.js (Preview)          usePrint.js (Print)
        │
        ▼
Renderer / Canvas / CSS  —  ONLY sees PreviewPlacementGeometry; never knows autoRotation origin
```

**FORBIDDEN**: `usePreview.js → PrintAutoRotationPolicy → Canvas`. `usePreview` must call `PreviewGeometryBuilder`, never the Policy directly.

---

## 3. PreviewGeometryBuilder interface

```js
// frontend/src/geometry/PreviewGeometryBuilder.js  (Gate 2)
import { resolvePrintAutoRotation } from './PrintAutoRotationPolicy.js'

/**
 * @param {object} rawDocumentGeometry
 *   Raw CONTENT geometry from the file object — SAME fields detectDocumentOrientation reads,
 *   but KEEPING px (Policy needs widthPx/heightPx, not just orientation).
 *   { widthPx, heightPx }
 *     PDF  : _pdfPageWidth / _pdfPageHeight
 *     Image/OFD: _imageWidth / _imageHeight  (or previewWidth / previewHeight)
 * @param {object} requestedPaperGeometry
 *   { orientation }   // from resolvePaper(paperSize, customPaper): widthMM > heightMM ? 'landscape' : 'portrait'
 * @param {object} userRotation
 *   { degrees }       // fileRotations[file.key] || 0  (manual rotation, session authority)
 * @returns {PreviewPlacementGeometry}
 *   {
 *     effectiveRotation,           // canonical clockwise {0,90,180,270}   (from Policy)
 *     paperGeometry,               // { orientation } — physical paper, external constraint, NEVER from effectiveRotation
 *     effectiveContentGeometry,    // { widthPx, heightPx } — post-auto-rotation content geometry (from Policy)
 *     contentLandscape,            // boolean: content is landscape, from effectiveContentGeometry (post-rotation)
 *     paperLandscape,              // boolean: paper is landscape, from PaperGeometry (physical paper orientation)
 *     isLandscape,                 // preview container swap — combination of the two, computed ONLY inside Builder
 *   }
 */
export function buildPreviewGeometry({ rawDocumentGeometry, requestedPaperGeometry, userRotation }) {
  const sourceContentGeometry = {
    widthPx: rawDocumentGeometry.widthPx,
    heightPx: rawDocumentGeometry.heightPx,
    orientation: rawDocumentGeometry.heightPx > rawDocumentGeometry.widthPx ? 'portrait' : 'landscape',
  }
  const targetPaperGeometry = { orientation: requestedPaperGeometry.orientation }

  const { autoRotation, effectiveRotation, effectiveContentWidth, effectiveContentHeight } =
    resolvePrintAutoRotation({ sourceContentGeometry, targetPaperGeometry, userRotation: userRotation.degrees || 0 })

  // FROZEN DIRECTION (D2 amendment — MUST NOT reverse):
  //   paperLandscape   ← PaperGeometry       (physical paper, external constraint: A4 portrait = 210×297 always)
  //   contentLandscape ← effectiveContentGeometry (post-rotation)
  //   isLandscape (display swap) ← combination of the two, computed ONLY here — never from effectiveRotation alone.
  // effectiveRotation MUST NOT become the source of paperLandscape: that would couple content
  // rotation back into physical paper, violating INV-2 and corrupting Sumatra / MediaBox / Margin Contract.
  const paperLandscape = requestedPaperGeometry.orientation === 'landscape'
  const contentLandscape = effectiveContentWidth > effectiveContentHeight  // boolean: content is landscape (post-rotation)
  const isLandscape = contentLandscape !== paperLandscape                  // both booleans — mirrors old `contentOrient !== paperOrient`

  // FIXED OUTPUT CONTRACT (B-7): return a named PreviewPlacementGeometry object, NOT the raw
  // resolvePrintAutoRotation(...) return. Consumption domain (Preview) connects to the decision
  // domain (Policy) via this data contract, not object pass-through.
  return {
    effectiveRotation,
    paperGeometry: { orientation: requestedPaperGeometry.orientation },
    effectiveContentGeometry: { widthPx: effectiveContentWidth, heightPx: effectiveContentHeight },
    contentLandscape,
    paperLandscape,
    isLandscape,
  }
}
```

**Responsibilities**: geometry-in → geometry-out. **Non-responsibilities**: render, canvas, pdf, image, persistence, any write-back.

---

## 4. Boundary invariants (core of the contract)

- **B-1 (call graph)**: `usePreview.js` MUST NOT import or call `resolvePrintAutoRotation` / `PrintAutoRotationPolicy`. It imports and calls `buildPreviewGeometry` only.
- **B-2 (pure transform, no state)**: `PreviewGeometryBuilder` holds no state, caches nothing, and MUST NOT write back into `documentStateRef`, `fileRotations`, `DocFacts`, or any preview model. Function: geometry-in → geometry-out.
- **B-3 (no feedback loop / INV-D4-1 guardian at preview layer)**: Builder output is **strictly downstream**. It is never fed back as input to itself, `detectDocumentOrientation`, or `resolvePaper`. Persisted rotation state represents **user intent only**; effective rotation is **runtime geometry output** and MUST NOT be persisted back into document state (`documentStateRef`, `fileRotations`, `DocFacts`). Forbidden reverse: `effectiveRotation → fileRotations`. (Today's L1643–1644 writes the user-rotation part only; this invariant generalizes that to any future user-intent signal — rotate 90 / cancel / keep-orientation — not just `contentRotation`.)
- **B-4 (renderer isolation)**: Renderer / Canvas / CSS transform receive only `PreviewPlacementGeometry` fields. They never know whether a rotation came from auto or user — both are already merged into `effectiveRotation` by the Policy.
- **B-5 (single decision point)**: The three existing inline computations (L687, L1076–1088, L1579) MUST collapse into ONE `buildPreviewGeometry` call site (memoized from the same inputs). No other path may compute content-vs-paper orientation.
- **B-6 (canonical degrees)**: All rotation values out of the Builder into renderer/Canvas/CSS MUST be canonical clockwise ∈ `{0,90,180,270}` (inherited from Policy INV-D4-3). No `-90`, no arbitrary degrees.
- **B-7 (single resolver / fixed output contract)**: `PreviewGeometryBuilder` MUST NOT become a second resolver. It MUST NOT independently compute the auto-rotation decision — no self-judged landscape/portrait, no self-computed `±90` mapping, no self-`normalizeRotation`. The rotation decision belongs **solely** to `PrintAutoRotationPolicy` (prevents a dual source of truth / resolver fork). The Builder MAY only *combine* Policy outputs with `PaperGeometry` (`paperLandscape` / `contentLandscape` / `isLandscape`) — combination is not decision. It MUST return its own named `PreviewPlacementGeometry` object (§3); it MUST NOT `return resolvePrintAutoRotation(...)` verbatim (consumption domain vs decision domain are connected by a data contract, not object pass-through).

---

## 5. Acceptance matrix (Gate 2)

Reuse v1.0 FINAL **D3 4-cell**. Add:

- **G2-INV-D4-1 Regression (no feedback)**: Landscape invoice `widthPx=3508, heightPx=2480` + A4 portrait paper.
  - First build → `effectiveRotation=270`.
  - On refresh (re-enter builder with same inputs) → input MUST still be `{widthPx:3508, heightPx:2480}`, output MUST still be `270`. Builder MUST NOT read back a transposed geometry (`2480×3508`) as its own input. **Test**: call builder twice with identical raw geometry; assert `out2 === out1` AND the raw input object is unmutated.
- **G2-Coordinate Regression (preview == print, same resolver)**: For the same document + paper + userRotation, `buildPreviewGeometry(...).effectiveRotation` MUST equal `buildPrintGeometry(...).effectiveRotation` (Gate 3). Both consume `resolvePrintAutoRotation`; neither computes rotation independently. **Test**: shared vector table drives both builders; assert equality.
- **G2-B-5 (single call site)**: Static — `usePreview.js` imports `buildPreviewGeometry` from `geometry/PreviewGeometryBuilder.js` and contains **zero** direct references to `resolvePrintAutoRotation` / `PrintAutoRotationPolicy`. Grep → 0 matches.
- **G2-B-3 (no writeback)**: Static + runtime — builder output never assigned to `documentStateRef.current.{pageOrientation,contentRotation,rotation}` or `fileRotations`. Grep builder for `documentStateRef|fileRotations|saveDocFacts` → 0 matches.
- **Visual**: 横票+竖纸 / 竖票+横纸 render matches expected swap exactly — no double-rotation, no missing rotation.

---

## 6. Gate ordering (reaffirmed)

```
Gate 1  ✅ resolvePrintAutoRotation (pure)            commit 5552375
Gate 2  ⏸ PreviewGeometryBuilder + usePreview consumes   (this contract → build → tests)
Gate 3  ⏸ PrintGeometryBuilder + usePrint consumes
Gate 4  ⏸ Merge per-slot (V16 createPlacement)
Gate 5  ⏸ LAST: relax detectOrientation.js:5-6 + regression
                              (OFD guard 3/3, Gate A 77/77, new vectors)
```

**Do NOT delete the `disable-auto-rotation` guard (`detectOrientation.js:5-6`) until Gate 2/3/4 all consume the resolver and pass regression.** Old guard removed + new rule not covering all paths = rotation fork window.

---

## 7. Open design decisions (confirm before build)

1. **RawDocumentGeometry source**: `detectDocumentOrientation` (`detectOrientation.js:23`) discards px (returns orientation only). Builder needs `{widthPx,heightPx}`. **Decision**: Builder consumes the file's raw px fields directly (same source `detectDocumentOrientation` reads) and derives orientation internally; `usePreview` passes the file object (or extracted px), **not** the orientation boolean. → *Confirmed.*
2. **paperLandscape / isLandscape 来源分离 (D2 修正, APPROVED WITH AMENDMENT)**: `paperLandscape` 来源于 `PaperGeometry`（物理纸张方向，外部约束——A4 portrait 恒为 210×297，不随 rotation 改变）；`contentLandscape` 来源于 `effectiveContentGeometry`（`effectiveRotation` 之后的内容几何）；所有 display/placement swap 决策（含 `isLandscape`）必须消费 Builder 输出，禁止重新由 `contentOrientation + paperOrientation` 独立推导。`effectiveRotation` **不得**成为 `paperLandscape` 的来源——否则内容旋转重新耦合物理纸张方向，违反 INV-2 并破坏 Sumatra 参数 / MediaBox / Margin Contract。→ *Confirmed.*
3. **Three call-site collapse**: L687 (renderKey), L1076–1088 (container swap), L1579 (load DocumentState) all read the SAME builder output. **Decision**: compute `buildPreviewGeometry` once per `(file, paper, userRotation)` change in a `useMemo`, share to all three sites. → *Confirmed.*

---

## 8. Gate 2 Build Sequence & Constraints (APPROVED)

Build order (per review approval):

1. `PreviewGeometryBuilder.js` pure function (no production wiring)
2. vector tests (D3 4-cell + G2-INV-D4-1 Regression + G2-Coordinate Regression + G2-B-3 / G2-B-5 guards)
3. static grep guard (G2-B-5: `usePreview.js` zero direct `resolvePrintAutoRotation` / `PrintAutoRotationPolicy` refs; G2-B-3: builder zero `documentStateRef | fileRotations | saveDocFacts`)
4. `usePreview.js` integration (collapse L687 / L1076–1088 / L1579 to a single `buildPreviewGeometry` `useMemo`)

Allowed:
- ✅ 新增 `PreviewGeometryBuilder.js`
- ✅ 新增 vector tests
- ✅ 修改 `usePreview.js` 接入口（仅消费 Builder 输出）

Forbidden (unchanged from v1.0 FINAL freeze):
- ❌ 修改 `RotationResolver`
- ❌ 修改 `renderMultipleItemsToCanvas`
- ❌ 修改 renderer
- ❌ 删除 `detectOrientation.js` guard（Gate 5 才动）
- ❌ 修改 `PrintAutoRotationPolicy` 契约

---

*Frozen references:* `docs/print_auto_rotation_contract_v1.md` (v1.0 FINAL, D1–D7, INV-D4-1/2/3); `frontend/src/geometry/PrintAutoRotationPolicy.js` (Gate 1, commit `5552375`); `frontend/src/hooks/usePreview.js` (L687 / L1076–1088 / L1576–1579 / L1643–1644); `frontend/src/utils/detectOrientation.js:23`.
