"""Minimal OpenAI-compatible chat client (stdlib only).

Works with llama.cpp server, LM Studio, Ollama (/v1), vLLM, DeepSeek, OpenAI,
SiliconFlow, and anything else that speaks ``/v1/chat/completions``.

Thinking models: ``disable_thinking=True`` sends
``chat_template_kwargs={"enable_thinking": false}``, which vLLM / SGLang /
llama.cpp server / LM Studio understand. If a server rejects the field with
400/422 we retry once with a ``/no_think`` suffix in the prompt instead.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Dict, List, Optional, Tuple


def endpoint_url(base_url: str) -> str:
    url = (base_url or "").strip().rstrip("/")
    if not url:
        raise ValueError(
            "base_url 为空。填一个 OpenAI 兼容端点，例如：\n"
            "  Ollama        http://127.0.0.1:11434/v1\n"
            "  LM Studio     http://127.0.0.1:1234/v1\n"
            "  llama.cpp     http://127.0.0.1:8080/v1\n"
            "  DeepSeek      https://api.deepseek.com/v1"
        )
    if url.endswith("/chat/completions"):
        return url
    if not url.endswith("/v1"):
        url += "/v1"
    return url + "/chat/completions"


def no_think_messages(messages: List[Dict[str, str]]) -> List[Dict[str, str]]:
    """Return a copy with ``/no_think`` appended to the last user message."""
    out = [dict(m) for m in messages]
    for m in reversed(out):
        if m.get("role") == "user":
            if "/no_think" not in str(m.get("content", "")):
                m["content"] = str(m.get("content", "")) + "\n/no_think"
            break
    return out


def build_payload(
    model: str,
    messages: List[Dict[str, str]],
    temperature: float = 0.5,
    top_p: float = 0.9,
    max_tokens: int = 2048,
    disable_thinking: bool = False,
) -> Dict:
    payload: Dict = {
        "model": model.strip(),
        "messages": messages,
        "temperature": float(temperature),
        "top_p": float(top_p),
        "max_tokens": int(max_tokens),
        "stream": False,
    }
    if disable_thinking:
        payload["chat_template_kwargs"] = {"enable_thinking": False}
    return payload


def _post(url: str, payload: Dict, api_key: str, timeout: int) -> str:
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    key = (api_key or "").strip()
    if key:
        headers["Authorization"] = f"Bearer {key}"
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=int(timeout)) as resp:
        return resp.read().decode("utf-8", "replace")


def chat_completion(
    base_url: str,
    api_key: str,
    model: str,
    messages: List[Dict[str, str]],
    temperature: float = 0.5,
    top_p: float = 0.9,
    max_tokens: int = 2048,
    timeout: int = 600,
    disable_thinking: bool = False,
) -> Tuple[str, Optional[Dict]]:
    """POST /chat/completions and return ``(text, usage)``."""
    if not (model or "").strip():
        raise ValueError("model 为空：填服务端实际暴露的模型名（本地端点可以先 curl /v1/models 看一眼）。")

    url = endpoint_url(base_url)
    payload = build_payload(model, messages, temperature, top_p, max_tokens, disable_thinking)

    try:
        body = _post(url, payload, api_key, timeout)
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")
        if "chat_template_kwargs" in payload and e.code in (400, 422):
            print("[SkillPrompt] 服务端不接受 chat_template_kwargs，改用提示词 /no_think 关闭思考。")
            payload.pop("chat_template_kwargs", None)
            payload["messages"] = no_think_messages(messages)
            try:
                body = _post(url, payload, api_key, timeout)
            except urllib.error.HTTPError as e2:
                detail2 = e2.read().decode("utf-8", "replace")
                raise RuntimeError(f"HTTP {e2.code} from {url}\n{detail2[:800]}") from e2
        else:
            raise RuntimeError(f"HTTP {e.code} from {url}\n{detail[:800]}") from e
    except urllib.error.URLError as e:
        raise RuntimeError(
            f"连不上 {url}：{e.reason}\n"
            "检查服务是否已启动、端口是否正确、防火墙是否放行。"
        ) from e
    except TimeoutError as e:
        raise RuntimeError(f"请求超时（{timeout}s）：{url}") from e

    try:
        result = json.loads(body)
    except json.JSONDecodeError:
        raise RuntimeError(f"返回内容不是 JSON：{body[:500]}")

    choices = result.get("choices") or []
    if not choices:
        raise RuntimeError(f"返回里没有 choices：{body[:500]}")

    message = choices[0].get("message") or {}
    text = message.get("content") or ""
    finish = choices[0].get("finish_reason")
    usage = {**(result.get("usage") or {}), "finish_reason": finish}

    if not text.strip():
        reasoning = message.get("reasoning_content") or ""
        if reasoning.strip():
            raise RuntimeError(
                "模型这次只返回了思考内容（content 为空，reasoning_content 有内容）。\n"
                "把 disable_thinking 打开；若已打开，说明端点不认 chat_template_kwargs，"
                "试试把 max_tokens 调大（思考可能把额度吃完了）。"
            )
        raise RuntimeError(f"模型返回空内容（finish_reason={finish}）：{body[:500]}")

    return text, usage
