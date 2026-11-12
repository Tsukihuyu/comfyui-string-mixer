"""双击就地改词（edit_segment）的无头自测。

用法：python tests/test_edit_segment.py
不依赖 ComfyUI：按包加载插件根目录，直接调 nodes/toggle.py 里的纯函数。

守住的契约：
  * 只替换那一段的原文区间 —— 前后的分隔符、别的段的标点一个都不动
  * 空串 / 纯空白 = 删掉这一段
  * 下标越界、原文对不上、词没变 -> 原样返回（宁可不动也不乱改）
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
edit_segment = mod.edit_segment
insert_segment = mod.insert_segment
apply_toggle = mod.apply_toggle

failures = []


def check(name, got, want):
    ok = got == want
    print(("  PASS  " if ok else "  FAIL  ") + name + ("" if ok else f"\n         得到 {got!r}\n         期望 {want!r}"))
    if not ok:
        failures.append(name)


def bodies(text):
    return [b for b, _before in split(text)]


print("edit_segment —— 只换一段，别的字符不动")

check("中间一段", edit_segment("a, b, c", 1, "cat"), "a, cat, c")
check("首段", edit_segment("a, b, c", 0, "start"), "start, b, c")
check("末段", edit_segment("a, b, c", 2, "z"), "a, b, z")

# 原标点必须原样活着：句号 / 分号 / 换行不是编辑的借口去重排
src = "masterpiece, 1girl. blue hair; smile\ntender light"
check("别的段标点不动", edit_segment(src, 2, "red hair"),
      "masterpiece, 1girl. red hair; smile\ntender light")

print("edit_segment —— 权重与受保护块整块交给用户改")

check("带权重的段按原文替换", edit_segment("(cat:1.2), dog", 0, "(fox:1.2)"), "(fox:1.2), dog")
check("删掉括号 = 变裸词", edit_segment("(cat:1.2), dog", 0, "cat"), "cat, dog")
check("成对括号块整块替换", edit_segment("高质量, 《红, 蓝》, 微笑", 1, "《黑, 白》"),
      "高质量, 《黑, 白》, 微笑")
check("LoRA 段整块替换", edit_segment("<lora:foo:0.8>, cat", 0, "<lora:bar:0.6>"), "<lora:bar:0.6>, cat")
check("冒号标签后面的词", edit_segment("Style: anime, cat", 1, "realistic"), "Style: realistic, cat")

print("edit_segment —— 空 = 删这一段")

check("空串等同删除", edit_segment("a, b, c", 1, ""), "a, c")
check("纯空白等同删除", edit_segment("a, b, c", 1, "   "), "a, c")
check("删成一段", edit_segment("a, b", 0, ""), "b")
check("全删光 -> 空串", edit_segment("a", 0, ""), "")

print("edit_segment —— 拒绝乱动")

check("越界原样返回", edit_segment("a, b", 5, "x"), "a, b")
check("负下标原样返回", edit_segment("a, b", -1, "x"), "a, b")
check("词没变不重写", edit_segment("a, b", 1, "b"), "a, b")
check("首尾空白被吃掉但内容一样 -> 原样", edit_segment("a, b", 1, "  b  "), "a, b")
check("空文本不炸", edit_segment("", 0, "x"), "")

print("edit_segment —— 改出新段（词里带逗号）")

grown = edit_segment("a, b", 0, "x, y")
check("拆成两段", bodies(grown), ["x", "y", "b"])
check("文本本身", grown, "x, y, b")

print("edit_segment + apply_toggle —— 开关状态还能接上")

out = edit_segment("cat, dog, bird", 1, "wolf")
check("三段的文本", out, "cat, wolf, bird")
check("关中间一段", apply_toggle(out, "[1,0,1]"), "cat, bird")
check("全开 = 原文", apply_toggle(out, "[1,1,1]"), "cat, wolf, bird")

print("insert_segment —— 只加新词和一个分隔符")

check("插在中间", insert_segment("a, b, c", 1, "x"), "a, x, b, c")
check("插在最前", insert_segment("a, b, c", 0, "x"), "x, a, b, c")
check("插到末尾", insert_segment("a, b, c", 3, "x"), "a, b, c, x")
check("越界按末尾算", insert_segment("a, b", 99, "x"), "a, b, x")
check("负下标按最前算", insert_segment("a, b", -5, "x"), "x, a, b")
check("空文本 = 新建第一段", insert_segment("", 0, "x"), "x")
check("空词什么都不做", insert_segment("a, b", 1, "   "), "a, b")
check("首尾空白被吃", insert_segment("a, b", 1, "  x  "), "a, x, b")

check("冒号标签后面只隔空格", insert_segment("Style: anime", 1, "x"), "Style: x, anime")
check("新词本身是标签", insert_segment("a, b", 1, "Style:"), "a, Style: b")
check("原文以逗号结尾别叠逗号", insert_segment("a,", 1, "x"), "a, x")

check("原文标点一个不动", insert_segment("a. b; c", 2, "x"), "a. b; x, c")
check("插进受保护块之前", insert_segment("《红, 蓝》, 微笑", 1, "x"), "《红, 蓝》, x, 微笑")

grown_ins = insert_segment("a, b", 1, "x, y")
check("新词带逗号 -> 多出两段", bodies(grown_ins), ["a", "x", "y", "b"])

print()
if failures:
    print(f"✘ {len(failures)} 项失败：" + "、".join(failures))
    sys.exit(1)
print("✔ 全部通过")
