"""Admission control and the creation queue.

Docker Compose is not a resource scheduler: it will happily start a hundred
containers on a host that has no memory left. This module is the piece that
makes the "small single server" requirement real.

Two hard rules:
  1. Running sessions are NEVER killed because a limit was reached. Limits
     only gate NEW sessions.
  2. Every refusal and every queue wait is explained in the response, so the
     operator can tell "at capacity" from "out of memory".
"""
from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from itertools import count
from typing import Any, Callable

log = logging.getLogger("manager.scheduler")


@dataclass
class Decision:
    allowed: bool
    reason: str = ""
    detail: str = ""
    # Set when the request must wait for capacity to free up.
    wait: bool = False


@dataclass
class Waiter:
    event: asyncio.Event = field(default_factory=asyncio.Event)
    reason: str = ""
    created_at: float = field(default_factory=time.monotonic)


class AdmissionController:
    def __init__(self, config, monitor) -> None:
        self.cfg = config
        self.monitor = monitor
        self._queue: list[Waiter] = []
        self._lock = asyncio.Lock()
        # Slots handed out to admitted requests whose session is not visible to
        # _running_sessions() yet. One entry per request, keyed by a unique
        # token: a set of a single constant would cap reservations at 1 no
        # matter how many creates are in flight.
        self._reserved: set[str] = set()
        self._tokens = count(1)

    # ---------------------------------------------------------------- rules
    def evaluate(self, running_count: int, requested_memory_mb: int) -> Decision:
        a = self.cfg.get("resources.admission", {})
        s = self.monitor.sample()

        max_sessions = int(a.get("max_sessions", 20))
        if running_count + len(self._reserved) >= max_sessions:
            return Decision(
                allowed=False,
                reason="max_sessions",
                detail=f"{running_count} of {max_sessions} sessions already allocated",
            )

        if not s.host_visible:
            log.warning(
                "host /proc is not visible from the manager container; memory "
                "admission checks fall back to container-local values"
            )

        min_free = int(a.get("min_free_memory_mb", 700))
        if min_free and s.available_memory_mb < min_free:
            return Decision(
                allowed=False,
                reason="insufficient_free_memory",
                detail=(
                    f"only {s.available_memory_mb} MiB available, "
                    f"{min_free} MiB required before starting a session"
                ),
            )

        reserve = int(a.get("reserve_memory_mb", 512))
        if reserve:
            headroom = s.available_memory_mb - requested_memory_mb - reserve
            if headroom < 0:
                return Decision(
                    allowed=False,
                    reason="insufficient_memory_headroom",
                    detail=(
                        f"a session with a {requested_memory_mb} MiB limit plus the "
                        f"{reserve} MiB reserve exceeds the {s.available_memory_mb} MiB "
                        f"currently available"
                    ),
                )

        min_disk = int(a.get("min_free_disk_mb", 2048))
        if min_disk and s.disk_free_mb and s.disk_free_mb < min_disk:
            return Decision(
                allowed=False,
                reason="insufficient_disk",
                detail=f"{s.disk_free_mb} MiB free on disk, {min_disk} MiB required",
            )

        max_load = float(a.get("max_load_per_cpu", 0) or 0)
        if max_load and s.load_per_cpu > max_load:
            return Decision(
                allowed=False,
                reason="host_overloaded",
                detail=(
                    f"load average {s.load_average_1m:.2f} over {s.cpu_count} CPU(s) "
                    f"exceeds the limit of {max_load} per CPU"
                ),
            )

        return Decision(allowed=True)

    # ---------------------------------------------------------------- queue
    def queue_length(self) -> int:
        return len(self._queue)

    async def acquire(
        self,
        running_count_fn: Callable[[], int],
        requested_mb: int,
        timeout: float | None = None,
    ) -> tuple[bool, str, str, str]:
        """Admit immediately, wait in the queue, or refuse.

        Returns (admitted, reason, detail, token). The token identifies this
        request's reservation and MUST be handed to release_reservation() once
        the session becomes visible to running_count_fn (or creation failed).
        """
        a = self.cfg.get("resources.admission", {})
        action = str(a.get("overload_action", "queue")).lower()
        if timeout is None:
            timeout = float(a.get("queue_timeout_s", 120))

        async with self._lock:
            decision = self.evaluate(running_count_fn(), requested_mb)
            if decision.allowed:
                return True, "", "", self._reserve_locked()

            if action != "queue":
                return False, decision.reason, decision.detail, ""

            max_queue = int(a.get("max_queue", 10))
            if len(self._queue) >= max_queue:
                return False, "queue_full", f"{len(self._queue)} requests already waiting", ""

            waiter = Waiter(reason=decision.reason)
            self._queue.append(waiter)
            log.info("session queued (%s), position %d", decision.reason, len(self._queue))

        try:
            await asyncio.wait_for(waiter.event.wait(), timeout=timeout)
        except asyncio.TimeoutError:
            async with self._lock:
                if waiter in self._queue:
                    self._queue.remove(waiter)
            return False, "queue_timeout", f"waited more than {timeout:.0f}s for capacity", ""

        async with self._lock:
            if waiter in self._queue:
                self._queue.remove(waiter)
            decision = self.evaluate(running_count_fn(), requested_mb)
            if decision.allowed:
                return True, "", "", self._reserve_locked()
            return False, decision.reason, decision.detail, ""

    def _reserve_locked(self) -> str:
        """Take one slot. Caller must hold self._lock."""
        token = f"pending-{next(self._tokens)}"
        self._reserved.add(token)
        return token

    async def release_reservation(self, token: str) -> None:
        """Give a slot back. Releasing an unknown token is a no-op."""
        if not token:
            return
        async with self._lock:
            self._reserved.discard(token)

    @property
    def reserved_count(self) -> int:
        """Slots currently held by creates that are not visible yet."""
        return len(self._reserved)

    def notify_all(self) -> None:
        """Wake queued waiters so they can re-evaluate."""
        for waiter in list(self._queue):
            waiter.event.set()

    # -------------------------------------------------------------- snapshot
    def status(self, running_count: int) -> dict[str, Any]:
        s = self.monitor.sample()
        a = self.cfg.get("resources.admission", {})
        per = self.cfg.get("resources.per_session", {})
        return {
            "sessions_running": running_count,
            "sessions_max": int(a.get("max_sessions", 20)),
            "queue_length": len(self._queue),
            "slots_reserved": self.reserved_count,
            "limits": {
                "memory_per_session_mb": per.get("memory_mb"),
                "cpus_per_session": per.get("cpus"),
                "pids_per_session": per.get("pids_limit"),
                "max_sessions": a.get("max_sessions"),
                "min_free_memory_mb": a.get("min_free_memory_mb"),
                "reserve_memory_mb": a.get("reserve_memory_mb"),
                "min_free_disk_mb": a.get("min_free_disk_mb"),
                "max_load_per_cpu": a.get("max_load_per_cpu"),
                "overload_action": a.get("overload_action"),
            },
            "host": {
                "visible": s.host_visible,
                "total_memory_mb": s.total_memory_mb,
                "available_memory_mb": s.available_memory_mb,
                "committed_memory_mb": s.committed_memory_mb,
                "cpu_count": s.cpu_count,
                "load_average_1m": s.load_average_1m,
                "load_per_cpu": s.load_per_cpu,
                "disk_free_mb": s.disk_free_mb,
                "disk_total_mb": s.disk_total_mb,
            },
        }


async def periodic_notify(admission: AdmissionController, interval: float = 5.0) -> None:
    """Periodically re-evaluate queued waiters."""
    while True:
        await asyncio.sleep(interval)
        if admission.queue_length():
            admission.notify_all()
