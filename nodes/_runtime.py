"""ComfyUI 运行时对象（单测环境里为 None）。"""

try:
    from aiohttp import web  # type: ignore
    from server import PromptServer  # type: ignore  # 只有 ComfyUI 运行时才有
except ImportError:  # 单测 / 独立脚本环境
    PromptServer = web = None

__all__ = ["PromptServer", "web"]
