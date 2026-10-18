"""Configuration loading for the session manager.

Precedence: environment variable > config file > built-in default.
The config file lives at $MANAGER_CONFIG (default /app/config/manager.yaml).
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import yaml

CONFIG_PATH = Path(os.environ.get("MANAGER_CONFIG", "/app/config/manager.yaml"))


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    return int(raw) if raw not in (None, "") else default


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    return float(raw) if raw not in (None, "") else default


class Config:
    """Thin typed view over the YAML file plus environment overrides."""

    def __init__(self, data: dict[str, Any]) -> None:
        self._d = data
        self.apply_env()

    # ------------------------------------------------------------------ load
    @classmethod
    def load(cls, path: Path = CONFIG_PATH) -> "Config":
        if path.exists():
            with path.open("r", encoding="utf-8") as fh:
                data = yaml.safe_load(fh) or {}
        else:
            data = {}
        return cls(data)

    def get(self, dotted: str, default: Any = None) -> Any:
        node: Any = self._d
        for part in dotted.split("."):
            if not isinstance(node, dict) or part not in node:
                return default
            node = node[part]
        return node

    # ------------------------------------------------------------------ env
    def apply_env(self) -> None:
        mgr = self._d.setdefault("manager", {})
        auth = mgr.setdefault("auth", {})
        cors = mgr.setdefault("cors", {})
        sess = self._d.setdefault("session_defaults", {})
        per = self._d.setdefault("resources", {}).setdefault("per_session", {})
        adm = self._d.setdefault("resources", {}).setdefault("admission", {})
        dock = self._d.setdefault("docker", {})
        log = self._d.setdefault("logging", {})

        mgr["port"] = _env_int("MANAGER_PORT", mgr.get("port", 8080))
        mgr["public_base_url"] = os.environ.get("PUBLIC_BASE_URL", mgr.get("public_base_url", ""))
        mgr["state_dir"] = os.environ.get("STATE_DIR", mgr.get("state_dir", "/var/lib/session-manager"))
        # On SIGTERM the manager stops (never removes) the session containers it
        # created, so `docker compose down` finds the internal `sessions`
        # network free. They are started again on the next manager start.
        mgr["stop_sessions_on_shutdown"] = _env_bool(
            "STOP_SESSIONS_ON_SHUTDOWN", mgr.get("stop_sessions_on_shutdown", True)
        )
        auth["username"] = os.environ.get("MANAGER_USER", auth.get("username", "admin"))
        auth["password"] = os.environ.get("MANAGER_PASSWORD", auth.get("password", ""))
        auth["api_token"] = os.environ.get("MANAGER_API_TOKEN", auth.get("api_token", ""))
        # Auto-login: the browser is logged in as MANAGER_USER with no prompt.
        # Set MANAGER_AUTO_LOGIN=0 to fall back to plain HTTP Basic.
        auth["auto_login"] = _env_bool("MANAGER_AUTO_LOGIN", auth.get("auto_login", True))
        auth["auto_user"] = os.environ.get("MANAGER_AUTO_LOGIN_USER", auth.get("auto_user", ""))
        auth["allowed_origins"] = [
            o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "").split(",") if o.strip()
        ]
        cors["enabled"] = _env_bool("CORS_ENABLED", cors.get("enabled", False))
        cors["allowed_origins"] = auth["allowed_origins"] or cors.get("allowed_origins", [])

        sess["image"] = os.environ.get("DESKTOP_IMAGE", sess.get("image", "webdesktop:lxde"))
        sess["resolution"] = os.environ.get("SESSION_RESOLUTION", sess.get("resolution", "1440x900"))
        sess["vnc_password"] = os.environ.get("SESSION_VNC_PASSWORD", sess.get("vnc_password", ""))

        per["memory_mb"] = _env_int("SESSION_MEMORY_MB", per.get("memory_mb", 512))
        per["cpus"] = _env_float("SESSION_CPUS", per.get("cpus", 0.5))
        per["cpu_shares"] = _env_int("SESSION_CPU_SHARES", per.get("cpu_shares", 512))
        per["blkio_weight"] = _env_int("SESSION_BLACKDEV_WEIGHT", per.get("blkio_weight", 500))
        per["pids_limit"] = _env_int("SESSION_PIDS_LIMIT", per.get("pids_limit", 512))
        per["memory_swap_mb"] = _env_int("SESSION_MEMORY_SWAP_MB", per.get("memory_swap_mb", 0))
        per["tmpfs_mb"] = _env_int("SESSION_TMPFS_MB", per.get("tmpfs_mb", 64))

        adm["max_sessions"] = _env_int("MAX_SESSIONS", adm.get("max_sessions", 20))
        adm["min_free_memory_mb"] = _env_int("MIN_FREE_MEMORY_MB", adm.get("min_free_memory_mb", 700))
        adm["reserve_memory_mb"] = _env_int("RESERVE_MEMORY_MB", adm.get("reserve_memory_mb", 512))
        adm["min_free_disk_mb"] = _env_int("MIN_FREE_DISK_MB", adm.get("min_free_disk_mb", 2048))
        adm["max_load_per_cpu"] = _env_float("MAX_LOAD_PER_CPU", adm.get("max_load_per_cpu", 4.0))
        adm["max_queue"] = _env_int("MAX_QUEUE", adm.get("max_queue", 10))
        adm["overload_action"] = os.environ.get("OVERLOAD_ACTION", adm.get("overload_action", "queue"))
        adm["queue_timeout_s"] = _env_int("QUEUE_TIMEOUT_S", adm.get("queue_timeout_s", 120))

        dock["name_prefix"] = os.environ.get("SESSION_PREFIX", dock.get("name_prefix", "wd"))
        dock["ready_timeout_s"] = _env_int("SESSION_READY_TIMEOUT_S", dock.get("ready_timeout_s", 90))
        dock["stop_timeout_s"] = _env_int("SESSION_STOP_TIMEOUT_S", dock.get("stop_timeout_s", 15))
        dock["resource_sample_s"] = _env_int("RESOURCE_SAMPLE_S", dock.get("resource_sample_s", 5))

        log["level"] = os.environ.get("LOG_LEVEL", log.get("level", "INFO"))

    # --------------------------------------------------------- derived bits
    @property
    def resource_sample_s(self) -> int:
        return int(self.get("docker.resource_sample_s", 5))

    @property
    def name_prefix(self) -> str:
        return self.get("docker.name_prefix", "wd")

    def container_name(self, session_id: str) -> str:
        return f"{self.name_prefix}-{session_id}"

    def volume_name(self, session_id: str) -> str:
        return f"{self.name_prefix}-home-{session_id}"
