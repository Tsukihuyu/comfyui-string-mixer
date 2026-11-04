"""String Mixer 家族（3/5/7 框）+ Prompt Sanitizer。

纯文本处理，不依赖 ComfyUI，可以单独 import 做单测。
"""
import json
import re

from .textscan import PROTECTED_TOKEN_RE, _split_segments  # noqa: F401

class _StringMixerBase:
    """String Mixer 系列基类：INPUT_TYPES 生成与合并逻辑，子类只需声明 BOX_COUNT。"""

    BOX_COUNT = 0  # 子类必须覆盖

    @classmethod
    def INPUT_TYPES(cls):
        required = {
            # 普通 STRING 控件：现代前端可直接把它当端口连，无需 JS 转换
            "input_string": ("STRING", {"default": ""}),
        }
        for i in range(1, cls.BOX_COUNT + 1):
            required[f"box_{i}"] = ("STRING", {"default": "", "multiline": True})
            required[f"enable_{i}"] = ("BOOLEAN", {"default": True})
        required["separator"] = ("STRING", {"default": " ", "multiline": False})
        return {"required": required}

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("string",)
    FUNCTION = "merge"
    CATEGORY = "String-Mixer"
    OUTPUT_NODE = False

    @staticmethod
    def _decode_separator(s):
        """把连接符里字面的 \\n / \\t 解码为真实换行 / Tab。"""
        if not s:
            return ""
        return s.replace("\\n", "\n").replace("\\t", "\t")

    def merge(self, input_string, separator, **kwargs):
        segments = []
        # (文本, 是否开启)，按合并顺序：外部输入优先，随后 Box 1..N
        candidates = [(input_string, True)]
        for i in range(1, self.BOX_COUNT + 1):
            candidates.append(
                (kwargs.get(f"box_{i}", ""), kwargs.get(f"enable_{i}", False))
            )
        for text, enabled in candidates:
            if enabled and text:
                trimmed = text.strip()
                if trimmed:  # 空 / 纯空格一律跳过
                    segments.append(trimmed)
        return (self._decode_separator(separator).join(segments),)


class StringMixer(_StringMixerBase):
    """文本混合 3 / Text Mix 3：外部 string 与 3 个独立开关文本框合并。

    类名保持 StringMixer，兼容已存工作流。
    """

    BOX_COUNT = 3


class StringMixer5(_StringMixerBase):
    """文本混合 5 / Text Mix 5：外部 string 与 5 个独立开关文本框合并。"""

    BOX_COUNT = 5


class StringMixer7(_StringMixerBase):
    """文本混合 7 / Text Mix 7：外部 string 与 7 个独立开关文本框合并。"""

    BOX_COUNT = 7


# ============================================================
# Prompt Sanitizer —— 纯逻辑段（不依赖 ComfyUI，可直接单测）
# ============================================================

# 受保护特殊 token：`<|style|>`、`</style|>`，以及任何 `<|...|>` / `</...|>` 形态
# 裸词:权重 要求小数点（避免把 "3:4" 这类比例误判成权重）；括号/方括号内允许整数
_BARE_WEIGHT_RE = re.compile(r":(-?\d+\.\d+)\s*$")
_BRACKET_WEIGHT_RE = re.compile(r":(-?\d+(?:\.\d+)?)\s*$")


def _split_word_weight(s, allow_int):
    """拆出末尾的 ':权重'，返回 (词身, 权重|None)。"""
    pattern = _BRACKET_WEIGHT_RE if allow_int else _BARE_WEIGHT_RE
    m = pattern.search(s)
    if m:
        return s[:m.start()].strip(), float(m.group(1))
    return s.strip(), None


def parse_weight_tag(tag):
    """解析单个标签的权重语法 -> (词身, 权重)。

    支持：(词:1.5) / ((词)) / (((词))) / [词] / [词:1.2] / 词:1.5 / 裸词。
    嵌套括号无显式权重时按 SD 隐式权重 (x)=1.0 / ((x))=1.1 / (((x)))=1.21；[词] = 0.9。
    """
    t = tag.strip()
    if t.startswith("[") and t.endswith("]") and len(t) >= 2:
        word, w = _split_word_weight(t[1:-1], allow_int=True)
        return word, (w if w is not None else 0.9)
    if t.startswith("(") and t.endswith(")") and len(t) >= 2:
        n_open = len(t) - len(t.lstrip("("))
        n_close = len(t) - len(t.rstrip(")"))
        if 0 < n_open == n_close:
            word, w = _split_word_weight(t[n_open:len(t) - n_close], allow_int=True)
            if w is None:
                # SD 隐式权重：(x)=1.0, ((x))=1.1, (((x)))=1.21
                w = 1.1 ** (n_open - 1)
            return word, w
        # 括号不配对：当普通文本落到下面的裸词分支
    word, w = _split_word_weight(t, allow_int=False)
    return word, (w if w is not None else 1.0)


def _fmt_weight(w):
    """2.00 -> '2'，1.10 -> '1.1'，1.21 -> '1.21'。"""
    s = f"{w:.2f}".rstrip("0").rstrip(".")
    return s if s else "0"




def _split_tags(text):
    """按逗号切成标签（括号内的逗号视为标签的一部分），去首尾空白、丢空段。"""
    tags, buf, depth = [], [], 0
    for ch in text:
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth = max(0, depth - 1)
        if ch == "," and depth == 0:
            tags.append("".join(buf))
            buf = []
        else:
            buf.append(ch)
    tags.append("".join(buf))
    return [t.strip() for t in tags if t.strip()]


def _render_tags(chunk, seen, clean_weights, weight_mode,
                 min_weight, max_weight, dedupe, fmt):
    """处理一段普通文本：切标签 -> 清洗 -> 去重（共享 seen）-> 格式化，返回渲染项列表。"""
    out = []
    for tag in _split_tags(chunk):
        if clean_weights:
            word, w = parse_weight_tag(tag)
            if weight_mode == "strip_all":
                rendered = word
            else:
                w = round(max(min_weight, min(max_weight, w)), 2)
                rendered = word if w == 1.0 else f"({word}:{_fmt_weight(w)})"
            key_src = word  # 去重键用词身，(sky:1.5) 与 sky 视为同一词
        else:
            rendered = tag
            key_src = tag
        if dedupe:
            key = key_src.lower()
            if key in seen:
                continue
            seen.add(key)
        if fmt:
            rendered = re.sub(r"\s+", " ", rendered.replace("_", " ")).strip()
        out.append(rendered)
    return out


def sanitize_prompt(text, clean_weights=True, weight_mode="normalize",
                    min_weight=0.1, max_weight=8.0, dedupe=True, fmt=True):
    """三段管线：权重清洗 -> 去重 -> 格式化。保序（幸存项相对顺序 == 原顺序）。

    受保护块（<|style|> ... <|/style|> 等）整体保留：块内内容照常走
    清洗/去重/格式化（去重不跨块边界），开闭 token 与块内内容之间不插逗号；
    未配对的独立受保护 token 原样保留、不参与去重。
    输出以 ", " 统一连接。
    """
    if not text:
        return ""
    units = []
    seen = set()
    for seg in _split_segments(text):
        kind = seg[0]
        if kind == "block":
            open_tok, inner, close_tok = seg[1]
            # 块内内容独立去重（全新 seen），不与块外互吃
            inner_units = _render_tags(inner, set(), clean_weights, weight_mode,
                                       min_weight, max_weight, dedupe, fmt)
            inner_str = ", ".join(inner_units)
            units.append(f"{open_tok} {inner_str} {close_tok}" if inner_str
                         else f"{open_tok} {close_tok}")
        elif kind == "token":
            units.append(seg[1])
        else:
            units.extend(_render_tags(seg[1], seen, clean_weights, weight_mode,
                                      min_weight, max_weight, dedupe, fmt))
    return ", ".join(x for x in units if x)


class PromptSanitizer:
    """Prompt Sanitizer：纯提示词清洗节点（权重清洗 / 去重 / 格式化，三个独立开关）。

    输入为纯 string 端口（无文本框，前端 JS convertWidgetToInput 实现）。
    管线固定：权重清洗 -> 去重 -> 格式化；输出保序。
    受保护块（<|style|> ... <|/style|> 等）整体保留，开闭 token 与块内内容
    之间不插逗号，块内内容照常处理但去重不跨块边界。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "string": ("STRING", {"default": "", "multiline": True}),
            "clean_weights": ("BOOLEAN", {
                "default": True,
                "tooltip": "权重清洗：normalize=统一 (词:w) 语法并钳位到范围；strip_all=剥掉全部权重标记",
            }),
            "weight_mode": (["normalize", "strip_all"], {
                "default": "normalize",
                "tooltip": "normalize=规范化+钳位；strip_all=删光所有权重标记（如 (sky:1.5) -> sky）",
            }),
            "min_weight": ("FLOAT", {
                "default": 0.1, "min": 0.05, "max": 10.0, "step": 0.05,
                "tooltip": "权重下限（normalize 模式生效）",
            }),
            "max_weight": ("FLOAT", {
                "default": 8.0, "min": 0.1, "max": 100.0, "step": 0.1,
                "tooltip": "权重上限（normalize 模式生效）",
            }),
            "dedupe": ("BOOLEAN", {
                "default": True,
                "tooltip": "去重：忽略大小写，cat 与 cat:1.0 视为同一词；保留首次出现，顺序不变",
            }),
            "format": ("BOOLEAN", {
                "default": True,
                "tooltip": "格式化：下划线变空格、连续空白压缩（逗号统一 ', ' 连接恒生效）",
            }),
        }}

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("string",)
    FUNCTION = "sanitize"
    CATEGORY = "String-Mixer"
    OUTPUT_NODE = False

    def sanitize(self, string, clean_weights, weight_mode,
                 min_weight, max_weight, dedupe, format):
        return (sanitize_prompt(
            string,
            clean_weights=clean_weights,
            weight_mode=weight_mode,
            min_weight=min_weight,
            max_weight=max_weight,
            dedupe=dedupe,
            fmt=format,
        ),)
