"""Host resource sampling: RAM, CPU load, disk, and per-container usage.

The manager runs inside a container, so it reads the HOST's /proc and /sys
through bind mounts that compose.yaml provides (read-only). If those mounts are
missing the sampler degrades to container-local values and reports
``host_visible: false`` so callers never mistake them for host-wide numbers.
"""
from __future__ import annotations

import logging
import os
import shutil
import time
from dataclasses import dataclass, field, asdict
from typing import Any

log = logging.getLogger("manager.resources")

HOST_PROC = os.environ.get("HOST_PROC", "/host/proc")
HOST_SYS = os.environ.get("HOST_SYS", "/host/sys")


@dataclass
class ResourceSample:
    host_visible: bool = False
    total_memory_mb: int = 0
    free_memory_mb: int = 0
    available_memory_mb: int = 0
    committed_memory_mb: int = 0
    cpu_count: int = 0
    load_average_1m: float = 0.0
    load_per_cpu: float = 0.0
    disk_free_mb: int = 0
    disk_total_mb: int = 0
    sampled_at: float = field(default_factory=time.time)
    running_sessions: int = 0

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


def _read_meminfo(path: str) -> dict[str, int] | None:
    try:
        info: dict[str, int] = {}
        with open(path, "r", encoding="utf-8") as fh:
            for line in fh:
                key, _, value = line.partition(":")
                parts = value.split()
                if parts:
                    info[key.strip()] = int(parts[0]) * 1024  # kB -> bytes
        return info
    except (OSError, ValueError):
        return None


def _read_loadavg() -> list[float] | None:
    for base in (HOST_PROC, "/proc"):
        try:
            with open(os.path.join(base, "loadavg"), "r", encoding="utf-8") as fh:
                return [float(x) for x in fh.read().split()[:3]]
        except (OSError, ValueError):
            continue
    return None


def _cpu_count() -> int:
    for base in (HOST_SYS, "/sys"):
        try:
            with open(os.path.join(base, "devices/system/cpu/online"), "r", encoding="utf-8") as fh:
                cpu_list = fh.read().strip().split()
                total = 0
                for item in cpu_list:
                    if "-" in item:
                        lo, hi = item.split("-")
                        total += int(hi) - int(lo) + 1
                    else:
                        total += 1
                if total:
                    return total
        except (OSError, ValueError):
            continue
    return os.cpu_count() or 1


class ResourceMonitor:
    """Samples host resources at a fixed interval and caches the result."""

    def __init__(self, disk_path: str, sample_interval: int = 5) -> None:
        self.disk_path = disk_path
        self.sample_interval = sample_interval
        self._cache: ResourceSample | None = None
        self._ts = 0.0
        self._committed_bytes = 0
        self._session_count = 0

    def set_committed(self, committed_bytes: int, session_count: int) -> None:
        """Committed = sum of the memory limits of all running sessions."""
        self._committed_bytes = committed_bytes
        self._session_count = session_count

    def sample(self, force: bool = False) -> ResourceSample:
        now = time.monotonic()
        if not force and self._cache is not None and now - self._ts < self.sample_interval:
            return self._cache
        self._ts = now

        host_info = _read_meminfo(os.path.join(HOST_PROC, "meminfo"))
        visible = host_info is not None
        if not visible:
            host_info = _read_meminfo("/proc/meminfo") or {}

        total = host_info.get("MemTotal", 0)
        free = host_info.get("MemFree", 0)
        available = host_info.get("MemAvailable", free)

        load = _read_loadavg()
        load1 = load[0] if load else 0.0
        cpus = _cpu_count()

        try:
            usage = shutil.disk_usage(self.disk_path)
            disk_free, disk_total = usage.free, usage.total
        except OSError:
            disk_free = disk_total = 0

        self._cache = ResourceSample(
            host_visible=visible,
            total_memory_mb=total // (1024 * 1024),
            free_memory_mb=free // (1024 * 1024),
            available_memory_mb=available // (1024 * 1024),
            committed_memory_mb=self._committed_bytes // (1024 * 1024),
            cpu_count=cpus,
            load_average_1m=load1,
            load_per_cpu=round(load1 / cpus, 3) if cpus else 0.0,
            disk_free_mb=disk_free // (1024 * 1024),
            disk_total_mb=disk_total // (1024 * 1024),
            running_sessions=self._session_count,
        )
        return self._cache
