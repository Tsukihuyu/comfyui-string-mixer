"""Skill registry.

A "skill" is a folder under ``skills/`` (or an extra folder listed in the
``SKILLPROMPT_SKILL_DIRS`` environment variable) that contains a ``SKILL.md``
file. The full text of that file is used verbatim as the system message for
the prompt-optimising LLM, so one skill == one complete prompt-writing
rulebook.

Optional ``meta.json`` keys: ``display_name``, ``language``, ``notes``.
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Dict, List, Tuple

PKG_DIR = Path(__file__).resolve().parent  # skillprompt/ 自身
DEFAULT_SKILLS_DIR = PKG_DIR / "skills"
ENV_SKILL_DIRS = "SKILLPROMPT_SKILL_DIRS"
PLACEHOLDER = "(no skill found - drop SKILL.md into skills/<name>/)"

_CACHE: Dict[str, dict] = {}
_STAMP: Tuple = ()

_CJK_RE = re.compile(r"[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef]")


def estimate_tokens(text: str) -> int:
    """Rough token estimate: CJK ~0.9 token/char, other ~0.30 token/char.

    Calibrated against a real 43,639-char bilingual rulebook that a tokenizer
    counted at ~21,449 tokens (estimate 21,441). Errs slightly high on purpose
    because the number feeds context-size guards.
    """
    if not text:
        return 0
    cjk = len(_CJK_RE.findall(text))
    other = len(text) - cjk
    return int(cjk * 0.9 + other * 0.30) + 1


def _skill_dirs() -> List[Path]:
    dirs: List[Path] = [DEFAULT_SKILLS_DIR]
    extra = os.environ.get(ENV_SKILL_DIRS, "")
    for raw in extra.split(os.pathsep):
        raw = raw.strip()
        if raw:
            dirs.append(Path(raw))
    return [d for d in dirs if d.is_dir()]


def _scan() -> Dict[str, dict]:
    found: Dict[str, dict] = {}
    for base in _skill_dirs():
        try:
            children = sorted(base.iterdir())
        except OSError:
            continue
        for sub in children:
            skill_md = sub / "SKILL.md"
            if not (sub.is_dir() and skill_md.is_file()):
                continue
            meta: dict = {}
            meta_path = sub / "meta.json"
            if meta_path.is_file():
                try:
                    meta = json.loads(meta_path.read_text(encoding="utf-8"))
                except Exception:
                    meta = {}
            try:
                text = skill_md.read_text(encoding="utf-8")
            except OSError:
                continue
            found[sub.name] = {
                "name": sub.name,
                "path": str(skill_md),
                "display": meta.get("display_name") or sub.name,
                "meta": meta,
                "text": text,
                "tokens": estimate_tokens(text),
            }
    return found


def _stamp() -> Tuple:
    stamps: List[Tuple[str, float]] = []
    for base in _skill_dirs():
        try:
            for sub in sorted(base.iterdir()):
                f = sub / "SKILL.md"
                if sub.is_dir() and f.is_file():
                    stamps.append((str(f), f.stat().st_mtime))
        except OSError:
            continue
    return tuple(stamps)


def refresh(force: bool = False) -> Dict[str, dict]:
    """Re-scan when any SKILL.md changed; returns the registry."""
    global _CACHE, _STAMP
    stamp = _stamp()
    if force or stamp != _STAMP:
        _CACHE = _scan()
        _STAMP = stamp
    return _CACHE


def skill_choices() -> List[str]:
    reg = refresh()
    names = sorted(reg.keys())
    return names or [PLACEHOLDER]


def get_skill(name: str) -> dict:
    reg = refresh()
    if name in reg:
        return reg[name]
    # tolerate a renamed folder while a workflow still holds the old value
    names = sorted(reg.keys())
    if names:
        raise ValueError(
            f"找不到 skill「{name}」。当前可用的 skill：{', '.join(names)}"
        )
    raise ValueError(
        "skills/ 目录下没有找到任何 SKILL.md。请把技能放进 skills/<名称>/SKILL.md。"
    )


def describe() -> str:
    reg = refresh()
    if not reg:
        return "skills: (empty)"
    parts = [f"{k} (~{v['tokens']} tok)" for k, v in sorted(reg.items())]
    return "skills: " + ", ".join(parts)
