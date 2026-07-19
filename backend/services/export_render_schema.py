"""D3-3a Export RenderCommand schema + validator.

Locked contract between the frontend RenderCommand producer (D3-2) and the
backend executor (D3-3b). The backend receives a *fully resolved* RenderCommand:
geometry is owned by the frontend (createPlacement), the backend only consumes it.

Discipline locks (D3-1 boundary freeze + D3-3a boundary freeze):
  • paper MUST be a PaperSpec {widthMm, heightMm, dpi}, NEVER a PaperLayout
    (marginRect / displayRect / viewport / zoom). The backend must not depend on
    Preview-only layout fields — otherwise Export silently re-depends on Preview.
  • sourceRef MUST be resolved by the export caller as {path, page}; null is
    REJECTED. (D3-3-0 核心阻塞：资源绑定。D3-2 producer emits null; the export
    caller must fill it before POST.)
        sourceRef.page 约定：image → 0 | PDF → 实际页码 | OFD → 后续定义
  • NO geometry recomputation happens here or in the executor path. The backend
    never computes fit / scale / center / rotation. Grep ban:
    _apply_margins / calculateFit / fit_scale.

This module is pure validation — no Flask, no fitz, no IO. It is node/python
shared contract logic conceptually (mirrors frontend exportRenderCommand.js shape).
"""

from typing import Any, Dict, List, Optional, Tuple

# PaperSpec 必填字段（后端据其算 paperPx = mm * dpi / 25.4）。
_PAPER_SPEC_REQUIRED = ('widthMm', 'heightMm', 'dpi')
# PaperLayout 禁止字段（Preview-only，后端不得见）。
_PAPER_LAYOUT_FORBIDDEN = ('marginRect', 'displayRect', 'viewport', 'zoom')

_ALLOWED_ROTATIONS = (0, 90, 180, 270)


def _is_number(x: Any) -> bool:
    return isinstance(x, (int, float)) and not isinstance(x, bool)


def _validate_source_ref(src: Any) -> Optional[str]:
    """sourceRef 必须已由 caller 填充 {path, page}。null / 缺字段 → 拒绝。"""
    if not isinstance(src, dict):
        return "sourceRef 必须是对象 {path, page}（禁止 null）"
    path = src.get('path')
    page = src.get('page')
    if not isinstance(path, str) or not path:
        return "sourceRef.path 必须是非空字符串"
    # bool 是 int 子类，需排除；page 必须非负整数
    if not isinstance(page, int) or isinstance(page, bool) or page < 0:
        return "sourceRef.page 必须是非负整数（image=0, PDF=实际页码）"
    return None


def _validate_paper(paper: Any) -> Optional[str]:
    """paper 必须是 PaperSpec，禁止混入 PaperLayout 字段。"""
    if not isinstance(paper, dict):
        return "paper 必须是对象（PaperSpec: widthMm/heightMm/dpi），禁止 null"
    for key in _PAPER_LAYOUT_FORBIDDEN:
        if key in paper:
            return (f"paper 含禁止的 PaperLayout 字段 '{key}' —— "
                    f"后端只接受 PaperSpec，不依赖 Preview 布局")
    for key in _PAPER_SPEC_REQUIRED:
        val = paper.get(key)
        if not _is_number(val) or val <= 0:
            return f"paper.{key} 必须是正数（PaperSpec 必填）"
    return None


def _validate_size(size: Any, name: str) -> Optional[str]:
    """rotatedBounds 这类尺寸对象：只需 width/height 正数（无位置）。"""
    if not isinstance(size, dict):
        return f"{name} 必须是尺寸对象"
    if not _is_number(size.get('width')) or size['width'] <= 0:
        return f"{name}.width 必须是正数"
    if not _is_number(size.get('height')) or size['height'] <= 0:
        return f"{name}.height 必须是正数"
    return None


def _validate_rect(rect: Any, name: str) -> Optional[str]:
    """clip 这类矩形对象：x/y/width/height 数字，width/height 正数。"""
    if not isinstance(rect, dict):
        return f"{name} 必须是矩形对象"
    for key in ('x', 'y', 'width', 'height'):
        if not _is_number(rect.get(key)):
            return f"{name}.{key} 必须是数字"
    if rect['width'] <= 0 or rect['height'] <= 0:
        return f"{name}.width/height 必须为正数"
    return None


def _validate_command(cmd: Any, idx: int) -> Optional[str]:
    if not isinstance(cmd, dict):
        return f"commands[{idx}] 必须是对象"

    err = _validate_source_ref(cmd.get('sourceRef'))
    if err:
        return f"commands[{idx}]: {err}"

    err = _validate_paper(cmd.get('paper'))
    if err:
        return f"commands[{idx}]: {err}"

    placement = cmd.get('placement')
    if not isinstance(placement, dict):
        return f"commands[{idx}]: placement 必须是对象"
    for key in ('scale', 'offsetX', 'offsetY'):
        if not _is_number(placement.get(key)):
            return f"commands[{idx}]: placement.{key} 必须是数字"

    err = _validate_size(cmd.get('rotatedBounds'), f"commands[{idx}].rotatedBounds")
    if err:
        return err

    err = _validate_rect(cmd.get('clip'), f"commands[{idx}].clip")
    if err:
        return err

    cr = cmd.get('contentRotation')
    if cr not in _ALLOWED_ROTATIONS:
        return f"commands[{idx}]: contentRotation 必须是 0/90/180/270，实为 {cr!r}"

    rotation = cmd.get('rotation')
    if not isinstance(rotation, int) or isinstance(rotation, bool):
        return f"commands[{idx}]: rotation 必须是整数"

    if 'version' not in cmd:
        return f"commands[{idx}]: 缺 version 字段（约定 version=1）"

    return None


def validate_export_render_request(data: Any) -> Tuple[List[Dict], Optional[str]]:
    """校验 POST /api/export-render 请求体。

    Returns:
        (commands, None)       校验通过，commands 为原始命令列表（前端形状，未改写）。
        ([], error_message)    校验失败，error 描述首个错误（中文，面向 caller）。
    """
    if not isinstance(data, dict):
        return [], "请求体必须是 JSON 对象"
    commands = data.get('commands')
    if not isinstance(commands, list) or len(commands) == 0:
        return [], "commands 必须是非空数组"
    for i, cmd in enumerate(commands):
        err = _validate_command(cmd, i)
        if err:
            return [], err
    return commands, None
