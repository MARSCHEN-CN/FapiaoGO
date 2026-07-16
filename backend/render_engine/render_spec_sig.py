"""
render_spec_sig — RenderSpec 线路签名（与前端 frontend/src/layout/renderSpec.js 逐字节对齐）。

Commit A 目标（用户验收）：证明前端发送的 RenderSpec 能被后端无损接收、解析、验证，
而渲染结果 100% 不变（Transport Layer 验证，非 Execution Layer）。

本模块只做三件事（不触碰任何渲染逻辑）：
  1. normalize_render_spec  — 递归排序 + 6 位小数四舍五入（half-up，与 JS Math.round 一致）
  2. canonical_string      — 跨语言稳定序列化（数字定宽 6 小数 / 字符串 json.dumps(ensure_ascii=False)）
  3. render_spec_signature — FNV-1a(32)，按 UTF-16 码元迭代（与 JS charCodeAt + Math.imul 一致）

render_engine/render_spec_sig 与 frontend/src/layout/renderSpec.js 是**同一契约的两份实现**：
任何一方修改归一化/序列化逻辑，另一方必须同步修改，否则签名对不上（见 test_render_spec_sig.py 跨语言测试）。

verif_render_spec / rebuild_spec_from_args 供 api.py 在 /preview 路由重建 spec 并回显
（Commit A 仅诊断，绝不改变渲染路径）。
"""

import json
import math
import struct

__all__ = [
    "RENDER_SPEC_VERSION",
    "RenderSpecParseError",
    "normalize_render_spec",
    "canonical_string",
    "fnv1a_32",
    "render_spec_signature",
    "rebuild_spec_from_args",
    "verify_render_spec",
]

# 与前端 frontend/src/layout/renderSpec.js 的 RENDER_SPEC_VERSION 必须同步。
RENDER_SPEC_VERSION = "v1"


class RenderSpecParseError(ValueError):
    """Malformed RenderSpec request → 应映射为 HTTP 400。

    与 hash mismatch 严格区分：本异常表示「协议结构非法」——
      • `?spec=` 版本不支持（如 v2 而本端只认 v1）
      • 核心布局字段缺失（spec=v1 必须齐备 paper_w/h、scale、ox、oy、rotation、clip_*）
      • 数值字段非数字（如 scale=abc）
      • clip 不完整（部分 clip_* 缺失）
    即 malformed request，无论 Commit A / Commit B 都必须 400。

    而「签名不符」（verified=False）**不是**解析错误：Commit A 仍走 Legacy，
    只有 Commit B（spec 真正驱动渲染）才升级为 400。两者不可混为一谈。
    """


# spec=v1 必须齐备的核心布局线字段；任一缺失即视为 malformed → 400。
# margin_*/dpi 有合理默认值，允许缺失（但存在时必须是数字）。
_REQUIRED_WIRE_FIELDS = (
    "paper_w", "paper_h",
    "scale", "ox", "oy",
    "rotation",
    "clip_x", "clip_y", "clip_w", "clip_h",
)


def _round6(x: float) -> float:
    """四舍五入到 6 位小数，half-up，与 JS `Math.round(x * 1e6) / 1e6` 完全一致。

    必须 half-up 而非 Python 内置 round() 的银行家舍入，否则在恰好 .5 边界处
    前后端归一化结果会分叉，签名对不上。
    """
    if x >= 0:
        return math.floor(x * 1e6 + 0.5) / 1e6
    return -math.floor(-x * 1e6 + 0.5) / 1e6


def normalize_render_spec(spec):
    """递归排序 key + 6 位小数四舍五入，返回新对象，不修改入参（镜像 JS normalizeRenderSpec）。"""
    if spec is None or not isinstance(spec, (dict, list)):
        # bool 是 int 子类，必须优先判定，否则会被当数字
        if isinstance(spec, bool):
            return spec
        if isinstance(spec, (int, float)):
            return _round6(float(spec))
        return spec
    if isinstance(spec, list):
        return [normalize_render_spec(v) for v in spec]
    return {k: normalize_render_spec(v) for k, v in sorted(spec.items())}


def canonical_string(value) -> str:
    """跨语言稳定序列化（数字定宽 6 小数 / 字符串 json.dumps(ensure_ascii=False)）。

    与 JS canonicalString 逐字节对齐：
      • 数字 → f"{float(v):.6f}"（对应 JS toFixed(6)）
      • 字符串 → json.dumps(v, ensure_ascii=False)（对应 JS JSON.stringify）
      • key 递归字典序；数组/对象递归。
    """
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return f"{float(value):.6f}"
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(canonical_string(v) for v in value) + "]"
    if isinstance(value, dict):
        return "{" + ",".join(
            f"{json.dumps(k, ensure_ascii=False)}:{canonical_string(v)}"
            for k, v in sorted(value.items())
        ) + "}"
    return "null"


def fnv1a_32(s: str) -> str:
    """FNV-1a 32-bit，按 UTF-16 码元迭代（与 JS `charCodeAt(i)` + `Math.imul` 一致）。

    JS 用 charCodeAt 取每个 UTF-16 码元（0–65535，astral 字符拆成代理对两个码元）；
    这里把字符串按 utf-16-le 编码（无 BOM），逐个 16-bit 码元迭代，逐一 XOR + 乘 0x01000193，
    与 JS 的位运算在 mod 2^32 下完全等价。最终 8 位十六进制。
    """
    h = 0x811C9DC5
    for (unit,) in struct.Struct("<H").iter_unpack(s.encode("utf-16-le")):
        h ^= unit
        h = (h * 0x01000193) & 0xFFFFFFFF
    return format(h, "08x")


def render_spec_signature(spec) -> str:
    """RenderSpec 线路签名（8 位十六进制），与前端 renderSpecSignature 逐字节一致。"""
    return fnv1a_32(canonical_string(normalize_render_spec(spec)))


def rebuild_spec_from_args(args, doc_id, page) -> dict:
    """从 URL 线字段重建完整 RenderSpec（镜像前端 buildRenderSpec 输出结构）。

    Commit A 仅用于签名校验。键名必须与 RenderLayoutFactory 输出严格一致：
      placement.offsetX / clip.{x,y,width,height} / paper.{width,height}
    否则前后端签名必然对不上。线字段名（paper_w/scale/ox/clip_* 等）是 Step 2 约定的
    「后端当前忽略」字段，详见 v16-stage1-design.md §Step 2 关键纪律。

    结构校验（调用前应已确认 `?spec=v1`）：核心布局字段缺失 / 数值字段非数字
    → 抛 RenderSpecParseError（→ HTTP 400）。**绝不静默归零**——
    旧实现会吞掉坏数字，导致 malformed 被当合法 spec 回显，已修正。
    """
    missing = [k for k in _REQUIRED_WIRE_FIELDS if args.get(k) in (None, "")]
    if missing:
        raise RenderSpecParseError(
            f"missing RenderSpec field(s): {', '.join(missing)} "
            f"(spec={RENDER_SPEC_VERSION!r} requires all layout fields)"
        )

    def f(name: str, default: float = 0.0) -> float:
        v = args.get(name)
        if v is None or v == "":
            return default
        try:
            return float(v)
        except (ValueError, TypeError):
            raise RenderSpecParseError(
                f"non-numeric RenderSpec field {name}={v!r} (expected a number)"
            )

    # 🆕 V17：paper_landscape 随 URL 发来（wireFieldsOf），必须带进重建的 spec，
    # 否则引擎 spec.get("paper_landscape", False) 永远 False → 横纸变竖纸
    # （repro_landscape_bug.py 复现：3438×3508 竖图 vs 期望 3508×2480 横图）。
    # 用 camelCase「paperLandscape」与前端 buildRenderSpec 输出结构一致，
    # 使 render_spec_signature 重算签名能与前端 spec_sig 对齐（verified=True）。
    paper_landscape_val = args.get("paper_landscape", "0") == "1"
    # 🆕 Page Placement Pipeline（Slice 1.2A）：contentRotation 随 URL 发来（wireFieldsOf），
    # 必须带进重建的 spec，否则前端签名的 spec 含 contentRotation、后端重建的没有 → verified=False
    # （静默 Bug，与 paper_landscape 漏字段同源：契约字段丢失 = 签名不符）。值 = 内容旋转角(0/90/180/270)。
    # legacy rotation 字段保留兼容（恒 0），contentRotation 才是真实内容旋转 Fact。
    content_rotation_val = int(f("content_rotation", 0.0))
    # 🆕 RenderCommand 契约版本（用户收尾建议）：随 URL 发来（wireFieldsOf version），
    # 缺省视为 1（兼容未发版本的老前端）。validate_render_command 据此拒绝未知版本，
    # 防止"前端升级 / 后端老版本"静默兼容（最难的排查问题）。
    version_val = int(args.get("version", "1"))
    spec = {
        "docId": doc_id,
        "page": page,
        "dpi": f("dpi", 300.0),
        "version": version_val,
        "paper": {"width": f("paper_w"), "height": f("paper_h")},
        "margin": {
            "top": f("margin_t"),
            "right": f("margin_r"),
            "bottom": f("margin_b"),
            "left": f("margin_l"),
        },
        "placement": {"scale": f("scale"), "offsetX": f("ox"), "offsetY": f("oy")},
        "rotation": int(f("rotation", 0.0)),
        "paperLandscape": paper_landscape_val,
        # 🆕 Page Placement Pipeline（Slice 1.2A）：真实内容旋转 Fact，RE 于 1.2B 消费。
        "contentRotation": content_rotation_val,
        "clip": {
            "x": f("clip_x"),
            "y": f("clip_y"),
            "width": f("clip_w"),
            "height": f("clip_h"),
        },
    }
    return spec


def verify_render_spec(args, doc_id, page):
    """Commit A：解析 + 校验 RenderSpec（仅诊断，绝不改变渲染）。

    返回 None    → 请求未携带有效 `?spec=`（缺失或空串），Legacy 客户端，不回显、不 400。
    抛 RenderSpecParseError → 协议结构非法（版本不支持 / 字段缺失 / 数值非数字）→ HTTP 400。
    返回 dict    含 version / sig / recomputed / verified / spec：
      • recomputed 是后端按相同契约重算的签名（用于回显，便于 DevTools 直接比对）。
      • verified 仅用于回显：**签名不符不是解析错误**，Commit A 仍走 Legacy（400 推迟到 Commit B）。
    """
    version = args.get("spec")
    if not version:  # 缺失或空串 → 视为无 spec（Legacy，不回显，不 400）
        return None
    if version != RENDER_SPEC_VERSION:
        raise RenderSpecParseError(
            f"unsupported RenderSpec version {version!r} (supported: {RENDER_SPEC_VERSION!r})"
        )
    spec = rebuild_spec_from_args(args, doc_id, page)
    recomputed = render_spec_signature(spec)
    sig = args.get("spec_sig") or ""
    return {
        "version": version,
        "sig": sig,
        "recomputed": recomputed,
        "verified": (recomputed == sig),
        "spec": spec,
    }
