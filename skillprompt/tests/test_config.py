"""Endpoint-config tests (temp ini files, no network)."""

import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))  # 仓库根

from skillprompt import config  # noqa: E402


class IniCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "skillprompt.ini"
        self._orig = config.CONFIG_PATH
        config.CONFIG_PATH = self.path

    def tearDown(self):
        config.CONFIG_PATH = self._orig
        config._CACHE["stamp"] = None
        config._CACHE["profiles"] = {}
        self.tmp.cleanup()

    def write(self, text: str):
        self.path.write_text(text, encoding="utf-8")
        config._CACHE["stamp"] = None


class TestProfiles(IniCase):
    def test_single_profile(self):
        self.write(
            "[local]\nname = 本地模型\nbase_url = http://127.0.0.1:8080/v1\nmodel = m1\n"
        )
        reg = config.profiles()
        self.assertEqual(list(reg), ["本地模型"])
        p = config.get("本地模型")
        self.assertEqual(p["base_url"], "http://127.0.0.1:8080/v1")
        self.assertEqual(p["model"], "m1")
        self.assertEqual(p["api_key"], "")

    def test_multiple_profiles_are_sorted(self):
        self.write(
            "[b]\nbase_url = http://h:2/v1\nmodel = m2\n"
            "[a]\nbase_url = http://h:1/v1\nmodel = m1\n"
        )
        self.assertEqual(config.choices(), ["a", "b"])

    def test_name_falls_back_to_section(self):
        self.write("[lmstudio]\nbase_url = http://h/v1\nmodel = m\n")
        self.assertEqual(config.choices(), ["lmstudio"])

    def test_api_key_env_wins(self):
        os.environ["SKILLPROMPT_TEST_KEY"] = "from-env"
        try:
            self.write(
                "[c]\nbase_url = http://h/v1\nmodel = m\n"
                f"api_key = literal\napi_key_env = SKILLPROMPT_TEST_KEY\n"
            )
            self.assertEqual(config.get("c")["api_key"], "from-env")
        finally:
            os.environ.pop("SKILLPROMPT_TEST_KEY", None)

    def test_api_key_literal_kept_when_env_missing(self):
        self.write("[c]\nbase_url = http://h/v1\nmodel = m\napi_key = literal\napi_key_env = NOT_SET_XYZ\n")
        self.assertEqual(config.get("c")["api_key"], "literal")

    def test_example_sections_ignored(self):
        self.write("[example-ollama]\nbase_url = http://h/v1\nmodel = m\n")
        self.assertEqual(config.choices(), [config.PLACEHOLDER])

    def test_incomplete_sections_skipped(self):
        self.write("[no-model]\nbase_url = http://h/v1\n[nothing]\n")
        self.assertEqual(config.choices(), [config.PLACEHOLDER])

    def test_missing_file(self):
        self.assertFalse(config.profiles())
        with self.assertRaises(ValueError) as ctx:
            config.get(config.PLACEHOLDER)
        self.assertIn("skillprompt.ini", str(ctx.exception))

    def test_unknown_profile_lists_alternatives(self):
        self.write("[a]\nbase_url = http://h/v1\nmodel = m\n")
        with self.assertRaises(ValueError) as ctx:
            config.get("nope")
        self.assertIn("a", str(ctx.exception))

    def test_reloads_after_edit(self):
        self.write("[a]\nbase_url = http://h1/v1\nmodel = m1\n")
        self.assertEqual(config.get("a")["model"], "m1")
        self.write("[a]\nbase_url = http://h1/v1\nmodel = m2\n")
        self.assertEqual(config.get("a")["model"], "m2")


class TestShippedExample(IniCase):
    def test_example_file_exists_and_parses(self):
        example = Path(__file__).resolve().parents[1] / "skillprompt.ini.example"
        self.assertTrue(example.is_file())
        config.CONFIG_PATH = example
        config._CACHE["stamp"] = None
        # every shipped line is commented out, so nothing should be active
        self.assertEqual(config.choices(), [config.PLACEHOLDER])


if __name__ == "__main__":
    unittest.main(verbosity=2)
