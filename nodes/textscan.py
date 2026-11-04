"""受保护 token（<|name|> … <|/name|>）的扫描器。

Prompt Sanitizer 和 Prompt Toggle 都要用同一份切分规则，抽出来免得两份实现漂移。
"""
import re

PROTECTED_TOKEN_RE = re.compile(r"<[/|][^|]*\|>")


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
