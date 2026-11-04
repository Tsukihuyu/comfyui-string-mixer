"""Pure-Python helpers: output sanitising, canvas-size extraction and the
deterministic Layout compiler.

Nothing in this module talks to ComfyUI, an LLM or the network, so it can be
unit-tested on its own.
"""

from __future__ import annotations

import json
import math
import re
from typing import Any, Dict, List, Optional, Tuple

FENCE_RE = re.compile(r"^\s*```[A-Za-z0-9_+.-]*[ \t]*\r?\n(.*?)\r?\n```\s*$", re.S)
FENCE_LINE_RE = re.compile(r"^\s*```[A-Za-z0-9_+.-]*\s*$", re.M)
LABEL_RE = re.compile(
    r"^\s*\*{0,2}\s*(English|Chinese|Bilingual|Prompt|Positive prompt|"
    r"正\s*向\s*提\s*示\s*词|英\s*文|中\s*文|双\s*语)\s*\*{0,2}\s*[:：]\s*",
    re.I,
)
SIZE_RE = re.compile(
    r"(?:画布|尺寸|分辨率|Canvas(?:\s*size)?|Size)\s*[:：]?\s*(\d{2,5})\s*[×xX*]\s*(\d{2,5})",
    re.I,
)

LAYOUT_LABELS = {"character", "object", "text"}
THINK_BLOCK_RE = re.compile(r"<think(?:ing)?>.*?</think(?:ing)?>", re.S | re.I)
THINK_BARE_TAG_RE = re.compile(r"</?think(?:ing)?>", re.I)
ALLOWED_ROOT_DRAFT = {"width", "height", "bbox_coord_space", "bbox_format", "summary", "items"}
ALLOWED_ROOT_FINAL = {"summary", "items", "bbox_coord_space", "bbox_format"}
ALLOWED_ROWS = {"label", "caption", "bbox", "text", "tags", "palette"}


# --------------------------------------------------------------------------- #
# output sanitising
# --------------------------------------------------------------------------- #
def strip_outer_fence(text: str) -> str:
    m = FENCE_RE.match(text)
    return m.group(1).strip() if m else text


def strip_leading_labels(text: str) -> str:
    for _ in range(5):
        m = LABEL_RE.match(text)
        if not m:
            break
        text = text[m.end():].lstrip()
    return text


def _match_size_line(line: str) -> Optional[Tuple[int, int]]:
    s = line.strip().strip("。.。 ").strip()
    if not s:
        return None
    m = SIZE_RE.fullmatch(s)
    if m:
        w, h = int(m.group(1)), int(m.group(2))
        return (w, h) if w and h else None
    # tolerate a trailing parenthetical such as "CANVAS: 1024x1024（宽×高）"
    m = SIZE_RE.match(s)
    if m and len(s) - m.end() <= 16:
        w, h = int(m.group(1)), int(m.group(2))
        return (w, h) if w and h else None
    return None


def _strip_think_blocks(text: str) -> Tuple[str, List[str]]:
    """Drop ``...`` blocks some servers inline into ``content``."""
    notes: List[str] = []
    cleaned = THINK_BLOCK_RE.sub("", text)
    if cleaned != text:
        notes.append("剥掉了 think 标签内的思考块")
    cleaned = THINK_BARE_TAG_RE.sub("", cleaned).strip()
    return cleaned, notes


def sanitize_output(text: str) -> Dict[str, Any]:
    """Unwrap code fences, pull the canvas-size line out of the prompt body."""
    notes: List[str] = []
    if not text or not text.strip():
        return {"prompt": "", "width": 0, "height": 0, "notes": ["模型返回了空内容"]}

    body = text.strip()
    body, think_notes = _strip_think_blocks(body)
    notes.extend(think_notes)
    unwrapped = strip_outer_fence(body)
    if unwrapped != body:
        notes.append("剥掉了整段代码围栏")
        body = unwrapped
    elif FENCE_LINE_RE.search(body):
        body = FENCE_LINE_RE.sub("", body).strip()
        notes.append("剥掉了零散的围栏行")

    width = height = 0
    kept: List[str] = []
    for line in body.splitlines():
        hit = _match_size_line(line)
        if hit:
            if not width:
                width, height = hit
                notes.append(f"移出画布说明行：{line.strip()}")
            else:
                notes.append(f"忽略重复的画布说明行：{line.strip()}")
            continue
        kept.append(line)

    body = strip_leading_labels("\n".join(kept).strip())
    return {"prompt": body, "width": width, "height": height, "notes": notes}


# --------------------------------------------------------------------------- #
# Layout JSON discovery
# --------------------------------------------------------------------------- #
def _balanced_objects(text: str) -> List[str]:
    objs: List[str] = []
    depth = 0
    start: Optional[int] = None
    in_str = False
    esc = False
    for i, ch in enumerate(text):
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == "{":
            if depth == 0:
                start = i
            depth += 1
        elif ch == "}":
            if depth:
                depth -= 1
                if depth == 0 and start is not None:
                    objs.append(text[start:i + 1])
                    start = None
    return objs


def find_layout_json(text: str) -> Optional[Dict[str, Any]]:
    """Return the last JSON object that looks like a Layout payload."""
    best: Optional[Dict[str, Any]] = None
    for raw in _balanced_objects(text or ""):
        try:
            obj = json.loads(raw)
        except Exception:
            continue
        if isinstance(obj, dict) and isinstance(obj.get("items"), list):
            best = obj
    return best


# --------------------------------------------------------------------------- #
# Layout compiler
# --------------------------------------------------------------------------- #
def _as_bbox(bbox: Any) -> List[float]:
    if not isinstance(bbox, (list, tuple)) or len(bbox) != 4:
        raise ValueError(f"bbox 必须是 4 个数字，收到：{bbox!r}")
    try:
        return [float(v) for v in bbox]
    except (TypeError, ValueError):
        raise ValueError(f"bbox 含非数字：{bbox!r}")


def _validate_summary(summary: Any, status: List[str]) -> Dict[str, Any]:
    if not isinstance(summary, dict):
        raise ValueError("summary 必须是对象，且包含非空 caption。")
    caption = summary.get("caption")
    if not isinstance(caption, str) or not caption.strip():
        raise ValueError("summary.caption 不能为空：画风首句与全局描述都写在这里。")
    if summary.get("canvas") not in (None, "single", "multi_panel", "collage"):
        status.append(f"注意：summary.canvas 取值异常（{summary.get('canvas')!r}），合法值为 single/multi_panel/collage。")
    return summary


def _validate_items(items: List[Any], width: int, height: int, final_space: bool, status: List[str]) -> None:
    if not items:
        raise ValueError("items 不能为空。")
    for idx, item in enumerate(items):
        where = f"items[{idx}]"
        if not isinstance(item, dict):
            raise ValueError(f"{where} 不是对象。")
        label = item.get("label")
        if label not in LAYOUT_LABELS:
            raise ValueError(f"{where}.label 必须是 character/object/text，收到：{label!r}")
        caption = item.get("caption")
        if not isinstance(caption, str) or not caption.strip():
            raise ValueError(f"{where}.caption 不能为空。")
        if label == "text":
            t = item.get("text")
            if not isinstance(t, str) or not t.strip():
                raise ValueError(f"{where} 是 text 项，但 text 字段为空。")
        bbox = _as_bbox(item.get("bbox"))
        extra = set(item) - ALLOWED_ROWS
        if extra:
            status.append(f"{where} 含模板不允许的字段：{', '.join(sorted(extra))}（已原样保留，建议删掉）。")
        if final_space:
            if not (bbox[0] < bbox[2] and bbox[1] < bbox[3]):
                raise ValueError(f"{where}.bbox 顺序不对：最终格式是 [y0,x0,y1,x1]，要求 y0<y1 且 x0<x1。收到：{bbox}")
        else:
            x0, y0, x1, y1 = bbox
            if not (0 <= x0 < x1 <= width and 0 <= y0 < y1 <= height):
                raise ValueError(
                    f"{where}.bbox 越界或面积为零：画布 {width}x{height}，收到 [x0,y0,x1,y1]={bbox}。"
                )


def compile_layout(text: str, default_width: int = 1024, default_height: int = 1024) -> Tuple[str, str]:
    """Draft (abs/xyxy) -> final (abs_centralized/yxyx) single-line JSON.

    Returns ``(final_json_line, status_text)``. Raises ``ValueError`` with a
    human-readable message on any structural problem.
    """
    body = strip_outer_fence((text or "").strip())
    obj = find_layout_json(body)
    if obj is None:
        raise ValueError(
            "没有在文本里找到 Layout JSON（需要包含 summary 与 items 的对象）。"
            "检查模型是否按草稿格式输出，或改用 Caption / Tag 模式。"
        )

    status: List[str] = []
    fmt = str(obj.get("bbox_format", "")).lower()
    space = str(obj.get("bbox_coord_space", "")).lower()
    already_final = fmt == "yxyx" and space == "abs_centralized"

    width = int(obj.get("width") or default_width)
    height = int(obj.get("height") or default_height)

    summary = _validate_summary(obj.get("summary"), status)

    if already_final:
        extra = set(obj) - ALLOWED_ROOT_FINAL
        if extra:
            status.append(f"最终格式含多余根字段：{', '.join(sorted(extra))}（已丢弃）。")
        _validate_items(obj["items"], width, height, True, status)
        final = {
            "summary": summary,
            "items": obj["items"],
            "bbox_coord_space": "abs_centralized",
            "bbox_format": "yxyx",
        }
        status.insert(0, f"输入已是最终格式（abs_centralized/yxyx），只做校验：{len(final['items'])} 项。")
    else:
        extra = set(obj) - ALLOWED_ROOT_DRAFT
        if extra:
            status.append(f"草稿含非标准根字段：{', '.join(sorted(extra))}（已丢弃）。")
        if not (isinstance(width, int) and isinstance(height, int) and width > 0 and height > 0):
            raise ValueError(f"画布尺寸非法：{width}x{height}")
        if width % 16 or height % 16:
            raise ValueError(
                f"画布 {width}x{height} 不是 16 的倍数，按模板要求无法得到整数中心坐标。"
                "请改用 1024x1024 / 1536x1024 / 1024x1536 之类。"
            )
        _validate_items(obj["items"], width, height, False, status)

        cx, cy = width / 2.0, height / 2.0
        out_items: List[Dict[str, Any]] = []
        for item in obj["items"]:
            x0, y0, x1, y1 = _as_bbox(item["bbox"])
            x0, y0 = math.floor(x0), math.floor(y0)
            x1, y1 = math.ceil(x1), math.ceil(y1)
            new_item = dict(item)
            new_item["bbox"] = [
                int(round(y0 - cy)),
                int(round(x0 - cx)),
                int(round(y1 - cy)),
                int(round(x1 - cx)),
            ]
            out_items.append(new_item)

        final = {
            "summary": summary,
            "items": out_items,
            "bbox_coord_space": "abs_centralized",
            "bbox_format": "yxyx",
        }
        status.insert(
            0,
            f"已编译：画布 {width}x{height}，{len(out_items)} 项，xyxy(abs) -> yxyx(abs_centralized)。",
        )

    line = json.dumps(final, ensure_ascii=False, separators=(",", ":"))
    return line, "\n".join(status)


def validate_layout_text(text: str, width: int = 1024, height: int = 1024) -> Tuple[str, str]:
    """Convenience alias used by tests: compile and hand back both parts."""
    return compile_layout(text, width, height)
