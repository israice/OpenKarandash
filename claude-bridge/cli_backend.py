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
import os
import re
import subprocess
import tempfile
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

    Rendered in the SAME shape the protocol asks the model to emit (the
    ``{"tool_calls": [...]}`` object), not as a human-readable
    ``Tool call: name(args)`` line. The model treats its own earlier turns as
    examples: after two tool rounds rendered as prose it answered the third
    round with ``Tool call: terminal({...})`` text, which the parser rejected,
    and the turn ended with tool requests delivered to the user as the answer.
    """
    return tool_protocol.render_tool_calls(msg.get("tool_calls") or [])


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
    # Размышления модели: Claude шлёт их отдельными блоками, а не текстом
    # ответа. Без них лента показывает только шаги, и между действиями агента
    # видна пустота — непонятно, чем он занят и почему выбрал именно это.
    reasoning: str = ""


HOST_WIN = os.name == "nt"


def to_target_path(path: str, cfg: BridgeConfig) -> str:
    """Rewrite a host path so the CLI on the OTHER side of WSL interop can open it.

    Windows host driving the WSL claude: C:\\x\\y -> /mnt/c/x/y.
    WSL host driving claude.exe:        /mnt/c/x/y -> C:\\x\\y.
    Same side: unchanged.
    """
    if HOST_WIN and cfg.target == "wsl":
        m = re.match(r"^([A-Za-z]):[\\/](.*)$", path)
        if m:
            return f"/mnt/{m.group(1).lower()}/{m.group(2).replace(chr(92), '/')}"
    if not HOST_WIN and cfg.target == "windows":
        m = re.match(r"^/mnt/([a-z])/(.*)$", path)
        if m:
            return f"{m.group(1).upper()}:\\{m.group(2).replace('/', chr(92))}"
    return path


def launch_prefix(cfg: BridgeConfig) -> list[str]:
    """How to start `claude` for the target the user connected in Settings.

    The bridge drives whichever installation OpenKarandash's Settings points
    at — the same one the server itself uses — so from a Windows host the WSL
    copy is reached exactly like server.js does it: wsl.exe + login bash
    (plain `wsl -e claude` has no ~/.local/bin in PATH). wsl.exe starts in the
    translated cwd by itself; the remaining args are passed through "$@".
    """
    if HOST_WIN and cfg.target == "wsl":
        return ["wsl.exe", "-e", "bash", "-lc", 'exec claude "$@"', "claude"]
    return [cfg.resolve_binary()]


def build_argv(cfg: BridgeConfig, model: str, system_prompt_file: str) -> list[str]:
    """Argv for one headless turn, configured to be a MODEL rather than an agent.

    --system-prompt-file REPLACES Claude Code's own agent preamble instead of
    appending to it: Hermes ships its own system prompt and its own toolbox, so
    the CLI's identity would be dead weight billed on every single turn.
    A FILE rather than --system-prompt <text>: Hermes' prompt plus the tool
    schemas runs to tens of thousands of characters, and on Windows the whole
    command line is capped at ~32k — claude.exe then fails to spawn with
    "[WinError 206] The filename or extension is too long".
    --setting-sources= and --strict-mcp-config keep the host user's settings,
    skills and MCP servers out of the session, so the bridge answers the same
    way regardless of local machine state.
    """
    return [
        *launch_prefix(cfg), "-p",
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
        "--system-prompt-file", to_target_path(system_prompt_file, cfg),
    ]


def _write_system_prompt(text: str, cfg: BridgeConfig) -> str:
    """Persist the system prompt to a file the CLI can read; caller unlinks.

    Not the system temp dir: with WSL interop the CLI may live on the other
    side (C:\\Users\\...\\Temp is invisible to a WSL claude, /tmp to claude.exe).
    The project's DATA/ folder is on the shared drive and seen by both.
    """
    tmp_dir = os.path.join(cfg.cwd, "DATA", "bridge-tmp")
    os.makedirs(tmp_dir, exist_ok=True)
    fd, path = tempfile.mkstemp(prefix="sys-", suffix=".md", dir=tmp_dir, text=True)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(text or DEFAULT_SYSTEM_PROMPT)
    return path


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
             tools: list[dict] | None, tool_choice: Any) -> tuple[list[str], str, str]:
    system_prompt, transcript, images = build_turn(messages)
    tool_section = tool_protocol.render_tools(tools or [], tool_choice)
    if tool_section:
        system_prompt = f"{system_prompt}\n\n{tool_section}" if system_prompt else tool_section
        # Repeated at the END of the turn as well: the CLI wraps the session in
        # its own agent framing, and a protocol stated only in the system prompt
        # loses to that framing — the model answers "I have no weather tool"
        # instead of requesting one.
        #
        # BEFORE the trailing "Assistant:" cue, not after it. With the reminder
        # placed after the cue the model re-emitted the cue itself and answered
        # ``Assistant: {"tool_calls": ...}`` (seen live), which the parser then
        # took for prose — the turn ended with a raw call delivered as the answer.
        transcript = tool_protocol.insert_reminder(transcript)
    prompt_file = _write_system_prompt(system_prompt, cfg)
    argv = build_argv(cfg, model, prompt_file)
    if cfg.debug:
        logger.info("spawn: model=%s images=%d tools=%d cwd=%s",
                    model, len(images), len(tools or []), cfg.cwd)
    return argv, build_stdin(transcript, images), prompt_file


def _spawn(cfg: BridgeConfig, argv: list[str], stdin_payload: str, prompt_file: str = "") -> subprocess.Popen:
    try:
        proc = subprocess.Popen(
            argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            # claude пишет UTF-8; без явной кодировки Windows-Python читает в cp1251/
            # cp1252 и падает на русском тексте: «'charmap' codec can't decode»
            text=True, encoding="utf-8", errors="replace", bufsize=1, cwd=cfg.cwd,
        )
    except Exception:
        _unlink(prompt_file)
        raise
    proc.prompt_file = prompt_file  # removed in _finish, once the CLI has read it
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
                # размышление приходит своим типом блока и своим полем
                elif delta.get("type") == "thinking_delta" and delta.get("thinking"):
                    yield ("reasoning", delta["thinking"])
        elif kind == "result":
            yield ("result", ev)


def _unlink(path: str) -> None:
    if path:
        try:
            os.unlink(path)
        except OSError:
            pass


def _finish(proc: subprocess.Popen) -> tuple[int, str]:
    proc.stdout.close()
    stderr = proc.stderr.read() if proc.stderr else ""
    proc.stderr.close()
    code = proc.wait()
    _unlink(getattr(proc, "prompt_file", ""))
    return code, stderr


def run_turn(cfg: BridgeConfig, messages: list[dict], model: str,
             tools: list[dict] | None = None, tool_choice: Any = None) -> BridgeResult:
    """Run one headless turn, returning text or parsed tool calls."""
    argv, stdin_payload, prompt_file = _prepare(cfg, messages, model, tools, tool_choice)
    proc = _spawn(cfg, argv, stdin_payload, prompt_file)
    final: BridgeResult | None = None
    try:
        reasoning: list[str] = []
        for kind, value in _events(proc):
            if kind == "reasoning":
                reasoning.append(value)
            elif kind == "result":
                # The last result wins: extra turns would only appear if the
                # CLI split the input, and the closing one is the answer.
                final = _result_from_payload(value, model)
    finally:
        code, stderr = _finish(proc)

    if final is None:
        raise RuntimeError(f"claude produced no result (exit {code}): {stderr.strip()[:300]}")
    final.reasoning = "".join(reasoning).strip()
    return _attach_tool_calls(final, tools)


def stream_turn(cfg: BridgeConfig, messages: list[dict], model: str,
                tools: list[dict] | None = None, tool_choice: Any = None):
    """Yield ("delta", text) as tokens arrive, then one ("done", BridgeResult).

    When tools are offered the deltas are BUFFERED rather than forwarded: a
    tool call arrives as JSON that Hermes must receive as `tool_calls`, not as
    assistant text, and whether the reply is a call is only known once it ends.
    """
    argv, stdin_payload, prompt_file = _prepare(cfg, messages, model, tools, tool_choice)
    buffering = bool(tools)
    proc = _spawn(cfg, argv, stdin_payload, prompt_file)
    final: BridgeResult | None = None
    try:
        reasoning: list[str] = []
        for kind, value in _events(proc):
            if kind == "delta":
                if not buffering:
                    yield ("delta", value)
            elif kind == "reasoning":
                reasoning.append(value)
            elif kind == "result":
                final = _result_from_payload(value, model)
    finally:
        code, stderr = _finish(proc)

    if final is None:
        raise RuntimeError(f"claude stream ended without a result (exit {code}): {stderr.strip()[:300]}")

    final.reasoning = "".join(reasoning).strip()
    final = _attach_tool_calls(final, tools)
    if buffering and not final.tool_calls and final.text:
        yield ("delta", final.text)  # plain answer held back by the tool buffer
    yield ("done", final)


def _attach_tool_calls(result: BridgeResult, tools: list[dict] | None) -> BridgeResult:
    """Promote a tool-call JSON reply into structured tool_calls.

    A short line of prose in front of the object is kept as the message content:
    an OpenAI assistant message carries text and tool_calls together, and
    dropping the text used to end the turn on an announcement instead of work."""
    if not tools:
        return result
    names = tool_protocol.tool_names(tools)
    prose, calls, note = tool_protocol.split_reply(result.text, names)
    if calls:
        result.tool_calls = calls
        result.text = prose
        result.stop_reason = "tool_use"
    elif note:
        # инструмента нет: ошибку возвращаем модели словами, а не сырым
        # объектом человеку — иначе ход кончается ничем и вызов повторяется
        result.text = f"{prose}\n\n{note}" if prose else note
    return result
