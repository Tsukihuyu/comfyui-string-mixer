"""Prompt File Loader：从目录里读 .txt + 同名缩略图预览。

两条 HTTP 路由（/prompt_file_loader/list、/preview）在这里注册。
"""
import mimetypes
import os

from ._runtime import PromptServer, web

# ---------------------------------------------------------------------------
# PromptFileLoader -> Prompt File Loader
# ---------------------------------------------------------------------------

NO_FILE = "（不读取文件）"  # 下拉列表里“一个文件都不读”的选项，选中即输出空串

# 前后缀：只影响输出，不改文件本身。空格一律照抄模板原文（MOSS 的后缀是前空格）。
AFFIX_MODES = ("无", "MOSS", "Krea2", "自定义")
AFFIX_TEMPLATES = {
    "MOSS": ("<|style|> ", " <|/style|>"),
    "Krea2": ("Style:", "Subject: "),
}


def apply_affix(text, affix="无", prefix="", suffix=""):
    """给正文套前后缀。没有正文就还是空串——别输出一对孤立的标签。"""
    if not text:
        return ""
    if affix == "自定义":
        return f"{prefix or ''}{text}{suffix or ''}"
    pre, suf = AFFIX_TEMPLATES.get(affix, ("", ""))
    return f"{pre}{text}{suf}"

try:
    import folder_paths  # type: ignore  # ComfyUI 运行时才有

    _COMFY_BASE = folder_paths.base_path
except ImportError:  # 不在 ComfyUI 里跑（单测）时退回当前目录
    _COMFY_BASE = os.getcwd()


def resolve_directory(directory):
    """目录解析：空 -> <ComfyUI>/input/prompts；相对路径 -> 相对 ComfyUI 根；绝对路径原样。"""
    d = (directory or "").strip().strip('"').strip("'")
    if not d:
        d = os.path.join("input", "prompts")
    d = os.path.expanduser(d)
    if not os.path.isabs(d):
        d = os.path.join(_COMFY_BASE, d)
    return os.path.abspath(d)


def list_txt_files(directory):
    """列出目录下的 .txt（不含子目录），按名字忽略大小写排序；目录不存在/不可读 -> []。"""
    d = resolve_directory(directory)
    try:
        names = [
            n for n in os.listdir(d)
            if n.lower().endswith(".txt") and os.path.isfile(os.path.join(d, n))
        ]
    except OSError:
        return []
    return sorted(names, key=str.lower)


def resolve_txt_path(directory, filename):
    """把文件名限定到目录内的 .txt：带路径分隔符 / 非 .txt / 越界 / 不存在 -> None。"""
    name = (filename or "").strip()
    if not name or name == NO_FILE:
        return None
    if os.sep in name or "/" in name or "\\" in name:
        return None
    if not name.lower().endswith(".txt"):
        return None
    d = resolve_directory(directory)
    path = os.path.abspath(os.path.join(d, name))
    if os.path.dirname(path) != d or not os.path.isfile(path):
        return None
    return path


def read_text_file(path):
    """按 utf-8-sig -> gbk -> latin-1 依次尝试读取，去掉末尾空白（内部换行原样保留）。"""
    for enc in ("utf-8-sig", "gbk"):
        try:
            with open(path, "r", encoding=enc) as f:
                return f.read().rstrip()
        except UnicodeDecodeError:
            continue
    with open(path, "r", encoding="latin-1") as f:
        return f.read().rstrip()


PREVIEW_EXTS = (".jpg", ".jpeg", ".png", ".webp")  # 同名缩略图的候选扩展名（按优先级）
THUMB_MAX = 320  # 缩略图最长边
_THUMB_CACHE = {}  # 路径 -> (mtime, size, bytes, mime)
_THUMB_CACHE_MAX = 128


def find_preview_image(directory, filename):
    """找同目录同主文件名的图片（jpg/jpeg/png/webp，扩展名大小写不敏感）；没有 -> None。"""
    name = (filename or "").strip()
    if not name or name == NO_FILE:
        return None
    if os.sep in name or "/" in name or "\\" in name:
        return None
    stem, ext = os.path.splitext(name)
    if not stem or ext.lower() != ".txt":
        return None
    d = resolve_directory(directory)
    try:
        by_lower = {e.lower(): e for e in os.listdir(d)}
    except OSError:
        return None
    for cand in PREVIEW_EXTS:
        real = by_lower.get((stem + cand).lower())
        if real:
            path = os.path.join(d, real)
            if os.path.isfile(path):
                return path
    return None


def preview_thumb(path, max_side=THUMB_MAX):
    """生成（并缓存）缩略图，返回 (bytes, mime)；文件读不到 -> None。

    PIL 不可用时退回原图字节，前端仍能显示，只是没缩小。
    """
    try:
        st = os.stat(path)
    except OSError:
        return None

    hit = _THUMB_CACHE.get(path)
    if hit and hit[0] == st.st_mtime and hit[1] == st.st_size:
        return hit[2], hit[3]

    with open(path, "rb") as f:
        raw = f.read()
    mime = mimetypes.guess_type(path)[0] or "image/jpeg"
    data = raw
    try:
        import io

        from PIL import Image

        im = Image.open(io.BytesIO(raw))
        im.thumbnail((max_side, max_side))
        buf = io.BytesIO()
        if im.mode in ("RGBA", "LA", "P"):
            im.convert("RGBA").save(buf, format="PNG")
            mime = "image/png"
        else:
            im.convert("RGB").save(buf, format="JPEG", quality=88)
            mime = "image/jpeg"
        data = buf.getvalue()
    except Exception:  # 没装 PIL / 图坏了：原样返回
        pass

    if len(_THUMB_CACHE) >= _THUMB_CACHE_MAX:
        _THUMB_CACHE.clear()
    _THUMB_CACHE[path] = (st.st_mtime, st.st_size, data, mime)
    return data, mime


class PromptFileLoader:
    """Prompt File Loader：从指定目录读一个 .txt，套上可选的前后缀，作为 string 输出。

    file 选「（不读取文件）」、文件不存在、或是越界/非 .txt 路径，一律输出空串（前后缀也不加）。
    前后缀只影响输出，不改文件内容。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "directory": ("STRING", {
                "default": "",
                "multiline": False,
                "tooltip": "目录：留空=ComfyUI/input/prompts；相对路径相对 ComfyUI 根；也可填绝对路径",
            }),
            "file": ([NO_FILE] + list_txt_files(""), {
                "default": NO_FILE,
                "tooltip": "该目录下的 .txt；选「（不读取文件）」或文件已删除时输出空串。改目录后点刷新按钮",
            }),
            "affix": (list(AFFIX_MODES), {
                "default": "无",
                "tooltip": "前后缀：给文件内容套模板。MOSS=<|style|> … <|/style|>，Krea2=Style:…Subject:；自定义则用下面两个框",
            }),
            "prefix": ("STRING", {
                "default": "",
                "multiline": False,
                "tooltip": "自定义前缀：只在 affix 选「自定义」时生效",
            }),
            "suffix": ("STRING", {
                "default": "",
                "multiline": False,
                "tooltip": "自定义后缀：只在 affix 选「自定义」时生效",
            }),
        }}

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("string",)
    FUNCTION = "load"
    CATEGORY = "String-Mixer"
    OUTPUT_NODE = False

    @classmethod
    def VALIDATE_INPUTS(cls, **kwargs):
        # file 的选项由前端按当前目录动态刷新，必然与 INPUT_TYPES 里扫的「默认目录」列表不一致，
        # 交给 ComfyUI 静态校验会被判 "Value not in list"。这里放行，
        # 真正的路径校验在 resolve_txt_path：必须 .txt、必须在该目录内、必须存在。
        return True

    def load(self, directory, file, affix="无", prefix="", suffix="", **kwargs):
        # **kwargs 兜住前端按钮控件可能被序列化进来的多余键
        path = resolve_txt_path(directory, file)
        if path is None:
            if file and file != NO_FILE:
                print(f"[PromptFileLoader] 读不到 {file!r}"
                      f"（目录 {resolve_directory(directory)}），输出空串")
            return ("",)
        return (apply_affix(read_text_file(path), affix, prefix, suffix),)


if PromptServer is not None:

    @PromptServer.instance.routes.get("/prompt_file_loader/list")
    async def _prompt_file_loader_list(request):
        directory = request.query.get("directory", "")
        return web.json_response({  # type: ignore[union-attr]
            "directory": resolve_directory(directory),
            "files": list_txt_files(directory),
        })

    @PromptServer.instance.routes.get("/prompt_file_loader/preview")
    async def _prompt_file_loader_preview(request):
        """同名 jpg/png 的 320px 缩略图；没有图 -> 404（前端据此不显示）。"""
        path = find_preview_image(request.query.get("directory", ""),
                                  request.query.get("file", ""))
        if path is None:
            return web.Response(status=404)  # type: ignore[union-attr]
        got = preview_thumb(path)
        if got is None:
            return web.Response(status=404)  # type: ignore[union-attr]
        data, mime = got
        return web.Response(body=data, content_type=mime)  # type: ignore[union-attr]
