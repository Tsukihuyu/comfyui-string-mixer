"""String Mixer 系列无头自测：不依赖 ComfyUI，直接 importlib 加载节点模块并调用节点函数。

用法：python tests/selftest_mixer.py
覆盖：INPUT_TYPES 键完整性、模拟 ComfyUI 全参调用、默认全空、开关、
      纯空格跳过、trim、连接符 \\n / \\t 解码、段顺序、显示名。
"""

import importlib.util
import os
import sys

# Windows 控制台/CI runner 的 stdout 默认可能是 cp1252，中文和 emoji 会直接抛 UnicodeEncodeError。
# 这里强制 UTF-8，脚本才在任何环境下都能打印结果。
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)  # 本文件在 tests/ 下，插件根目录是上一级
INIT = os.path.join(ROOT, "__init__.py")

# 按"包"加载：python 看到 __init__.py 会自动给出 submodule_search_locations，
# 于是 __init__.py 里的相对导入和 nodes/* 子模块都能正常工作（和 ComfyUI 的加载方式一致）
spec = importlib.util.spec_from_file_location("string_mixer", INIT)
mod = importlib.util.module_from_spec(spec)
sys.modules["string_mixer"] = mod  # 子模块导入需要父包已经注册
spec.loader.exec_module(mod)
files_mod = mod.nodes.files  # 私有状态（_COMFY_BASE / _THUMB_CACHE）住在 files 模块里

failures = []


def check(name, got, expected):
    ok = got == expected
    print(f"  {'PASS' if ok else 'FAIL'}  {name}: {got!r}" + ("" if ok else f"  (期望 {expected!r})"))
    if not ok:
        failures.append(name)


def defaults_for(cls):
    """从 INPUT_TYPES 提取每个输入的默认值（模拟未连接端口的状态）。"""
    req = cls.INPUT_TYPES()["required"]
    return {k: v[1].get("default") for k, v in req.items()}


def run(cls, **overrides):
    """模拟 ComfyUI 调用：全部输入按 kwargs 传入，返回输出字符串。"""
    kwargs = defaults_for(cls)
    kwargs.update(overrides)
    return getattr(cls(), cls.FUNCTION)(**kwargs)[0]


# ---- 0) 模块级映射 ----
print("== 模块映射 ==")
check("注册表：mixer 家族 9 个 + skillprompt 2 个",
      sorted(mod.NODE_CLASS_MAPPINGS),
      ["CameraMixer", "PromptFileLoader", "PromptSanitizer", "PromptToggle",
       "SkillPromptLayoutCompiler", "SkillPromptOptimizer",
       "StringMixer", "StringMixer5", "StringMixer7", "TextGateSplit", "TextSnapshot"])
check("3框版显示名", mod.NODE_DISPLAY_NAME_MAPPINGS["StringMixer"], "🧵 文本混合 3 / Text Mix 3")
check("5框版显示名", mod.NODE_DISPLAY_NAME_MAPPINGS["StringMixer5"], "🧵 文本混合 5 / Text Mix 5")
check("7框版显示名", mod.NODE_DISPLAY_NAME_MAPPINGS["StringMixer7"], "🧵 文本混合 7 / Text Mix 7")
check("3框版类名未变（工作流兼容）",
      mod.NODE_CLASS_MAPPINGS["StringMixer"].__name__, "StringMixer")

for name, cls, n in [
    ("StringMixer (3-box)", mod.StringMixer, 3),
    ("StringMixer5 (5-box)", mod.StringMixer5, 5),
    ("StringMixer7 (7-box)", mod.StringMixer7, 7),
]:
    print(f"== {name} ==")
    req = cls.INPUT_TYPES()["required"]

    # 键完整性：input_string + box_1..N + enable_1..N + separator
    expected_keys = {"input_string", "separator"} | {
        f"box_{i}" for i in range(1, n + 1)
    } | {f"enable_{i}" for i in range(1, n + 1)}
    check(f"INPUT_TYPES 键完整（{len(expected_keys)} 个）", set(req), expected_keys)

    # 模拟 ComfyUI 全参调用（签名必须能吃下所有输入键）
    check("默认全空 -> 空串", run(cls), "")

    # 外部输入 + 全部框开启且非空 -> 段顺序 外部 -> Box1..N
    kwargs = {f"box_{i}": f" b{i} " for i in range(1, n + 1)}
    check("段顺序 外部->Box1..N + trim", run(cls, input_string="EXT", **kwargs),
          " ".join(["EXT"] + [f"b{i}" for i in range(1, n + 1)]))

    # 关掉中间一个框 -> 该段跳过
    if n >= 2:
        kwargs = {f"box_{i}": f"b{i}" for i in range(1, n + 1)}
        kwargs[f"enable_{n // 2 + 1}"] = False
        expected = [f"b{i}" for i in range(1, n + 1) if i != n // 2 + 1]
        check(f"关掉 box_{n // 2 + 1} -> 跳过", run(cls, **kwargs), " ".join(expected))

    # 纯空格视为空 -> 跳过
    check("纯空格框被跳过", run(cls, input_string="A", **{f"box_{n}": "   "}), "A")

    # 连接符解码：字面 \n / \t
    check("连接符 \\n 解码", run(cls, input_string="A", **{f"box_{n}": "B"}, separator="\\n"), "A\nB")
    check("连接符 \\t 解码", run(cls, input_string="A", **{f"box_{n}": "B"}, separator="\\t"), "A\tB")
    check("空连接符", run(cls, input_string="A", **{f"box_{n}": "B"}, separator=""), "AB")

    # 全关 -> 空串
    off = {f"enable_{i}": False for i in range(1, n + 1)}
    check("全关 + 有内容 -> 空串", run(cls, input_string="", **{
        f"box_{i}": f"b{i}" for i in range(1, n + 1)
    }, **off), "")

# ---- PromptSanitizer（Prompt Sanitizer）----
print("== PromptSanitizer (Prompt Sanitizer) ==")
PS = mod.PromptSanitizer
req = PS.INPUT_TYPES()["required"]
check("INPUT_TYPES 键完整",
      set(req),
      {"string", "clean_weights", "weight_mode", "min_weight", "max_weight", "dedupe", "format"})
check("显示名", mod.NODE_DISPLAY_NAME_MAPPINGS["PromptSanitizer"], "🧼 提示词净化 / Prompt Cleaner")
check("输入控件名是 string（JS 端口化依赖）", "string" in req and "input_string" not in req, True)

# 权重清洗 - normalize
check("标准 (w:1.5) 原样", run(PS, string="(sky:1.5), cloud"), "(sky:1.5), cloud")
check("嵌套 ((w)) -> 1.1", run(PS, string="((fire))"), "(fire:1.1)")
check("三层 (((w))) -> 1.21", run(PS, string="(((fire)))"), "(fire:1.21)")
check("嵌套带显式权重取显式", run(PS, string="((fire:1.3))"), "(fire:1.3)")
check("[w] -> 0.9", run(PS, string="[blur]"), "(blur:0.9)")
check("[w:1.2] 取显式", run(PS, string="[blur:1.2]"), "(blur:1.2)")
check("裸词:1.5 -> 加括号", run(PS, string="sky:1.5"), "(sky:1.5)")
check("3:4 不误判为权重", run(PS, string="ratio 3:4"), "ratio 3:4")
check("钳位上限 9.9 -> 8.0", run(PS, string="(sky:9.9)"), "(sky:8)")
check("钳位下限 0.05 -> 0.1", run(PS, string="(sky:0.05)"), "(sky:0.1)")
check("w==1.0 -> 裸词", run(PS, string="(sky:1.0)"), "sky")
check("括号内整数权重 (sky:2)", run(PS, string="(sky:2)"), "(sky:2)")
check("多词标签 (long exposure:1.2)", run(PS, string="(long exposure:1.2)"), "(long exposure:1.2)")
check("括号内逗号不切段", run(PS, string="(a, b:1.5), c"), "(a, b:1.5), c")
check("(sky:1.5) 与 sky 视为同一词", run(PS, string="(sky:1.5), sky"), "(sky:1.5)")

# 权重清洗 - strip_all
check("strip_all 剥光标记", run(PS, string="(sky:1.5), ((fire)), [blur]", weight_mode="strip_all"),
      "sky, fire, blur")

# 去重
check("忽略大小写去重", run(PS, string="cat, Cat, CAT"), "cat")
check("cat 与 cat:1.0 同词", run(PS, string="cat:1.0, cat"), "cat")
check("去重保留首次的权重", run(PS, string="(cat:1.5), cat"), "(cat:1.5)")
check("去重关 -> 全留", run(PS, string="cat, cat", dedupe=False), "cat, cat")
check("保序：幸存项相对顺序 == 原顺序", run(PS, string="zeta, alpha, zeta, mid, alpha"), "zeta, alpha, mid")

# 受保护块
check("style 块语法保留（真实用例，一字不动）",
      run(PS, string="<|style|> anime illustration, anime coloring <|/style|>"),
      "<|style|> anime illustration, anime coloring <|/style|>")
check("块内内容照常清洗",
      run(PS, string="<|style|> cat:1.5, ((fire)), cat <|/style|>"),
      "<|style|> (cat:1.5), (fire:1.1) <|/style|>")
check("去重不跨块边界（块内词不被块外同名词吃掉）",
      run(PS, string="cat, <|style|> cat, dog <|/style|>"),
      "cat, <|style|> cat, dog <|/style|>")
check("多块 + 块外正常去重",
      run(PS, string="<|style|> a <|/style|>, b, b, <|style|> c <|/style|>"),
      "<|style|> a <|/style|>, b, <|style|> c <|/style|>")
check("老式闭 token </style|> 也配块",
      run(PS, string="<|style|> cat:1.5 </style|>"),
      "<|style|> (cat:1.5) </style|>")
check("空块保留结构",
      run(PS, string="<|style|>   <|/style|>"),
      "<|style|> <|/style|>")
check("未配对 token 独立保留、不参与去重",
      run(PS, string="<|style|> a <|style|> b"),
      "<|style|>, a, <|style|>, b")

# 格式化
check("下划线变空格", run(PS, string="cyber_punk"), "cyber punk")
check("逗号标准化 a,,b,  c ,d", run(PS, string="a,,b,  c ,d"), "a, b, c, d")
check("format 关 -> 下划线保留", run(PS, string="cyber_punk", format=False), "cyber_punk")

# 组合 / 边界
check("组合示例", run(PS, string="(sky:1.5), sky, Cloud, 蓝天白云, cyber_punk, 蓝天白云"),
      "(sky:1.5), Cloud, 蓝天白云, cyber punk")
check("中文标签不被拆坏", run(PS, string="蓝天白云, 蓝天白云"), "蓝天白云")
check("空输入 -> 空串", run(PS, string=""), "")
check("全关 = 仅逗号拼接", run(PS, string="  cat ,  cat  ", clean_weights=False, dedupe=False, format=False),
      "cat, cat")

# ---------------------------------------------------------------- PromptFileLoader
print("\n== PromptFileLoader (Prompt File Loader) ==")

import shutil
import tempfile

PFL = mod.PromptFileLoader
req = PFL.INPUT_TYPES()["required"]
check("INPUT_TYPES 键完整", sorted(req.keys()), ["directory", "file"])
check("显示名", mod.NODE_DISPLAY_NAME_MAPPINGS["PromptFileLoader"], "📄 提示词文件 / Prompt File")
check("默认 directory 为空（= ComfyUI/input/prompts）", req["directory"][1]["default"], "")
check("file 下拉首项是「不读取文件」", req["file"][0][0], mod.NO_FILE)

tmp = tempfile.mkdtemp(prefix="pfl_test_")
_old_base = files_mod._COMFY_BASE
files_mod._COMFY_BASE = tmp  # 空目录 / 相对目录都落到临时目录下

d = os.path.join(tmp, "input", "prompts")
os.makedirs(d)


def _write(name, text, encoding="utf-8", base=d):
    p = os.path.join(base, name)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w", encoding=encoding) as f:
        f.write(text)
    return p


_write("b.txt", "B")
_write("A.txt", "A")
_write("c.png", "not a txt")
os.makedirs(os.path.join(d, "d.txt"))  # 名字像 txt 的目录不该被列出

check("只列 .txt 且忽略大小写排序", mod.list_txt_files(""), ["A.txt", "b.txt"])
check("默认选「不读取文件」-> 空串", run(PFL), "")
check("选「不读取文件」即使目录有文件 -> 空串", run(PFL, file=mod.NO_FILE), "")
check("文件不存在 -> 空串", run(PFL, file="gone.txt"), "")
check("非 .txt -> 空串", run(PFL, file="c.png"), "")
check("../ 越界 -> 空串", run(PFL, file="../evil.txt"), "")
check("子路径 -> 空串", run(PFL, file="sub/evil.txt"), "")

_write("multi.txt", "第一行\n第二行\n\n")
check("多行原样保留、末尾空白去掉", run(PFL, file="multi.txt"), "第一行\n第二行")

_write("bom.txt", "带 BOM 的中文", encoding="utf-8-sig")
check("utf-8-sig（BOM）正确解码", run(PFL, file="bom.txt"), "带 BOM 的中文")

_write("gbk.txt", "国标编码中文，测试", encoding="gbk")
check("gbk 回退正确解码", run(PFL, file="gbk.txt"), "国标编码中文，测试")

rel = os.path.join(tmp, "other")
os.makedirs(rel)
_write("x.txt", "别的目录", base=rel)
check("相对目录（相对 ComfyUI 根）", run(PFL, directory="other", file="x.txt"), "别的目录")
check("绝对目录", run(PFL, directory=rel, file="x.txt"), "别的目录")
check("目录不存在 -> 列表只有「不读取文件」", mod.list_txt_files("nope_donotexist"),
      [])
check("目录带引号也能认", run(PFL, directory=f'"{rel}"', file="x.txt"), "别的目录")

# 同名缩略图匹配 / 缩略图生成
_write("粗笔触.txt", "x")
_write("粗笔触.JPG", "fake")  # 只有扩展名大小写不同
check("同名图匹配（.JPG 大小写不敏感）",
      os.path.basename(mod.find_preview_image("", "粗笔触.txt") or ""), "粗笔触.JPG")
_write("赛璐璐.txt", "x")
_write("赛璐璐.png", "fake")
check("同名 png 命中", os.path.basename(mod.find_preview_image("", "赛璐璐.txt") or ""), "赛璐璐.png")
check("无同名图 -> None", mod.find_preview_image("", "multi.txt"), None)
check("哨兵「不读取文件」-> None", mod.find_preview_image("", mod.NO_FILE), None)
check("越界文件名 -> None", mod.find_preview_image("", "../evil.txt"), None)
check("非 txt 文件名 -> None", mod.find_preview_image("", "c.png"), None)

try:
    from PIL import Image as _Image
except ImportError:  # 没装 Pillow 的机器（CI、干净环境）跳过这组检查，别让整份自测挂掉
    _Image = None
    print("  SKIP  Pillow 未安装：跳过缩略图尺寸检查")

if _Image is not None:
    _big = os.path.join(d, "大图.txt")
    open(_big, "w", encoding="utf-8").write("x")
    _img_path = os.path.join(d, "大图.png")
    _Image.new("RGBA", (900, 600), (10, 200, 90, 128)).save(_img_path)
    _bytes, _mime = mod.preview_thumb(_img_path)
    check("缩略图是 png（保留透明）", _mime, "image/png")
    check("缩略图最长边 <= 320", max(_Image.open(__import__("io").BytesIO(_bytes)).size), 320)
files_mod._THUMB_CACHE.clear()

files_mod._COMFY_BASE = _old_base
shutil.rmtree(tmp, ignore_errors=True)

# ---------------------------------------------------------------- PromptToggle
print("\n== PromptToggle (Prompt Toggle) ==")

import json

PT = mod.PromptToggle
req = PT.INPUT_TYPES()["required"]
check("INPUT_TYPES 键", sorted(req.keys()), ["join_mode", "text"])
check("mask 是可选输入（界面上不出现）",
      "mask" in PT.INPUT_TYPES().get("optional", {}), True)
check("显示名", mod.NODE_DISPLAY_NAME_MAPPINGS["PromptToggle"], "💥 提示词炸词 / Prompt Toggle")
check("有可选上游端口",
      "upstream" in PT.INPUT_TYPES().get("optional", {}), True)


def segs(t):
    return [s for s, _ in mod.split_prompt_segments(t)]


check("英文逗号", segs("a, b, c"), ["a", "b", "c"])
check("中文标点 逗号句号分号", segs("天空，云。雨；风"), ["天空", "云", "雨", "风"])
check("换行也拆", segs("a\nb"), ["a", "b"])
check("括号内逗号不拆", segs("(a, b:1.2), c"), ["(a, b:1.2)", "c"])
check("嵌套括号不拆", segs("((a, b)), c"), ["((a, b))", "c"])
check("冒号不拆（护 3:4 与权重）", segs("ratio 3:4, (cat:1.2)"), ["ratio 3:4", "(cat:1.2)"])
check("style 块整块不拆", segs("<|style|> a, b <|/style|>"), ["<|style|> a, b <|/style|>"])
check("纯标点 -> 空", segs(" , , . "), [])
check("首尾空白去掉", segs("  a  ,  b  "), ["a", "b"])

check("默认全开", mod.apply_toggle("a, b, c", ""), "a, b, c")
check("关掉中间", mod.apply_toggle("a, b, c", json.dumps([1, 0, 1])), "a, c")
check("全关 -> 空串", mod.apply_toggle("a, b", json.dumps([0, 0])), "")
check("mask 长度不符 -> 全开", mod.apply_toggle("a, b, c", json.dumps([0])), "a, b, c")
check("mask 不是 JSON -> 全开", mod.apply_toggle("a, b", "not json"), "a, b")
check("original 模式保留原标点",
      mod.apply_toggle("a, b；c。d", json.dumps([1, 0, 1, 0]), "original"), "a；c")
check("original 模式保留逗号后的空格",
      mod.apply_toggle("a, b, c", json.dumps([1, 0, 1]), "original"), "a, c")
check("节点调用（关中间）", run(PT, text="a, b, c", mask=json.dumps([1, 0, 1])), "a, c")
check("拼接上游：上游整段在前，本节点结果在后",
      run(PT, text="a, b, c", mask=json.dumps([1, 0, 1]), upstream="x, y"), "x, y, a, c")
check("上游不参与片段开关（mask 只作用于编辑框）",
      run(PT, text="a, b", mask=json.dumps([0, 1]), upstream="x, y"), "x, y, b")
check("编辑框空 + 有上游 -> 只输出上游", run(PT, text="", upstream="x, y"), "x, y")
check("上游为空不影响输出", run(PT, text="a, b", upstream="   "), "a, b")
check("空文本 -> 空串", run(PT, text=""), "")

# --- 词片右上角的 × ：从文本里彻底删掉一段（drop_segment）
drop = mod.nodes.toggle.drop_segment
check("删中间一段（保留原标点）", drop("a, b, c, d", 2), "a, b, d")
check("删最后一段不留尾逗号", drop("a, b, c", 2), "a, b")
check("删第一段不留开头逗号", drop("a, b, c", 0), "b, c")
check("只剩一段时删光", drop("a", 0), "")
check("越界 -> 原样返回", drop("a, b", 9), "a, b")
check("换行也保留", drop("a\nb\nc", 1), "a\nc")
check("冒号不参与分段（3:4 不被切开）", drop("3:4, cat", 1), "3:4")
check("删一段后重新拆分，片段数减一",
      [s for s, _ in mod.split_prompt_segments(drop("a, b, c", 1))], ["a", "c"])

# ---------------------------------------------------------------------------
# CameraMixer -> Camera Mixer
# ---------------------------------------------------------------------------
print("== Camera Mixer ==")

CM = mod.CameraMixer
WM_SAFE, WM_CUSTOM, WM_RAW = mod.CAMERA_WEIGHT_MODES


def cam(cfg_raw="", **kw):
    """跑一遍纯函数层：cfg_json 叠在默认上，其余参数直传。"""
    return mod.camera_build(mod.camera_cfg(cfg_raw), **kw)[0]


def cfg_json(**d):
    return json.dumps(d)


check("显示名", mod.NODE_DISPLAY_NAME_MAPPINGS["CameraMixer"], "🎥 相机镜头 / Camera Rig")
check("类别", CM.CATEGORY, "String-Mixer")
check("输出端口名", CM.RETURN_NAMES, ("相机提示词",))
check("_cfg / 机位 / 焦距 / 权重都是可选输入（界面上不占格子）",
      sorted(CM.INPUT_TYPES().get("optional", {})),
      ["_cfg", "focal_mm", "pos_azimuth", "pos_distance", "pos_elevation",
       "weight_cap", "weight_mode"])
check("节点主体上的控件（顺序即显示顺序）",
      list(CM.INPUT_TYPES()["required"]), ["lens_on", "f_stop", "dutch_enabled", "roll"])
check("光圈下拉第一项是「关」", list(mod.CAMERA_F_STOP_CHOICES)[0], "关")
check("节点调用默认值", run(CM), "(from front:1.40), (eye level:1.40), (medium shot:1.40)")

check("45° 拆到两个方向", cam(azimuth=0.25),
      "(from front:1.20), (from right:1.20), (eye level:1.40), (medium shot:1.40)")
check("背面 180°", cam(azimuth=1.0)[:18], "(from behind:1.40)")

# 方位死区：纯正方向不是数学上的一个点，是一个小范围（±5°）
check("正前 ±5° 内只出 from front（3.6°）", cam(azimuth=0.02),
      "(from front:1.40), (eye level:1.40), (medium shot:1.40)")
check("正后 ±5° 内只出 from behind（3.6°）", cam(azimuth=0.98),
      "(from behind:1.40), (eye level:1.40), (medium shot:1.40)")
check("方位一侧只出 from right（86.4°）", cam(azimuth=0.48),
      "(from right:1.40), (eye level:1.40), (medium shot:1.40)")
check("方位另一侧只出 from left（-86.4°）", cam(azimuth=-0.48),
      "(from left:1.40), (eye level:1.40), (medium shot:1.40)")
check("正右 90° 不再残留 from front", cam(azimuth=-0.5),
      "(from left:1.40), (eye level:1.40), (medium shot:1.40)")
check("正左 90° 不再残留 from behind", cam(azimuth=0.5),
      "(from right:1.40), (eye level:1.40), (medium shot:1.40)")
check("死区外一点仍是纯正面（7.2°）：1.04 的侧词不发", cam(azimuth=0.04),
      "(from front:1.36), (eye level:1.40), (medium shot:1.40)")
check("10.8° 才重新出现第二个方向", cam(azimuth=0.06),
      "(from front:1.34), (from right:1.06), (eye level:1.40), (medium shot:1.40)")
check("79.2° 还剩一点 from front（1.06）", cam(azimuth=0.44),
      "(from front:1.06), (from right:1.34), (eye level:1.40), (medium shot:1.40)")
check("84.6° 已无 from front", cam(azimuth=0.47),
      "(from right:1.37), (eye level:1.40), (medium shot:1.40)")
check("171°（离正后 9°）侧词才回来", cam(azimuth=0.95),
      "(from behind:1.35), (from right:1.05), (eye level:1.40), (medium shot:1.40)")


# 极端角度：这是单节点要能直接做到的事
check("鸟瞰（方位自动静默）", cam(elevation=1.0),
      "(directly above:1.40), (aerial view:1.40), (medium shot:1.40)")
check("虫瞰", cam(elevation=-1.0), "(directly below:1.40), (medium shot:1.40)")
check("极区留方位开关打开", cam(cfg_json(azimuth_in_pole=True), elevation=1.0),
      "(from front:1.40), (directly above:1.40), (aerial view:1.40), (medium shot:1.40)")
check("极区里方位线性衰减（y=0.925 -> 半强度 1.20）",
      cam(elevation=0.925),
      "(from front:1.20), (directly above:1.37), (aerial view:1.37), (medium shot:1.40)")

# 分档
check("俯视 0.5", cam(elevation=0.5), "(from front:1.40), (high angle:1.20), (from above:1.20), (medium shot:1.40)")

# 平视的权重曲线：正平视最高，越偏越弱
check("正平视 -> eye level 拿满权重", cam(elevation=0.0),
      "(from front:1.40), (eye level:1.40), (medium shot:1.40)")
check("略抬头 0.1 -> eye level 降到 1.24", cam(elevation=0.1),
      "(from front:1.40), (eye level:1.24), (medium shot:1.40)")
check("快到档界 0.24 -> eye level 只剩 1.02", cam(elevation=0.24),
      "(from front:1.40), (eye level:1.02), (medium shot:1.40)")
check("略低头 -0.1 同理", cam(elevation=-0.1),
      "(from front:1.40), (eye level:1.24), (medium shot:1.40)")
check("刚进俯视 0.26 -> high angle 很弱", cam(elevation=0.26),
      "(from front:1.40), (high angle:1.10), (from above:1.10), (medium shot:1.40)")
check("景别：特写", cam(distance=1.0), "(from front:1.40), (eye level:1.40), (extreme close-up:1.40)")
check("景别：远景", cam(distance=-1.0), "(from front:1.40), (eye level:1.40), (wide shot:1.40)")
check("景别界线 0.7 归特写", cam(distance=0.7), "(from front:1.40), (eye level:1.40), (extreme close-up:1.40)")

# 镜头 / 光圈
check("14mm -> 鱼眼", cam(focal_mm=14.0),
      "(from front:1.40), (eye level:1.40), (medium shot:1.40), (fisheye:1.40)")
check("35mm -> 广角", cam(focal_mm=35.0),
      "(from front:1.40), (eye level:1.40), (medium shot:1.40), (wide angle:1.28)")
check("50mm -> 标准镜头不出词", cam(focal_mm=50.0),
      "(from front:1.40), (eye level:1.40), (medium shot:1.40)")
check("135mm -> 长焦", cam(focal_mm=135.0),
      "(from front:1.40), (eye level:1.40), (medium shot:1.40), (telephoto lens:1.28)")
check("f/1.4 -> 浅景深 + 虚化", cam(f_stop="f/1.4"),
      "(from front:1.40), (eye level:1.40), (medium shot:1.40), "
      "(shallow depth of field:1.40), (bokeh:1.40)")
check("f/2.8 -> 只有浅景深", cam(f_stop="f/2.8"),
      "(from front:1.40), (eye level:1.40), (medium shot:1.40), (shallow depth of field:1.24)")
check("f/8 -> 空档不出词", cam(f_stop="f/8"),
      "(from front:1.40), (eye level:1.40), (medium shot:1.40)")
check("f/16 -> 深景深", cam(f_stop="f/16"),
      "(from front:1.40), (eye level:1.40), (medium shot:1.40), (deep depth of field:1.24)")

# 倾斜是独立开关
check("倾斜开关关 -> 不出词", cam(dutch_enabled=False, roll=1.0),
      "(from front:1.40), (eye level:1.40), (medium shot:1.40)")
check("倾斜开关一开就有词（滚轮没动也不空）", cam(dutch_enabled=True, roll=0.0),
      "(from front:1.40), (eye level:1.40), (medium shot:1.40), (dutch angle:1.14)")
check("倾斜过死区 -> dutch angle", cam(dutch_enabled=True, roll=0.8),
      "(from front:1.40), (eye level:1.40), (medium shot:1.40), (dutch angle:1.31)")

# 三种权重模式
check("关闭权重 -> 裸词", cam(weight_mode=WM_RAW), "from front, eye level, medium shot")
check("自定义上限 2.5", cam(weight_mode=WM_CUSTOM, weight_cap=2.5),
      "(from front:2.50), (eye level:2.50), (medium shot:2.50)")
check("自定义上限可以开到参考仓库那档（10）",
      cam(weight_mode=WM_CUSTOM, weight_cap=10.0),
      "(from front:10.00), (eye level:10.00), (medium shot:10.00)")
check("上限超过 10 会被夹回 10", cam(weight_mode=WM_CUSTOM, weight_cap=99.0),
      "(from front:10.00), (eye level:10.00), (medium shot:10.00)")
check("安全模式的 weight_cap 不生效（锁死 1.4）",
      cam(weight_mode=WM_SAFE, weight_cap=3.0), "(from front:1.40), (eye level:1.40), (medium shot:1.40)")

# 关掉某一档 / 某一轴
check("关掉整个高度轴",
      cam(cfg_json(tags={"elevation": {"enabled": False}})),
      "(from front:1.40), (medium shot:1.40)")
check("只关「正面」这一个方向",
      cam(cfg_json(tags={"azimuth": {"directions": {"front": {"enabled": False}}}})),
      "(eye level:1.40), (medium shot:1.40)")
check("关掉景深轴",
      cam(cfg_json(tags={"dof": {"enabled": False}}), f_stop="f/1.4"),
      "(from front:1.40), (eye level:1.40), (medium shot:1.40)")

# 容错：坏输入一律不抛，回落默认
check("坏 JSON 回落默认", cam("{这不是 json"), "(from front:1.40), (eye level:1.40), (medium shot:1.40)")
check("坏光圈文案不抛", cam(f_stop="光圈坏了"), "(from front:1.40), (eye level:1.40), (medium shot:1.40)")
check("超范围数值被夹住", cam(azimuth=9.0, elevation=-9.0, distance=9.0),
      "(directly below:1.40), (extreme close-up:1.40)")

# 焦距：开关管「要不要出词」，焦距管「出哪个词」
check("焦距提示开关：关 -> 不出透视词",
      cam(focal_mm=14.0, fov_enabled=False),
      "(from front:1.40), (eye level:1.40), (medium shot:1.40)")
check("焦距提示开关：开 -> 照常出词", cam(focal_mm=14.0, fov_enabled=True),
      "(from front:1.40), (eye level:1.40), (medium shot:1.40), (fisheye:1.40)")
check("焦距仍然上报给前端（图上要画扇形）",
      mod.camera_build(mod.camera_cfg(""), focal_mm=24.0, fov_enabled=False)[1]["focal_mm"], 24.0)
check("镜头 85mm 解析", mod.camera_focal("85mm"), 85.0)
check("镜头坏值回落 50mm", mod.camera_focal("???"), 50.0)
check("镜头档位里没有「无」（改由开关控制）", list(mod.CAMERA_LENSES),
      ["14mm", "24mm", "35mm", "50mm", "85mm", "135mm", "200mm"])

# 光圈：下拉里带「关」，选关就整段不出景深词
check("光圈选「关」-> 不出景深词", cam(f_stop="关"),
      "(from front:1.40), (eye level:1.40), (medium shot:1.40)")
check("光圈 f/1.4 -> 照常出词", cam(f_stop="f/1.4"),
      "(from front:1.40), (eye level:1.40), (medium shot:1.40), "
      "(shallow depth of field:1.40), (bokeh:1.40)")
check("光圈档位上报给前端",
      mod.camera_build(mod.camera_cfg(""), f_stop="f/16")[1]["f_stop_value"], 16.0)
check("输出原始光圈值", cam(cfg_json(out_fstop=True), f_stop="f/1.4"),
      "(from front:1.40), (eye level:1.40), (medium shot:1.40), "
      "(shallow depth of field:1.40), (bokeh:1.40), f/1.4")
check("输出原始焦距值", cam(cfg_json(out_focal=True), focal_mm=85.0),
      "(from front:1.40), (eye level:1.40), (medium shot:1.40), "
      "(telephoto lens:1.28), 85mm lens")
check("原始值不带权重：自定义上限 3.0 也不带",
      cam(cfg_json(out_focal=True, out_fstop=True), focal_mm=24.0, f_stop="f/2.8",
          weight_mode=WM_CUSTOM, weight_cap=3.0),
      "(from front:3.00), (eye level:3.00), (medium shot:3.00), "
      "(wide angle:2.40), 24mm lens, (shallow depth of field:2.20), f/2.8")
check("原始值不带权重：关闭权重模式下依旧裸词",
      cam(cfg_json(out_focal=True), focal_mm=14.0, weight_mode=WM_RAW),
      "from front, eye level, medium shot, fisheye, 14mm lens")

# 每个词单独的权重上限（全局是天花板，单词只能更低）
check("单词上限：留空跟随全局", cam(),
      "(from front:1.40), (eye level:1.40), (medium shot:1.40)")
check("单词上限：压到 1.1", cam(cfg_json(tags={"distance": {"tiers": {"medium": {"cap": 1.1}}}})),
      "(from front:1.40), (eye level:1.40), (medium shot:1.10)")
check("单词上限：想突破全局也没用（安全模式 1.4 是硬顶）",
      cam(cfg_json(tags={"distance": {"tiers": {"medium": {"cap": 2.5}}}})),
      "(from front:1.40), (eye level:1.40), (medium shot:1.40)")
check("单词上限：自定义模式下如实生效",
      cam(cfg_json(tags={"distance": {"tiers": {"medium": {"cap": 1.6}}}}),
          weight_mode=WM_CUSTOM, weight_cap=2.5),
      "(from front:2.50), (eye level:2.50), (medium shot:1.60)")
check("单词上限：方位词也能单设",
      cam(cfg_json(tags={"azimuth": {"directions": {"front": {"cap": 1.15}}}})),
      "(from front:1.15), (eye level:1.40), (medium shot:1.40)")
check("单词上限：坏值回落全局",
      cam(cfg_json(tags={"distance": {"tiers": {"medium": {"cap": "abc"}}}})),
      "(from front:1.40), (eye level:1.40), (medium shot:1.40)")

# 不会越界：全轴拉满 + 各种上限
bad = []
for mode, cap, limit in ((WM_SAFE, 3.0, 1.4), (WM_CUSTOM, 3.0, 3.0), (WM_CUSTOM, 1.0, 1.0)):
    text = cam(azimuth=0.5, elevation=1.0, distance=1.0, focal_mm=14.0, f_stop="f/1.2",
               dutch_enabled=True, roll=1.0, weight_mode=mode, weight_cap=cap)
    nums = [float(p.split(":")[1].rstrip(")")) for p in text.split(", ") if ":" in p]
    if max(nums) > limit + 1e-9:
        bad.append((mode, cap, max(nums)))
check("任何组合下权重都不超过上限", bad, [])

# 给前端的状态
_info = mod.camera_build(mod.camera_cfg(""), elevation=1.0)[1]
check("状态：档位键", [_info["elevation_key"], _info["distance_key"], _info["fov_key"]],
      ["bird", "medium", "normal"])
check("状态：方位门控在鸟瞰时为 0", _info["azimuth_gate"], 0.0)
check("状态：平视带半径", _info["eye_band"], 0.25)
check("状态：读数文案", _info["readout"], "方位 正面 0° · 高度 鸟瞰 90° · 中景 · 镜头 50mm · f/8")
check("状态：景别界线传给前端", _info["distance_gears"], [0.7, 0.2, 0.0, -0.35, -0.7])

# ---------------------------------------------------------------------- TextSnapshot
print()
print("TextSnapshot（文本闸门）")

_ts_it = mod.TextSnapshot.INPUT_TYPES()
check("快照：text 是多行控件", _ts_it["required"]["text"][1].get("multiline"), True)
check("快照：source 是端口（forceInput）", _ts_it["optional"]["source"][1].get("forceInput"), True)
check("快照：是输出节点（局部执行只认它）", mod.TextSnapshot.OUTPUT_NODE, True)
check("快照：返回一个 string", mod.TextSnapshot.RETURN_TYPES, ("STRING",))

_ts = mod.TextSnapshot()
_r = _ts.snapshot(text="改过的词", source="上游 原文")
check("快照：有内容时输出编辑框（不是上游）", _r["result"], ("改过的词",))
check("快照：上游原文回传前端", _r["ui"]["ts_source"], ["上游 原文"])
check("快照：段数", _r["ui"]["ts_count"], [1])
check("快照：接线标记", _r["ui"]["ts_linked"], [1])
check("快照：本次输出取自快照", _r["ui"]["ts_used"], [0])

_r0 = _ts.snapshot(text="", source=None)
check("空框 + 没上游：输出空", _r0["result"], ("",))
check("空框 + 没上游：标记为 0", _r0["ui"]["ts_linked"], [0])
check("空框 + 没上游：不算取自上游", _r0["ui"]["ts_used"], [0])

_r1 = _ts.snapshot(text="", source="")
check("空框 + 上游为空串：仍算接线", _r1["ui"]["ts_linked"], [1])
check("空框 + 上游为空串：输出仍为空", _r1["result"], ("",))

_rf = _ts.snapshot(text="", source="上游 原文")
check("空框 + 有上游：跟随，直接输出上游", _rf["result"], ("上游 原文",))
check("空框 + 有上游：标记本次取自上游", _rf["ui"]["ts_used"], [1])

_rw = _ts.snapshot(text="   \n ", source="上游 原文")
check("纯空白也算空框：跟随上游", _rw["result"], ("上游 原文",))

_rl = _ts.snapshot(text="", source=["甲乙", "丙丁"])
check("列表上游两段", _rl["ui"]["ts_count"], [2])
check("列表上游按空行拼接（跟随态直接输出）", _rl["result"], ("甲乙\n\n丙丁",))

_rn = _ts.snapshot(text="", source=123)
check("非字符串上游转成文本", _rn["result"], ("123",))

_rs = _ts.snapshot(text="空格里的快照", source="上游")
check("快照优先于上游", _rs["result"], ("空格里的快照",))

# ---- 闸门：被拦下的判定
_rb = _ts.snapshot(text="我的词", source="上游的另一些词")
check("闸门：上游不同 -> 报被拦下", _rb["ui"]["ts_blocked"], [1])
check("闸门：被拦时仍输出框内", _rb["result"], ("我的词",))

_rsame = _ts.snapshot(text="上游", source="上游")
check("闸门：框内与上游一致 -> 不算拦", _rsame["ui"]["ts_blocked"], [0])

_rblank = _ts.snapshot(text="上游 \n", source="上游")
check("闸门：只有空白差异 -> 不算拦", _rblank["ui"]["ts_blocked"], [0])

_rnone = _ts.snapshot(text="我的词", source=None)
check("闸门：没接上游 -> 不算拦", _rnone["ui"]["ts_blocked"], [0])

_rempty = _ts.snapshot(text="我的词", source="")
check("闸门：上游为空 -> 不算拦", _rempty["ui"]["ts_blocked"], [0])

_rgate = _ts.snapshot(text="   \n", source="上游词")
check("闸门：框内只有空白 -> 开闸，输出上游", _rgate["result"], ("上游词",))
check("闸门：开闸那次不算拦", _rgate["ui"]["ts_blocked"], [0])

# ---------------------------------------------------------------------- TextGateSplit
print()
print("TextGateSplit（闸门炸词）")

_gs_it = mod.TextGateSplit.INPUT_TYPES()
check("闸门炸词：join_mode 两个选项", _gs_it["required"]["join_mode"][0], ["comma", "original"])
check("闸门炸词：source 是端口", _gs_it["optional"]["source"][1].get("forceInput"), True)
check("闸门炸词：mask 是隐藏状态输入", _gs_it["optional"]["mask"][1].get("default"), "")
check("闸门炸词：是输出节点", mod.TextGateSplit.OUTPUT_NODE, True)

_gs = mod.TextGateSplit()


def gs(text, join_mode="comma", mask="", source=None):
    return _gs.run(text=text, join_mode=join_mode, mask=mask, source=source)


_r = gs("", source="红裙。长发; 微笑")
check("空框 -> 上游原样通过（不炸不重拼）", _r["result"], ("红裙。长发; 微笑",))
check("空框 -> 标记取自上游", _r["ui"]["ts_used"], [1])

_r = gs("红裙。长发; 微笑", mask=json.dumps([1, 1, 1]))
check("全开 -> 箱内原样（不动标点）", _r["result"], ("红裙。长发; 微笑",))
check("全开 -> 段数", _r["ui"]["tgs_total"], [3])
check("全开 -> 不算全关", _r["ui"]["tgs_all_off"], [0])

_r = gs("红裙, 长发, 微笑", mask=json.dumps([1, 0, 1]))
check("关中间一段 -> comma 重拼", _r["result"], ("红裙, 微笑",))
check("关中间一段 -> 开着的段数", _r["ui"]["tgs_kept"], [2])

_r = gs("红裙。长发; 微笑", join_mode="original", mask=json.dumps([1, 0, 1]))
check("关中间一段 -> original 保留原分隔符", _r["result"], ("红裙; 微笑",))

_r = gs("红裙, 长发", mask=json.dumps([0, 0]))
check("全关 -> 输出空", _r["result"], ("",))
check("全关 -> 报警标记", _r["ui"]["tgs_all_off"], [1])

_r = gs("红裙, 长发", mask=json.dumps([1, 0, 1]))
check("mask 长度对不上 -> 视为全开，箱内原样", _r["result"], ("红裙, 长发",))

_r = gs("红裙, 长发", mask="不是JSON")
check("mask 坏值 -> 视为全开", _r["result"], ("红裙, 长发",))

_r = gs("我的词", source="上游的另一些词")
check("箱内有字 + 上游不同 -> 报被拦下", _r["ui"]["ts_blocked"], [1])
check("被拦时仍输出箱内", _r["result"], ("我的词",))

_r = gs("红裙, 长发", mask=json.dumps([1, 0]))
check("上游为空不算拦", _r["ui"]["ts_blocked"], [0])

_r = gs("", source=None)
check("空框 + 没上游 -> 输出空", _r["result"], ("",))
check("空框 + 没上游 -> 不算取自上游", _r["ui"]["ts_used"], [0])

print()
if failures:
    print(f"共 {len(failures)} 项失败：{failures}")
    sys.exit(1)
print("全部通过 ✔")
