"""炸词的两个新能力无头自测：成对标点保护 / 片段排序 / 权重调节。

用法：python tests/test_split_guard.py
不依赖 ComfyUI：按包加载插件根目录，直接调 nodes 里的纯函数。
"""

import importlib.util
import os
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
INIT = os.path.join(ROOT, "__init__.py")

spec = importlib.util.spec_from_file_location("string_mixer", INIT)
mod = importlib.util.module_from_spec(spec)
sys.modules["string_mixer"] = mod
spec.loader.exec_module(mod)

split_spans = mod.split_spans
split = mod.split_prompt_segments
apply_toggle = mod.apply_toggle
drop_segment = mod.drop_segment
move_segment = mod.move_segment
adjust_weight = mod.adjust_weight
set_weight = mod.set_weight
parse_weight = mod.parse_weight

failures = []


def check(name, got, want):
    ok = got == want
    print(("  PASS  " if ok else "  FAIL  ") + name + ("" if ok else f"\n         得到 {got!r}\n         期望 {want!r}"))
    if not ok:
        failures.append(name)


def segs(text):
    return [body for body, _b, _s, _e in split_spans(text)]


print("\n[1] 成对标点保护：内部不炸开")
check("LoRA 整段不被拆",
      segs("1girl, <lora:003.Aesthetic_Quality_Modifiers:0.80>, masterpiece"),
      ["1girl", "<lora:003.Aesthetic_Quality_Modifiers:0.80>", "masterpiece"])
check("两个 LoRA 连着也不拆",
      segs("<lora:foo:0.8> and <lora:bar:1.0>"),
      ["<lora:foo:0.8> and <lora:bar:1.0>"])
check("方括号",
      segs("a [b, c] d, e"), ["a [b, c] d", "e"])
check("书名号",
      segs("《书名, 号》副标题, next"), ["《书名, 号》副标题", "next"])
check("中文引号",
      segs("“引号, 里的逗号” b, c"), ["“引号, 里的逗号” b", "c"])
check("花括号 / 直角引号 / 生僻书名号",
      segs("{x, y}, 「a, b」, 『c, d』, 〈e, f〉, 【g, h】"),
      ["{x, y}", "「a, b」", "『c, d』", "〈e, f〉", "【g, h】"])
check("圆括号与权重（原行为不变）",
      segs("(cat:1.2), [dog], {e}, f"), ["(cat:1.2)", "[dog]", "{e}", "f"])
check("嵌套括号",
      segs("((a, b):1.2), c"), ["((a, b):1.2)", "c"])
check("落单的括号不算保护（不吞后半段）",
      segs("a (b, c"), ["a (b", "c"])
check("落单的《 也不吞",
      segs("一只《猫, 一只狗"), ["一只《猫", "一只狗"])
check("未闭合的 LoRA 按普通文本处理（冒号标签规则照旧）",
      segs("<lora:x, y"), ["<lora:", "x", "y"])
check("比例 3:4 不拆",
      segs("3:4, wide"), ["3:4", "wide"])
check("<|...|> 块照旧整块（块内逗号不拆）",
      segs("<|style|> a, b <|/style|>"), ["<|style|> a, b <|/style|>"])
check("小数点照旧不拆",
      segs("cat:1.5, 0.9 girl"), ["cat:1.5", "0.9 girl"])

print("\n[2] 冒号标签（原行为不变）")
check("标签单独成段",
      segs("Style: anime, flat color. Subject: 1girl"),
      ["Style:", "anime", "flat color", "Subject:", "1girl"])
check("逗号模式拼回来",
      apply_toggle("Style: anime, flat color. Subject: 1girl", "[1,1,1,1,1]"),
      "Style: anime, flat color. Subject: 1girl")
check("关掉一段后按标签规则重拼",
      apply_toggle("Style: anime, flat color. Subject: 1girl", "[1,1,0,1,1]"),
      "Style: anime. Subject: 1girl")

print("\n[3] 片段下标：body 恒等于 text[start:end]")
corpus = [
    "1girl, <lora:003.Aesthetic_Quality_Modifiers:0.80>, masterpiece",
    "  masterpiece , best quality\n1girl, [a, b], “q, q”  ",
    "Style: anime, flat color. Subject: 1girl; 《书名,号》",
    "<|style|> a, b <|/style|>, tail",
    "",
    "no split chars at all",
]
for text in corpus:
    bad = [(b, s, e) for b, _bf, s, e in split_spans(text) if text[s:e] != b]
    check(f"下标自洽: {text[:26]!r}", bad, [])

print("\n[4] 删除（原有能力不受影响）")
check("删中间", drop_segment("a, b, c", 1), "a, c")
check("删第一段不带出逗号", drop_segment("a, b, c", 0), "b, c")
check("删 LoRA 那一段",
      drop_segment("1girl, <lora:x:0.8>, hi", 1), "1girl, hi")

print("\n[5] 排序")
check("挪到最后", move_segment("a, b, c", 0, 2), "b, c, a")
check("挪到最前", move_segment("a, b, c", 2, 0), "c, a, b")
check("原地不动", move_segment("a, b, c", 1, 1), "a, b, c")
check("夹在范围外的 to 会被夹回来", move_segment("a, b, c", 0, 99), "b, c, a")
check("标签词挪动后按标签规则重拼（标签起新句，用句点）",
      move_segment("Style: anime, flat color", 1, 0), "anime. Style: flat color")
check("排序保留 LoRA 整段",
      move_segment("1girl, <lora:x:0.8>, hi", 0, 2), "<lora:x:0.8>, hi, 1girl")
check("排序后片段数不变",
      len(segs(move_segment("a, b, c, d", 0, 3))), 4)

print("\n[6] 权重：解析")
check("裸词", parse_weight("cat"), ("none", 1.0))
check("括号权重", parse_weight("(cat:1.2)"), ("paren", 1.2))
check("裸权重", parse_weight("cat:1.5"), ("bare", 1.5))
check("LoRA 强度", parse_weight("<lora:x:0.80>"), ("lora", 0.80))
check("LoRA 没写强度 = 1.0", parse_weight("<lora:x>"), ("lora", 1.0))
check("比例不是权重", parse_weight("3:4"), ("none", 1.0))
check("隐式括号不是显式权重", parse_weight("(cat)"), ("none", 1.0))

print("\n[7] 权重：加减与边界")
check("裸词 +0.05", adjust_weight("cat", 0.05), "(cat:1.05)")
check("裸词 -0.05", adjust_weight("cat", -0.05), "(cat:0.95)")
check("括号权重加", adjust_weight("(cat:1.1)", 0.05), "(cat:1.15)")
check("回到 1.00 去掉括号", adjust_weight("(cat:1.05)", -0.05), "cat")
check("裸权重加", adjust_weight("cat:1.5", 0.05), "cat:1.55")
check("裸权重回到 1.00 变裸词", adjust_weight("cat:1.05", -0.05), "cat")
check("LoRA 改自己的数字", adjust_weight("<lora:x:0.80>", 0.05), "<lora:x:0.85>")
check("LoRA 没写强度就补一个", adjust_weight("<lora:x>", 0.05), "<lora:x:1.05>")
check("LoRA 三段式只动第一个", adjust_weight("<lora:x:0.8:0.6>", 0.05), "<lora:x:0.85:0.6>")
check("LoRA 下限 0", adjust_weight("<lora:x:0>", -0.05), "<lora:x:0>")
check("比例词被当成普通词包一层", adjust_weight("3:4", 0.05), "(3:4:1.05)")
check("隐式括号包一层", adjust_weight("(cat)", 0.05), "((cat):1.05)")
w = "cat"
for _ in range(40):
    w = adjust_weight(w, 0.05)
check("上限夹到 2", w, "(cat:2)")
w = "cat"
for _ in range(40):
    w = adjust_weight(w, -0.05)
check("下限夹到 0.05", w, "(cat:0.05)")

print("\n[8] 权重：只改那一段，别的字一个不动")
text = "1girl, blue hair <extra>, <lora:x:0.8>"
check("改第 2 段", set_weight(text, 1, 0.05),
      "1girl, (blue hair <extra>:1.05), <lora:x:0.8>")
check("改 LoRA 段", set_weight(text, 2, 0.05),
      "1girl, blue hair <extra>, <lora:x:0.85>")
check("越界下标不动", set_weight(text, 9, 0.05), text)
check("改完还能原样拆回去",
      len(segs(set_weight(text, 1, 0.05))), 3)
check("加权的词条仍受保护（括号内有逗号也不炸）",
      segs(set_weight("a [b, c], d", 0, 0.05)),
      ["(a [b, c]:1.05)", "d"])

print()
if failures:
    print(f"失败 {len(failures)} 项 ✘")
    sys.exit(1)
print("全部通过 ✔")
