"""Canvas in/out behaviour — no network, fake backend."""

import os
import sys
import atexit
import shutil
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))  # 仓库根

from skillprompt.optimizer import _build_messages, _check_canvas, _generate  # noqa: E402

# The repo ships no skills, so build a throwaway one for these tests.
_FIXTURE_ROOT = Path(tempfile.mkdtemp(prefix="skillprompt_canvas_"))
atexit.register(shutil.rmtree, _FIXTURE_ROOT, True)  # 跑完自己清掉，别在 Temp 里堆垃圾
(_FIXTURE_ROOT / "test-skill").mkdir(parents=True, exist_ok=True)
(_FIXTURE_ROOT / "test-skill" / "SKILL.md").write_text(
    "# test rulebook\n\nWrite one art-style sentence, then the subject.\n", encoding="utf-8"
)
_existing = os.environ.get("SKILLPROMPT_SKILL_DIRS", "")
os.environ["SKILLPROMPT_SKILL_DIRS"] = os.pathsep.join(
    p for p in (_existing, str(_FIXTURE_ROOT)) if p
)

SKILL = "test-skill"


class FakeSender:
    def __init__(self, reply):
        self.reply = reply
        self.messages = None
        self.est = None

    def __call__(self, messages, est):
        self.messages = messages
        self.est = est
        return self.reply, {"finish_reason": "stop"}


def user_msg(width=0, height=0, fmt="caption"):
    msgs = _build_messages("a girl", "SKILLTEXT", "English", fmt, "", width, height)
    return msgs[1]["content"]


class TestCanvasPrompt(unittest.TestCase):
    def test_auto_has_no_canvas_hint(self):
        self.assertNotIn("画布尺寸", user_msg(0, 0))

    def test_fixed_injects_canvas_into_caption(self):
        msg = user_msg(1024, 1536)
        self.assertIn("1024×1536", msg)
        self.assertIn("已固定", msg)

    def test_layout_fixed_states_bbox_bounds(self):
        msg = user_msg(1536, 1024, fmt="layout")
        self.assertIn("画布固定为 1536x1024", msg)
        self.assertIn("x1<=1536", msg)
        self.assertIn("y1<=1024", msg)
        self.assertIn("CANVAS: 1536x1024", msg)

    def test_layout_auto_uses_placeholder(self):
        msg = user_msg(0, 0, fmt="layout")
        self.assertIn("CANVAS: WxH", msg)


class TestCanvasValidation(unittest.TestCase):
    def test_only_one_side_set(self):
        with self.assertRaises(ValueError):
            _check_canvas(1024, 0, "caption")

    def test_layout_requires_multiple_of_16(self):
        with self.assertRaises(ValueError) as ctx:
            _check_canvas(1000, 1500, "layout")
        self.assertIn("16", str(ctx.exception))

    def test_caption_allows_non_multiple_of_16(self):
        _check_canvas(1000, 1500, "caption")  # must not raise

    def test_too_small(self):
        with self.assertRaises(ValueError):
            _check_canvas(8, 8, "caption")


class TestCanvasRoundTrip(unittest.TestCase):
    def test_fixed_canvas_wins_over_model_claim(self):
        sender = FakeSender("A girl in a meadow.\nCANVAS: 512x512")
        text, size_note, w, h = _generate(
            "a girl", SKILL, "", "English", "caption", 1024, 1536, sender
        )
        self.assertEqual((w, h), (1024, 1536))
        self.assertEqual(size_note, "1024x1536")
        self.assertEqual(text, "A girl in a meadow.")

    def test_fixed_layout_keeps_draft_json(self):
        draft = '{"width":1024,"height":1024,"bbox_coord_space":"abs","bbox_format":"xyxy",' \
                '"summary":{"caption":"x"},"items":[]}'
        sender = FakeSender(draft + "\nCANVAS: 1024x1024")
        text, size_note, w, h = _generate(
            "poster", SKILL, "", "English", "layout", 1024, 1024, sender
        )
        self.assertIn('"items"', text)
        self.assertEqual((w, h), (1024, 1024))

    def test_auto_parses_model_canvas(self):
        sender = FakeSender("A poster.\nCANVAS: 1536x1024")
        text, size_note, w, h = _generate(
            "poster", SKILL, "", "English", "layout", 0, 0, sender
        )
        self.assertEqual((w, h), (1536, 1024))
        self.assertEqual(size_note, "1536x1024")

    def test_auto_without_canvas_line(self):
        sender = FakeSender("A plain caption.")
        _, size_note, w, h = _generate("a girl", SKILL, "", "English", "caption", 0, 0, sender)
        self.assertEqual((w, h), (0, 0))
        self.assertEqual(size_note, "")


if __name__ == "__main__":
    unittest.main(verbosity=2)
