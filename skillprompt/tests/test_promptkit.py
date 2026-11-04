"""Unit tests for the pure-logic layer (no ComfyUI, no network)."""

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))  # 仓库根

from skillprompt.promptkit import compile_layout, find_layout_json, sanitize_output
from skillprompt.skills import estimate_tokens, skill_choices

DRAFT_1024 = {
    "width": 1024,
    "height": 1024,
    "bbox_coord_space": "abs",
    "bbox_format": "xyxy",
    "summary": {"caption": "A Japanese 2D anime illustration. A cafe poster.", "canvas": "single"},
    "items": [
        {"label": "object", "caption": "One red ceramic cup.", "bbox": [100, 320, 440, 760]},
    ],
}


def draft_with(bbox, w=1024, h=1024):
    d = json.loads(json.dumps(DRAFT_1024))
    d["width"], d["height"] = w, h
    d["items"][0]["bbox"] = bbox
    return d


class TestSanitize(unittest.TestCase):
    def test_unwrap_fence(self):
        out = sanitize_output("```text\nA pink-haired girl stands in a meadow.\n```")
        self.assertEqual(out["prompt"], "A pink-haired girl stands in a meadow.")

    def test_strip_label(self):
        out = sanitize_output("English: A girl with a pink halo.")
        self.assertEqual(out["prompt"], "A girl with a pink halo.")

    def test_size_line_extracted(self):
        out = sanitize_output("A poster.\nCANVAS: 1024x1024")
        self.assertEqual(out["prompt"], "A poster.")
        self.assertEqual((out["width"], out["height"]), (1024, 1024))

    def test_chinese_size_line(self):
        out = sanitize_output("咖啡海报。\n画布：1536×1024")
        self.assertEqual(out["prompt"], "咖啡海报。")
        self.assertEqual((out["width"], out["height"]), (1536, 1024))

    def test_content_mentioning_canvas_survives(self):
        text = "A wide canvas: 2048x1152 sea view hangs on the wall."
        out = sanitize_output(text)
        self.assertEqual(out["prompt"], text)
        self.assertEqual(out["width"], 0)

    def test_empty(self):
        out = sanitize_output("   ")
        self.assertEqual(out["prompt"], "")


class TestLayoutCompiler(unittest.TestCase):
    def test_template_example_1024(self):
        """1024x1024, [100,320,440,760] -> [-192,-412,248,-72] (§12.3)."""
        final, status = compile_layout(json.dumps(DRAFT_1024))
        obj = json.loads(final)
        self.assertEqual(obj["items"][0]["bbox"], [-192, -412, 248, -72])
        self.assertEqual(obj["bbox_coord_space"], "abs_centralized")
        self.assertEqual(obj["bbox_format"], "yxyx")
        self.assertNotIn("width", obj)
        self.assertNotIn("height", obj)
        self.assertIn("已编译", status)

    def test_single_line_output(self):
        final, _ = compile_layout(json.dumps(DRAFT_1024))
        self.assertNotIn("\n", final)

    def test_axes_use_own_centres_1536x1024(self):
        """1536x1024: subtract 768 from x and 512 from y (not one shared number)."""
        final, _ = compile_layout(json.dumps(draft_with([100, 320, 440, 760], 1536, 1024)))
        obj = json.loads(final)
        self.assertEqual(obj["items"][0]["bbox"], [-192, -668, 248, -328])

    def test_float_edges_floor_ceil(self):
        final, _ = compile_layout(json.dumps(draft_with([100.4, 320.6, 439.2, 759.9])))
        obj = json.loads(final)
        # floor(100.4)=100, floor(320.6)=320, ceil(439.2)=440, ceil(759.9)=760
        self.assertEqual(obj["items"][0]["bbox"], [-192, -412, 248, -72])

    def test_rejects_non_16_multiple(self):
        with self.assertRaises(ValueError) as ctx:
            compile_layout(json.dumps(draft_with([10, 10, 100, 100], 1000, 1500)))
        self.assertIn("16", str(ctx.exception))

    def test_rejects_out_of_bounds(self):
        with self.assertRaises(ValueError):
            compile_layout(json.dumps(draft_with([0, 0, 2000, 100])))

    def test_rejects_zero_area(self):
        with self.assertRaises(ValueError):
            compile_layout(json.dumps(draft_with([100, 100, 100, 400])))

    def test_rejects_bad_label(self):
        d = json.loads(json.dumps(DRAFT_1024))
        d["items"][0]["label"] = "panel"
        with self.assertRaises(ValueError):
            compile_layout(json.dumps(d))

    def test_text_item_requires_text(self):
        d = json.loads(json.dumps(DRAFT_1024))
        d["items"][0]["label"] = "text"
        with self.assertRaises(ValueError):
            compile_layout(json.dumps(d))

    def test_summary_caption_required(self):
        d = json.loads(json.dumps(DRAFT_1024))
        d["summary"]["caption"] = ""
        with self.assertRaises(ValueError):
            compile_layout(json.dumps(d))

    def test_extra_root_fields_dropped(self):
        d = json.loads(json.dumps(DRAFT_1024))
        d["negative_prompt"] = "bad hands"
        final, status = compile_layout(json.dumps(d))
        self.assertNotIn("negative_prompt", json.loads(final))
        self.assertIn("non标准", status.replace("非", "non"))

    def test_accepts_fenced_json_with_prose(self):
        text = "Here is the layout:\n```json\n" + json.dumps(DRAFT_1024) + "\n```\nCANVAS: 1024x1024"
        final, _ = compile_layout(text)
        self.assertEqual(json.loads(final)["items"][0]["bbox"], [-192, -412, 248, -72])

    def test_final_format_passthrough(self):
        final_in = {
            "summary": {"caption": "test"},
            "items": [{"label": "object", "caption": "cup", "bbox": [-192, -412, 248, -72]}],
            "bbox_coord_space": "abs_centralized",
            "bbox_format": "yxyx",
        }
        final, status = compile_layout(json.dumps(final_in))
        self.assertEqual(json.loads(final)["items"][0]["bbox"], [-192, -412, 248, -72])
        self.assertIn("只做校验", status)

    def test_rejects_bad_final_order(self):
        final_in = {
            "summary": {"caption": "test"},
            # final bbox is [y0, x0, y1, x1]: x0=248 > x1=-412 -> invalid
            "items": [{"label": "object", "caption": "cup", "bbox": [-192, 248, -72, -412]}],
            "bbox_coord_space": "abs_centralized",
            "bbox_format": "yxyx",
        }
        with self.assertRaises(ValueError):
            compile_layout(json.dumps(final_in))

    def test_no_json(self):
        with self.assertRaises(ValueError):
            compile_layout("just a caption, no json here")

    def test_multiple_items_compiled(self):
        d = json.loads(json.dumps(DRAFT_1024))
        d["items"].append({"label": "character", "caption": "a girl", "bbox": [512, 0, 1024, 512]})
        final, _ = compile_layout(json.dumps(d))
        obj = json.loads(final)
        self.assertEqual(len(obj["items"]), 2)
        self.assertEqual(obj["items"][1]["bbox"], [-512, 0, 0, 512])


class TestSkills(unittest.TestCase):
    def test_choices_non_empty(self):
        self.assertTrue(skill_choices())

    def test_estimate_tokens_monotonic(self):
        self.assertLess(estimate_tokens("hello"), estimate_tokens("hello world " * 20))

    def test_find_layout_json_prefers_items(self):
        text = 'text {"a": 1} more {"summary": {}, "items": []}'
        obj = find_layout_json(text)
        self.assertIn("items", obj)


if __name__ == "__main__":
    unittest.main(verbosity=2)
