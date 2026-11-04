"""mixer 家族节点：每个功能一个模块，这里汇总注册表。"""

from .camera import CameraMixer
from .files import PromptFileLoader
from .gates import TextGateSplit, TextSnapshot
from .mixers import PromptSanitizer, StringMixer, StringMixer5, StringMixer7
from .toggle import PromptToggle

NODE_CLASS_MAPPINGS = {
    "StringMixer": StringMixer,
    "StringMixer5": StringMixer5,
    "StringMixer7": StringMixer7,
    "PromptSanitizer": PromptSanitizer,
    "PromptFileLoader": PromptFileLoader,
    "PromptToggle": PromptToggle,
    "CameraMixer": CameraMixer,
    "TextSnapshot": TextSnapshot,
    "TextGateSplit": TextGateSplit,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "StringMixer": "🧵 文本混合 3 / Text Mix 3",
    "StringMixer5": "🧵 文本混合 5 / Text Mix 5",
    "StringMixer7": "🧵 文本混合 7 / Text Mix 7",
    "PromptSanitizer": "🧼 提示词净化 / Prompt Cleaner",
    "PromptFileLoader": "📄 提示词文件 / Prompt File",
    "PromptToggle": "💥 提示词炸词 / Prompt Toggle",
    "CameraMixer": "🎥 相机镜头 / Camera Rig",
    "TextSnapshot": "⛩ 文本闸门 / Text Gate",
    "TextGateSplit": "⛩ 闸门炸词 / Text Gate Toggle",
}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
