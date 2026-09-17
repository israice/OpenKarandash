"""exec-bridge configuration.

Runs on the HOST (outside Docker), like claude-bridge, because it spawns real
CLI processes that live there - opencode/pi/codex today, potentially the
Karandash screenshot's powershell.exe later. Unlike claude-bridge (an
OpenAI-compatible shim specific to Claude/Hermes), this bridge is a generic
remote-exec primitive: server.js keeps all target-selection/argument-building
logic and only swaps its local spawn() for an HTTP call when it itself runs
in a container. See DOCS/decisions/037 and DOCS/план-докеризации-коннекторов.md.
"""
from __future__ import annotations

import os
import pathlib
from dataclasses import dataclass, field


def load_dotenv(path: str | os.PathLike = None) -> None:
    """Load KEY=VALUE lines from exec-bridge's own .env into os.environ.

    Mirrors claude-bridge/config.py's loader exactly (existing env vars win).
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
    host: str = field(default_factory=lambda: os.environ.get("EXEC_BRIDGE_HOST", "127.0.0.1"))
    port: int = field(default_factory=lambda: int(os.environ.get("EXEC_BRIDGE_PORT", "8789")))
    auth_token: str = field(default_factory=lambda: os.environ.get("EXEC_BRIDGE_TOKEN", "").strip())
    default_timeout: float = field(default_factory=lambda: float(os.environ.get("EXEC_BRIDGE_TIMEOUT", "3600")))
    debug: bool = field(default_factory=lambda: _env_bool("EXEC_BRIDGE_DEBUG", False))


load_dotenv()
