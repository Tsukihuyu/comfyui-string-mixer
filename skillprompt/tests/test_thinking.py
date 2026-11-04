"""Thinking-control tests (no network)."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))  # 仓库根

from skillprompt.http_client import build_payload, no_think_messages  # noqa: E402
from skillprompt.promptkit import sanitize_output  # noqa: E402


class TestThinkingPayload(unittest.TestCase):
    MSGS = [{"role": "system", "content": "S"}, {"role": "user", "content": "U"}]

    def test_off_by_default(self):
        payload = build_payload("m", self.MSGS)
        self.assertNotIn("chat_template_kwargs", payload)

    def test_switch_sends_template_kwargs(self):
        payload = build_payload("m", self.MSGS, disable_thinking=True)
        self.assertEqual(payload["chat_template_kwargs"], {"enable_thinking": False})

    def test_switch_keeps_standard_fields(self):
        payload = build_payload("m", self.MSGS, temperature=0.3, top_p=0.8,
                                max_tokens=512, disable_thinking=True)
        self.assertEqual(payload["model"], "m")
        self.assertEqual(payload["temperature"], 0.3)
        self.assertEqual(payload["top_p"], 0.8)
        self.assertEqual(payload["max_tokens"], 512)
        self.assertFalse(payload["stream"])

    def test_no_think_suffix_appended_to_last_user(self):
        msgs = no_think_messages(self.MSGS)
        self.assertTrue(msgs[-1]["content"].endswith("/no_think"))
        self.assertEqual(msgs[0]["content"], "S")  # system untouched
        self.assertNotIn("/no_think", self.MSGS[-1]["content"])  # input not mutated

    def test_no_think_not_duplicated(self):
        msgs = no_think_messages([{"role": "user", "content": "hi\n/no_think"}])
        self.assertEqual(msgs[-1]["content"].count("/no_think"), 1)


class TestThinkingStripping(unittest.TestCase):
    def test_think_block_removed(self):
        text = "<think>the user wants a cat</think>A fluffy cat sits on a wall."
        out = sanitize_output(text)
        self.assertEqual(out["prompt"], "A fluffy cat sits on a wall.")
        self.assertTrue(any("think" in n for n in out["notes"]))

    def test_thinking_tag_variant(self):
        text = "<thinking>hmm</thinking>A girl with pink hair."
        self.assertEqual(sanitize_output(text)["prompt"], "A girl with pink hair.")

    def test_bare_stray_tags_removed(self):
        text = "A girl. </think>Another line."
        self.assertNotIn("think", sanitize_output(text)["prompt"])

    def test_multiline_think_block(self):
        text = "<think>\nline1\nline2\n</think>Final prompt text."
        self.assertEqual(sanitize_output(text)["prompt"], "Final prompt text.")

    def test_plain_text_untouched(self):
        text = "A girl in a meadow, warm light."
        out = sanitize_output(text)
        self.assertEqual(out["prompt"], text)
        self.assertEqual(out["notes"], [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
