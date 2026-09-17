"""claude-bridge configuration.

The bridge runs on the HOST (outside Docker) because the `claude` CLI it drives
lives there. Hermes runs in a container with ``network_mode: host``, so it
reaches the bridge over plain ``127.0.0.1:<port>``.

Every setting is an env var so the bridge can be retargeted without an edit:
the CLI target (WSL vs Windows) is the one the user is expected to flip.
"""

from __future__ import annotations

import os
import pathlib
import shutil
from dataclasses import dataclass, field

# OpenAI-facing model id -> `claude --model` value. Anything not listed is
# passed through verbatim, so a full model id ("claude-sonnet-5") also works.
DEFAULT_MODEL_MAP = {
    "claude-bridge-sonnet": "sonnet",
    "claude-bridge-opus": "opus",
    "claude-bridge-haiku": "haiku",
}

# Claude Code ships its own toolbox. Hermes brings its own, and a bridge that
# let the CLI act on its own would double-execute every tool call.
#
# Naming them here does more than block execution: a disallowed tool's SCHEMA
# is dropped from the prompt too. Left in, those schemas cost ~9k tokens per
# request AND actively break tool calling — the model trusts the schemas it can
# see over the text protocol, announces "my real tools are ListAgents,
# Workflow, ..." and refuses Hermes' tools as imaginary. With the list complete
# the model reports NONE and the overhead falls to ~565 tokens.
#
# Keep this list exhaustive; a tool missing from it comes back into the prompt.
BUILTIN_TOOLS = (
    # File and shell
    "Bash", "BashOutput", "KillShell", "Read", "Write", "Edit", "Glob", "Grep",
    "NotebookEdit", "LSP",
    # Web
    "WebFetch", "WebSearch",
    # Agents and orchestration
    "Task", "Agent", "ListAgents", "SendMessage", "TaskOutput", "TaskStop",
    "Workflow", "Monitor", "ScheduleWakeup",
    # Skills, plans, artifacts
    "Skill", "SlashCommand", "ToolSearch", "TodoWrite", "EnterPlanMode",
    "ExitPlanMode", "Artifact", "DesignSync", "ReportFindings",
    # Scheduling, worktrees, misc
    "CronCreate", "CronDelete", "CronList", "EnterWorktree", "ExitWorktree",
    "PushNotification", "RemoteTrigger", "SendUserFile", "SendFeedback",
    "EndConversation", "AskUserQuestion",
)


def load_dotenv(path: str | os.PathLike = None) -> None:
    """Load ``KEY=VALUE`` lines from the bridge's .env into os.environ.

    Existing environment variables win, so an explicit `VAR=... python3 server.py`
    still overrides the file. Called once at import so every BridgeConfig()
    built afterwards sees the same values.
    """
    env_path = pathlib.Path(path or pathlib.Path(__file__).with_name(".env"))
    if not env_path.is_file():
        return
    for raw in env_path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


@dataclass
class BridgeConfig:
    """Resolved bridge settings."""

    host: str = field(default_factory=lambda: os.environ.get("CLAUDE_BRIDGE_HOST", "127.0.0.1"))
    port: int = field(default_factory=lambda: int(os.environ.get("CLAUDE_BRIDGE_PORT", "8787")))

    # "wsl" -> spawn the Linux `claude`; "windows" -> spawn `claude.exe` through
    # WSL interop. User-selectable, per the deployment decision.
    target: str = field(default_factory=lambda: os.environ.get("CLAUDE_BRIDGE_TARGET", "wsl").strip().lower())

    # Explicit binary path wins over target-based discovery.
    binary: str = field(default_factory=lambda: os.environ.get("CLAUDE_BRIDGE_BINARY", "").strip())

    default_model: str = field(default_factory=lambda: os.environ.get("CLAUDE_BRIDGE_MODEL", "sonnet"))

    # Shared secret Hermes sends as a bearer/extra header. Empty = no auth,
    # which is only safe while the port stays bound to 127.0.0.1.
    auth_token: str = field(default_factory=lambda: os.environ.get("CLAUDE_BRIDGE_TOKEN", "").strip())

    # Working directory for the spawned CLI: what Claude sees as the project.
    cwd: str = field(default_factory=lambda: os.environ.get(
        "CLAUDE_BRIDGE_CWD", "/mnt/c/0_PROJECTS/OpenKarandash"))

    # Hermes' own OpenAI-compatible API server. The console proxies to it when
    # the user wants the AGENT (tools, skills, memory) rather than a bare model.
    hermes_api_url: str = field(default_factory=lambda: os.environ.get(
        "HERMES_API_URL", "http://127.0.0.1:8642/v1").strip().rstrip("/"))
    hermes_api_key: str = field(default_factory=lambda: os.environ.get("HERMES_API_KEY", "").strip())

    timeout: float = field(default_factory=lambda: float(os.environ.get("CLAUDE_BRIDGE_TIMEOUT", "600")))
    debug: bool = field(default_factory=lambda: _env_bool("CLAUDE_BRIDGE_DEBUG", False))

    # Уровень рассуждений claude (low|medium|high|xhigh|max, пусто — как решит CLI).
    # Один на весь мост: он часть кешируемого запроса, смена посреди разговора
    # сбрасывает кеш целиком.
    effort: str = field(default_factory=lambda: os.environ.get("CLAUDE_BRIDGE_EFFORT", "").strip().lower())

    # Продолжать сессию CLI между ходами агента, чтобы история читалась из кеша
    # (session_cache.py). 0 — прежний режим: каждый ход полной перепиской.
    session_reuse: bool = field(default_factory=lambda: _env_bool("CLAUDE_BRIDGE_SESSION_REUSE", True))

    @property
    def sessions_dir(self) -> str:
        """cwd запущенного CLI и место индекса сессий моста."""
        return os.path.join(self.cwd, "DATA", "bridge-sessions")

    def resolve_binary(self) -> str:
        """Absolute path to the `claude` executable for the configured target."""
        if self.binary:
            return self.binary
        # on a Windows host the WSL target is launched through wsl.exe (see
        # cli_backend.launch_prefix), so no binary is looked up here for it
        candidates = ("claude.exe", "claude") if self.target == "windows" else ("claude",)
        for name in candidates:
            found = shutil.which(name)
            if found:
                return found
        raise RuntimeError(
            f"claude CLI not found for target={self.target!r}; "
            f"set CLAUDE_BRIDGE_BINARY to its absolute path"
        )

    def map_model(self, requested: str | None) -> str:
        if not requested:
            return self.default_model
        return DEFAULT_MODEL_MAP.get(requested.strip(), requested.strip())


load_dotenv()
