"""Запуск процесса claude CLI: командная строка, файл системного промпта, чтение потока.

Всё, что знает про сам процесс и стороны WSL/Windows, но ничего — про
переписку Hermes и продолжение сессий (это cli_backend.py и session_cache.py).
"""

from __future__ import annotations

import json
import os
import queue
import re
import subprocess
import tempfile
import threading
import time
from typing import Any, Iterator

from config import BUILTIN_TOOLS, BridgeConfig

# Used when Hermes sends no system message. Kept minimal on purpose: the point
# of replacing Claude Code's preamble is to stop paying for an identity the
# bridge does not use.
DEFAULT_SYSTEM_PROMPT = "You are a helpful assistant."

_WSL_MOUNT = re.compile(r"^/mnt/([a-z])/(.*)$", re.IGNORECASE)

# Пока модель думает, CLI молчит минутами. Раз в столько секунд тишины наружу
# уходит пустой кусок потока: Hermes засчитывает его как признак жизни, а не
# принимает ход за зависший.
PING_SECONDS = 15


HOST_WIN = os.name == "nt"

def to_windows_path(path: str) -> str:
    """`/mnt/c/foo` -> `C:\\foo`, for paths passed as ARGUMENTS to claude.exe."""
    m = _WSL_MOUNT.match(path or "")
    if not m:
        return path
    drive, rest = m.group(1).upper(), m.group(2).replace("/", "\\")
    return f"{drive}:\\{rest}"


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
    --effort is fixed per bridge (CLAUDE_BRIDGE_EFFORT), never per request: it is
    part of the cached request, and changing it between turns of one
    conversation throws the whole prompt cache away (measured).
    """
    argv = [
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
        "--system-prompt-file", to_target_path(system_prompt_file, cfg),
    ]
    if cfg.effort:
        argv += ["--effort", cfg.effort]
    return argv


def write_system_prompt(text: str, cfg: BridgeConfig) -> str:
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


def sweep_prompt_files(cfg: BridgeConfig, older_than: float = 3600) -> None:
    """Убрать файлы системного промпта, брошенные прерванными запусками.

    Обычно файл удаляет _finish, но мост, перезапущенный посреди хода (правка
    .py, Ctrl+C), оставляет их лежать — в DATA/bridge-tmp копились десятки."""
    tmp_dir = os.path.join(cfg.cwd, "DATA", "bridge-tmp")
    try:
        names = os.listdir(tmp_dir)
    except OSError:
        return
    now = time.time()
    for name in names:
        if not (name.startswith("sys-") and name.endswith(".md")):
            continue
        path = os.path.join(tmp_dir, name)
        try:
            if now - os.path.getmtime(path) > older_than:
                os.unlink(path)
        except OSError:
            pass


def spawn(cfg: BridgeConfig, argv: list[str], stdin: str, prompt_file: str) -> subprocess.Popen:
    os.makedirs(cfg.sessions_dir, exist_ok=True)
    try:
        proc = subprocess.Popen(
            argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            # claude пишет UTF-8; без явной кодировки Windows-Python читает в cp1251/
            # cp1252 и падает на русском тексте: «'charmap' codec can't decode»
            text=True, encoding="utf-8", errors="replace", bufsize=1,
            # Своя папка, а не проект: CLI не подтягивает CLAUDE.md проекта (у
            # Hermes свои инструкции), а сессии моста не смешиваются с историей
            # пользователя в `claude --resume`.
            cwd=cfg.sessions_dir,
        )
    except Exception:
        unlink(prompt_file)
        raise
    proc.prompt_file = prompt_file  # removed in _finish, once the CLI has read it
    # Closing stdin tells the CLI the conversation is complete. The payload can
    # be large (base64 images), so it is written before stdout is drained only
    # because the CLI reads its whole input before emitting a turn.
    proc.stdin.write(stdin)
    proc.stdin.close()
    return proc


def parse_event(line: str) -> tuple[str, Any] | None:
    line = line.strip()
    if not line:
        return None
    try:
        ev = json.loads(line)
    except json.JSONDecodeError:
        return None  # non-JSON chatter on stdout is not fatal
    kind = ev.get("type")
    if kind == "stream_event":
        inner = ev.get("event") or {}
        if inner.get("type") == "content_block_delta":
            delta = inner.get("delta") or {}
            if delta.get("type") == "text_delta" and delta.get("text"):
                return ("delta", delta["text"])
            # размышление приходит своим типом блока и своим полем
            if delta.get("type") == "thinking_delta" and delta.get("thinking"):
                return ("reasoning", delta["thinking"])
    elif kind == "result":
        return ("result", ev)
    return None


def events(proc: subprocess.Popen) -> Iterator[tuple[str, Any]]:
    """Yield ("delta"|"reasoning"|"result", value), and ("ping", None) on silence.

    stdout читает отдельный поток: иначе генератор висит на readline и не может
    дать знать о себе, пока модель думает."""
    events: queue.Queue = queue.Queue()

    def pump() -> None:
        try:
            for line in proc.stdout:
                parsed = parse_event(line)
                if parsed:
                    events.put(parsed)
        except (OSError, ValueError):
            pass
        finally:
            events.put(None)

    threading.Thread(target=pump, daemon=True, name="claude-stdout").start()
    while True:
        try:
            item = events.get(timeout=PING_SECONDS)
        except queue.Empty:
            yield ("ping", None)
            continue
        if item is None:
            return
        yield item


def unlink(path: str) -> None:
    if path:
        try:
            os.unlink(path)
        except OSError:
            pass


def finish(proc: subprocess.Popen, completed: bool) -> tuple[int, str]:
    if not completed and proc.poll() is None:
        # Hermes отключился посреди хода (сессию прервали): ответ уже никому не
        # нужен, а без kill CLI дописал бы его и сжёг токены впустую.
        proc.kill()
    stderr = proc.stderr.read() if proc.stderr else ""
    proc.stderr.close()
    code = proc.wait()
    unlink(getattr(proc, "prompt_file", ""))
    return code, stderr
