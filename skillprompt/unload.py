"""Best-effort model unload, so the image model gets its VRAM back.

Prompt writing is followed by image generation on the same GPU in the typical
ComfyUI workflow, so a 20 GB chat model left resident is the difference between
"works" and "CUDA OOM". Every server exposes this differently:

  llama.cpp router       POST {root}/models/unload        {"model": id}
  LM Studio              POST {root}/api/v1/models/unload {"model": id}
  Ollama                 POST {root}/api/generate         {"model": id, "keep_alive": 0}
  vLLM / cloud / others  no unload endpoint -> reported, never fatal

``root`` is ``base_url`` with any trailing ``/v1`` or ``/chat/completions`` removed.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import List, Tuple


def server_root(base_url: str) -> str:
    url = (base_url or "").strip().rstrip("/")
    for suffix in ("/chat/completions", "/v1"):
        if url.endswith(suffix):
            url = url[: -len(suffix)]
    return url.rstrip("/")


def _post(url: str, payload: dict, api_key: str, timeout: int) -> Tuple[int, str]:
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    key = (api_key or "").strip()
    if key:
        headers["Authorization"] = f"Bearer {key}"
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=int(timeout)) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")


def unload_model(base_url: str, api_key: str, model: str,
                 timeout: int = 10) -> Tuple[bool, str]:
    """Try each known unload shape; stop at the first one that works."""
    root = server_root(base_url)
    if not root:
        return False, "base_url 为空，跳过卸载"
    if not (model or "").strip():
        return False, "model 为空，跳过卸载"

    attempts = [
        (f"{root}/models/unload", {"model": model}, "llama.cpp router"),
        (f"{root}/api/v1/models/unload", {"model": model}, "LM Studio"),
        (f"{root}/api/generate", {"model": model, "keep_alive": 0, "stream": False}, "Ollama"),
    ]

    tried: List[str] = []
    for url, payload, label in attempts:
        try:
            code, body = _post(url, payload, api_key, timeout)
        except Exception as e:  # noqa: BLE001 - connection problems must not fail the run
            tried.append(f"{label}: {type(e).__name__}")
            continue
        if code == 404:
            tried.append(f"{label}: 无此端点")
            continue
        if 200 <= code < 300:
            return True, f"{label} 已卸载 {model}"
        lowered = body.lower()
        if code == 400 and "not running" in lowered:
            # llama.cpp: endpoint exists, model simply is not resident right now.
            return True, f"{label}：模型本来就不在显存里（{model}）"
        tried.append(f"{label}: HTTP {code} {body[:120]}")

    return False, "未卸载（" + "; ".join(tried) + "）"
