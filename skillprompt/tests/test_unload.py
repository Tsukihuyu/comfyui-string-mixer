"""Unload helper tests — real HTTP against a local stub server."""

import json
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))  # 仓库根

from skillprompt.unload import server_root, unload_model  # noqa: E402

MODEL = "test-model"


class StubHandler(BaseHTTPRequestHandler):
    # set per test class
    routes = {}

    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length).decode() if length else ""
        spec = self.routes.get(self.path)
        if spec is None:
            self._reply(404, {"error": "not found"})
            return
        self.last_body = body
        code, payload = spec
        self._reply(code, payload)

    def _reply(self, code, payload):
        data = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass


class StubServer:
    def __init__(self, routes):
        handler = type("H", (StubHandler,), {"routes": routes})
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *exc):
        self.httpd.shutdown()
        self.httpd.server_close()

    @property
    def base_url(self):
        return f"http://127.0.0.1:{self.port}/v1"


class TestServerRoot(unittest.TestCase):
    def test_strips_v1(self):
        self.assertEqual(server_root("http://h:1/v1"), "http://h:1")

    def test_strips_trailing_slash(self):
        self.assertEqual(server_root("http://h:1/v1/"), "http://h:1")

    def test_strips_chat_completions(self):
        self.assertEqual(server_root("http://h:1/v1/chat/completions"), "http://h:1")

    def test_keeps_plain_root(self):
        self.assertEqual(server_root("http://h:1"), "http://h:1")

    def test_empty(self):
        self.assertEqual(server_root(""), "")


class TestUnloadLoop(unittest.TestCase):
    def test_llamacpp_router_success(self):
        with StubServer({"/models/unload": (200, {"success": True})}) as s:
            ok, detail = unload_model(s.base_url, "", MODEL)
        self.assertTrue(ok)
        self.assertIn("llama.cpp", detail)

    def test_already_unloaded_is_success(self):
        routes = {"/models/unload": (400, {"error": {"message": "model is not running"}})}
        with StubServer(routes) as s:
            ok, detail = unload_model(s.base_url, "", MODEL)
        self.assertTrue(ok)
        self.assertIn("不在显存", detail)

    def test_falls_back_to_lmstudio(self):
        routes = {"/api/v1/models/unload": (200, {"ok": True})}
        with StubServer(routes) as s:
            ok, detail = unload_model(s.base_url, "", MODEL)
        self.assertTrue(ok)
        self.assertIn("LM Studio", detail)

    def test_falls_back_to_ollama(self):
        routes = {"/api/generate": (200, {"done": True})}
        with StubServer(routes) as s:
            ok, detail = unload_model(s.base_url, "", MODEL)
        self.assertTrue(ok)
        self.assertIn("Ollama", detail)

    def test_nothing_supports_unload(self):
        with StubServer({}) as s:
            ok, detail = unload_model(s.base_url, "", MODEL)
        self.assertFalse(ok)
        self.assertIn("未卸载", detail)

    def test_unreachable_server_does_not_raise(self):
        ok, detail = unload_model("http://127.0.0.1:1/v1", "", MODEL, timeout=2)
        self.assertFalse(ok)
        self.assertIn("未卸载", detail)

    def test_empty_model_is_skipped(self):
        ok, detail = unload_model("http://127.0.0.1:1/v1", "", "")
        self.assertFalse(ok)
        self.assertIn("跳过", detail)


if __name__ == "__main__":
    unittest.main(verbosity=2)
