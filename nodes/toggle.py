"""Prompt Toggle：把提示词按标点拆成片段，逐段开关。

拆分逻辑同时暴露成 /prompt_toggle/split 给前端渲染，保证两边是同一份算法。
"""
import json
import re

from ._runtime import PromptServer, web
from .textscan import _split_segments, protected_mask

# ---------------------------------------------------------------------------
# PromptToggle -> Prompt Toggle：按标点把提示词拆成片段，逐段开关
# ---------------------------------------------------------------------------

# 拆分分隔符：中英文逗号、句号、分号、换行
SPLIT_CHARS = set(",，.。;；\n")
# 冒号单独处理：只有“词尾冒号”才断开（Style: / 风格：），
# 冒号后紧跟数字的是权重或比例（3:4、cat:1.5），原样留在词里。
COLON_CHARS = (":", "：")
COLON_TAILS = COLON_CHARS

# 权重调节：范围 0.05–2.00，每点一次 ±0.05；回到 1.00 自动去掉括号。
WEIGHT_MIN = 0.05
WEIGHT_MAX = 2.00
WEIGHT_STEP = 0.05
# LoRA 段的强度区间（<lora:名:0.80>，0 = 关掉这个 LoRA）。
LORA_MIN = 0.00
LORA_MAX = 2.00

LORA_RE = re.compile(r"^<lora:([^:<>]+?)(?::(-?\d*\.?\d+))?(?::(-?\d*\.?\d+))?>$", re.IGNORECASE)
PAREN_W_RE = re.compile(r"^\((.*):\s*(-?\d*\.?\d+)\s*\)$", re.S)
BARE_W_RE = re.compile(r"^(.*?):\s*(-?\d*\.?\d+)$", re.S)


def is_colon_tail(body):
    """这一段是不是“冒号标签”（以冒号结尾）。拼接时它两侧用空格，不用逗号。"""
    return body.endswith(COLON_TAILS)


def split_spans(text):
    """按标点拆片段，返回 [(片段, 前置分隔符, 起点, 终点), ...]。

    片段恒等于 text[起点:终点]（已去首尾空白）；排序与加权都靠这两个下标
    只改那一段，其它字一个都不碰。
    受保护：成对标点（() [] {} （） 【】 《》 〈〉 「」 『』 “” ‘’ <>）内部整块
    不拆，<|...|> 块同样整块不拆。只有「真的配得上对」的括号才算保护——
    落单的符号按普通文本处理，免得一个手误就把后半段提示词整段吞掉。
    以冒号结尾的词（Style: / 风格：）单独成段，冒号留在段里。
    """
    if not text or not text.strip():
        return []

    prot = protected_mask(text)

    # 先把原文拆成「原子」：普通字符一个原子一个，<|...|> 块整块一个原子。
    # 这样对标点扫描来说，块就是一个不会被打断的黑盒，下标又能回到原文。
    atoms = []  # ("c", 字符, 绝对下标) / ("b", 整块文字, 绝对下标)
    off = 0
    for kind, payload in _split_segments(text):
        if kind == "text":
            for i, ch in enumerate(payload):
                atoms.append(("c", ch, off + i))
            off += len(payload)
            continue
        chunk = payload if kind == "token" else f"{payload[0]}{payload[1]}{payload[2]}"
        atoms.append(("b", chunk, off))
        off += len(chunk)

    pieces = []  # [(原文片段, 前置分隔符, 起点, 终点)]
    buf = []     # 当前片段攒下的原子
    first = last = -1
    delim = ""
    after_colon = False  # 刚在冒号处断过：紧跟的空格归分隔符，original 模式才还原成 ": "

    def flush(next_delim):
        nonlocal buf, first, last, delim
        if buf:
            pieces.append(("".join(buf), delim, first, last))
        buf, first, last = [], -1, -1
        delim = next_delim

    def grow(ch, idx):
        nonlocal first, last
        if first < 0:
            first = idx
        buf.append(ch)
        last = idx + 1

    for atom in atoms:
        if atom[0] == "b":
            # 受保护块 / 独立 token：整块塞进当前片段，标点扫描跳过它
            chunk, pos = atom[1], atom[2]
            if first < 0:
                first = pos
            buf.append(chunk)
            last = pos + len(chunk)
            after_colon = False
            continue

        ch, idx = atom[1], atom[2]

        if ch in SPLIT_CHARS and not prot[idx]:
            # 小数点不是句号：1.5 / 0.9 / cat:1.5 里的点不拆
            if not (ch == "." and 0 < idx < len(text) - 1
                    and text[idx - 1].isdigit() and text[idx + 1].isdigit()):
                flush(ch)
                after_colon = False
                continue

        if ch in COLON_CHARS and not prot[idx]:
            nxt = text[idx + 1] if idx + 1 < len(text) else ""
            grow(ch, idx)  # 冒号留在段里，界面上显示成「Style:」
            if nxt.isdigit():
                # 冒号后紧跟数字的是权重/比例（3:4、cat:1.5），不拆
                after_colon = False
                continue
            # 标签要单独成段：先在最后一个空白处把「标签」和它前面的词切开，
            # 否则 "flat color Subject:" 会整块粘在一起
            joined = "".join(buf)
            label = joined.rsplit(None, 1)[-1]
            label_at = len(joined) - len(label)
            head = joined[:label_at]
            if head.strip():
                pieces.append((head, delim, first, first + len(head)))
                pieces.append((label, " ", first + label_at, first + len(joined)))
            else:
                pieces.append((label, delim, first + label_at, first + len(joined)))
            buf, first, last, delim = [], -1, -1, ""
            after_colon = True
            continue

        if not buf and (delim or after_colon) and ch in " \t":
            delim += ch  # 冒号后面的空格归分隔符，original 模式才还原成 ": "
            continue

        grow(ch, idx)
        after_colon = False
    flush("")

    out = []
    for raw, before, start, _end in pieces:
        body = raw.strip()
        if not body:
            continue
        body_at = start + (len(raw) - len(raw.lstrip()))
        out.append((body, before, body_at, body_at + len(body)))
    return out


def split_prompt_segments(text):
    """老接口：只要 (片段, 前置分隔符)。apply_toggle / 前端渲染都用它。"""
    return [(body, before) for body, before, _s, _e in split_spans(text)]


def compose_bodies(bodies):
    """按 comma 模式把一串片段拼回文本（冒号标签两侧用空格 / 句点）。"""
    if not bodies:
        return ""
    out = bodies[0]
    for i in range(1, len(bodies)):
        prev, cur = bodies[i - 1], bodies[i]
        if is_colon_tail(prev):
            sep = " "
        elif is_colon_tail(cur):
            sep = ". "
        else:
            sep = ", "
        out += sep + cur
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
    # 全开 = 原文返回，不重拼：和「闸门炸词」一致，别静默改标点
    # （关掉任意一段才进入重拼，那时冒号标签的 . / 空格规则才生效）
    if all(mask):
        return text

    kept = [(body, before) for (body, before), on in zip(segs, mask) if on]
    if not kept:
        return ""
    if join_mode == "original":
        # 保留原来的分隔符（被删片段留下的分隔符一并收掉）
        out = kept[0][0]
        for body, before in kept[1:]:
            out += (before or ", ") + body
        return out
    # comma 模式：见 compose_bodies 的三种情况
    return compose_bodies([body for body, _ in kept])


def drop_segment(text, index, pairs=None):
    """删掉第 index 段，其余原样保留。

    标点跟着原文走：删中间一段不会留下 ", ,"，删第一段不会留下开头的逗号。
    前端点击词片右上角的 × 就走这里（经 /prompt_toggle/split?drop=i）。
    """
    segs = list(pairs) if pairs is not None else split_spans(text)
    if not segs:
        return text
    if index < 0 or index >= len(segs):
        return text
    kept = [(body, before) for i, (body, before, _s, _e) in enumerate(segs) if i != index]
    if not kept:
        return ""
    if index == 0:
        kept[0] = (kept[0][0], "")  # 删的是第一段：新的第一段不该继承被删那段的逗号
    out = kept[0][0]
    for i in range(1, len(kept)):
        body, before = kept[i]
        prev = kept[i - 1][0]
        # 与 comma 模式同一套：前一保留段是标签 -> 空格；后一段是标签 -> ". "；
        # 否则按原文分隔符（删掉 "Style: anime" 的 anime，留 "Style: color" 而不是 "Style:, color"）
        if is_colon_tail(prev):
            sep = " "
        elif is_colon_tail(body):
            sep = ". "
        else:
            sep = before or ""
        out += sep + body
    return out.strip()


def move_segment(text, frm, to, pairs=None):
    """把第 frm 段挪到第 to 位（先摘出来、再插进去的语义），重拼后返回新文本。

    换过顺序以后原文的标点就没有意义了（原来那段的逗号句号是给老位置配的），
    所以这里统一按 comma 模式重拼：', '，冒号标签两侧用空格 / 句点。
    """
    segs = list(pairs) if pairs is not None else split_spans(text)
    n = len(segs)
    if n < 2 or not (0 <= frm < n):
        return text
    try:
        to = max(0, min(n - 1, int(to)))
    except (TypeError, ValueError):
        return text
    if to == frm:
        return text
    bodies = [s[0] for s in segs]
    bodies.insert(to, bodies.pop(frm))
    return compose_bodies(bodies)


def format_weight(w):
    """权重写成短形式：1.5 / 1.05 / 0.8（不补零，1.00 不写）。"""
    s = f"{float(w):.2f}".rstrip("0").rstrip(".")
    return s or "0"


def parse_weight(body):
    """找出这一段现在的权重：返回 (形态, 当前权重)。

    形态：lora = <lora:名:强度>；paren = (词:1.2)；bare = 词:1.2；none = 裸词。
    裸词里的 "3:4" 这类比例不算权重（要求带小数点，且落在可调区间内）。
    """
    m = LORA_RE.match(body)
    if m:
        w1 = m.group(2)
        return "lora", (float(w1) if w1 is not None else 1.0)
    m = PAREN_W_RE.match(body)
    if m:
        return "paren", float(m.group(2))
    m = BARE_W_RE.match(body)
    if m:
        raw = m.group(2)
        w = float(raw)
        if "." in raw and WEIGHT_MIN <= w <= WEIGHT_MAX:
            return "bare", w
    return "none", 1.0


def adjust_weight(body, delta):
    """把一段的权重加减 delta，返回改好的片段文字。

    lora 段改它自己的强度数字（0–2），其它段包一层显式权重 (词:1.15)；
    已经有 (词:1.15) / 词:1.15 的改那个数字，不套第二层。
    """
    form, w = parse_weight(body)
    if form == "lora":
        m = LORA_RE.match(body)
        name, w1, w2 = m.group(1), m.group(2), m.group(3)
        new = min(LORA_MAX, max(LORA_MIN, round(w + delta, 2)))
        ww = format_weight(new)
        if w2 is not None:  # 三段式 <lora:名:模型强度:CLIP强度>：只动第一个
            return f"<lora:{name}:{ww}:{w2}>"
        return f"<lora:{name}:{ww}>"

    new = min(WEIGHT_MAX, max(WEIGHT_MIN, round(w + delta, 2)))
    if form == "paren":
        core = PAREN_W_RE.match(body).group(1).strip()
        return core if new == 1.0 else f"({core}:{format_weight(new)})"
    if form == "bare":
        core = BARE_W_RE.match(body).group(1).strip()
        return core if new == 1.0 else f"{core}:{format_weight(new)}"
    # 裸词 / 隐式括号 ((cat)、[dog])：包一层显式权重，原样留在里面
    return f"({body}:{format_weight(new)})"


def set_weight(text, index, delta, pairs=None):
    """给第 index 段加减权重，只替换那一段的原文区间，其余字符一个不动。"""
    segs = list(pairs) if pairs is not None else split_spans(text)
    if not segs or not (0 <= index < len(segs)):
        return text
    body, _before, start, end = segs[index]
    if text[start:end] != body:  # 下标对不上就别动，宁可不动也不乱改
        return text
    new_body = adjust_weight(body, delta)
    if new_body == body:
        return text
    return text[:start] + new_body + text[end:]



def edit_segment(text, index, new_body, pairs=None):
    """把第 index 段整段换成 new_body，其余字符一个都不动。

    只替换这一段的原文区间 text[start:end]：前后的分隔符、别的段的标点、
    别的段的权重全部原样保留——和 set_weight 是同一套「原地改一段」的做法。
    new_body 去首尾空白后为空 = 等同删掉这一段（留个空段没有意义）。
    """
    segs = list(pairs) if pairs is not None else split_spans(text)
    if not segs or not (0 <= index < len(segs)):
        return text
    body, _before, start, end = segs[index]
    if text[start:end] != body:  # 下标对不上就别动，宁可不动也不乱改
        return text
    clean = (new_body or "").strip()
    if clean == body:
        return text
    if not clean:
        return drop_segment(text, index, segs)
    return text[:start] + clean + text[end:]


def insert_segment(text, index, body, pairs=None):
    """在第 index 段之前插入新的一段，其余字符一个都不动。

    只额外产生「新词 + 一个分隔符」，原文的标点、空格、别的段原样活着：
      k == 0        -> 新词放在最前
      0 < k < n     -> 原文该位置已有的分隔符留着，新词塞在它和下一段之间
      k >= n        -> 追加到末尾（前一段是冒号标签就只隔一个空格）
    空文本 -> 新词就是全文（等于新建第一段）。空 body 什么都不做。
    前端「双击词片之间的空白」走这里（/prompt_toggle/split?insert=k,新词）。
    """
    clean = (body or "").strip()
    if not clean:
        return text
    segs = list(pairs) if pairs is not None else split_spans(text)
    if not segs:  # 空文本：新词就是全部
        return clean
    try:
        k = max(0, min(len(segs), int(index)))
    except (TypeError, ValueError):
        k = len(segs)
    # 新词后面跟什么：冒号标签后面只能隔空格，其它按逗号
    after = " " if is_colon_tail(clean) else ", "

    if k == 0:
        return clean + after + text

    if k >= len(segs):  # 追加：别在原本就以分隔符结尾的文本后面再叠一个
        head = text.rstrip()
        if head and head[-1] in SPLIT_CHARS:
            return head + " " + clean
        sep = " " if is_colon_tail(segs[-1][0]) else ", "
        return text + sep + clean

    start = segs[k][2]
    return text[:start] + clean + after + text[start:]


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
                    "tooltip": "comma=开启片段用 ', ' 拼接（冒号段两侧用空格）；original=保留原来的标点",
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

        三个可选动作参数，改完都把「新文本 + 新文本的片段」一起返回，前端直接换：
          drop=<i>            删掉第 i 段（词片右上角的 ×）
          move=<from>,<to>    把第 from 段挪到第 to 位（按住拖动排序）
          weight=<i>,<delta>  给第 i 段加减权重（词片左边的 ＋/－）
          edit=<i>,<新词>     把第 i 段整段换成新词（双击词片就地编辑；只改这一段）
          insert=<k>,<新词>   在第 k 段之前插入一段（双击词片之间的空白；只插新词和一个分隔符）
        让服务端算，前端就不用自己拼标点，也就不会和 original 模式两套实现。
        """
        text = request.query.get("text", "")

        def snapshot(s):
            spans = split_spans(s)
            return {
                "segments": [body for body, _b, _s, _e in spans],
                "weights": [round(parse_weight(body)[1], 2) for body, _b, _s, _e in spans],
            }

        payload = snapshot(text)
        new_text = None

        raw_drop = request.query.get("drop")
        if raw_drop not in (None, ""):
            try:
                new_text = drop_segment(text, int(raw_drop))
            except (TypeError, ValueError):
                pass  # 参数坏了就当没传，宁可不动文本

        raw_move = request.query.get("move")
        if new_text is None and raw_move:
            try:
                frm, to = (int(x) for x in raw_move.split(",", 1))
                new_text = move_segment(text, frm, to)
            except (TypeError, ValueError):
                pass

        raw_weight = request.query.get("weight")
        if new_text is None and raw_weight:
            try:
                idx, delta = raw_weight.split(",", 1)
                new_text = set_weight(text, int(idx), float(delta))
            except (TypeError, ValueError):
                pass

        raw_edit = request.query.get("edit")
        if new_text is None and raw_edit:
            try:
                idx, body = raw_edit.split(",", 1)
                new_text = edit_segment(text, int(idx), body)
            except (TypeError, ValueError):
                pass

        raw_insert = request.query.get("insert")
        if new_text is None and raw_insert:
            try:
                idx, body = raw_insert.split(",", 1)
                new_text = insert_segment(text, int(idx), body)
            except (TypeError, ValueError):
                pass

        if new_text is not None and new_text != text:
            payload["text"] = new_text
            payload.update(snapshot(new_text))
        return web.json_response(payload)  # type: ignore[union-attr]
