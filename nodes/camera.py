"""Camera Mixer：可视化相机控制（方位 / 俯仰 / 距离 / 焦距 / 光圈 / 倾斜）。

算法真源是 camera_build()，节点的 build() 和 /camera_mixer/preview 路由都调它，
界面显示和真输出物理上不可能不一致。
"""
import json
import math

from ._runtime import PromptServer, web

# ---------------------------------------------------------------------------
# CameraMixer -> Camera Mixer：可视化相机控制（方位 / 俯仰 / 距离 / 焦距 / 光圈）
# ---------------------------------------------------------------------------
#
# 一个节点的全部状态 = 几个数：方位、俯仰、距离、焦距、光圈、倾斜。
# 前端（web_extensions/camera_mixer.js）只画图、只搬数字；算权重、挑档位、
# 选文案全在下面这几个函数里。节点的 build() 和前端预览路由
# /camera_mixer/preview 调的是同一个 camera_build()，所以「界面上看到的那行」
# 和「真正排队时输出的那行」物理上不可能不一致。
#
# 权重怎么在 Anima 上生效（本机 comfyui 源码验证，不是臆测）：
#   comfy/sd1_clip.py:348  token_weights() 解析 (word:1.4) -> 1.4，裸括号 (word) -> x1.1
#   comfy/text_encoders/anima.py:23  Qwen3 分支的权重被强制改写为 1.0，只有 T5 分支保留
#   comfy/ldm/anima/model.py:198  preprocess_text_embeds() 里 out = out * t5xxl_weights
# 也就是说：权重不是"编码器能吃多少"的硬上限，而是一个逐 token 的乘法因子 ——
# 越大，那个词在注意力里越独占；过大不会崩，只会把画面压成那个词的样子。
# 默认 1.4 是保守值（社区手册的经验区间），不是硬限制；要给老模型或做强度实验，
# 把 weight_mode 切「自定义上限」，最高可到 10（也就是参考仓库那套尺度）。
#
# 档位（文案与开关都在 _cfg 里，节点面板可改、可单独关）：
#   方位 4 向：from front / from right / from behind / from left
#   高度 5 档：directly above+aerial view / high angle+from above / eye level /
#              low angle+from below / directly below
#   景别 6 档：extreme close-up / close-up / medium shot / cowboy shot / full body / wide shot
#   透视 4 档：fisheye / wide angle /（标准镜头不出词）/ telephoto lens
#   景深 4 档：shallow depth of field+bokeh / shallow depth of field /（标准）/ deep depth of field

CAMERA_WEIGHT_MODES = ("保守 (≤1.4)", "自定义上限", "关闭权重 (裸词)")
CAMERA_WM_SAFE, CAMERA_WM_CUSTOM, CAMERA_WM_RAW = CAMERA_WEIGHT_MODES

CAMERA_LENSES = ("14mm", "24mm", "35mm", "50mm", "85mm", "135mm", "200mm")
CAMERA_FSTOP_OFF = "关"
CAMERA_F_STOPS = ("f/1.2", "f/1.4", "f/1.8", "f/2", "f/2.8", "f/4", "f/5.6", "f/8", "f/11", "f/16")
# 节点上那个光圈下拉：第一项是「关」（整段景深不出词）
CAMERA_F_STOP_CHOICES = (CAMERA_FSTOP_OFF,) + CAMERA_F_STOPS

CAMERA_DIR_LABELS = {"front": "正面", "back": "背面", "right": "右侧", "left": "左侧"}
CAMERA_ELEV_LABELS = {"bird": "鸟瞰", "high": "俯视", "eye": "平视", "low": "仰视", "worm": "虫瞰"}
CAMERA_DIST_LABELS = {"ecu": "特写", "cu": "近景", "medium": "中景",
                      "cowboy": "牛仔", "full": "全身", "wide": "远景"}

# 景别档的 5 条界线（与 CAMERA_DISTANCE_KEYS 一一对应：值 > 界线 就落在该档）
CAMERA_DISTANCE_GEARS = (0.7, 0.2, 0.0, -0.35, -0.7)
CAMERA_DISTANCE_KEYS = ("ecu", "cu", "medium", "cowboy", "full", "wide")

CAMERA_DEFAULTS = {
    "tags": {
        "azimuth": {
            "enabled": True,
            "directions": {
                # 统一按"相机在哪一侧"出词：右侧 -> from right，左侧 -> from left
                "front": {"tag": "from front", "enabled": True},
                "right": {"tag": "from right", "enabled": True},
                "back": {"tag": "from behind", "enabled": True},
                "left": {"tag": "from left", "enabled": True},
            },
        },
        "elevation": {
            "enabled": True,
            "tiers": {
                "bird": {"tag": "directly above, aerial view", "enabled": True},
                "high": {"tag": "high angle, from above", "enabled": True},
                "eye": {"tag": "eye level", "enabled": True},
                "low": {"tag": "low angle, from below", "enabled": True},
                "worm": {"tag": "directly below", "enabled": True},
            },
        },
        "distance": {
            "enabled": True,
            "tiers": {
                "ecu": {"tag": "extreme close-up", "enabled": True},
                "cu": {"tag": "close-up", "enabled": True},
                "medium": {"tag": "medium shot", "enabled": True},
                "cowboy": {"tag": "cowboy shot", "enabled": True},
                "full": {"tag": "full body", "enabled": True},
                "wide": {"tag": "wide shot", "enabled": True},
            },
        },
        "fov": {
            "enabled": True,
            # max_mm = 该档的焦距上限；strength = 该档词打满时的强度比例
            "bands": {
                "fisheye": {"tag": "fisheye", "max_mm": 20, "enabled": True, "strength": 1.0},
                "wide": {"tag": "wide angle", "max_mm": 35, "enabled": True, "strength": 0.7},
                "normal": {"tag": "", "max_mm": 70, "enabled": True, "strength": 0.0},
                "tele": {"tag": "telephoto lens", "max_mm": 100000, "enabled": True, "strength": 0.7},
            },
        },
        "dof": {
            "enabled": True,
            # max_f = 该档的光圈上限（f 数越小光圈越大），升序挑档
            "bands": {
                "shallow": {"tag": "shallow depth of field, bokeh", "max_f": 2.0,
                            "enabled": True, "strength": 1.0},
                "mild": {"tag": "shallow depth of field", "max_f": 4.0,
                         "enabled": True, "strength": 0.6},
                "neutral": {"tag": "", "max_f": 8.0, "enabled": True, "strength": 0.0},
                "deep": {"tag": "deep depth of field", "max_f": 1000, "enabled": True,
                         "strength": 0.6},
            },
        },
        "tilt": {"tag": "dutch angle", "enabled": True, "deadzone": 0.15},
    },
    "weight_strength": 1.0,
    "azimuth_in_pole": False,
    "pole": 0.85,
    # 是否把「原始数值」也当词输出（如 85mm lens / f/1.4）
    "out_focal": False,
    "out_fstop": False,
}


def camera_cfg(raw):
    """把 _cfg 这个 JSON 字符串叠到默认配置上；坏 JSON 一律当空配置，绝不抛错。"""
    cfg = json.loads(json.dumps(CAMERA_DEFAULTS))
    if raw:
        try:
            got = json.loads(raw)
        except (TypeError, ValueError):
            got = None
        if isinstance(got, dict):
            _camera_merge(cfg, got)
    return cfg


def _camera_merge(base, over):
    for key, val in over.items():
        if isinstance(base.get(key), dict) and isinstance(val, dict):
            _camera_merge(base[key], val)
        else:
            base[key] = val


def camera_focal(lens):
    """焦距档位（"50mm" 这类字符串）-> 数字；只给面板/API 兜底用。"""
    try:
        return float(str(lens).replace("mm", ""))
    except ValueError:
        return 50.0


def _camera_fstop_value(label):
    try:
        return float(str(label).strip().replace("f/", ""))
    except ValueError:
        return 8.0


def _camera_weight(norm, cap):
    """0~1 的强度 -> 1.0~cap 的权重。满强度才到上限。"""
    return 1.0 + max(0.0, min(1.0, norm)) * (cap - 1.0)


def _camera_cap(item, global_cap):
    """单个词的上限：只能在全局上限之下再压低，不能反过来突破。
    没填（None / 空串 / 0）就跟随全局。"""
    raw = item.get("cap")
    if raw is None or raw == "" or raw == 0:
        return global_cap
    try:
        return max(1.0, min(global_cap, float(raw)))
    except (TypeError, ValueError):
        return global_cap


def _camera_emit(parts, tag, weight, mode, cap):
    # 一个档位可以是多个词（如 "directly above, aerial view"），逐个上权重
    for piece in str(tag).split(","):
        piece = piece.strip()
        if not piece:
            continue
        if mode == CAMERA_WM_RAW:
            parts.append(piece)
        else:
            parts.append(f"({piece}:{max(1.0, min(cap, weight)):.2f})")


def _camera_emit_bare(parts, tag):
    """原样输出，永不带权重（焦距值 / 光圈值这类"读数"用，加权重反而会污染模型）。"""
    for piece in str(tag).split(","):
        piece = piece.strip()
        if piece:
            parts.append(piece)


# 容差：纯正方向不是数学上的一个点，而是一个小范围，不然"对准"太反人类
CAMERA_AZ_DEAD_DEG = 5.0   # 正前 / 正左 / 正右 / 正后 各 ±5° 内只出那一个方向
CAMERA_AZ_EMIT_MIN = 0.12  # 配比低于这个值的方位词干脆不发（1.03 这种残渣只会跟主方向打架）
CAMERA_EYE_BAND = 0.25     # 平视档半径；再小就不好精细控制


def _camera_azimuth_ratios(az, dead_deg=CAMERA_AZ_DEAD_DEG):
    """方位 -> 四个方向的配比（归一化）。

    正前/正左/正右/正后各有 ±dead_deg 的死区：落在死区里只出那一个方向、满配比。
    否则按 cos/sin 平滑过渡。
    """
    az = max(-1.0, min(1.0, az))
    dead = max(0.0, float(dead_deg)) / 180.0
    if dead > 0.0:
        for center, key in ((0.0, "front"), (0.5, "right"), (-0.5, "left"),
                            (1.0, "back"), (-1.0, "back")):
            if abs(az - center) <= dead:
                out = {"front": 0.0, "back": 0.0, "right": 0.0, "left": 0.0}
                out[key] = 1.0
                return out
    angle = az * math.pi
    ratios = {
        "front": max(0.0, math.cos(angle)),
        "back": max(0.0, -math.cos(angle)),
        "right": max(0.0, math.sin(angle)),
        "left": max(0.0, -math.sin(angle)),
    }
    total = sum(ratios.values())
    if total > 0:
        for key in ratios:
            ratios[key] /= total
    return ratios


def _camera_elevation_key(el, pole, band=CAMERA_EYE_BAND):
    band = max(0.05, min(band, pole))
    if el >= pole:
        return "bird"
    if el > band:
        return "high"
    if el >= -band:
        return "eye"
    if el > -pole:
        return "low"
    return "worm"


def _camera_distance_key(dist):
    # 界线属于「更近」的那一档：dist=0.7 算特写、dist=0 算中景
    for gear, key in zip(CAMERA_DISTANCE_GEARS, CAMERA_DISTANCE_KEYS):
        if dist >= gear:
            return key
    return CAMERA_DISTANCE_KEYS[-1]


def _camera_band(bands, value, limit_key):
    """按上限升序挑档：返回第一条 value <= 上限 的档。"""
    ordered = sorted(bands.items(), key=lambda kv: float(kv[1].get(limit_key, 1e9)))
    for name, band in ordered:
        if value <= float(band.get(limit_key, 1e9)):
            return name, band
    return ordered[-1]


def _camera_readout(az, el, dist, mm, f_stop, ratios, el_key, dist_key):
    az_key = max(ratios, key=lambda k: ratios[k])
    lens_txt = f"{mm:.0f}mm" if mm is not None else "无"
    return (f"方位 {CAMERA_DIR_LABELS.get(az_key, az_key)} {abs(az) * 180:.0f}°"
            f" · 高度 {CAMERA_ELEV_LABELS.get(el_key, el_key)} {abs(el) * 90:.0f}°"
            f" · {CAMERA_DIST_LABELS.get(dist_key, dist_key)}"
            f" · 镜头 {lens_txt} · {f_stop}")


def camera_build(cfg, azimuth=0.0, elevation=0.0, distance=0.0, focal_mm: float | None = 50.0,
                 f_stop="f/8", dutch_enabled=False, roll=0.0, fov_enabled=True,
                 weight_mode=CAMERA_WM_SAFE, weight_cap=1.4):
    """唯一的算法真源。返回 (提示词, 当前状态) —— 状态给前端画图用。

    focal_mm 永远是「画图用的焦距」，fov_enabled 才决定要不要输出透视词。
    """
    tags = cfg["tags"]
    strength = max(0.0, min(1.0, float(cfg.get("weight_strength", 1.0))))
    pole = max(0.3, min(1.0, float(cfg.get("pole", 0.85))))
    band = max(0.05, min(float(cfg.get("eye_band", CAMERA_EYE_BAND)), pole))
    keep_az_in_pole = bool(cfg.get("azimuth_in_pole", False))

    cap = max(1.0, min(10.0, float(weight_cap))) if weight_mode == CAMERA_WM_CUSTOM else 1.4

    az = max(-1.0, min(1.0, float(azimuth)))
    el = max(-1.0, min(1.0, float(elevation)))
    dist = max(-1.0, min(1.0, float(distance)))
    mm = None if focal_mm is None else max(1.0, float(focal_mm))
    # 光圈选「关」时整段景深都不出词
    dof_off = str(f_stop).strip() in ("关", "", "off")
    aperture = 8.0 if dof_off else _camera_fstop_value(f_stop)
    out_focal = bool(cfg.get("out_focal", False))
    out_fstop = bool(cfg.get("out_fstop", False))

    parts = []

    # ---- 方位：按角度分给四个方向；过了极区（|el| > pole）线性衰减到 0 ----
    gate = 1.0
    if abs(el) > pole:
        gate = 1.0 if keep_az_in_pole else max(0.0, (1.0 - abs(el)) / (1.0 - pole))
    ratios = _camera_azimuth_ratios(az, float(cfg.get("az_dead", CAMERA_AZ_DEAD_DEG)))
    az_cfg = tags["azimuth"]
    az_weights = {}
    if az_cfg.get("enabled", True) and gate > 0.0:
        for key, ratio in ratios.items():
            item = az_cfg["directions"].get(key) or {}
            # 残渣不发：正右 90° 时 cos 还会留个 1e-17，
            # 不拦的话会冒出 (from front:1.00) 这种毫无意义的词
            if ratio < CAMERA_AZ_EMIT_MIN or not item.get("enabled", True):
                continue
            if not str(item.get("tag", "")).strip():
                continue
            weight = _camera_weight(ratio * gate * strength, _camera_cap(item, cap))
            _camera_emit(parts, item["tag"], weight, weight_mode, cap)
            az_weights[key] = round(weight, 2)

    # ---- 高度：5 档 ----
    # 权重曲线分两种：
    #   平视(eye)：越接近 0 越确定 -> 权重最高，略抬头/低头就线性衰减到档界
    #   俯视/仰视/鸟瞰/虫瞰：越极端越确定 -> 权重随 |el| 涨
    # 权重应随「离平视越远」递增：正平视最高，仰到顶/俯到底最弱
    el_key = _camera_elevation_key(el, pole, band)
    el_cfg = tags["elevation"]
    if el_cfg.get("enabled", True):
        item = el_cfg["tiers"].get(el_key) or {}
        if item.get("enabled", True) and str(item.get("tag", "")).strip():
            if el_key == "eye":
                norm = max(0.0, 1.0 - abs(el) / band)
            else:
                norm = abs(el)
            _camera_emit(parts, item["tag"],
                         _camera_weight(norm * strength, _camera_cap(item, cap)),
                         weight_mode, cap)

    # ---- 景别：6 档，权重恒为满强度（景别是最硬的构图信号）----
    dist_key = _camera_distance_key(dist)
    dist_cfg = tags["distance"]
    if dist_cfg.get("enabled", True):
        item = dist_cfg["tiers"].get(dist_key) or {}
        if item.get("enabled", True) and str(item.get("tag", "")).strip():
            _camera_emit(parts, item["tag"],
                         _camera_weight(strength, _camera_cap(item, cap)), weight_mode, cap)

    # ---- 透视：按焦距挑档；开关关掉就只算不用 ----
    fov_cfg = tags["fov"]
    if mm is None:
        fov_key = "none"
    else:
        fov_key, fov_band = _camera_band(fov_cfg["bands"], mm, "max_mm")
        if fov_enabled and fov_cfg.get("enabled", True):
            if fov_band.get("enabled", True) and str(fov_band.get("tag", "")).strip():
                _camera_emit(parts, fov_band["tag"],
                             _camera_weight(float(fov_band.get("strength", 0.0)) * strength,
                                            _camera_cap(fov_band, cap)),
                             weight_mode, cap)
            if out_focal:
                _camera_emit_bare(parts, f"{mm:.0f}mm lens")

    # ---- 景深：光圈挑档（f 数越小，景深越浅）；选「关」就整段不出 ----
    dof_cfg = tags["dof"]
    dof_key, dof_band = _camera_band(dof_cfg["bands"], aperture, "max_f")
    if not dof_off and dof_cfg.get("enabled", True):
        if dof_band.get("enabled", True) and str(dof_band.get("tag", "")).strip():
            _camera_emit(parts, dof_band["tag"],
                         _camera_weight(float(dof_band.get("strength", 0.0)) * strength,
                                        _camera_cap(dof_band, cap)),
                         weight_mode, cap)
        if out_fstop:
            _camera_emit_bare(parts, str(f_stop).strip())

    # ---- 倾斜：独立开关，过死区才出词 ----
    tilt_cfg = tags["tilt"]
    deadzone = max(0.0, min(0.9, float(tilt_cfg.get("deadzone", 0.15))))
    if tilt_cfg.get("enabled", True) and dutch_enabled:
        # 开关打开就一定出词：滚轮没动时给个基础强度，不然看着像开关失效
        norm = max(0.35, min(1.0, (float(roll) - deadzone) / (1.0 - deadzone)))
        _camera_emit(parts, tilt_cfg.get("tag", "dutch angle"),
                     _camera_weight(norm * strength, _camera_cap(tilt_cfg, cap)),
                     weight_mode, cap)

    info = {
        "azimuth_key": max(ratios, key=lambda k: ratios[k]),
        "azimuth_weights": az_weights,
        "elevation_key": el_key,
        "distance_key": dist_key,
        "fov_key": fov_key,
        "dof_key": dof_key,
        "azimuth_gate": round(gate, 3),
        "pole": pole,
        "eye_band": band,
        "az_dead_deg": float(cfg.get("az_dead", CAMERA_AZ_DEAD_DEG)),
        "cap": cap,
        "distance_gears": list(CAMERA_DISTANCE_GEARS),
        "elevation_edges": [band, -band],
        "weight_mode": weight_mode,
        "focal_mm": mm,
        "f_stop_value": aperture,
        "readout": _camera_readout(az, el, dist, mm, f_stop, ratios, el_key, dist_key),
    }
    return ", ".join(parts), info


class CameraMixer:
    """可视化相机：拖出方位/俯仰/距离，选镜头和光圈，输出一串带权重的相机提示词。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "lens_on": ("BOOLEAN", {"default": True,
                                        "tooltip": "透视提示词总开关：关掉就不输出 wide angle / telephoto 这类词"
                                                   "（选哪个焦段在节点面板「透视」里）"}),
                "f_stop": (list(CAMERA_F_STOP_CHOICES), {
                    "default": "f/8",
                    "tooltip": "光圈：f 数越小景深越浅；选「关」则整段景深不出词",
                }),
                "dutch_enabled": ("BOOLEAN", {"default": False,
                                              "tooltip": "倾斜（dutch angle）总开关"}),
                "roll": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 1.0, "step": 0.05,
                                   "tooltip": "倾斜强度；过死区（默认 0.15）才输出 dutch angle"}),
            },
            "optional": {
                "pos_azimuth": ("FLOAT", {"default": 0.0, "min": -1.0, "max": 1.0, "step": 0.01,
                                          "tooltip": "方位：0=正面，±0.5=左右 90°，±1=背面（图上拖紫点）"}),
                "pos_elevation": ("FLOAT", {"default": 0.0, "min": -1.0, "max": 1.0, "step": 0.01,
                                            "tooltip": "高度：>0 俯视，<0 仰视，±1 为鸟瞰 / 虫瞰（拖青点）"}),
                "pos_distance": ("FLOAT", {"default": 0.0, "min": -1.0, "max": 1.0, "step": 0.01,
                                           "tooltip": "距离：>0 近，<0 远；落在 6 档景别上（拖紫点的远近）"}),
                "focal_mm": ("FLOAT", {"default": 50.0, "min": 8.0, "max": 300.0, "step": 1.0,
                                       "tooltip": "焦距（mm），节点面板「透视」里选；只影响出词和图上扇形"}),
                "weight_mode": (list(CAMERA_WEIGHT_MODES), {
                    "default": CAMERA_WM_SAFE,
                    "tooltip": "节点面板「权重」里设置；这里只给 API 调用用",
                }),
                "weight_cap": ("FLOAT", {"default": 1.4, "min": 1.0, "max": 10.0, "step": 0.05,
                                         "tooltip": "节点面板「权重」里设置；仅「自定义上限」模式生效，最高 10"}),
                "_cfg": ("STRING", {"default": "",
                                    "tooltip": "标签文案与行为开关（JSON），节点面板里改，排队时自动注入"}),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("相机提示词",)
    FUNCTION = "build"
    CATEGORY = "String-Mixer"
    DESCRIPTION = "拖 3D 式 2D 场景摆机位（方位/俯仰/距离）+ 镜头光圈，输出相机提示词"

    def build(self, lens_on, f_stop, dutch_enabled, roll,
              pos_azimuth=0.0, pos_elevation=0.0, pos_distance=0.0,
              focal_mm=50.0,
              weight_mode=CAMERA_WM_SAFE, weight_cap=1.4, _cfg=""):
        text, _info = camera_build(
            camera_cfg(_cfg),
            azimuth=pos_azimuth,
            elevation=pos_elevation,
            distance=pos_distance,
            focal_mm=focal_mm,
            f_stop=f_stop,
            dutch_enabled=dutch_enabled,
            roll=roll,
            fov_enabled=lens_on,
            weight_mode=weight_mode,
            weight_cap=weight_cap,
        )
        return (text,)


def _camera_query_float(query, key, default):
    try:
        return float(query.get(key, default))
    except (TypeError, ValueError):
        return default


if PromptServer is not None:

    @PromptServer.instance.routes.get("/camera_mixer/preview")
    async def _camera_mixer_preview(request):
        """给前端画图用：提示词 + 当前档位 + 叠好的完整配置。

        前端不复制任何算法 —— 画什么、显示什么全部照这里的返回值来。
        """
        query = request.query
        cfg = camera_cfg(query.get("_cfg", ""))
        text, info = camera_build(
            cfg,
            azimuth=_camera_query_float(query, "pos_azimuth", 0.0),
            elevation=_camera_query_float(query, "pos_elevation", 0.0),
            distance=_camera_query_float(query, "pos_distance", 0.0),
            focal_mm=_camera_query_float(query, "focal_mm", 50.0),
            f_stop=query.get("f_stop", "f/8"),
            dutch_enabled=str(query.get("dutch_enabled", "false")).lower() in ("true", "1"),
            roll=_camera_query_float(query, "roll", 0.0),
            fov_enabled=str(query.get("lens_on", "true")).lower() in ("true", "1"),
            weight_mode=query.get("weight_mode", CAMERA_WM_SAFE),
            weight_cap=_camera_query_float(query, "weight_cap", 1.4),
        )
        return web.json_response({  # type: ignore[union-attr]
            "text": text,
            "info": info,
            "cfg": cfg,
            "weight_modes": list(CAMERA_WEIGHT_MODES),
            "lenses": list(CAMERA_LENSES),
            "f_stops": list(CAMERA_F_STOPS),
        })
