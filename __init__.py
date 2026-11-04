"""
String Mixer 系列 — ComfyUI 节点

功能：把一个外部 string 输入（可接端口，也可直接在控件里填）与 N 个内部文本框合并输出。
每个内部文本框各有一个独立开关（checkbox）；关掉后该框内容不参与合并。
外部输入端口未连接时视为空，自动跳过。

系列成员（仅内部文本框数量不同，合并规则完全一致）：
  * StringMixer    -> String Mixer (3-box)   3 个框
  * StringMixer5   -> String Mixer (5-box)   5 个框
  * StringMixer7   -> String Mixer (7-box)   7 个框
3 框版类名保持 StringMixer，确保已存工作流继续兼容。

注：input_string 在 Python 侧是普通 STRING 输入。现代 ComfyUI 前端里「控件」与
「端口」是共存的（每个控件旁自带连接点），不需要 JS 转换；只有很旧的前端才会
只剩文本框、无法连线。

合并规则（系列通用）：
  * 段顺序固定为：外部输入 -> Box 1 -> ... -> Box N。
  * 一段只有在「开启 且 非空」时才参与合并（纯空格视为空，一律跳过）。
  * 参与合并的段会先去掉首尾空白，再用「连接符」连接。
  * 若没有任何段满足条件，输出为空字符串。

连接符（separator）：
  * 单行 STRING，默认一个空格。
  * 支持把字面的 \\n / \\t 解码为真实换行 / Tab，方便做换行分隔。

PromptSanitizer -> Prompt Sanitizer（纯清洗节点，无内部文本框，仅 string 输入端口）：
  三段固定管线：权重清洗 -> 去重 -> 格式化，三个功能各自独立开关。
  * 权重清洗（clean_weights）：
      - normalize：统一语法为 (词:w)；嵌套括号按 SD 隐式权重 (x)=1.0 / ((x))=1.1 / (((x)))=1.21，
        [词] = 0.9，裸词:1.5（要求小数点，避免误伤 "3:4"）；
        钳位到 [min_weight, max_weight]，保留两位小数，w==1.0 时输出裸词。
      - strip_all：剥掉全部权重标记，只留词。
  * 去重（dedupe）：忽略大小写，以「去掉权重后的词身」为键，cat 与 cat:1.0 视为同一词；
    保留首次出现（提示词前段权重高）。
  * 格式化（format）：下划线变空格、连续空白压缩。
    注意：逗号统一以 ", " 连接是管线本身的拼接动作，恒生效；
    format 开关只控制下划线/空白这两项字符级清理。
  * 受保护块：开 `<|name|>` + 对应闭 `<|/name|>`（或 `</name|>`）整体保留——
    块内内容照常走清洗/去重/格式化（去重不跨块边界），开闭 token 与块内内容
    之间不插逗号（保住 "<|style|> 内容 <|/style|>" 语法）；
    未配对的独立受保护 token 原样保留、不参与去重（出现几次留几次）。
  * 保序：输出中幸存词/ token 的相对顺序恒等于原顺序。

PromptFileLoader -> Prompt File Loader（从指定目录读一个 .txt，作为 string 输出）：
  * 目录（directory）：留空 = ComfyUI/input/prompts；相对路径相对 ComfyUI 根；也可填绝对路径。
  * 文件（file）：下拉列表 = 该目录下所有 .txt，最前面一项「（不读取文件）」。
    改完目录点节点上的「刷新文件列表」按钮重扫（JS 向后端要一次列表）。
  * 每次执行时现读文件：改完 txt 直接重跑，不用重启 ComfyUI。
  * 输出保留文件内部换行，只去掉末尾空白。
  * 不读取 / 文件不存在 / 越界路径 -> 输出空串（不抛错，方便批量跑）。
  * 编码依次尝试 utf-8-sig -> gbk -> latin-1。
  * 悬停预览：鼠标停在 file 控件或下拉列表中的某一项上，显示同目录同主文件名的
    jpg/jpeg/png/webp 缩略图（最长边 320px，后端用 PIL 缓存）；没有同名图就不显示。

PromptToggle -> Prompt Toggle（编辑框 + 按标点拆出的可点片段）：
  * 拆分：中英文逗号、句号、分号、换行；括号内与 <|...|> 块整块不拆；刻意不切冒号。
  * 片段开关存在节点属性里（前端写 properties，随工作流保存），排队时由前端注入 mask 输入；
    节点界面上没有 mask 控件，mask 是可选输入（API 调用不传 = 全开）。
  * join_mode：comma=用 ", " 拼接；original=保留原来的标点。
  * upstream（拼接上游）：上游文本整段排在前，本节点结果接在后面，不参与片段开关。
  * 界面：片段排在编辑框下方，点一下切换；节点高度有下限，超出滚动，拖高才铺开。

TextSnapshot -> 文本闸门 ⛩（闸门：框空放上游进来，有字就拦下上游）：
  * 状态由"框里有没有字"表达（无意义空格/换行不算），没有额外开关：
      - 框空 + 接了上游 -> 闸门开着：执行时上游整段流进来，写进框，之后可直接改
      - 框空 + 没接上游 -> 空：没上游也没内容（界面红字直说，不静默）
      - 框里有字       -> 闸门关着：只输出框里的字；上游不同则报警"被拦下"
      - 清空框 / 点 ✕   -> 重新开闸
  * 写控件只发生在两处：①框是空的（没东西可丢）②用户点了「放入上游」并确认过。
    有字时的 queue 绝不写框。
  * 「放入上游」只跑本节点和它的上游（局部执行 + 执行缓存），不跑整条工作流。
  * ui 回报 ts_source / ts_count / ts_linked / ts_used / ts_blocked：
    ts_used=1 表示本次输出取自上游，ts_blocked=1 表示上游有内容但和框里不一样、被拦下了。

TextGateSplit -> 闸门炸词 ⛩（闸门 + 按标点炸开成可开关片段）：
  * 闸门段与 TextSnapshot 完全一致（框空放上游进来并写进框；有字只输出框内、上游有差异则报警）。
  * 炸词段复用 PromptToggle 的拆分：中英文逗号和句号、分号、换行都算分隔点；
    括号里的 (cat:1.2)、<|...|> 块整块不拆。关掉的片段不进输出。
  * 输出规则：框空 -> 上游原样；片段全开 -> 框内原样（都不重拼标点）；
    有关掉的片段 -> 按 join_mode 重拼（comma/original）；片段全关 -> 空串 + 界面红字报警。
  * 开关状态存在节点 properties（tgs_mask），排队时由前端注入 mask 输入，界面上没有那一行控件。
  * 开关按文字内容接续：改字或上游流入后，同一段词保持原来的开关状态（与 PromptToggle 一致）。

CameraMixer -> Camera Mixer（可视化相机，输出相机提示词）：
  * 一个节点管全部：方位 / 俯仰 / 距离 / 焦距 / 光圈 / 倾斜，没有副节点。
  * 交互：节点画布上画一张俯视盘（方位+距离）和一张侧视剖面（俯仰），拖点即改。
  * 权重按 Anima 定标：满强度只到 1.4（Qwen 文本编码器超过这个数会崩）；
    不需要权重就切「关闭权重」，只出裸词。
  * 各档文案与开关存在 _cfg 这个隐藏 JSON 控件里，节点面板里改。
  * 前端不实现算法：画图与预览文本都来自 /camera_mixer/preview 的返回值，
    跟节点的 build() 是同一个 camera_build()，界面显示不会和真输出漂移。
"""

# ---------------------------------------------------------------------------
# 插件入口：这里只做「汇总注册」；节点实现分别在
#   nodes/        纯文本 / 相机类节点（mixer 家族，不联网）
#   skillprompt/  LLM 写词 + 布局编译（子包，自带 endpoint 配置与规则书）
# ---------------------------------------------------------------------------
from .nodes import NODE_CLASS_MAPPINGS as _MIXER_CLASSES
from .nodes import NODE_DISPLAY_NAME_MAPPINGS as _MIXER_NAMES

NODE_CLASS_MAPPINGS = dict(_MIXER_CLASSES)
NODE_DISPLAY_NAME_MAPPINGS = dict(_MIXER_NAMES)

try:
    from .skillprompt import NODE_CLASS_MAPPINGS as _SP_CLASSES
    from .skillprompt import NODE_DISPLAY_NAME_MAPPINGS as _SP_NAMES
except Exception as _exc:  # 子包出问题不该拖垮 mixer 家族
    print(f"[string-mixer] SkillPrompt 子包未加载：{_exc!r}")
else:
    NODE_CLASS_MAPPINGS.update(_SP_CLASSES)
    NODE_DISPLAY_NAME_MAPPINGS.update(_SP_NAMES)

# 前端扩展目录：ComfyUI 只在这个属性存在时才加载 web_extensions/ 里的 .js
WEB_DIRECTORY = "./web_extensions"


# ---------------------------------------------------------------------------
# 兼容导出：拆模块之前所有名字都在根 __init__.py 上，脚本和单测按名字取；
# 这里继续透出一份，别让外部脚本集体失效。
# ---------------------------------------------------------------------------
from .nodes.camera import (  # noqa: E402,F401
    CAMERA_F_STOP_CHOICES,
    CAMERA_LENSES,
    CAMERA_WEIGHT_MODES,
    CameraMixer,
    camera_build,
    camera_cfg,
    camera_focal,
)
from .nodes.files import (  # noqa: E402,F401
    NO_FILE,
    PromptFileLoader,
    find_preview_image,
    list_txt_files,
    preview_thumb,
)
from .nodes.gates import TextGateSplit, TextSnapshot  # noqa: E402,F401
from .nodes.mixers import (  # noqa: E402,F401
    PromptSanitizer,
    StringMixer,
    StringMixer5,
    StringMixer7,
    sanitize_prompt,
)
from .nodes.toggle import (  # noqa: E402,F401
    PromptToggle,
    apply_toggle,
    merge_upstream,
    split_prompt_segments,
)
