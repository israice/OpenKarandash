"""ACP backend: drives `claude-agent-acp` as a long-lived JSON-RPC subprocess.

Why this exists alongside the CLI backend: `claude -p` spawns a fresh process
per request, so every turn re-writes the whole prompt cache (~20k cache-write
tokens). ACP keeps a session open, so a follow-up turn re-reads the cache
instead of re-writing it — measured 22.7k cache-write on turn 1 down to 45 on
turn 3, and 4.8s down to 1.7s.

The OpenAI wire is stateless (Hermes re-sends the whole history every time),
so sessions are keyed by the history that produced them: a request whose
messages extend a known session continues it with only the new message.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import queue
import subprocess
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Iterator

import tool_protocol
from cli_backend import BridgeResult, build_turn, split_content
from config import BUILTIN_TOOLS, BridgeConfig

logger = logging.getLogger("claude_bridge.acp")

PROTOCOL_VERSION = 1
_SESSION_IDLE_SECONDS = 1800.0
_MAX_SESSIONS = 32


class AcpError(RuntimeError):
    """An ACP call failed, or the agent process died."""


# ── JSON-RPC transport ───────────────────────────────────────

class AcpProcess:
    """One `claude-agent-acp` subprocess, shared by every session.

    Reading happens on a single background thread: responses are routed to the
    waiting caller by id, and session/update notifications to that session's
    queue. Server->client requests (permission prompts) are answered
    immediately, because Hermes — not the agent — owns tool execution here.
    """

    def __init__(self, cfg: BridgeConfig):
        self._cfg = cfg
        self._lock = threading.Lock()
        self._next_id = 1
        self._pending: dict[int, queue.Queue] = {}
        self._updates: dict[str, queue.Queue] = {}
        self._proc: subprocess.Popen | None = None

    # -- lifecycle --
    def start(self) -> None:
        if self._proc and self._proc.poll() is None:
            return
        binary = self._cfg.resolve_acp_binary()
        env = dict(os.environ)
        if self._cfg.acp_config_dir:
            # Isolated config: keeps the host user's skills, plugins and MCP
            # servers out of the session. Measured 35.7k -> 12.3k prompt tokens.
            env["CLAUDE_CONFIG_DIR"] = self._cfg.acp_config_dir
        logger.info("starting ACP agent: %s (cwd=%s)", binary, self._cfg.cwd)
        self._proc = subprocess.Popen(
            [binary], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL if not self._cfg.debug else None,
            text=True, bufsize=1, cwd=self._cfg.cwd, env=env,
        )
        threading.Thread(target=self._read_loop, daemon=True).start()
        self.request("initialize", {
            "protocolVersion": PROTOCOL_VERSION,
            "clientCapabilities": {"fs": {"readTextFile": False, "writeTextFile": False}},
        })

    def _read_loop(self) -> None:
        proc = self._proc
        assert proc and proc.stdout
        for line in proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            self._dispatch(msg)
        # Process exited: unblock everyone still waiting.
        with self._lock:
            waiters = list(self._pending.values()) + list(self._updates.values())
            self._pending.clear()
        for q in waiters:
            q.put({"__dead__": True})

    def _dispatch(self, msg: dict) -> None:
        mid = msg.get("id")
        method = msg.get("method")

        if method and mid is not None:
            # Server->client request. The only one that matters is a permission
            # prompt; the agent must never act on its own here.
            self._write({"jsonrpc": "2.0", "id": mid,
                         "result": {"outcome": {"outcome": "cancelled"}}})
            return

        if method == "session/update":
            params = msg.get("params") or {}
            sid = params.get("sessionId")
            with self._lock:
                q = self._updates.get(sid)
            if q is not None:
                q.put(params.get("update") or {})
            return

        if mid is not None:
            with self._lock:
                q = self._pending.pop(mid, None)
            if q is not None:
                q.put(msg)

    def _write(self, payload: dict) -> None:
        proc = self._proc
        if not proc or proc.poll() is not None or not proc.stdin:
            raise AcpError("ACP agent is not running")
        with self._lock:
            proc.stdin.write(json.dumps(payload) + "\n")
            proc.stdin.flush()

    # -- calls --
    def request(self, method: str, params: dict, timeout: float | None = None) -> dict:
        self.start() if method != "initialize" else None
        with self._lock:
            mid = self._next_id
            self._next_id += 1
            waiter: queue.Queue = queue.Queue()
            self._pending[mid] = waiter
        self._write({"jsonrpc": "2.0", "id": mid, "method": method, "params": params})
        try:
            msg = waiter.get(timeout=timeout or self._cfg.timeout)
        except queue.Empty:
            with self._lock:
                self._pending.pop(mid, None)
            raise AcpError(f"ACP call {method} timed out")
        if msg.get("__dead__"):
            raise AcpError(f"ACP agent exited during {method}")
        if "error" in msg:
            raise AcpError(f"ACP {method} failed: {json.dumps(msg['error'])[:300]}")
        return msg.get("result") or {}

    # -- session update plumbing --
    def watch(self, session_id: str) -> queue.Queue:
        q: queue.Queue = queue.Queue()
        with self._lock:
            self._updates[session_id] = q
        return q

    def unwatch(self, session_id: str) -> None:
        with self._lock:
            self._updates.pop(session_id, None)


# ── session pool ─────────────────────────────────────────────

def _history_key(messages: list[dict]) -> str:
    """Stable fingerprint of a message list, used to match a live session."""
    payload = json.dumps(messages, sort_keys=True, ensure_ascii=False, default=str)
    return hashlib.sha256(payload.encode()).hexdigest()


@dataclass
class Session:
    session_id: str
    key: str
    created: float = field(default_factory=time.time)
    used: float = field(default_factory=time.time)


class AcpBackend:
    """Session-reusing ACP driver exposing the same surface as cli_backend."""

    def __init__(self, cfg: BridgeConfig):
        self._cfg = cfg
        self._proc = AcpProcess(cfg)
        self._sessions: dict[str, Session] = {}
        self._lock = threading.Lock()

    # -- session selection --
    def _reap(self) -> None:
        cutoff = time.time() - _SESSION_IDLE_SECONDS
        stale = [k for k, s in self._sessions.items() if s.used < cutoff]
        for k in stale:
            self._sessions.pop(k, None)
        while len(self._sessions) > _MAX_SESSIONS:
            oldest = min(self._sessions.items(), key=lambda kv: kv[1].used)[0]
            self._sessions.pop(oldest, None)

    def _new_session(self, system_prompt: str) -> Session:
        """Open an ACP session stripped down to a bare model.

        - ``settingSources: []`` drops the host user's settings, and with them
          their MCP servers (Gmail, Figma, ...) — the agent otherwise inherits
          every tool the operator has configured.
        - ``tools: []`` / ``disallowedTools`` empty the built-in toolbox, whose
          SCHEMAS would otherwise stay in the prompt and convince the model that
          Hermes' tools are imaginary.
        - ``_meta.systemPrompt`` replaces Claude Code's preset preamble, the
          same trick as the CLI backend's --system-prompt.
        """
        result = self._proc.request("session/new", {
            "cwd": self._cfg.cwd,
            "mcpServers": [],
            "_meta": {
                "systemPrompt": system_prompt or "You are a helpful assistant.",
                "claudeCode": {"options": {
                    "settingSources": [],
                    "tools": [],
                    "disallowedTools": list(BUILTIN_TOOLS),
                }},
            },
        })
        sid = result.get("sessionId")
        if not sid:
            raise AcpError("session/new returned no sessionId")
        return Session(session_id=sid, key="")

    def _acquire(self, messages: list[dict], system_prompt: str = "") -> tuple[Session, list[dict]]:
        """Return (session, messages still to send).

        A request whose history matches a live session's key continues it and
        sends only the trailing messages. Anything else starts a new session and
        replays the whole conversation.
        """
        with self._lock:
            self._reap()
            # Longest prefix wins: prefer continuing the deepest known state.
            for cut in range(len(messages) - 1, 0, -1):
                sess = self._sessions.get(_history_key(messages[:cut]))
                if sess:
                    sess.used = time.time()
                    self._sessions.pop(sess.key, None)
                    return sess, messages[cut:]

        return self._new_session(system_prompt), messages

    def _remember(self, sess: Session, messages: list[dict], reply: str) -> None:
        """Key the session by the conversation it has now seen."""
        seen = list(messages) + ([{"role": "assistant", "content": reply}] if reply else [])
        sess.key = _history_key(seen)
        sess.used = time.time()
        with self._lock:
            self._sessions[sess.key] = sess
            self._reap()

    # -- prompt construction --
    def _prompt_blocks(self, messages: list[dict], tools: list[dict] | None,
                       tool_choice: Any, fresh: bool) -> list[dict]:
        """ACP content blocks for the messages to send.

        On a continued session only the new turn is sent, so the system prompt
        and tool protocol are folded into the text — ACP has no separate system
        channel, and the agent already carries the earlier context.
        """
        system_prompt, transcript, images = build_turn(messages)
        parts = []
        if fresh and system_prompt:
            parts.append(f"[System instructions]\n{system_prompt}")
        tool_section = tool_protocol.render_tools(tools or [], tool_choice)
        if tool_section:
            parts.append(tool_section)
        parts.append(transcript)
        if tool_section:
            parts.append(tool_protocol.REMINDER)

        blocks: list[dict] = [{"type": "text", "text": "\n\n".join(p for p in parts if p)}]
        for img in images:
            source = img.get("source") or {}
            if source.get("type") == "base64":
                blocks.append({"type": "image",
                               "mimeType": source.get("media_type", "image/png"),
                               "data": source.get("data", "")})
            elif source.get("type") == "url":
                blocks.append({"type": "image", "uri": source.get("url", "")})
        return blocks

    # -- turns --
    def stream_turn(self, messages: list[dict], model: str,
                    tools: list[dict] | None = None, tool_choice: Any = None) -> Iterator[tuple[str, Any]]:
        self._proc.start()
        system_prompt, _, _ = build_turn(messages)
        sess, to_send = self._acquire(messages, system_prompt)
        fresh = not sess.key
        # The system prompt is set on the session itself, so it is not repeated
        # in the turn text.
        blocks = self._prompt_blocks(to_send, tools, tool_choice, fresh=False)
        buffering = bool(tools)

        updates = self._proc.watch(sess.session_id)
        text_parts: list[str] = []
        usage: dict[str, Any] = {}
        done: queue.Queue = queue.Queue()

        def call():
            try:
                done.put(("ok", self._proc.request(
                    "session/prompt",
                    {"sessionId": sess.session_id, "prompt": blocks},
                )))
            except Exception as exc:                      # surfaced below
                done.put(("err", exc))

        threading.Thread(target=call, daemon=True).start()

        try:
            while True:
                try:
                    outcome = done.get_nowait()
                except queue.Empty:
                    outcome = None
                if outcome is not None and updates.empty():
                    break
                try:
                    update = updates.get(timeout=0.2)
                except queue.Empty:
                    continue
                kind = update.get("sessionUpdate")
                if kind == "agent_message_chunk":
                    chunk = (update.get("content") or {}).get("text") or ""
                    if chunk:
                        text_parts.append(chunk)
                        if not buffering:
                            yield ("delta", chunk)
                elif kind == "usage_update":
                    usage = update
            status, payload = outcome if outcome else done.get(timeout=self._cfg.timeout)
        finally:
            self._proc.unwatch(sess.session_id)

        if status == "err":
            raise payload

        text = "".join(text_parts)
        result = _to_bridge_result(payload, text, model, sess.session_id, usage)
        result = _attach_tool_calls(result, tools)
        self._remember(sess, messages, result.text)

        if buffering and not result.tool_calls and result.text:
            yield ("delta", result.text)
        yield ("done", result)

    def run_turn(self, messages: list[dict], model: str,
                 tools: list[dict] | None = None, tool_choice: Any = None) -> BridgeResult:
        final = None
        for kind, value in self.stream_turn(messages, model, tools, tool_choice):
            if kind == "done":
                final = value
        if final is None:
            raise AcpError("ACP turn produced no result")
        return final


def _to_bridge_result(payload: dict, text: str, model: str,
                      session_id: str, usage_update: dict) -> BridgeResult:
    usage = payload.get("usage") or {}
    input_tokens = (
        int(usage.get("inputTokens") or 0)
        + int(usage.get("cachedReadTokens") or 0)
        + int(usage.get("cachedWriteTokens") or 0)
    ) or int(usage_update.get("used") or 0)
    return BridgeResult(
        text=text,
        input_tokens=input_tokens,
        output_tokens=int(usage.get("outputTokens") or 0),
        session_id=session_id,
        model=model,
        stop_reason=str(payload.get("stopReason") or "end_turn"),
        cache_read=int(usage.get("cachedReadTokens") or 0),
        cache_write=int(usage.get("cachedWriteTokens") or 0),
    )


def _attach_tool_calls(result: BridgeResult, tools: list[dict] | None) -> BridgeResult:
    if not tools:
        return result
    calls = tool_protocol.parse_tool_calls(result.text, tool_protocol.tool_names(tools))
    if calls:
        result.tool_calls = calls
        result.text = ""
        result.stop_reason = "tool_use"
    return result
