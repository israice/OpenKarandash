"""Thin, deliberately narrow wrapper around the Docker API.

This module is the ONLY place that touches the Docker socket. Lifecycle,
inspection, archive transfer and a narrowly wrapped non-interactive exec are
kept here; the HTTP layer remains responsible for authentication and checking
that the requested container belongs to the addressed desktop session.
Reading a file out of a session is not that: it copies bytes, it does not
execute them. Committing a container is not that either: it snapshots the
writable layer into an image, it runs nothing.

The socket is mounted read-only in compose.yaml and fronted by the
`docker-socket-proxy` container, which additionally blocks POST/DELETE on
/container endpoints, so an unauthenticated local process cannot create or
destroy containers through the proxy either.
"""
from __future__ import annotations

import io
import logging
import os
import tarfile
import tempfile
from typing import Any

import docker
from docker.errors import DockerException, NotFound

log = logging.getLogger("manager.docker")

# Ports allocated to sessions on the internal network. Never published.
VNC_PORT_BASE = 5900
VNC_PORT_MAX = 5999
DISPLAY_BASE = 1

# Capabilities a session container keeps.
#
# The desktop itself needs none of them, but `apt-get install` does: dpkg
# unpacks files as their package owner (CHOWN), writes into /var/lib/dpkg and
# /etc (DAC_OVERRIDE), sets the setuid bit (FSETID), sets file capabilities
# (SETFCAP) and runs maintainer scripts as other users (SETUID/SETGID).
#
# Everything else stays dropped: no SYS_ADMIN (so no mount, no namespace
# games), no NET_ADMIN, no SYS_PTRACE, no SYS_MODULE. The set is deliberately
# the shortest one that makes `sudo apt-get install` work.
SESSION_CAPABILITIES = [
    "CHOWN",
    "DAC_OVERRIDE",
    "FOWNER",
    "FSETID",
    "SETGID",
    "SETUID",
    "SETFCAP",
    "SYS_CHROOT",
    "KILL",
    "AUDIT_WRITE",
]

# Upper bound for one archive extraction (a directory listing or one file).
# The Docker API has no way to ask for a partial tar, so the whole thing is
# buffered; this keeps a huge home directory from eating the manager's RAM.
MAX_ARCHIVE_BYTES = 64 * 1024 * 1024

# Upper bound for the home directory copied from the main session into a new
# session. A desktop can legitimately keep installers, caches and user files
# in HOME, so 256 MiB was too small for normal use. The bytes travel through
# the manager as a tar in a temporary file, so retain a generous safety cap.
MAX_TEMPLATE_COPY_BYTES = 1024 * 1024 * 1024

# Tag prefix of the published template images.
TEMPLATE_TAG_PREFIX = "template-"

# The home directory of a session. It is a Docker volume of its own.
SESSION_HOME = "/home/desktop"

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
            # TMPDIR is the session's own home volume, NOT /tmp. The
            # container's /tmp is a small RAM-backed tmpfs (noexec), and every
            # "curl | bash" installer needs hundreds of MB of scratch space
            # there - the opencode CLI alone unpacks to ~300 MB, which does not
            # fit in 64 MB and would eat the session's RAM instead. The home
            # volume is disk-backed and private to this session.
            "TMPDIR": "/home/desktop/.tmp",
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
            # no-new-privileges is deliberately NOT set on a session: it blocks
            # setuid binaries, and without it `sudo` cannot become root inside
            # the session, so `sudo apt-get install` would fail with a
            # privilege error instead of installing the package. The session
            # is a throwaway desktop with a volume of its own; it reaches the
            # internet and the Docker network it is attached to, and nothing
            # else - no docker socket, no host mounts, hard resource limits.
            #
            # CapDrop=ALL stays, and only the capabilities dpkg needs are
            # added back (see SESSION_CAPABILITIES).
            "cap_drop": ["ALL"],
            "cap_add": list(SESSION_CAPABILITIES),
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

    def exec_create(self, container_name: str, command: list[str], workdir: str, env: dict[str, str] | None = None) -> str:
        """Create a non-interactive argv command inside one managed session."""
        if not command or any(not isinstance(part, str) or not part for part in command):
            raise ValueError("command must be a non-empty list of strings")
        container = self.client.containers.get(container_name)
        labels = container.attrs.get("Config", {}).get("Labels") or {}
        if not labels.get(SESSION_LABEL):
            raise ValueError("container is not a managed desktop session")
        created = self.client.api.exec_create(
            container.id, cmd=command, workdir=workdir, environment=env or {}, stdin=False, tty=False
        )
        return str(created["Id"])

    def exec_stream(self, exec_id: str):
        return self.client.api.exec_start(exec_id, stream=True, demux=True)

    def exec_inspect(self, exec_id: str) -> dict[str, Any]:
        return dict(self.client.api.exec_inspect(exec_id))

    def exec_kill(self, container_name: str, exec_id: str) -> None:
        """Terminate one exec process without stopping its desktop container."""
        container = self.client.containers.get(container_name)
        info = self.exec_inspect(exec_id)
        pid = info.get("Pid")
        container_id = info.get("ContainerID") or info.get("ContainerId")
        if container_id and container_id != container.id:
            raise ValueError("exec does not belong to this desktop session")
        if not pid or not container_id:
            return
        killer = self.client.api.exec_create(
            container_id, cmd=["/bin/sh", "-lc", f"kill -TERM {int(pid)}"]
        )
        self.client.api.exec_start(killer["Id"], stream=False)

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

    # --------------------------------------------------------------- files
    def _archive(self, container: str, path: str) -> bytes:
        """The raw tar the Docker API returns for a path inside a container.

        The tar is rooted at the BASENAME of the requested path, exactly like
        `docker cp container:/dir/. ./here` does: asking for /home/desktop
        yields entries named "desktop/...", asking for a file yields that one
        file. The caller works with that shape.
        """
        if not self.available:
            raise DockerUnavailable("Docker daemon is unavailable")
        try:
            stream, _stat = self.client.containers.get(container).get_archive(path)
            data = b"".join(stream)
        except NotFound:
            raise FileNotFoundError(path)
        except DockerException as exc:
            raise DockerUnavailable(f"cannot read {path} from {container}: {exc}") from exc
        if len(data) > MAX_ARCHIVE_BYTES:
            raise DockerUnavailable(
                f"{path} is larger than the {MAX_ARCHIVE_BYTES // (1024 * 1024)} MiB "
                "limit for a single download"
            )
        return data

    def list_directory(self, container: str, path: str) -> list[dict[str, Any]]:
        """The direct children of a directory inside a session container.

        Only the first level is reported: the tar contains the whole subtree
        (the Docker API offers no partial read), but a file browser must not
        drown in .cache/fontconfig.
        """
        data = self._archive(container, path)
        root = path.rstrip("/").rsplit("/", 1)[-1]
        entries: list[dict[str, Any]] = []
        with tarfile.open(fileobj=io.BytesIO(data)) as tar:
            for member in tar.getmembers():
                name = member.name.lstrip("./")
                if name == root:
                    continue
                if not name.startswith(root + "/"):
                    continue
                relative = name[len(root) + 1:]
                if not relative or "/" in relative:
                    continue          # deeper level: not a direct child
                entries.append(
                    {
                        "name": relative,
                        "is_dir": member.isdir(),
                        "size": member.size,
                        "mode": member.mode,
                        "mtime": member.mtime,
                    }
                )
        entries.sort(key=lambda e: (not e["is_dir"], e["name"].lower()))
        return entries

    def read_file(self, container: str, path: str) -> bytes:
        """The content of one file inside a session container."""
        data = self._archive(container, path)
        with tarfile.open(fileobj=io.BytesIO(data)) as tar:
            for member in tar.getmembers():
                if member.isfile():
                    handle = tar.extractfile(member)
                    if handle is not None:
                        return handle.read()
        raise FileNotFoundError(path)

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
            raise DockerUnavailable("Docker daemon is unavailable; cannot remove the desktop data volume")
        try:
            self.client.volumes.get(name).remove(force=True)
            log.info("removed volume %s", name)
            return True
        except NotFound:
            return False
        except DockerException as exc:
            raise DockerUnavailable(f"could not remove volume {name}: {exc}") from exc

    # -------------------------------------------------------------- network
    # NOTE: no network mutation here on purpose. NETWORKS=0 on the socket proxy
    # and the manager only ever attaches a session to a network Compose has
    # already created.

    # ------------------------------------------------------------ templates
    def image_exists(self, name: str) -> bool:
        if not self.available:
            return False
        try:
            self.client.images.get(name)
            return True
        except (NotFound, DockerException):
            return False

    def remove_image(self, name: str) -> bool:
        """Delete an image. Docker refuses while a container was made from it."""
        if not self.available:
            return False
        try:
            self.client.images.remove(name, force=False)
            log.info("removed image %s", name)
            return True
        except NotFound:
            return False
        except DockerException as exc:
            log.info("image %s is still in use, keeping it: %s", name, exc)
            return False

    def writable_size(self, container: str) -> int | None:
        """Size of the container's writable layer, in bytes.

        The writable layer is exactly what `sudo apt-get install` changes, so
        its size says whether the programs of the main session changed since
        the template was published. None means "cannot tell" - the caller then
        republishes.
        """
        if not self.available:
            return None
        try:
            # The low-level API is the only one that asks for the sizes.
            for entry in self.client.api.containers(all=True, size=True):
                names = entry.get("Names") or []
                if entry.get("Id") == container or any(
                    n.lstrip("/") == container for n in names
                ):
                    return int(entry.get("SizeRw") or 0)
        except DockerException as exc:
            log.warning("cannot read the writable size of %s: %s", container, exc)
        return None

    def commit_template(self, container: str, image: str, base_image: str) -> str:
        """Publish a session container as the image new sessions are created from.

        The writable layer of the container - everything `sudo apt-get install`
        put there - becomes the new image, so a session created from it starts
        with the same programs.

        The image CONFIGURATION comes from the base image, not from the
        container: the container carried session-specific variables
        (VNC_PORT, VNC_PASSWORD, DISPLAY_NUM) and baking them into the
        template would make every clone ask for a password nobody knows.
        """
        if not self.available:
            raise DockerUnavailable("Docker daemon is unavailable")
        repository, _, tag = image.partition(":")
        if not repository or not tag:
            raise ValueError(f"a template image must be repository:tag, got {image!r}")
        try:
            base_config = self.client.images.get(base_image).attrs.get("Config") or {}
        except (NotFound, DockerException) as exc:
            raise DockerUnavailable(f"cannot read the base image {base_image}: {exc}") from exc
        conf: dict[str, Any] = {}
        for key in ("Cmd", "Entrypoint", "User", "WorkingDir", "Env"):
            value = base_config.get(key)
            if value:
                conf[key] = value
        try:
            self.client.api.commit(
                container,
                repository=repository,
                tag=tag,
                message=f"template published from session {container}",
                conf=conf,
                pause=True,
            )
        except DockerException as exc:
            raise DockerUnavailable(f"cannot publish the template image {image}: {exc}") from exc
        log.info("published template image %s from %s", image, container)
        return image

    def copy_home(self, src_container: str, dst_container: str, path: str = SESSION_HOME) -> int:
        """Copy the home directory of one session into another one.

        The Docker API has no "copy between volumes" call, so the bytes travel
        through the manager as a tar: the source archive is read into a
        temporary file, the root directory the API adds is stripped (the
        archive is rooted at the base name of the requested path, while
        put_archive extracts INTO the target directory), and the result is
        written into the destination container - where that path IS the
        destination session's own volume.

        Ownership and timestamps travel with the archive, so the copied files
        belong to the session user (uid 1000) exactly like the originals.
        Writing into the volume before the container starts is safe: Docker
        fills the volume from the image at start, but it does not overwrite
        files that are already there.
        """
        if not self.available:
            raise DockerUnavailable("Docker daemon is unavailable")
        try:
            source = self.client.containers.get(src_container)
            target = self.client.containers.get(dst_container)
        except (NotFound, DockerException) as exc:
            raise DockerUnavailable(f"cannot copy the home directory: {exc}") from exc

        src_tmp = tempfile.NamedTemporaryFile(prefix="wd-src-", suffix=".tar", delete=False)
        dst_tmp = tempfile.NamedTemporaryFile(prefix="wd-dst-", suffix=".tar", delete=False)
        try:
            stream, _ = source.get_archive(path)
            written = 0
            for chunk in stream:
                written += len(chunk)
                if written > MAX_TEMPLATE_COPY_BYTES:
                    raise DockerUnavailable(
                        f"the home directory of {src_container} is larger than the "
                        f"{MAX_TEMPLATE_COPY_BYTES // (1024 * 1024)} MiB limit for a clone"
                    )
                src_tmp.write(chunk)
            src_tmp.flush()
            src_tmp.seek(0)

            root = path.rstrip("/").rsplit("/", 1)[-1]
            count = 0
            with tarfile.open(fileobj=src_tmp, mode="r|") as tar_in:
                with tarfile.open(fileobj=dst_tmp, mode="w|") as tar_out:
                    for member in tar_in:
                        name = member.name
                        if name.startswith("./"):
                            name = name[2:]
                        if name == root:
                            continue          # the root directory itself
                        prefix = root + "/"
                        if not name.startswith(prefix):
                            continue
                        member.name = name[len(prefix):]
                        if member.isfile():
                            tar_out.addfile(member, tar_in.extractfile(member))
                        else:
                            tar_out.addfile(member)
                        count += 1
            dst_tmp.flush()
            dst_tmp.seek(0)

            target.put_archive(path, dst_tmp)
            log.info(
                "copied %d entries of %s from %s to %s",
                count, path, src_container, dst_container,
            )
            return count
        except DockerException as exc:
            raise DockerUnavailable(f"cannot copy the home directory: {exc}") from exc
        finally:
            for tmp in (src_tmp, dst_tmp):
                try:
                    os.unlink(tmp.name)
                except OSError:
                    pass
