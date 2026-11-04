"""Deterministic Layout compiler node.

The LLM designs the layout; this node does the arithmetic the template says
must never be eyeballed: [x0,y0,x1,y1] absolute top-left pixels ->
[y0-H/2, x0-W/2, y1-H/2, x1-W/2] centre-origin yxyx integers, plus a battery
of structural checks.
"""

from __future__ import annotations

from .promptkit import compile_layout

CATEGORY = "String-Mixer/SkillPrompt"


class SkillPromptLayoutCompiler:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "text": ("STRING", {"multiline": True, "default": ""}),
                "width": ("INT", {"default": 1024, "min": 16, "max": 8192, "step": 16}),
                "height": ("INT", {"default": 1024, "min": 16, "max": 8192, "step": 16}),
            }
        }

    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("layout_json", "status")
    FUNCTION = "compile"
    CATEGORY = CATEGORY

    def compile(self, text: str, width: int, height: int):
        final_json, status = compile_layout(text, int(width), int(height))
        print("[SkillPrompt] " + status.replace("\n", " | "))
        return (final_json, status)
