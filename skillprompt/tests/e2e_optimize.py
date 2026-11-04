"""End-to-end check: run the node's core against a profile from skillprompt.ini.

  python tests/e2e_optimize.py --list                      # show configured profiles
  python tests/e2e_optimize.py --profile "local llama.cpp" --format caption
  python tests/e2e_optimize.py --profile lmstudio --format layout --width 1024 --height 1536
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))  # 仓库根

from skillprompt import config  # noqa: E402
from skillprompt.layout_compiler import SkillPromptLayoutCompiler  # noqa: E402
from skillprompt.optimizer import SkillPromptOptimizer  # noqa: E402

HOSHINO = (
    "backless cheongsam, hoshino (blue archive), blue archive, 1girl, heterochromia, "
    "fang, blue eyes, hair between eyes, yellow eyes, pink hair, very long hair, long hair, "
    "ahoge, low twintails, medium breasts, halo, pink halo, looking at viewer, white cheongsam, "
    "full body, high heel sandals, sandals, toe, white sandals, mini cheongsam, short cheongsam, "
    "no bra, no panties, open field, meadow, on petals and grass, sakura tree, sakura in full bloom, "
    "falling petals, (hanafubuki:1.2), blue sky, dappled sunlight, spring vibes, cloud,"
)

POSTER = "咖啡海报：上方大标题「星海咖啡」，左边一个红杯子，右边一个蓝礼盒，奶油色背景。"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--list", action="store_true", help="print configured profiles and exit")
    ap.add_argument("--profile", default=None, help="display name from skillprompt.ini")
    ap.add_argument("--skill", default=None, help="skill folder name under skills/")
    ap.add_argument("--format", default="caption", choices=["auto", "caption", "tag", "layout"])
    ap.add_argument("--language", default="English", choices=["English", "中文", "Bilingual"])
    ap.add_argument("--prompt", default=None)
    ap.add_argument("--prompt-preset", default="hoshino", choices=["hoshino", "poster"])
    ap.add_argument("--timeout", type=int, default=900)
    ap.add_argument("--max-tokens", type=int, default=2048)
    ap.add_argument("--width", type=int, default=0, help="0 = auto canvas")
    ap.add_argument("--height", type=int, default=0, help="0 = auto canvas")
    ap.add_argument("--keep-thinking", action="store_true", help="do not disable model thinking")
    ap.add_argument("--keep-loaded", action="store_true", help="do not unload the model after the run")
    args = ap.parse_args()

    if args.list or not args.profile:
        print(f"config: {config.CONFIG_PATH}")
        print("configured profiles:")
        for name in config.choices():
            prof = config.profiles().get(name)
            if prof:
                print(f"  - {name}  ->  {prof['model']}  @  {prof['base_url']}")
            else:
                print(f"  - {name}")
        return 0

    prompt = args.prompt or (POSTER if args.prompt_preset == "poster" else HOSHINO)

    skill = args.skill
    if not skill:
        from nodes.skills import PLACEHOLDER, skill_choices

        available = [s for s in skill_choices() if s != PLACEHOLDER]
        if not available:
            raise SystemExit(
                "skills/ 里没有可用的技能。先建一个 skills/<名称>/SKILL.md（见 skills/README.md），"
                "或用 --skill 指定。"
            )
        skill = available[0]
        print(f"[e2e] using skill: {skill}")

    node = SkillPromptOptimizer()
    text, size_note, width, height = node.optimize(
        prompt=prompt,
        skill=skill,
        llm_model=args.profile,
        width=args.width,
        height=args.height,
        disable_thinking=not args.keep_thinking,
        language=args.language,
        output_format=args.format,
        temperature=0.5,
        top_p=0.9,
        max_tokens=args.max_tokens,
        timeout=args.timeout,
        unload_after_run=not args.keep_loaded,
        extra_instruction="",
    )

    print("\n===== OPTIMIZED PROMPT =====\n")
    print(text)
    print("\n===== SIZE NOTE =====")
    print(size_note or "(none)")

    if args.format == "layout":
        compiler = SkillPromptLayoutCompiler()
        final_json, status = compiler.compile(text, width or 1024, height or 1024)
        print("\n===== COMPILED LAYOUT (one line) =====\n")
        print(final_json)
        print("\n===== STATUS =====\n")
        print(status)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
