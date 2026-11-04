"""Endpoint profiles read from ``skillprompt.ini``.

The node exposes one ``llm_model`` dropdown built from this file; the URL and the
API key never appear as widgets. Every ``[section]`` is one dropdown entry.

    [local-router]                     ; section name = stable id
    name = local llama.cpp             ; display name (optional, any language)
    base_url = http://127.0.0.1:8080/v1
    model = YOUR-MODEL-NAME
    api_key =                          ; optional for local servers
    api_key_env = DEEPSEEK_API_KEY     ; optional, takes precedence over api_key

Sections whose name starts with ``example`` or that lack ``base_url``/``model``
are ignored, so commented-out notes never reach the dropdown.
Rewrite the file, then restart ComfyUI (the combo is built at load time).
"""

from __future__ import annotations

import configparser
import os
from pathlib import Path
from typing import Dict, List

PKG_DIR = Path(__file__).resolve().parent  # skillprompt/ 自身
CONFIG_PATH = Path(os.environ.get("SKILLPROMPT_CONFIG") or (PKG_DIR / "skillprompt.ini"))
EXAMPLE_PATH = PKG_DIR / "skillprompt.ini.example"
PLACEHOLDER = "(no endpoint configured - edit skillprompt.ini)"

_CACHE: Dict[str, object] = {"stamp": None, "profiles": {}}


def _read_raw() -> Dict[str, dict]:
    if not CONFIG_PATH.is_file():
        return {}
    parser = configparser.ConfigParser(interpolation=None)
    try:
        parser.read(CONFIG_PATH, encoding="utf-8")
    except Exception:
        return {}

    profiles: Dict[str, dict] = {}
    for section in parser.sections():
        if section.lower().startswith("example"):
            continue
        base_url = (parser.get(section, "base_url", fallback="") or "").strip()
        model = (parser.get(section, "model", fallback="") or "").strip()
        if not base_url or not model:
            continue
        api_key = (parser.get(section, "api_key", fallback="") or "").strip()
        env_name = (parser.get(section, "api_key_env", fallback="") or "").strip()
        if env_name:
            api_key = (os.environ.get(env_name) or "").strip() or api_key
        display = (parser.get(section, "name", fallback="") or "").strip() or section
        profiles[display] = {
            "id": section,
            "name": display,
            "base_url": base_url,
            "model": model,
            "api_key": api_key,
        }
    return profiles


def profiles() -> Dict[str, dict]:
    """Reload when the ini changes; cheap enough to call on every node build."""
    try:
        stamp = (str(CONFIG_PATH), CONFIG_PATH.stat().st_mtime)
    except OSError:
        stamp = (str(CONFIG_PATH), None)
    if stamp != _CACHE["stamp"]:
        _CACHE["profiles"] = _read_raw()
        _CACHE["stamp"] = stamp
    return _CACHE["profiles"]  # type: ignore[return-value]


def choices() -> List[str]:
    names = sorted(profiles().keys())
    return names or [PLACEHOLDER]


def get(name: str) -> dict:
    """Resolve a dropdown value to ``{base_url, model, api_key, ...}``."""
    reg = profiles()
    if name in reg:
        return reg[name]
    if not reg:
        raise ValueError(
            f"没有可用的端点配置。请编辑 {CONFIG_PATH}"
            + (f"（示例见 {EXAMPLE_PATH}）" if EXAMPLE_PATH.is_file() else "")
            + "：每个 [段] 填 base_url 与 model，重启 ComfyUI 后会在 llm_model 下拉框出现。"
        )
    raise ValueError(
        f"llm_model 里找不到「{name}」。当前可用：{', '.join(sorted(reg))}"
    )


def describe() -> str:
    reg = profiles()
    if not reg:
        return f"endpoints: (none - edit {CONFIG_PATH})"
    parts = [f"{p['name']} -> {p['model']}" for p in reg.values()]
    return "endpoints: " + "; ".join(parts)
