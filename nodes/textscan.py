"""受保护 token（<|name|> … <|/name|>）与成对标点的扫描器。

Prompt Sanitizer 和 Prompt Toggle 都要用同一份切分规则，抽出来免得两份实现漂移。
"""
import re

PROTECTED_TOKEN_RE = re.compile(r"<[/|][^|]*\|>")

# 成对标点：开 -> 闭。配对成功时，中间的内容在炸词时整块保护，不按标点切开。
# 半角 " 和 ' 刻意不在表里：它们和英寸符号（8"）、缩写（don't）撞车，
# 一个手误的半角引号能把后面半段提示词整段吞掉。
PAIR_MAP = {
    "(": ")", "[": "]", "{": "}",
    "（": "）", "【": "】", "《": "》", "〈": "〉",
    "「": "」", "『": "』",
    "“": "”", "‘": "’",
    "<": ">",
}
CLOSERS = set(PAIR_MAP.values())


def protected_spans(s):
    """返回被成对标点包住的区间 [(start, end), ...]（闭区间，已排序并合并）。

    只认「真的配得上对」的括号：落单的开/闭符号不算保护——一个手误的《
    不该把后面整段提示词都吞掉。配对用栈做，允许嵌套；遇到类型对不上的
    闭符号时，把它上面那些本来也配不上的开符号一并丢掉。
    """
    stack = []  # [(开符号, 下标)]
    spans = []
    for i, ch in enumerate(s):
        if ch in PAIR_MAP:
            stack.append((ch, i))
            continue
        if ch in CLOSERS:
            for k in range(len(stack) - 1, -1, -1):
                if PAIR_MAP[stack[k][0]] == ch:
                    spans.append((stack[k][1], i))
                    del stack[k:]  # 它上面没配上的开符号一起丢掉
                    break
            # 找不到对应开符号：这个字符就是普通文本，不保护任何东西
    if not spans:
        return []
    spans.sort()
    merged = [list(spans[0])]
    for a, b in spans[1:]:
        if a <= merged[-1][1]:  # 嵌套 / 相接：并进去
            merged[-1][1] = max(merged[-1][1], b)
        else:
            merged.append([a, b])
    return [(a, b) for a, b in merged]


def protected_mask(s):
    """逐字符的「受保护」标记，长度与 s 相同。"""
    mask = [False] * len(s)
    for a, b in protected_spans(s):
        for i in range(a, b + 1):
            mask[i] = True
    return mask


def _split_segments(s):
    """把字符串切成有序段：

    ("text", chunk)                  普通文本
    ("block", (open, inner, close))  受保护块：开 <|name|> + 中间内容 + 闭 <|/name|>（或 </name|>）
    ("token", tok)                   未配对的独立受保护 token
    """
    segments, pos = [], 0
    for m in PROTECTED_TOKEN_RE.finditer(s):
        if m.start() < pos:
            continue  # 已被前面的块整体消费（如闭 token），跳过
        tok = m.group(0)
        if m.start() > pos:
            segments.append(("text", s[pos:m.start()]))
        name = tok[2:-2]  # 剥掉 <| 和 |>（或 </ 和 |>）
        if not name.startswith("/"):
            # 尝试配对应闭 token（<|/name|> 与 </name|> 两种形态都认，取最近的一个）
            end, close = -1, ""
            for c in (f"<|/{name}|>", f"</{name}|>"):
                e = s.find(c, m.end())
                if e != -1 and (end == -1 or e < end):
                    end, close = e, c
            if end != -1:
                segments.append(("block", (tok, s[m.end():end], close)))
                pos = end + len(close)
                continue
        segments.append(("token", tok))
        pos = m.end()
    if pos < len(s):
        segments.append(("text", s[pos:]))
    return segments
