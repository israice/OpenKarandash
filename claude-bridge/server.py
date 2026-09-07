"""OpenAI-compatible HTTP front end for the Claude bridge.

Built on the standard library so the bridge runs with a bare `python3` on the
host — no venv, no pip install, nothing to keep in sync with the container.
ThreadingHTTPServer gives one thread per request, which is what multi-session
use needs since each turn is a blocking subprocess.
"""

from __future__ import annotations

import json
import logging
import pathlib
import threading
import time
import urllib.error
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import cli_backend
from config import DEFAULT_MODEL_MAP, BridgeConfig

WEB_DIR = pathlib.Path(__file__).with_name("web")
LOOPBACK = ("127.0.0.1", "::1", "localhost")

logger = logging.getLogger("claude_bridge.server")

CFG = BridgeConfig()

# The ACP backend owns a long-lived subprocess and a session pool, so exactly
# one instance is shared by every request; the CLI backend is stateless and is
# called as a module.
_ACP: "acp_backend.AcpBackend | None" = None
_ACP_LOCK = threading.Lock()


def _backend():
    """Return an object exposing run_turn/stream_turn for the configured backend."""
    if CFG.backend != "acp":
        return cli_backend_adapter
    global _ACP
    with _ACP_LOCK:
        if _ACP is None:
            import acp_backend
            _ACP = acp_backend.AcpBackend(CFG)
    return _ACP


class cli_backend_adapter:
    """Bind CFG into the stateless CLI backend so both share one call shape."""

    @staticmethod
    def run_turn(messages, model, tools=None, tool_choice=None):
        return cli_backend.run_turn(CFG, messages, model, tools, tool_choice)

    @staticmethod
    def stream_turn(messages, model, tools=None, tool_choice=None):
        return cli_backend.stream_turn(CFG, messages, model, tools, tool_choice)


# Claude's published context window and output cap for the Sonnet tier the
# bridge fronts. Reported through the Ollama-style /api/show probe Hermes runs
# against local endpoints, so it learns the real window instead of guessing a
# small default — and learns that tools and images are supported.
CONTEXT_WINDOW = 200_000
MAX_OUTPUT_TOKENS = 64_000


def _model_card() -> dict:
    return {
        "capabilities": ["completion", "tools", "vision"],
        "model_info": {
            "general.architecture": "claude",
            "claude.context_length": CONTEXT_WINDOW,
        },
        "parameters": f"num_ctx {CONTEXT_WINDOW}",
        "details": {"family": "claude", "parameter_size": "n/a"},
    }


def _finish_reason(result: cli_backend.BridgeResult) -> str:
    if result.tool_calls:
        return "tool_calls"
    return "stop" if result.stop_reason in ("end_turn", "tool_use") else "length"


def _completion_envelope(result: cli_backend.BridgeResult, model: str) -> dict:
    message: dict = {"role": "assistant", "content": result.text or None}
    if result.tool_calls:
        message["tool_calls"] = result.tool_calls
    return {
        "id": f"chatcmpl-{uuid.uuid4().hex[:24]}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": model,
        "choices": [{"index": 0, "message": message, "finish_reason": _finish_reason(result)}],
        "usage": {
            "prompt_tokens": result.input_tokens,
            "completion_tokens": result.output_tokens,
            "total_tokens": result.input_tokens + result.output_tokens,
        },
        # Non-standard but harmless, and it makes CLI-side debugging possible.
        "claude_bridge": {
            "session_id": result.session_id,
            "backend": CFG.backend,
            "cache_read_tokens": result.cache_read,
            "cache_write_tokens": result.cache_write,
        },
    }


def _chunk_envelope(cid: str, model: str, created: int, delta: dict, finish: str | None = None) -> dict:
    return {
        "id": cid,
        "object": "chat.completion.chunk",
        "created": created,
        "model": model,
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "claude-bridge/0.1"

    def log_message(self, fmt, *args):  # route access logs through logging
        logger.info("%s - %s", self.address_string(), fmt % args)

    # ── helpers ──────────────────────────────────────────────
    def _send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _error(self, status: int, message: str, kind: str = "invalid_request_error") -> None:
        self._send_json(status, {"error": {"message": message, "type": kind}})

    def _authorized(self) -> bool:
        """Constant work regardless of outcome; empty token means auth is off."""
        if not CFG.auth_token:
            return True
        header = self.headers.get("Authorization", "")
        presented = header[7:] if header.startswith("Bearer ") else self.headers.get("X-Bridge-Token", "")
        return presented == CFG.auth_token

    # ── routes ───────────────────────────────────────────────
    def _serve_console(self) -> None:
        """Serve the bundled chat console.

        The bridge token is injected into the page ONLY for loopback callers:
        anyone on localhost can already read .env, so this leaks nothing, while
        a remote viewer (if the port is ever exposed) gets a tokenless page that
        simply cannot call the API.
        """
        index = WEB_DIR / "index.html"
        if not index.is_file():
            self._error(404, "console not installed")
            return
        token = CFG.auth_token if self.client_address[0] in LOOPBACK else ""
        html = index.read_text(encoding="utf-8").replace(
            "<script src=\"/app.js\">",
            f"<script>window.__BRIDGE_TOKEN__ = {json.dumps(token)};</script>\n<script src=\"/app.js\">",
        )
        body = html.encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _serve_asset(self, name: str, ctype: str) -> None:
        path = WEB_DIR / name
        # Static names are hardcoded by the router, so no traversal is possible.
        if not path.is_file():
            self._error(404, f"{name} not found")
            return
        body = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        route = self.path.split("?")[0].rstrip("/") or "/"
        if route == "/":
            self._serve_console()
            return
        if route == "/app.js":
            self._serve_asset("app.js", "application/javascript; charset=utf-8")
            return
        if route == "/favicon.ico":
            # Browsers request this unauthenticated; answering 401 just fills
            # the log with noise.
            self.send_response(204)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if self.path.rstrip("/") in ("/health", "/v1/health"):
            self._send_json(200, {"status": "ok", "target": CFG.target, "backend": CFG.backend})
            return
        if not self._authorized():
            self._error(401, "missing or invalid bridge token", "authentication_error")
            return
        if self.path.rstrip("/") == "/v1/models":
            now = int(time.time())
            self._send_json(200, {
                "object": "list",
                "data": [
                    {"id": name, "object": "model", "created": now, "owned_by": "claude-bridge"}
                    for name in DEFAULT_MODEL_MAP
                ],
            })
            return
        self._error(404, f"unknown path {self.path}")

    def _proxy_to_agent(self, body: dict) -> None:
        """Relay a chat request to Hermes' API server and stream the reply back.

        The console reaches the Hermes AGENT this way — with its tools, skills
        and memory — instead of the bare model behind /v1/chat/completions.
        Proxying (rather than letting the page call Hermes directly) keeps the
        Hermes API key server-side and the page on a single origin.
        """
        if not CFG.hermes_api_key:
            self._error(503, "HERMES_API_KEY is not configured on the bridge", "configuration_error")
            return

        body.setdefault("model", "hermes-agent")
        payload = json.dumps(body).encode()
        req = urllib.request.Request(
            f"{CFG.hermes_api_url}/chat/completions", data=payload, method="POST",
            headers={"Content-Type": "application/json",
                     "Authorization": f"Bearer {CFG.hermes_api_key}"},
        )
        try:
            upstream = urllib.request.urlopen(req, timeout=CFG.timeout)  # noqa: S310 — loopback Hermes
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode(errors="replace")[:500]
            self._error(exc.code, f"hermes api error: {detail}", "upstream_error")
            return
        except Exception as exc:
            self._error(502, f"hermes api unreachable at {CFG.hermes_api_url}: {exc}", "upstream_error")
            return

        with upstream:
            streaming = bool(body.get("stream"))
            self.send_response(200)
            self.send_header("Content-Type",
                             "text/event-stream" if streaming else "application/json")
            if streaming:
                self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "close")
            self.end_headers()
            for chunk in iter(lambda: upstream.read(4096), b""):
                self.wfile.write(chunk)
                self.wfile.flush()
        self.close_connection = True

    def do_POST(self):
        if not self._authorized():
            self._error(401, "missing or invalid bridge token", "authentication_error")
            return
        route = self.path.split("?")[0].rstrip("/")
        if route == "/api/show":
            self._send_json(200, _model_card())
            return
        if route not in ("/v1/chat/completions", "/agent/v1/chat/completions"):
            self._error(404, f"unknown path {self.path}")
            return

        try:
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, json.JSONDecodeError) as exc:
            self._error(400, f"malformed request body: {exc}")
            return

        if route == "/agent/v1/chat/completions":
            self._proxy_to_agent(body)
            return

        messages = body.get("messages")
        if not isinstance(messages, list) or not messages:
            self._error(400, "'messages' must be a non-empty list")
            return
        requested = body.get("model")
        model = CFG.map_model(requested)
        tools = body.get("tools") if isinstance(body.get("tools"), list) else None
        tool_choice = body.get("tool_choice")

        if body.get("stream"):
            self._stream_completion(messages, model, requested or model, tools, tool_choice)
            return

        try:
            result = _backend().run_turn(messages, model, tools, tool_choice)
        except Exception as exc:
            logger.exception("turn failed")
            self._error(502, f"claude backend failed: {exc}", "upstream_error")
            return

        self._send_json(200, _completion_envelope(result, requested or model))

    def _stream_completion(self, messages: list[dict], model: str, label: str,
                           tools: list[dict] | None = None, tool_choice=None) -> None:
        """Relay CLI deltas as an OpenAI SSE stream.

        Headers go out only after the generator produces its first item, so a
        backend that fails immediately still yields a proper JSON error status
        rather than a 200 with an error buried in the stream.
        """
        cid = f"chatcmpl-{uuid.uuid4().hex[:24]}"
        created = int(time.time())
        started = False

        try:
            for kind, value in _backend().stream_turn(messages, model, tools, tool_choice):
                if not started:
                    self.send_response(200)
                    self.send_header("Content-Type", "text/event-stream")
                    self.send_header("Cache-Control", "no-cache")
                    # HTTP/1.0 with no Content-Length: the END of the stream IS
                    # the socket close, so keep-alive would hang the client.
                    self.send_header("Connection", "close")
                    self.end_headers()
                    started = True
                    self._sse(_chunk_envelope(cid, label, created, {"role": "assistant", "content": ""}))

                if kind == "delta":
                    self._sse(_chunk_envelope(cid, label, created, {"content": value}))
                elif kind == "done":
                    if value.tool_calls:
                        # OpenAI streams tool calls as indexed delta fragments;
                        # sending each complete in one delta is valid and is what
                        # a non-token-level backend can honestly produce.
                        self._sse(_chunk_envelope(cid, label, created, {"tool_calls": [
                            {"index": i, **call} for i, call in enumerate(value.tool_calls)
                        ]}))
                    final = _chunk_envelope(cid, label, created, {}, _finish_reason(value))
                    # stream_options.include_usage is the OpenAI convention;
                    # Hermes reads usage off the terminal chunk for accounting.
                    final["usage"] = {
                        "prompt_tokens": value.input_tokens,
                        "completion_tokens": value.output_tokens,
                        "total_tokens": value.input_tokens + value.output_tokens,
                    }
                    self._sse(final)
        except Exception as exc:
            logger.exception("stream failed")
            if not started:
                self._error(502, f"claude backend failed: {exc}", "upstream_error")
                return
            self._sse({"error": {"message": str(exc), "type": "upstream_error"}})

        if not started:  # generator yielded nothing at all
            self._error(502, "claude backend produced no output", "upstream_error")
            return
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()
        self.close_connection = True

    def _sse(self, payload: dict) -> None:
        self.wfile.write(f"data: {json.dumps(payload)}\n\n".encode())
        self.wfile.flush()


def main() -> None:
    logging.basicConfig(
        level=logging.DEBUG if CFG.debug else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    logger.info(
        "claude-bridge listening on http://%s:%s (backend=%s, target=%s, auth=%s)",
        CFG.host, CFG.port, CFG.backend, CFG.target,
        "on" if CFG.auth_token else "OFF",
    )
    ThreadingHTTPServer((CFG.host, CFG.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
