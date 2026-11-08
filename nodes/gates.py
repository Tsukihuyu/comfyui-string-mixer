"""文本闸门 ⛩ / 闸门炸词 ⛩：框空就放上游进来，有字就拦下；炸词版再按标点开关片段。

闸门段与 TextSnapshot 同一套语义；炸词段复用 toggle.py 的拆分与拼回。

第三种状态是**蓄水**：永不拦，上游每次都把"账本里没有的段"接到框内文本末尾。
"""
import json

from .toggle import apply_toggle, split_prompt_segments, split_spans


# ---------------------------------------------------------------------------
# 蓄水（reservoir）：只增不减的上游累积
# ---------------------------------------------------------------------------
# 判据只有一条：这一段"蓄过没有"。比对的两边是「上游这一次给的每一段」和「账本」，
# 与框里现在有什么无关——手动写进去的同名词不会被当成重复吃掉，也不会被拦。
#
# 为什么按段而不是按整段文本：上游常常只在中间插一个词（或改一个词），整段比对
# 会把前面所有词再蓄一遍。按段差集就只蓄那一个词。


def seg_key(body):
    """账本的归一键：大小写折叠、下划线当空格、连续空白压缩（刻意不剥权重）。

    * "Blue_Hair" 与 "blue hair" -> 同一段，不会重复蓄
    * "(blue hair:1.1)" 与 "blue hair" -> 两段（上游改权重能蓄进来）
    """
    return " ".join(str(body).casefold().replace("_", " ").split())


def parse_reservoir(blob):
    """前端注入的 {"on":1,"seen":[...]} -> (开没开, 账本)。"""
    try:
        cfg = json.loads(blob) if blob else None
    except (ValueError, TypeError):
        return False, []
    if not isinstance(cfg, dict):
        return False, []
    seen = cfg.get("seen")
    seen = [str(x) for x in seen] if isinstance(seen, list) else []
    return bool(cfg.get("on")), seen


def append_chunk(body, tail):
    """给前端的追加串：带上分隔符，直接接在框内文本末尾。"""
    raw = str(body or "")
    if not raw.strip():
        return tail
    if raw.rstrip(" \t").endswith("\n"):
        return tail  # 框里已经是换行结尾：新词另起一行
    t = raw.rstrip()
    if t[-1] in ",，;；" or t[-1] in ".。!！?？":
        return " " + tail
    return ", " + tail


def absorb_upstream(body, raw, seen=()):
    """把上游里"账本没有的段"按原顺序接到 body 末尾。

    返回 (新文本, 新增段, 新增的归一键, 追加串)。
      * 上游在中间插了一个词 -> 只有那一个词是新增
      * 上游完全重复        -> 一个都不加（新文本 == body）
    这里没有"强制再蓄"这一档：点按钮和正常排队走的是同一条路，只蓄新词。
    """
    body = str(body or "")
    raw = str(raw or "")
    ledger = list(seen)
    known = set(ledger)
    fresh, new_keys, taken = [], [], set()
    if raw.strip():
        for seg, _before, _start, _end in split_spans(raw):
            key = seg_key(seg)
            if not key or key in taken:
                continue
            if key in known:
                continue
            taken.add(key)
            fresh.append(seg)
            if key not in known:
                new_keys.append(key)
    if not fresh:
        return body, [], [], ""
    tail = ", ".join(fresh)
    chunk = append_chunk(body, tail)
    # 行尾空格去掉，但保留换行（换行结尾时新词另起一行）
    new_text = (body.rstrip(" \t") + chunk) if body.strip() else tail
    return new_text, fresh, new_keys, chunk


# ---------------------------------------------------------------------------
# TextSnapshot -> 文本闸门 ⛩：框空时放上游进来（并留在框里），有字时只输出框内
# 拉取按钮只跑本节点和它的上游（局部执行），不跑整条工作流。
# ---------------------------------------------------------------------------
# 和 ShowText（pysssss）的差别不在界面，在"谁去取词"：
#   它：整条工作流跑完，Python 把值塞进 ui，前端回填；控件是只读显示位。
#   这个：前端点按钮 -> app.queuePrompt(0, 1, {queueNodeIds: [本节点]})，ComfyUI 的
#         局部执行只跑本节点和它的上游（execution.py validate_prompt 按
#         partial_execution_list 收执行目标，其他分支一概不碰），取回来的原文写进
#         text 控件；此后 text 就是真源——输出给下游的是你改过的内容，不是上游。
#
# 四个必须守住的约定：
#   * 两态就是闸门：框空 = 开着（执行时上游整段流进来，并写进框）；框里有字 = 关着
#     （只输出框内的字，上游再变也不动，且上游有差异时要报警）。
#   * OUTPUT_NODE 必须为 True。局部执行只认输出节点当目标（execution.py 里
#     outputs.add 只收 OUTPUT_NODE 为真的节点），也只有输出节点带 ui 回填。
#   * ui 键写 ts_source，且前端只在"刚点了刷新"时才写控件——正常排队跑完不动编辑内容。
#   * source 是 optional + forceInput：不接线也能当纯文本框用，且不占 widgets_values
#     的位置，老工作流不会因为多一个控件而错位。


class TextSnapshot:
    """TextSnapshot（文本闸门）：框空时放上游进来并留在框里，框里有字时只输出框内。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "text": ("STRING", {
                    "default": "",
                    "multiline": True,
                    "tooltip": "快照文本：点节点上的「拉取上游」写入；之后随便改，输出就是这里的内容",
                }),
            },
            "optional": {
                "source": ("STRING", {
                    "forceInput": True,
                    "tooltip": "上游文本：只有点「拉取上游」时才读进来，不会随队列自动更新",
                }),
                "reservoir": ("STRING", {
                    "forceInput": True,
                    "tooltip": "蓄水模式开关 + 已吸收账本（界面注入的 JSON），不用手填",
                }),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("text",)
    FUNCTION = "snapshot"
    CATEGORY = "String-Mixer"
    OUTPUT_NODE = True

    def snapshot(self, text, source=None, reservoir=""):
        linked, parts = snapshot_source(source)
        raw = "\n\n".join(parts)

        # 蓄水：永不拦，只把账本里没有的段接到框内文本末尾
        on, seen = parse_reservoir(reservoir)
        if on:
            out, fresh, new_keys, chunk = absorb_upstream(str(text), raw, seen)
            return {
                "ui": {
                    "ts_source": [raw],
                    "ts_count": [len(parts)],
                    "ts_linked": [1 if linked else 0],
                    "ts_used": [0],
                    "ts_blocked": [0],
                    "rsv_on": [1],
                    "rsv_n": [len(fresh)],
                    "rsv_fresh": [", ".join(fresh)],
                    "rsv_chunk": [chunk],
                    "rsv_keys": [json.dumps(new_keys, ensure_ascii=False)],
                },
                "result": (out,),
            }

        # 闸门：框空 = 开着，输出上游（让上游流过去）；框里有字 = 关着，只输出框内的字。
        body = str(text)
        if not body.strip():
            ui = {
                "ts_source": [raw],
                "ts_count": [len(parts)],
                "ts_linked": [1 if linked else 0],
                "ts_used": [1 if linked else 0],  # 本次输出取自上游
                "ts_blocked": [0],
            }
            return {"ui": ui, "result": (raw,)}
        # 被闸门拦下的情况要报出来，前端才好提示"上游有东西没进来"。
        # 只在上游确实有内容、而且和框里不一样时才算拦——只是重复同一段就没什么好报警的。
        blocked = 1 if (linked and raw.strip() and body.strip() != raw.strip()) else 0
        return {
            "ui": {
                "ts_source": [raw],
                "ts_count": [len(parts)],
                "ts_linked": [1 if linked else 0],
                "ts_used": [0],  # 本次输出取自快照（编辑框）
                "ts_blocked": [blocked],
            },
            "result": (text,),
        }


def snapshot_source(source):
    """上游原文 -> (是否接线, 段列表)。上游是 list（列表 / 批量输出）时按段拆开。"""
    if source is None:
        return False, []
    items = list(source) if isinstance(source, (list, tuple)) else [source]
    return True, [str(x) for x in items if x is not None]


# ---------------------------------------------------------------------------
# TextGateSplit -> 闸门炸词 ⛩：文本闸门 + 按标点炸开成可开关的片段
# ---------------------------------------------------------------------------
# 一个节点干两段活，两段都复用已有的实现，不另写一套：
#   闸门段（同 TextSnapshot）：框空 -> 输出上游原样，并把上游写进框；框里有字 -> 只输出框内
#   炸词段（同 PromptToggle）：框内文字按标点炸成片段，关掉的片段不进输出
#
# 输出规则：
#   * 框空            -> 输出上游原样（不重拼标点）
#   * 片段全开        -> 输出框内原文（同样不重拼，别静默改标点）
#   * 有关掉的片段    -> 按 join_mode 重拼：comma=", "，original=保留原分隔符
#   * 片段全关        -> 输出空串 + ui 报 tgs_all_off=1（前端红字报警，不静默）
#   * 开关状态按文字内容接续（reconcile 在前端做，和 PromptToggle 同一套）
#
# 为什么 mask 是 optional 输入而不是控件：它是纯状态，由前端存在 properties 里、
# 排队前注入（同 PromptToggle）。前端会把这一行控件从界面上摘掉。


def _mask_array(mask_json, n):
    """把 mask JSON 解析成 0/1 数组；长度对不上或坏值返回 None（= 视为全开）。"""
    try:
        arr = json.loads(mask_json) if mask_json else None
    except (ValueError, TypeError):
        return None
    if not isinstance(arr, list) or len(arr) != n:
        return None
    return [1 if x else 0 for x in arr]


class TextGateSplit:
    """TextGateSplit：闸门放上游进来，再按标点炸成片段逐段开关。

    闸门的开关判据是「你动没动过手」，不是「框里有没有字」：
      * 没动过手（没改字、没关词、没手动锁） -> 每次全局 queue 都把新上游放进来
      * 动过手 -> 拦下上游，只输出框内（前端负责把这个判断注入 adopt）
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "text": ("STRING", {
                    "default": "",
                    "multiline": True,
                    "tooltip": "框内文字：空着=放上游进来；没动过手=下次执行自动换新上游；动过手=只输出这里的内容",
                }),
                "join_mode": (["comma", "original"], {
                    "default": "comma",
                    "tooltip": "comma=关掉片段后用 ', ' 重拼（冒号段两侧用空格）；original=保留原本的标点",
                }),
            },
            "optional": {
                "source": ("STRING", {
                    "forceInput": True,
                    "tooltip": "上游文本：框空或没动过手时，执行会把上游整段放进来；动过手则被拦下并报警",
                }),
                "mask": ("STRING", {
                    "default": "",
                    "tooltip": "片段开关状态（0/1 的 JSON 数组），由节点界面自动注入，不用手填",
                }),
                "adopt": ("STRING", {
                    "forceInput": True,
                    "tooltip": "由节点界面注入：1 = 上次流入后没动过手，这次让新上游直接进来",
                }),
                "reservoir": ("STRING", {
                    "forceInput": True,
                    "tooltip": "蓄水模式开关 + 已吸收账本（界面注入的 JSON），不用手填",
                }),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("text",)
    FUNCTION = "run"
    CATEGORY = "String-Mixer"
    OUTPUT_NODE = True

    def run(self, text, join_mode, mask="", source=None, adopt="", reservoir=""):
        linked, parts = snapshot_source(source)
        raw = "\n\n".join(parts)
        body = str(text)
        segs = split_prompt_segments(body)
        arr = _mask_array(mask, len(segs))

        # 蓄水：永不拦、不看动没动手，只把账本里没有的段接到框内文本末尾。
        # 手动点按钮和正常排队走同一条路（没有"强制再蓄"那一档，避免误解）。
        on, seen = parse_reservoir(reservoir)
        if on:
            out, fresh, new_keys, chunk = absorb_upstream(body, raw, seen)
            return {
                "ui": {
                    "ts_source": [raw],
                    "ts_count": [len(parts)],
                    "ts_linked": [1 if linked else 0],
                    "ts_used": [0],
                    "ts_blocked": [0],
                    "tgs_total": [len(segs)],
                    "tgs_kept": [len(segs) if arr is None else sum(arr)],
                    "tgs_all_off": [0],
                    "tgs_adopted": [0],
                    "rsv_on": [1],
                    "rsv_n": [len(fresh)],
                    "rsv_fresh": [", ".join(fresh)],
                    "rsv_chunk": [chunk],
                    "rsv_keys": [json.dumps(new_keys, ensure_ascii=False)],
                },
                "result": (out,),
            }

        # adopt=1：上次流入之后用户没动过手。上游给的新词就是他要的，直接放行，
        # 本次输出就是新词（不必跑两遍）。框空时本来就走这条路。
        adopt_on = adopt == "1" and linked and bool(raw.strip()) and bool(body.strip())

        all_off = 1 if (segs and arr is not None and not any(arr)) else 0
        blocked = 0
        adopted = 0
        if not body.strip() or adopt_on:
            # 闸门开着：上游原样通过（不炸、不重拼）
            out = raw
            used = 1 if linked else 0
            adopted = 1 if adopt_on else 0
            all_off = 0
        else:
            used = 0
            if arr is None or all(arr) or not segs:
                out = body  # 全开：原样，不静默改标点
            else:
                out = apply_toggle(body, mask, join_mode)
            blocked = 1 if (linked and raw.strip() and body.strip() != raw.strip()) else 0

        return {
            "ui": {
                "ts_source": [raw],
                "ts_count": [len(parts)],
                "ts_linked": [1 if linked else 0],
                "ts_used": [used],
                "ts_blocked": [blocked],
                "tgs_total": [len(segs)],
                "tgs_kept": [len(segs) if arr is None else sum(arr)],
                "tgs_all_off": [all_off],
                "tgs_adopted": [adopted],
            },
            "result": (out,),
        }
