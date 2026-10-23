"""Session metadata store.

Session state is deliberately kept OUTSIDE the containers and OUTSIDE the
session home volumes, in the manager's own state directory. A session can be
recreated from this metadata alone; deleting a container never loses the record
of what it was.

Layout:
    <state_dir>/sessions/<id>.json     one file per session (atomic replace)
    <state_dir>/sessions/index.json   lightweight id -> summary map
"""
from __future__ import annotations

import json
import os
import threading
import time
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Iterable

# Session lifecycle.
#
# There is deliberately no QUEUED state: queueing happens in the admission
# controller BEFORE a session record exists, so a request waiting for capacity
# has no id yet and cannot be listed.
CREATING = "creating"
STARTING = "starting"
RUNNING = "running"
STOPPING = "stopping"
STOPPED = "stopped"
FAILED = "failed"

ACTIVE_STATES = {CREATING, STARTING, RUNNING, STOPPING}

# A session is either an ordinary desktop or THE main one - the template every
# new session is cloned from. At most one session carries the MAIN role.
ROLE_NORMAL = "normal"
ROLE_MAIN = "main"


@dataclass
class Session:
    id: str
    owner: str
    state: str = CREATING
    image: str = ""
    resolution: str = "1440x900"
    container_name: str = ""
    volume_name: str = ""
    display_num: int = 1
    vnc_port: int = 5900
    has_vnc_password: bool = False
    memory_limit_mb: int = 0
    cpu_limit: float = 0.0
    url_path: str = ""
    # "main" for the one session new sessions are cloned from, "normal" for
    # everything else.
    role: str = ROLE_NORMAL
    created_at: float = field(default_factory=time.time)
    started_at: float | None = None
    stopped_at: float | None = None
    last_seen: float | None = None
    error: str | None = None
    labels: dict[str, str] = field(default_factory=dict)

    def public_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["password_protected"] = self.has_vnc_password
        return d

    def summary_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "owner": self.owner,
            "state": self.state,
            "url": self.url_path,
            "resolution": self.resolution,
            "created_at": self.created_at,
            # The UI shows uptime from this; without it the age column would
            # silently fall back to creation time and keep counting a stopped
            # session as if it were up.
            "started_at": self.started_at,
            "memory_limit_mb": self.memory_limit_mb,
            "cpu_limit": self.cpu_limit,
            "role": self.role,
        }


class SessionStore:
    def __init__(self, state_dir: str) -> None:
        self.root = Path(state_dir) / "sessions"
        self.root.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._cache: dict[str, Session] = {}
        self._load_all()

    # ------------------------------------------------------------------ io
    def _load_all(self) -> None:
        for path in self.root.glob("*.json"):
            if path.name == "index.json":
                continue
            try:
                with path.open("r", encoding="utf-8") as fh:
                    data = json.load(fh)
                self._cache[data["id"]] = Session(**data)
            except (OSError, ValueError, KeyError, TypeError) as exc:
                print(f"[store] skipping unreadable {path.name}: {exc}")

    def _persist(self, session: Session) -> None:
        tmp = self.root / f".{session.id}.tmp"
        final = self.root / f"{session.id}.json"
        with tmp.open("w", encoding="utf-8") as fh:
            json.dump(asdict(session), fh, indent=2, sort_keys=True)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, final)
        self._write_index()

    def _write_index(self) -> None:
        index = {sid: s.summary_dict() for sid, s in self._cache.items()}
        tmp = self.root / ".index.tmp"
        with tmp.open("w", encoding="utf-8") as fh:
            json.dump(index, fh, indent=2, sort_keys=True)
        os.replace(tmp, self.root / "index.json")

    # --------------------------------------------------------------- CRUD
    @staticmethod
    def new_id() -> str:
        # Short, URL friendly, unambiguous.
        return uuid.uuid4().hex[:12]

    def create(self, session: Session) -> Session:
        with self._lock:
            self._cache[session.id] = session
            self._persist(session)
            return session

    def get(self, session_id: str) -> Session | None:
        with self._lock:
            return self._cache.get(session_id)

    def update(self, session_id: str, **changes: Any) -> Session | None:
        with self._lock:
            s = self._cache.get(session_id)
            if s is None:
                return None
            for k, v in changes.items():
                if hasattr(s, k):
                    setattr(s, k, v)
            self._persist(s)
            return s

    def delete(self, session_id: str) -> bool:
        with self._lock:
            existed = self._cache.pop(session_id, None) is not None
            path = self.root / f"{session_id}.json"
            if path.exists():
                path.unlink()
            if existed:
                self._write_index()
            return existed

    def list(self, states: Iterable[str] | None = None) -> list[Session]:
        with self._lock:
            items = list(self._cache.values())
        if states:
            wanted = set(states)
            items = [s for s in items if s.state in wanted]
        return sorted(items, key=lambda s: s.created_at)

    def active(self) -> list[Session]:
        return self.list(ACTIVE_STATES)

    def main_session(self) -> Session | None:
        """The session new sessions are cloned from, if one was designated."""
        with self._lock:
            for s in self._cache.values():
                if s.role == ROLE_MAIN:
                    return s
        return None

    def set_role(self, session_id: str, role: str) -> Session | None:
        """Give one session the MAIN role (or take it away).

        Promoting demotes the previous main in the same step: there is exactly
        one template, and two sessions claiming it would make the inheritance
        depend on the order the sessions were listed in.
        """
        with self._lock:
            target = self._cache.get(session_id)
            if target is None:
                return None
            if role == ROLE_MAIN:
                for s in self._cache.values():
                    if s.id != session_id and s.role != ROLE_NORMAL:
                        s.role = ROLE_NORMAL
                        self._persist(s)
            target.role = role
            self._persist(target)
            return target

    def adopt(self, session: Session) -> None:
        """Put a discovered-but-unknown session into the store."""
        with self._lock:
            self._cache[session.id] = session
            self._persist(session)

    def reconcile(self, known_ids: set[str], stale_after_s: float = 0.0) -> list[Session]:
        """Return sessions whose container vanished; mark them stopped.

        `stale_after_s` also covers the other direction: a session that is
        still CREATING or STARTING but whose container does not exist (any
        more) can never become healthy. Without this such a record would stay
        "creating" forever - the manager was killed between the store write
        and the container creation - and the UI would show a session that
        does not exist and never will.
        """
        orphans: list[Session] = []
        now = time.time()
        with self._lock:
            for sid, s in list(self._cache.items()):
                if s.state in (CREATING, STARTING, STOPPING):
                    if s.state not in (CREATING, STARTING):
                        continue
                    if sid in known_ids:
                        continue
                    if stale_after_s <= 0 or (now - s.created_at) < stale_after_s:
                        continue
                    s.state = FAILED
                    s.error = "the container was never created"
                    self._persist(s)
                    orphans.append(s)
                    continue
                if sid not in known_ids and s.state == RUNNING:
                    s.state = STOPPED
                    s.stopped_at = time.time()
                    s.error = "container disappeared (removed outside the manager)"
                    self._persist(s)
                    orphans.append(s)
        return orphans
