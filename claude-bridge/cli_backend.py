"""CLI backend: drives the `claude` binary in headless (`-p`) mode.

Input goes in as stream-json rather than a bare prompt, which is what makes
images possible — but every `user` line in that stream starts its own turn, so
the whole conversation is packed into ONE user message: a role-labelled
transcript plus the image blocks. One turn per HTTP request, history preserved,
pictures included.
"""

from __future__ import annotations

import base64
import json
import logging
import re
import subprocess
from dataclasses import dataclass, field
from typing import Any, Iterator

import tool_protocol
from config import BUILTIN_TOOLS, BridgeConfig

logger = logging.getLogger("claude_bridge.cli")

# Used when Hermes sends no system message. Kept minimal on purpose: the point
# of replacing Claude Code's preamble is to stop paying for an identity the
# bridge does not use.
DEFAULT_SYSTEM_PROMPT = "You are a helpful assistant."

_WSL_MOUNT = re.compile(r"^/mnt/([a-z])/(.*)$", re.IGNORECASE)
_DATA_URL = re.compile(r"^data:(?P<media>[\w.+/-]+);base64,(?P<data>.+)$", re.DOTALL)

_ROLE_LABELS = {"user": "User", "assistant": "Assistant", "tool": "Tool result", "function": "Tool result"}


def to_windows_path(path: str) -> str:
    """`/mnt/c/foo` -> `C:\\foo`, for paths passed as ARGUMENTS to claude.exe."""
    m = _WSL_MOUNT.match(path or "")
    if not m:
        return path
    drive, rest = m.group(1).upper(), m.group(2).replace("/", "\\")
    return f"{drive}:\\{rest}"


# ── message flattening ───────────────────────────────────────

def _image_block(url: str) -> dict | None:
    """OpenAI image part -> Anthropic image content block."""
    data_url = _DATA_URL.match(url or "")
    if data_url:
        return {"type": "image", "source": {
            "type": "base64",
            "media_type": data_url.group("media"),
            "data": data_url.group("data").strip(),
        }}
    if url.startswith(("http://", "https://")):
        return {"type": "image", "source": {"type": "url", "url": url}}
    return None


def split_content(content: Any) -> tuple[str, list[dict]]:
    """Split OpenAI message content into (text, image blocks)."""
    if isinstance(content, str):
        return content, []
    if not isinstance(content, list):
        return ("" if content is None else str(content)), []

    texts, images = [], []
    for item in content:
        if not isinstance(item, dict):
            continue
        kind = item.get("type")
        if kind == "text":
            texts.append(str(item.get("text") or ""))
        elif kind == "image_url":
            url = (item.get("image_url") or {}).get("url") if isinstance(item.get("image_url"), dict) else None
            block = _image_block(str(url or ""))
            if block:
                images.append(block)
        elif kind == "input_image":  # Responses-style part, accepted for tolerance
            block = _image_block(str(item.get("image_url") or ""))
            if block:
                images.append(block)
    return "\n".join(t for t in texts if t), images


def _describe_tool_calls(msg: dict) -> str:
    """Render an assistant turn's tool_calls back into the transcript.

    Without this, a tool result in the history has nothing to refer back to and
    the model cannot tell which call produced it.
    """
    rendered = []
    for call in msg.get("tool_calls") or []:
        fn = call.get("function") or {}
        if fn.get("name"):
            rendered.append(f'{fn["name"]}({fn.get("arguments") or "{}"})')
    return "Tool call: " + "; ".join(rendered) if rendered else ""


def build_turn(messages: list[dict]) -> tuple[str, str, list[dict]]:
    """Return (system_prompt, transcript, image_blocks) for one request."""
    system_parts, lines, images = [], [], []

    for msg in messages or []:
        if not isinstance(msg, dict):
            continue
        role = str(msg.get("role") or "user")
        text, msg_images = split_content(msg.get("content"))
        images.extend(msg_images)

        if role == "system" or role == "developer":
            if text:
                system_parts.append(text)
            continue

        if role == "assistant" and msg.get("tool_calls"):
            described = _describe_tool_calls(msg)
            text = f"{text}\n{described}".strip() if text else described

        if role in ("tool", "function"):
            name = msg.get("name") or msg.get("tool_call_id") or ""
            label = f"Tool result ({name})" if name else "Tool result"
            lines.append(f"{label}: {text}")
            continue

        if text or msg_images:
            label = _ROLE_LABELS.get(role, role.title())
            body = text if text else "(see attached image)"
            lines.append(f"{label}: {body}")

    system_prompt = "\n\n".join(p for p in system_parts if p)

    # A single trailing user message is sent verbatim: an invented "User:"
    # wrapper around a lone question only adds noise.
    if len(lines) == 1 and lines[0].startswith("User: "):
        transcript = lines[0][len("User: "):]
    else:
        transcript = "\n\n".join(lines + ["Assistant:"])

    return system_prompt, transcript, images


def build_stdin(transcript: str, images: list[dict]) -> str:
    """One stream-json `user` line — one turn."""
    content: list[dict] = [{"type": "text", "text": transcript}]
    content.extend(images)
    return json.dumps({"type": "user", "message": {"role": "user", "content": content}}) + "\n"


# ── process handling ─────────────────────────────────────────

@dataclass
class BridgeResult:
    """Normalized outcome of one CLI turn."""

    text: str
    input_tokens: int = 0
    output_tokens: int = 0
    session_id: str = ""
    model: str = ""
    stop_reason: str = "end_turn"
    tool_calls: list[dict] = field(default_factory=list)
    # Cache split, reported separately because the two have very different
    # prices: writing the cache costs more than plain input, reading it costs a
    # fraction. Summing them into prompt_tokens hides which backend is cheaper.
    cache_read: int = 0
    cache_write: int = 0


def build_argv(cfg: BridgeConfig, model: str, system_prompt: str) -> list[str]:
    """Argv for one headless turn, configured to be a MODEL rather than an agent.

    --system-prompt REPLACES Claude Code's own agent preamble instead of
    appending to it: Hermes ships its own system prompt and its own toolbox, so
    the CLI's identity would be dead weight billed on every single turn.
    --setting-sources= and --strict-mcp-config keep the host user's settings,
    skills and MCP servers out of the session, so the bridge answers the same
    way regardless of local machine state.
    """
    return [
        cfg.resolve_binary(), "-p",
        "--input-format", "stream-json",
        "--output-format", "stream-json",
        "--include-partial-messages",
        "--verbose",
        "--model", model,
        # Hermes owns the toolbox; the CLI must not act on its own.
        "--disallowed-tools", ",".join(BUILTIN_TOOLS),
        "--setting-sources", "",
        "--strict-mcp-config",
        "--no-session-persistence",
        "--system-prompt", system_prompt or DEFAULT_SYSTEM_PROMPT,
    ]


def _result_from_payload(payload: dict, model: str) -> BridgeResult:
    """Normalize the CLI's terminal ``result`` envelope."""
    if payload.get("is_error"):
        raise RuntimeError(f"claude reported an error: {str(payload.get('result'))[:500]}")
    usage = payload.get("usage") or {}
    # Cached tokens are still input tokens on the OpenAI wire; Hermes reads its
    # accounting off prompt_tokens.
    input_tokens = (
        int(usage.get("input_tokens") or 0)
        + int(usage.get("cache_read_input_tokens") or 0)
        + int(usage.get("cache_creation_input_tokens") or 0)
    )
    model_usage = payload.get("modelUsage") or {}
    resolved_model = next(iter(model_usage), "") if isinstance(model_usage, dict) else ""
    return BridgeResult(
        text=str(payload.get("result") or ""),
        input_tokens=input_tokens,
        output_tokens=int(usage.get("output_tokens") or 0),
        session_id=str(payload.get("session_id") or ""),
        model=resolved_model or model,
        stop_reason=str(payload.get("stop_reason") or "end_turn"),
        cache_read=int(usage.get("cache_read_input_tokens") or 0),
        cache_write=int(usage.get("cache_creation_input_tokens") or 0),
    )


def _prepare(cfg: BridgeConfig, messages: list[dict], model: str,
             tools: list[dict] | None, tool_choice: Any) -> tuple[list[str], str]:
    system_prompt, transcript, images = build_turn(messages)
    tool_section = tool_protocol.render_tools(tools or [], tool_choice)
    if tool_section:
        system_prompt = f"{system_prompt}\n\n{tool_section}" if system_prompt else tool_section
        # Repeated at the END of the turn as well: the CLI wraps the session in
        # its own agent framing, and a protocol stated only in the system prompt
        # loses to that framing — the model answers "I have no weather tool"
        # instead of requesting one.
        transcript = f"{transcript}\n\n{tool_protocol.REMINDER}"
    argv = build_argv(cfg, model, system_prompt)
    if cfg.debug:
        logger.info("spawn: model=%s images=%d tools=%d cwd=%s",
                    model, len(images), len(tools or []), cfg.cwd)
    return argv, build_stdin(transcript, images)


def _spawn(cfg: BridgeConfig, argv: list[str], stdin_payload: str) -> subprocess.Popen:
    proc = subprocess.Popen(
        argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, bufsize=1, cwd=cfg.cwd,
    )
    # Closing stdin tells the CLI the conversation is complete. The payload can
    # be large (base64 images), so it is written before stdout is drained only
    # because the CLI reads its whole input before emitting a turn.
    proc.stdin.write(stdin_payload)
    proc.stdin.close()
    return proc


def _events(proc: subprocess.Popen) -> Iterator[tuple[str, Any]]:
    """Yield ("delta", text) / ("result", payload) from the CLI's event stream."""
    for line in proc.stdout:
        line = line.strip()
        if not line:
            continue
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue  # non-JSON chatter on stdout is not fatal
        kind = ev.get("type")
        if kind == "stream_event":
            inner = ev.get("event") or {}
            if inner.get("type") == "content_block_delta":
                delta = inner.get("delta") or {}
                if delta.get("type") == "text_delta" and delta.get("text"):
                    yield ("delta", delta["text"])
        elif kind == "result":
            yield ("result", ev)


def _finish(proc: subprocess.Popen) -> tuple[int, str]:
    proc.stdout.close()
    stderr = proc.stderr.read() if proc.stderr else ""
    proc.stderr.close()
    return proc.wait(), stderr


def run_turn(cfg: BridgeConfig, messages: list[dict], model: str,
             tools: list[dict] | None = None, tool_choice: Any = None) -> BridgeResult:
    """Run one headless turn, returning text or parsed tool calls."""
    argv, stdin_payload = _prepare(cfg, messages, model, tools, tool_choice)
    proc = _spawn(cfg, argv, stdin_payload)
    final: BridgeResult | None = None
    try:
        for kind, value in _events(proc):
            if kind == "result":
                # The last result wins: extra turns would only appear if the
                # CLI split the input, and the closing one is the answer.
                final = _result_from_payload(value, model)
    finally:
        code, stderr = _finish(proc)

    if final is None:
        raise RuntimeError(f"claude produced no result (exit {code}): {stderr.strip()[:300]}")
    return _attach_tool_calls(final, tools)


def stream_turn(cfg: BridgeConfig, messages: list[dict], model: str,
                tools: list[dict] | None = None, tool_choice: Any = None):
    """Yield ("delta", text) as tokens arrive, then one ("done", BridgeResult).

    When tools are offered the deltas are BUFFERED rather than forwarded: a
    tool call arrives as JSON that Hermes must receive as `tool_calls`, not as
    assistant text, and whether the reply is a call is only known once it ends.
    """
    argv, stdin_payload = _prepare(cfg, messages, model, tools, tool_choice)
    buffering = bool(tools)
    proc = _spawn(cfg, argv, stdin_payload)
    final: BridgeResult | None = None
    try:
        for kind, value in _events(proc):
            if kind == "delta":
                if not buffering:
                    yield ("delta", value)
            elif kind == "result":
                final = _result_from_payload(value, model)
    finally:
        code, stderr = _finish(proc)

    if final is None:
        raise RuntimeError(f"claude stream ended without a result (exit {code}): {stderr.strip()[:300]}")

    final = _attach_tool_calls(final, tools)
    if buffering and not final.tool_calls and final.text:
        yield ("delta", final.text)  # plain answer held back by the tool buffer
    yield ("done", final)


def _attach_tool_calls(result: BridgeResult, tools: list[dict] | None) -> BridgeResult:
    """Promote a tool-call JSON reply into structured tool_calls."""
    if not tools:
        return result
    calls = tool_protocol.parse_tool_calls(result.text, tool_protocol.tool_names(tools))
    if calls:
        result.tool_calls = calls
        result.text = ""
        result.stop_reason = "tool_use"
    return result
