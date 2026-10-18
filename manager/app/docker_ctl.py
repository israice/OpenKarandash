"""Thin, deliberately narrow wrapper around the Docker API.

This module is the ONLY place that touches the Docker socket, and it only ever
calls: create_container, start, stop, remove, inspect, list, logs. There is no
exec, no attach, no commit, no image build - the manager has no way to run code
inside a session container even if it were compromised through the API.

The socket is mounted read-only in compose.yaml and fronted by the
`docker-socket-proxy` container, which additionally blocks POST/DELETE on
/container endpoints, so an unauthenticated local process cannot create or
destroy containers through the proxy either.
"""
from __future__ import annotations

import logging
from typing import Any

import docker
from docker.errors import DockerException, NotFound

log = logging.getLogger("manager.docker")

# Ports allocated to sessions on the internal network. Never published.
VNC_PORT_BASE = 5900
VNC_PORT_MAX = 5999
DISPLAY_BASE = 1

# Label carried by every container the manager creates. It is the ONLY reliable
# way to tell a session apart from the compose services, and it is what the
# shutdown teardown filters on.
SESSION_LABEL = "webdesktop.session"


def _cgroup_v2() -> bool:
    """cgroup v2 hosts reject blkio_weight; detect instead of assuming."""
    import os

    return os.path.isfile("/sys/fs/cgroup/cgroup.controllers")


class DockerUnavailable(RuntimeError):
    pass


# Fallback addresses tried when the configured DOCKER_HOST is unreachable.
# Docker Desktop for Windows exposes the daemon on TCP only after enabling
# "Expose daemon on tcp://localhost:2375 without TLS" in Settings -> General.
_DOCKER_FALLBACK_URLS = (
    "tcp://host.docker.internal:2375",
    "tcp://127.0.0.1:2375",
    "tcp://localhost:2375",
)


def _resolve_ipv4(host: str) -> str | None:
    """Return the first IPv4 address for *host*, or None."""
    import socket

    try:
        infos = socket.getaddrinfo(host, None, socket.AF_INET)
        if infos:
            return infos[0][4][0]
    except OSError:
        pass
    return None


class DockerControl:
    def __init__(self, base_url: str | None = None, timeout: int = 60) -> None:
        self.available = False
        self.client = None
        kwargs: dict[str, Any] = {"timeout": timeout, "version": "auto"}
        urls: list[str] = []
        if base_url:
            urls.append(base_url)
        urls.extend(_DOCKER_FALLBACK_URLS)

        last: Exception | None = None
        for url in urls:
            try:
                kwargs["base_url"] = url
                client = docker.DockerClient(**kwargs)
                client.ping()
                self.client = client
                self.available = True
                if url != (base_url or urls[0]):
                    log.info("connected to Docker daemon at fallback URL %s", url)
                return
            except DockerException as exc:
                last = exc
                continue
        log.warning("Docker daemon unreachable (%s); manager will start without Docker", last)

    # ---------------------------------------------------------------- ports
    def session_ports(self) -> set[int]:
        """Ports already claimed by running containers.

        Session containers publish nothing to the host, so Docker's own port
        bookkeeping is empty. The env var VNC_PORT inside each container is the
        authoritative record of which ports are in use.
        """
        if not self.available:
            return set()
        used: set[int] = set()
        for c in self.client.containers.list():
            env = c.attrs.get("Config", {}).get("Env") or []
            for entry in env:
                if entry.startswith("VNC_PORT="):
                    try:
                        used.add(int(entry.split("=", 1)[1]))
                    except ValueError:
                        pass
            for net in (c.attrs.get("NetworkSettings", {}).get("Networks", {}) or {}).values():
                for port, binding in (net.get("Ports") or {}).items():
                    if port.endswith("/tcp") and binding:
                        used.add(int(port.split("/")[0]))
        return used

    def allocate_port(self, taken: set[int]) -> int:
        for port in range(VNC_PORT_BASE, VNC_PORT_MAX + 1):
            if port not in taken:
                return port
        raise DockerUnavailable(
            f"no free VNC port left in the {VNC_PORT_BASE}-{VNC_PORT_MAX} range "
            f"(in use: {sorted(taken)})"
        )

    @staticmethod
    def display_for(port: int) -> int:
        return DISPLAY_BASE + (port - VNC_PORT_BASE)

    # ------------------------------------------------------------ lifecycle
    def create_session_container(
        self,
        *,
        name: str,
        image: str,
        vnc_port: int,
        display_num: int,
        resolution: str,
        volume_name: str,
        network: str,
        memory_mb: int,
        cpus: float,
        cpu_shares: int,
        blkio_weight: int,
        cgroup_v2: bool = True,
        pids_limit: int,
        memory_swap_mb: int,
        tmpfs_mb: int,
        vnc_password: str,
        extra_env: dict[str, str] | None = None,
        labels: dict[str, str] | None = None,
    ) -> str:
        env = {
            "DISPLAY_NUM": str(display_num),
            "SCREEN_GEOMETRY": f"{resolution}x24",
            "VNC_RESOLUTION": resolution,
            "VNC_PORT": str(vnc_port),
            "HOME": "/home/desktop",
        }
        if vnc_password:
            env["VNC_PASSWORD"] = vnc_password
        env.update(extra_env or {})

        host_config: dict[str, Any] = {
            # No published ports at all: VNC is reachable only from this
            # manager over the internal compose network.
            "network_mode": network,
            "ports": {},
            "volumes": {volume_name: {"bind": "/home/desktop", "mode": "rw"}},
            # Hard resource limits.
            "mem_limit": f"{memory_mb}m" if memory_mb else None,
            # Docker treats MemorySwap == Memory as "no swap at all" and
            # MemorySwap == 0 as "unset", which makes the daemon fall back to
            # twice the memory limit. Setting it equal to the memory limit is
            # the only way to actually say "this container may not swap".
            "memswap_limit": (
                f"{memory_swap_mb}m"
                if memory_swap_mb
                else (f"{memory_mb}m" if memory_mb else None)
            ),
            "nano_cpus": int(cpus * 1_000_000_000) if cpus else None,
            "cpu_shares": cpu_shares if not cpus else None,
            # Only meaningful on cgroup v1. On cgroup v2 the daemon fails the
            # container with "openat2 .../io.weight: no such file", so this is
            # 0 (omitted) unless the operator explicitly asks for it.
            "blkio_weight": blkio_weight if blkio_weight and not cgroup_v2 else None,
            "pids_limit": pids_limit if pids_limit > 0 else None,
            "restart_policy": {"Name": "unless-stopped"},
            "security_opt": ["no-new-privileges:true"],
            "cap_drop": ["ALL"],
            "read_only": False,
            "tmpfs": {"/tmp": f"rw,size={tmpfs_mb}m,mode=1777"} if tmpfs_mb else {},
        }
        # Drop the keys that are None so the daemon uses its own defaults.
        host_config = {k: v for k, v in host_config.items() if v is not None}

        if not self.available:
            log.warning("Docker unavailable: cannot create container %s", name)
            return f"unavailable-{name}"
        try:
            container = self.client.containers.create(
                image=image,
                environment=env,
                command=[],                      # use the image ENTRYPOINT
                name=name,
                hostname=name,
                labels=labels or {},
                **host_config,
            )
        except DockerException as exc:
            raise DockerUnavailable(f"failed to create container {name}: {exc}") from exc
        log.info("created container %s (display :%s, vnc %d)", name, display_num, vnc_port)
        return container.id

    def start(self, container_id: str) -> None:
        if not self.available:
            log.warning("Docker unavailable: cannot start %s", container_id)
            return
        try:
            self.client.containers.get(container_id).start()
        except DockerException as exc:
            raise DockerUnavailable(f"failed to start {container_id}: {exc}") from exc

    def stop(self, container_id: str, timeout: int = 15) -> None:
        if not self.available:
            log.warning("Docker unavailable: cannot stop %s", container_id)
            return
        try:
            self.client.containers.get(container_id).stop(timeout=timeout)
        except NotFound:
            pass
        except DockerException as exc:
            raise DockerUnavailable(f"failed to stop {container_id}: {exc}") from exc

    def remove(self, container_id: str, remove_volume: bool = False) -> None:
        if not self.available:
            log.warning("Docker unavailable: cannot remove %s", container_id)
            return
        try:
            self.client.containers.get(container_id).remove(
                v=remove_volume, force=True
            )
        except NotFound:
            pass
        except DockerException as exc:
            raise DockerUnavailable(f"failed to remove {container_id}: {exc}") from exc

    # -------------------------------------------------------------- queries
    def inspect(self, container_id: str) -> dict[str, Any] | None:
        if not self.available:
            return None
        try:
            return self.client.containers.get(container_id).attrs
        except NotFound:
            return None
        except DockerException as exc:
            log.warning("inspect failed for %s: %s", container_id, exc)
            return None

    def find_by_name(self, name: str) -> dict[str, Any] | None:
        if not self.available:
            return None
        try:
            return self.client.containers.get(name).attrs
        except NotFound:
            return None
        except DockerException:
            return None

    def list_sessions(self, name_prefix: str) -> list[dict[str, Any]]:
        """Containers that the manager created.

        Filtered by the `webdesktop.session` LABEL, not by name prefix: the
        compose services are called wd-manager / wd-docker-proxy / wd-desktop-
        image and would otherwise be mistaken for user desktops.
        """
        if not self.available:
            return []
        out: list[dict[str, Any]] = []
        try:
            for c in self.client.containers.list(all=True):
                labels = c.attrs.get("Config", {}).get("Labels") or {}
                if labels.get(SESSION_LABEL):
                    out.append(c.attrs)
                else:
                    log.debug("ignoring non-session container %s", c.attrs.get("Name"))
        except DockerException as exc:
            log.warning("container list failed: %s", exc)
        return out

    def stop_session_containers(self, stop_timeout: int = 10) -> list[str]:
        """STOP every container this manager created, keep the containers.

        Session containers are NOT compose services, so `docker compose down`
        cannot stop or remove them, and it fails with "Network
        webdesktop_sessions Resource is still in use" while they run.

        Stopping (rather than removing) is what makes the teardown correct in
        both directions:
          * compose down  -> the network is free, and the session's home volume
                             and container survive for a later `up`;
          * manager restart -> startup resumes exactly the sessions that were
                             running, so nothing is silently lost.
        A stopped container releases its endpoint, an endpoint on a stopped
        container does not block `docker network rm`.

        Filters by the `webdesktop.session` LABEL, so wd-manager / wd-proxy /
        unrelated containers are never touched. Returns the names stopped.
        """
        if not self.available:
            return []
        stopped: list[str] = []
        try:
            containers = self.client.containers.list(
                all=True, filters={"label": SESSION_LABEL}
            )
        except DockerException as exc:
            log.warning("could not list session containers for shutdown: %s", exc)
            return stopped
        for c in containers:
            name = (c.attrs.get("Name") or c.short_id).lstrip("/")
            if not c.attrs.get("State", {}).get("Running"):
                continue
            try:
                c.stop(timeout=stop_timeout)
                stopped.append(name)
                log.info("stopped session container %s on shutdown", name)
            except (NotFound, DockerException) as exc:
                log.warning("could not stop session container %s: %s", name, exc)
        return stopped

    def recreate_session_container(
        self,
        *,
        name: str,
        image: str,
        labels: dict[str, str],
        **kwargs,
    ) -> str:
        """Remove a stale container and create an equivalent one under the same name.

        Used to recover a session that cannot be started because it still
        references a network that no longer exists - the normal state after
        `docker compose down` followed by `up`, because compose deletes and
        recreates the sessions network with a NEW id.

        The session's home VOLUME is untouched (it is a separate object, and
        `remove(v=False)` is deliberate), so the user's files survive; only the
        container is replaced. There is no way to fix this in place: the
        socket proxy is configured with NETWORKS=0 so the manager cannot touch
        network endpoints, which is a deliberate security boundary.
        """
        if not self.available:
            log.warning("Docker unavailable: cannot recreate container %s", name)
            return f"unavailable-{name}"
        try:
            existing = self.client.containers.get(name)
        except NotFound:
            existing = None
        except DockerException as exc:
            raise DockerUnavailable(f"could not look up container {name}: {exc}") from exc

        if existing is not None:
            try:
                # v=False: keep the anonymous/home volume mount data.
                existing.remove(force=True)
                log.info("removed stale container %s (its network no longer exists)", name)
            except (NotFound, DockerException) as exc:
                raise DockerUnavailable(f"could not remove stale container {name}: {exc}") from exc

        return self.create_session_container(name=name, image=image, labels=labels, **kwargs)

    def container_running(self, container_id: str) -> bool:
        attrs = self.inspect(container_id)
        return bool(attrs and attrs.get("State", {}).get("Running"))

    def health(self, container_id: str) -> str:
        attrs = self.inspect(container_id)
        if not attrs:
            return "missing"
        state = attrs.get("State", {})
        if not state.get("Running"):
            return "exited"
        health = (state.get("Health") or {}).get("Status")
        if health:
            return health
        return "running"

    def stats(self, container_id: str) -> dict[str, Any] | None:
        """One-shot stats. Disabled by default: it is expensive."""
        if not self.available:
            return None
        try:
            raw = self.client.containers.get(container_id).stats(stream=False)
        except (NotFound, DockerException):
            return None
        mem = raw.get("memory_stats", {}) or {}
        cpu = raw.get("cpu_stats", {}) or {}
        pre = raw.get("precpu_stats", {}) or {}
        try:
            cpu_delta = cpu["cpu_usage"]["total_usage"] - pre["cpu_usage"]["total_usage"]
            sys_delta = cpu["system_cpu_usage"] - pre["system_cpu_usage"]
            cpus = cpu["online_cpus"] or len(cpu["cpu_usage"].get("percpu_usage") or []) or 1
            cpu_pct = (cpu_delta / sys_delta) * cpus * 100.0 if sys_delta > 0 else 0.0
        except (KeyError, ZeroDivisionError, TypeError):
            cpu_pct = 0.0
        return {
            "memory_usage_mb": int(mem.get("usage", 0) / 1048576),
            "memory_limit_mb": int(mem.get("limit", 0) / 1048576),
            "cpu_percent": round(cpu_pct, 2),
        }

    # ------------------------------------------------------------- volumes
    def volume_exists(self, name: str) -> bool:
        if not self.available:
            return False
        try:
            self.client.volumes.get(name)
            return True
        except NotFound:
            return False
        except DockerException:
            return False

    def remove_volume(self, name: str) -> bool:
        if not self.available:
            return False
        try:
            self.client.volumes.get(name).remove(force=True)
            log.info("removed volume %s", name)
            return True
        except NotFound:
            return False
        except DockerException as exc:
            log.warning("could not remove volume %s: %s", name, exc)
            return False

    # -------------------------------------------------------------- network
    # NOTE: no network mutation here on purpose. NETWORKS=0 on the socket proxy
    # and the manager only ever attaches a session to a network Compose has
    # already created.
