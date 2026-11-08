"""蓄水模式的无头自测：段级差集、归一键、追加分隔符、两个节点的 run 行为。

用法：python tests/test_reservoir.py
"""

import importlib.util
import json
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
absorb = mod.absorb_upstream
chunk_of = mod.append_chunk
parse_reservoir = mod.parse_reservoir
TextSnapshot = mod.TextSnapshot
TextGateSplit = mod.TextGateSplit

failures = []


def check(name, got, want):
    ok = got == want
    print(("  PASS  " if ok else "  FAIL  ") + name + ("" if ok else f"\n         得到 {got!r}\n         期望 {want!r}"))
    if not ok:
        failures.append(name)


def rsv(on=1, seen=()):
    return json.dumps({"on": on, "seen": list(seen)}, ensure_ascii=False)


print("\n[1] 归一键（B：大小写/下划线/空白；不剥权重）")
check("大小写 + 下划线算同一段", seg_key("Blue_Hair") == seg_key("blue hair"), True)
check("多余空白算同一段", seg_key("  blue   hair ") == seg_key("blue hair"), True)
check("权重不同算两段", seg_key("(blue hair:1.1)") == seg_key("blue hair"), False)
check("中文/英文不互相归一", seg_key("长发") == seg_key("long hair"), False)

print("\n[2] 段级差集")
text, fresh, keys, chunk = absorb("", "masterpiece, 1girl, blue hair")
check("框空 -> 整段蓄进来", text, "masterpiece, 1girl, blue hair")
check("框空 -> 没有前导逗号", chunk, "masterpiece, 1girl, blue hair")
check("新增 3 段", len(fresh), 3)

body = "masterpiece, 1girl, blue hair"
seen = ["masterpiece", "1girl", "blue hair"]
text, fresh, keys, chunk = absorb(
    body, "masterpiece, 1girl, long hair, blue hair", seen)
check("上游中间插一个词 -> 只蓄那一个", fresh, ["long hair"])
check("拼接位置在末尾", text, "masterpiece, 1girl, blue hair, long hair")
check("追加串带逗号分隔", chunk, ", long hair")
check("账本只多一条", keys, ["long hair"])

text, fresh, keys, chunk = absorb(body, "masterpiece, 1girl, blue hair", seen)
check("完全重复 -> 什么都不加", (text, fresh, chunk), (body, [], ""))

text, fresh, keys, chunk = absorb("masterpiece, 1girl, blue hair, long hair",
                                  "masterpiece, 1girl, blue hair",
                                  seen + ["long hair"])
check("上游删词 -> 不删框里的词", (text, fresh), ("masterpiece, 1girl, blue hair, long hair", []))

text, fresh, keys, chunk = absorb("a, b", "a, b, c", ["a", "b", "c"])
check("曾经蓄过的词不再回来（账本永久）", (fresh, chunk), ([], ""))

text, fresh, keys, chunk = absorb("a, b", "a, b, c", ["a", "b", "c"])
check("蓄过的词即便框里没有也不再来（没有强制通道）", (fresh, chunk), ([], ""))

text, fresh, keys, chunk = absorb("a", "x, x, y, x")
check("上游自己重复的段只蓄一次", fresh, ["x", "y"])

print("\n[3] 追加分隔符")
check("框以逗号结尾不再叠逗号", chunk_of("a,", "b"), " b")
check("框以句号结尾用空格", chunk_of("a.", "b"), " b")
check("框以换行结尾直接接", chunk_of("a\n", "b"), "b")
check("框以普通字结尾用逗号", chunk_of("a", "b"), ", b")
check("空框不加分隔", chunk_of("", "b"), "b")

print("\n[4] 权重差异能蓄进来（B 口径）")
text, fresh, keys, chunk = absorb("blue hair", "blue hair, (blue hair:1.1)", ["blue hair"])
check("同词不同权重算新段", fresh, ["(blue hair:1.1)"])
check("归一后大小写不同不重复", absorb("Blue Hair", "blue hair", ["blue hair"])[1], [])

print("\n[5] 注入参数解析")
check("正常 JSON", parse_reservoir('{"on":1,"seen":["a"]}'), (True, ["a"]))
check("空串 = 关", parse_reservoir(""), (False, []))
check("坏 JSON = 关", parse_reservoir("{oops"), (False, []))
check("seen 不是数组 = 空账本", parse_reservoir('{"on":1,"seen":"x"}'), (True, []))
check("旧的 force 字段被忽略", parse_reservoir('{"on":1,"seen":[],"force":1}'), (True, []))

print("\n[6] 文本闸门 ⛩：run 里走蓄水")
snap = TextSnapshot()
r = snap.snapshot("a, b", "a, b, c", rsv(seen=["a", "b"]))
check("输出 = 框 + 新词", r["result"], ("a, b, c",))
check("回报蓄水标记", r["ui"]["rsv_on"], [1])
check("回报新增串", r["ui"]["rsv_chunk"], [", c"])
check("回报新增键", json.loads(r["ui"]["rsv_keys"][0]), ["c"])
check("蓄水时不报被拦下", r["ui"]["ts_blocked"], [0])

r = snap.snapshot("", "x, y", rsv())
check("首轮框空 -> 整段", r["result"], ("x, y",))

r = snap.snapshot("a, b", "a, b", rsv(seen=["a", "b"]))
check("没新词 -> 输出不变、追加串为空", (r["result"], r["ui"]["rsv_chunk"]), (("a, b",), [""]))

r = snap.snapshot("mine", "", rsv())
check("上游为空 -> 不动框", r["result"], ("mine",))

r = snap.snapshot("a, b", "a, b, c", "")
check("不注入蓄水 -> 老行为（框里有字就只输出框内）", r["result"], ("a, b",))

print("\n[7] 闸门炸词 ⛩：run 里走蓄水")
gate = TextGateSplit()
r = gate.run("a, b", "comma", "", "a, b, c", "1", rsv(seen=["a", "b"]))
check("输出 = 框 + 新词", r["result"], ("a, b, c",))
check("蓄水优先于 adopt", r["ui"]["tgs_adopted"], [0])
check("回报新增串", r["ui"]["rsv_chunk"], [", c"])

r = gate.run("a, b", "comma", "", "a, b, c", "1", "")
check("关掉蓄水 -> 回到闸门语义（adopt=1 换新词）", r["result"], ("a, b, c",))
check("关掉蓄水 -> 不是蓄水回报", "rsv_on" in r["ui"], False)

print()
if failures:
    print(f"失败 {len(failures)} 项 ✘")
    sys.exit(1)
print("全部通过 ✔")
