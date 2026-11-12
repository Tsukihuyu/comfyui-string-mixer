"""逐词锁（pin）的无头自测：认词、清空保留、换词补位。

用法：python tests/test_pins.py
不依赖 ComfyUI：按包加载插件根目录，直接调纯函数。

守住的契约：
  * 锁按**归一化词键**认（大小写折叠、下划线当空格、不剥权重）
  * 清空只留锁词，分隔符沿用原文（幸存段的那个），第一段不继承被删段的逗号
  * 换新词：新词里有同一个锁词 -> 用新词的位置（不重复）；没有 -> 补到整篇最后
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

seg_key = mod.seg_key
parse_pins = mod.parse_pins
keep_pinned = mod.keep_pinned
merge_pins = mod.merge_pins
split = mod.split_prompt_segments
absorb_upstream = mod.absorb_upstream

failures = []


def check(name, got, want):
    ok = got == want
    print(("  PASS  " if ok else "  FAIL  ") + name + ("" if ok else f"\n         得到 {got!r}\n         期望 {want!r}"))
    if not ok:
        failures.append(name)


def bodies(text):
    return [b for b, _b in split(text)]


print("seg_key —— 认词的尺子（与蓄水账本同一把）")

check("大小写折叠", seg_key("Blue Hair"), seg_key("blue hair"))
check("下划线当空格", seg_key("blue_hair"), "blue hair")
check("连续空白压缩", seg_key("  blue   hair  "), "blue hair")
check("不剥权重（算两个词）", seg_key("(blue hair:1.1)") != seg_key("blue hair"), True)
check("空串", seg_key("   "), "")

print("parse_pins —— 前端注入的解析（坏的当没有锁）")

check("二元数组形态", parse_pins('[["cat", "cat"], ["dog", "dog"]]'), [("cat", "cat"), ("dog", "dog")])
check("对象形态", parse_pins('[{"key": "cat", "body": "cat"}]'), [("cat", "cat")])
check("空输入", parse_pins(""), [])
check("坏 JSON 不当锁", parse_pins("{oops"), [])
check("缺 body 丢掉", parse_pins('[["cat", ""]]'), [])
check("键会被 strip、词也会", parse_pins('[[" cat ", " cat "]]'), [("cat", "cat")])

print("keep_pinned —— 清空框只留锁词")

check("留中间一个", keep_pinned("a, b, c", ["b"]), "b")
check("留两个保序", keep_pinned("a, b, c, d", ["d", "a"]), "a, d")
check("原文标点沿用", keep_pinned("x. y; z", ["y"]), "y")
check("全不锁 -> 空", keep_pinned("a, b", []), "")
check("锁的词不在文本里 -> 空", keep_pinned("a, b", ["zzz"]), "")
check("冒号标签相邻只隔空格", keep_pinned("Style: anime, cat", ["anime"]), "anime")
check("标签后面的词被留下时用原逗号", keep_pinned("Style: anime, cat", ["anime", "cat"]), "anime, cat")
check("受保护块整块保留", keep_pinned("高质量, 《红, 蓝》, 微笑", ["《红, 蓝》".casefold()]), "《红, 蓝》")
check("大小写不同也认得", keep_pinned("Blue Hair, cat", ["blue hair"]), "Blue Hair")

print("merge_pins —— 换新词后锁词补位")

pins = [("blue hair", "blue hair"), ("cinematic light", "cinematic light")]

check("新词里都有 -> 一个不动", merge_pins("blue hair, cat, cinematic light", pins),
      "blue hair, cat, cinematic light")
check("新词里都没有 -> 按 pins 顺序补末尾",
      merge_pins("cat, dog", pins), "cat, dog, blue hair, cinematic light")
check("新词里有一个 -> 只补缺的那个",
      merge_pins("cat, cinematic light", pins), "cat, cinematic light, blue hair")
check("空文本 -> 就是锁词",
      merge_pins("", [("cat", "cat")]), "cat")
check("没有锁 -> 原样", merge_pins("cat", []), "cat")
check("权重外壳不同算两个词（锁的是带权重那个）",
      merge_pins("blue hair", [("(blue hair:1.2)", "(blue hair:1.2)")]),
      "blue hair, (blue hair:1.2)")

print("merge_pins + absorb_upstream —— 蓄水不重复锁词")

seen = [seg_key("cat")]
out, fresh, _keys, _chunk = absorb_upstream(
    "cat, blue hair", "cat, dog, blue hair", seen, [seg_key("blue hair")]
)
check("蓄水不重复锁词（锁词当已账本）", bodies(merge_pins(out, pins)).count("blue hair"), 1)
check("蓄水只吸了新词", fresh, ["dog"])

print("组合 —— 换词后先合并、再走 mask 才能保住开关语义")

merged = merge_pins("dog", pins)
check("合并后的段", bodies(merged), ["dog", "blue hair", "cinematic light"])
check("锁词关掉时不进输出（这里只用文本断言，mask 语义见节点测试）",
      mod.apply_toggle(merged, "[1,0,0]"), "dog")

print()
if failures:
    print(f"✘ {len(failures)} 项失败：" + "、".join(failures))
    sys.exit(1)
print("✔ 全部通过")
