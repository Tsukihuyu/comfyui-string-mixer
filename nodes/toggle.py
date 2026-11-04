"""Prompt Toggle：把提示词按标点拆成片段，逐段开关。

拆分逻辑同时暴露成 /prompt_toggle/split 给前端渲染，保证两边是同一份算法。
"""
import json

from ._runtime import PromptServer, web
from .textscan import _split_segments

# ---------------------------------------------------------------------------
# PromptToggle -> Prompt Toggle：按标点把提示词拆成片段，逐段开关
# ---------------------------------------------------------------------------

# 拆分分隔符：中英文逗号、句号、分号、换行。刻意不含冒号（护住 3:4 与 (cat:1.2)）
SPLIT_CHARS = set(",，.。;；\n")


def split_prompt_segments(text):
    """按标点拆片段，返回 [(片段, 它前面的分隔符), ...]。

    括号内（含权重 (cat:1.2)、嵌套括号）与 <|...|> 受保护块整块当一个片段，不拆。
    片段去首尾空白，空片段丢弃。
    """
    if not text or not text.strip():
        return []

    pieces = []  # [(buf, delim)]
    buf = []
    delim = ""
    depth = 0

    for kind, payload in _split_segments(text):
        # 受保护块 / 独立 token：整块塞进当前片段，标点扫描跳过它
        if kind == "block":
            open_tok, inner, close_tok = payload
            buf.append(f"{open_tok}{inner}{close_tok}")
            continue
        if kind == "token":
            buf.append(payload)
            continue

        for ch in payload:
            if ch == "(":
                depth += 1
            elif ch == ")":
                depth = max(0, depth - 1)
            if depth == 0 and ch in SPLIT_CHARS:
                pieces.append(("".join(buf), delim))
                buf, delim = [], ch
            elif depth == 0 and not buf and delim and ch in " \t":
                delim += ch  # 分隔符后面的空格归分隔符，original 模式才还原成 ", "
            else:
                buf.append(ch)
    pieces.append(("".join(buf), delim))

    out = []
    for body, before in pieces:
        body = body.strip()
        if body:
            out.append((body, before))
    return out


def apply_toggle(text, mask_json, join_mode="comma"):
    """按 mask 拼出输出。mask 是与片段一一对应的 0/1 数组（JSON）。

    长度对不上（文本改过、还没同步）时视为全开，宁可多给词，不静默吞词。
    """
    segs = split_prompt_segments(text)
    if not segs:
        return ""
    try:
        mask = json.loads(mask_json) if mask_json else None
    except (ValueError, TypeError):
        mask = None
    if not isinstance(mask, list) or len(mask) != len(segs):
        mask = [1] * len(segs)

    kept = [(body, before) for (body, before), on in zip(segs, mask) if on]
    if not kept:
        return ""
    if join_mode == "original":
        # 保留原来的分隔符（被删片段留下的分隔符一并收掉）
        out = kept[0][0]
        for body, before in kept[1:]:
            out += (before or ", ") + body
        return out
    return ", ".join(body for body, _ in kept)


def drop_segment(text, index, pairs=None):
    """删掉第 index 段，其余原样保留。

    标点跟着原文走：删中间一段不会留下 ", ,"，删第一段不会留下开头的逗号。
    前端点击词片右上角的 × 就走这里（经 /prompt_toggle/split?drop=i）。
    """
    segs = list(pairs) if pairs is not None else split_prompt_segments(text)
    if not segs:
        return text
    if index < 0 or index >= len(segs):
        return text
    kept = [(body, before) for i, (body, before) in enumerate(segs) if i != index]
    if not kept:
        return ""
    if index == 0:
        kept[0] = (kept[0][0], "")  # 删的是第一段：新的第一段不该继承被删那段的逗号
    out = kept[0][0]
    for body, before in kept[1:]:
        out += (before or "") + body
    return out.strip()


def merge_upstream(main, upstream):
    """上游在前、本节点结果在后。上游原样保留（不参与开关），空则忽略。"""
    extra = (upstream or "").strip()
    if not extra:
        return main
    if not main:
        return extra
    return f"{extra}, {main}"


class PromptToggle:
    """Prompt Toggle：编辑框 + 片段开关（点一下切换一个词/一句话）。

    text 写提示词；下方由前端渲染可点片段（同一套拆分逻辑，见 /prompt_toggle/split）。
    片段开关状态存在节点 properties 里，排队时由前端注入 mask 输入。
    upstream 是可选的「拼接上游」：上游文本原样接在编辑框结果之后，不参与片段开关。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "text": ("STRING", {"default": "", "multiline": True}),
                "join_mode": (["comma", "original"], {
                    "default": "comma",
                    "tooltip": "comma=开启片段用 ', ' 拼接；original=保留原来的标点",
                }),
            },
            "optional": {
                "upstream": ("STRING", {
                    "forceInput": True,
                    "tooltip": "拼接上游：上游文本整段排在最前，后面接本节点编辑框的开启片段"
                               "（上游原样保留，不参与片段开关）",
                }),
                "mask": ("STRING", {
                    "default": "",
                    "tooltip": "片段开关状态（0/1 的 JSON 数组），由节点界面自动注入，不用手填",
                }),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("string",)
    FUNCTION = "toggle"
    CATEGORY = "String-Mixer"
    OUTPUT_NODE = False

    def toggle(self, text, join_mode, mask="", upstream=""):
        return (merge_upstream(apply_toggle(text, mask, join_mode), upstream),)


if PromptServer is not None:

    @PromptServer.instance.routes.get("/prompt_toggle/split")
    async def _prompt_toggle_split(request):
        """给前端渲染片段用：返回拆分结果，保证和节点内部是同一份逻辑。

        drop=<i> 时额外返回「删掉第 i 段之后的文本」，界面上词片右上角的 × 用的就是这个：
        让服务端算，前端就不用自己拼标点，也就不会和 original 模式两套实现。
        """
        text = request.query.get("text", "")
        segs = split_prompt_segments(text)
        payload = {"segments": [body for body, _ in segs]}
        raw_drop = request.query.get("drop")
        if raw_drop not in (None, ""):
            try:
                payload["text"] = drop_segment(text, int(raw_drop), segs)
            except (TypeError, ValueError):
                pass  # 参数坏了就当没传，宁可不动文本
        return web.json_response(payload)  # type: ignore[union-attr]
