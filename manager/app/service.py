"""Session lifecycle orchestration: create, start, stop, restart, delete."""
from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from pathlib import Path
from typing import Any

from docker.errors import DockerException

from . import store as st
from .docker_ctl import (
    TEMPLATE_TAG_PREFIX,
    DockerControl,
    DockerUnavailable,
)
from .store import Session, SessionStore

log = logging.getLogger("manager.service")


class CapacityError(Exception):
    def __init__(self, reason: str, detail: str) -> None:
        super().__init__(detail)
        self.reason = reason
        self.detail = detail


class SessionNotFound(Exception):
    pass


class SessionService:
    def __init__(
        self,
        config,
        store: SessionStore,
        docker: DockerControl,
        admission,
        network_name: str,
    ) -> None:
        self.cfg = config
        self.store = store
        self.docker = docker
        self.admission = admission
        self.network = network_name
        self._tasks: dict[str, asyncio.Task] = {}

    # ------------------------------------------------------------- helpers
    def _per_session_cfg(self) -> dict[str, Any]:
        return self.cfg.get("resources.per_session", {})

    def _running_sessions(self) -> list[Session]:
        return [s for s in self.store.active() if s.state in (st.RUNNING, st.STARTING)]

    def refresh_resource_ledger(self) -> None:
        committed = 0
        for s in self._running_sessions():
            mb = int(s.memory_limit_mb)
            if not mb:
                # Adopted session: ask Docker what limit the container really has.
                attrs = self.docker.find_by_name(s.container_name) or {}
                mb = int(attrs.get("HostConfig", {}).get("Memory", 0)) // (1024 * 1024)
            committed += mb * 1024 * 1024
        self.admission.monitor.set_committed(committed, len(self._running_sessions()))

    def _container_id(self, s: Session) -> str | None:
        attrs = self.docker.find_by_name(s.container_name)
        if not attrs:
            return None
        return attrs.get("Id")

    # --------------------------------------------------------------- create
    async def create(
        self,
        *,
        owner: str,
        resolution: str | None = None,
        vnc_password: str | None = None,
        max_wait: float | None = None,
        inherit: bool = True,
    ) -> Session:
        per = self._per_session_cfg()
        sess_defaults = self.cfg.get("session_defaults", {})
        memory_mb = int(per.get("memory_mb", 512))

        admission_cfg = self.cfg.get("resources.admission", {})
        if max_wait is None:
            max_wait = float(admission_cfg.get("queue_timeout_s", 120))

        # The token identifies THIS request's reservation. Between admission and
        # the moment the session reaches STARTING it is not visible to
        # _running_sessions(), so the reservation is what stops two concurrent
        # requests from both claiming the last free slot.
        admitted, reason, detail, token = await self.admission.acquire(
            lambda: len(self._running_sessions()), memory_mb, timeout=max_wait
        )
        if not admitted:
            self.admission.notify_all()
            raise CapacityError(reason, detail)
        self.admission.notify_all()

        # A new session is a clone of the main one: the programs come from the
        # published template image, the files from the main session's home
        # directory (copied further down, once the container exists).
        main = self.store.main_session() if inherit else None
        template_image: str | None = None
        if main is not None:
            try:
                # Publishing commits an image - seconds of blocking work.
                template_image = await asyncio.to_thread(self._publish_template, main)
            except DockerUnavailable as exc:
                await self.admission.release_reservation(token)
                raise CapacityError("docker_error", str(exc)) from exc

        session_id = SessionStore.new_id()
        resolution = resolution or sess_defaults.get("resolution", "1440x900")
        password = vnc_password if vnc_password is not None else sess_defaults.get("vnc_password", "")
        if password and len(password) > 8:
            raise ValueError(
                "VNC password is limited to 8 characters by the RFB protocol"
            )

        session = Session(
            id=session_id,
            owner=owner,
            state=st.CREATING,
            image=template_image or sess_defaults.get("image", "webdesktop:lxde"),
            resolution=resolution,
            container_name=self.cfg.container_name(session_id),
            volume_name=self.cfg.volume_name(session_id),
            memory_limit_mb=memory_mb,
            cpu_limit=float(per.get("cpus", 0.5) or 0),
            url_path=f"/s/{session_id}/",
            has_vnc_password=bool(password),
            labels={"webdesktop.session": session_id, "webdesktop.owner": owner},
        )
        # The first desktop is the user's main desktop by default.  Without
        # this, cloning only starts after the user explicitly presses
        # "Make main", which makes the additional-desktop button appear to
        # lose all changes made in the first desktop.
        if inherit and self.store.main_session() is None:
            session.role = st.ROLE_MAIN

        try:
            # Ports claimed by live containers PLUS ports reserved by sessions
            # that are being created right now (their container may not be
            # visible to the Docker API for a few hundred milliseconds).
            taken = self.docker.session_ports()
            taken |= {s.vnc_port for s in self.store.active() if s.id != session_id}
            vnc_port = self.docker.allocate_port(taken)
            session.vnc_port = vnc_port
            session.display_num = DockerControl.display_for(vnc_port)
            self.store.create(session)

            if not self.docker.available:
                log.warning("Docker unavailable: cannot pre-create volume %s", session.volume_name)
            elif not self.docker.volume_exists(session.volume_name):
                try:
                    self.docker.client.volumes.create(
                        name=session.volume_name,
                        # Labelled so a clean teardown can find every session
                        # volume without guessing names from container names.
                        labels={"webdesktop.session": session_id, "webdesktop.owner": owner},
                    )
                except DockerException as exc:
                    # Not fatal: Docker creates a named volume on first use,
                    # so the explicit call is only about visibility/ordering.
                    log.warning("could not pre-create volume %s: %s", session.volume_name, exc)

            container_id = self.docker.create_session_container(
                name=session.container_name,
                image=session.image,
                vnc_port=vnc_port,
                display_num=session.display_num,
                resolution=resolution,
                volume_name=session.volume_name,
                network=self.network,
                memory_mb=memory_mb,
                cpus=float(per.get("cpus", 0.5) or 0),
                cpu_shares=int(per.get("cpu_shares", 512)),
                blkio_weight=int(per.get("blkio_weight", 500)),
                pids_limit=int(per.get("pids_limit", 512)),
                memory_swap_mb=int(per.get("memory_swap_mb", 0)),
                tmpfs_mb=int(per.get("tmpfs_mb", 64)),
                vnc_password=password,
                extra_env={str(k): str(v) for k, v in (sess_defaults.get("extra_env") or {}).items()},
                labels={"webdesktop.session": session_id, "webdesktop.owner": owner},
            )
            if main is not None:
                # The home directory is copied live from the main session, so
                # files and desktop settings are inherited exactly as they are
                # right now - no snapshot, no waiting for a publish.
                await asyncio.to_thread(
                    self.docker.copy_home, main.container_name, session.container_name
                )
            self.store.update(session_id, state=st.STARTING)
            self.docker.start(container_id)
            # STARTING sessions are counted by _running_sessions() from here on,
            # so the reservation has done its job and must be handed back.
            await self.admission.release_reservation(token)
        except DockerUnavailable as exc:
            await self.admission.release_reservation(token)
            self.store.update(session_id, state=st.FAILED, error=str(exc))
            raise CapacityError("docker_error", str(exc)) from exc
        except Exception as exc:  # noqa: BLE001 - cleanup then re-raise
            await self.admission.release_reservation(token)
            self.store.update(session_id, state=st.FAILED, error=f"{type(exc).__name__}: {exc}")
            raise

        task = asyncio.create_task(self._await_ready(session_id))
        self._tasks[session_id] = task
        return session

    async def _await_ready(self, session_id: str) -> None:
        """Wait for the container healthcheck, then mark the session RUNNING."""
        timeout = float(self.cfg.get("docker.ready_timeout_s", 90))
        deadline = time.monotonic() + timeout
        try:
            while time.monotonic() < deadline:
                s = self.store.get(session_id)
                if s is None:
                    return
                container_id = self._container_id(s)
                if container_id is None:
                    self.store.update(session_id, state=st.FAILED, error="container vanished")
                    return
                health = self.docker.health(container_id)
                if health == "healthy":
                    self.store.update(
                        session_id,
                        state=st.RUNNING,
                        started_at=time.time(),
                        last_seen=time.time(),
                        error=None,
                    )
                    log.info("session %s is ready", session_id)
                    self.refresh_resource_ledger()
                    return
                if health in ("exited", "missing"):
                    self.store.update(session_id, state=st.FAILED, error=f"container {health}")
                    return
                await asyncio.sleep(2)
            s = self.store.get(session_id)
            if s and s.state in (st.STARTING, st.CREATING):
                self.store.update(
                    session_id,
                    state=st.FAILED,
                    error=f"did not become healthy within {timeout:.0f}s",
                )
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            log.exception("readiness watcher failed for %s", session_id)
            self.store.update(session_id, state=st.FAILED, error=str(exc))
        finally:
            self.refresh_resource_ledger()

    # ------------------------------------------------------------- template
    def set_main(self, session_id: str) -> Session:
        """Make this session the one new sessions are cloned from."""
        self.get(session_id)
        updated = self.store.set_role(session_id, st.ROLE_MAIN)
        log.info("session %s is now the main session", session_id)
        return updated  # type: ignore[return-value]

    def unmake_main(self, session_id: str) -> Session:
        """Stop cloning new sessions from this one."""
        self.get(session_id)
        updated = self.store.set_role(session_id, st.ROLE_NORMAL)
        log.info("session %s is no longer the main session", session_id)
        return updated  # type: ignore[return-value]

    def _template_state_path(self) -> Path:
        state_dir = self.cfg.get("manager.state_dir", "/var/lib/session-manager")
        return Path(state_dir) / "template.json"

    def _load_template(self) -> dict[str, Any]:
        try:
            with self._template_state_path().open("r", encoding="utf-8") as fh:
                return json.load(fh)
        except (OSError, ValueError):
            return {}

    def _save_template(self, data: dict[str, Any]) -> None:
        path = self._template_state_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(path.name + ".tmp")
        with tmp.open("w", encoding="utf-8") as fh:
            json.dump(data, fh, indent=2, sort_keys=True)
        os.replace(tmp, path)

    def template_info(self) -> dict[str, Any]:
        """What new sessions are cloned from right now."""
        state = self._load_template()
        main = self.store.main_session()
        return {
            "main": main.summary_dict() if main else None,
            "image": state.get("image"),
            "published_at": state.get("published_at"),
            "source": state.get("source"),
        }

    def _publish_template(self, main: Session) -> str:
        """Publish the main session as the image every new session starts from.

        The image carries the writable layer of the main session - the
        programs that were installed in it - so a new session starts with the
        same software. It is published again only when that layer changed:
        every publish copies the whole layer, and doing it on every session
        creation would fill the disk with images nobody uses.
        """
        base_image = self.cfg.get("session_defaults.image", "webdesktop:lxde")
        state = self._load_template()
        size = self.docker.writable_size(main.container_name)
        if (
            state.get("source") == main.id
            and state.get("image")
            and size is not None
            and size == state.get("size_rw")
            and self.docker.image_exists(state["image"])
        ):
            return str(state["image"])

        repository = base_image.rsplit(":", 1)[0] if ":" in base_image else base_image
        image = f"{repository}:{TEMPLATE_TAG_PREFIX}{time.strftime('%Y%m%d-%H%M%S')}"
        self.docker.commit_template(main.container_name, image, base_image)
        self._save_template({
            "image": image,
            "source": main.id,
            "published_at": time.time(),
            "size_rw": size,
        })
        self._drop_stale_templates(repository, keep=image)
        return image

    def _drop_stale_templates(self, repository: str, keep: str) -> None:
        """Delete template images that no session was created from.

        Every publish copies the whole writable layer of the main session, so
        without this the disk fills up with images nobody uses. An image a
        session was created from cannot be removed - Docker refuses - and is
        left for `docker image prune`.
        """
        try:
            images = self.docker.client.images.list(repository)
        except DockerException as exc:
            log.warning("cannot list the template images: %s", exc)
            return
        for image in images:
            for tag in image.attrs.get("RepoTags") or []:
                if not tag.startswith(f"{repository}:{TEMPLATE_TAG_PREFIX}") or tag == keep:
                    continue
                self.docker.remove_image(tag)

    # ------------------------------------------------------------ lifecycle
    def get(self, session_id: str) -> Session:
        s = self.store.get(session_id)
        if s is None:
            raise SessionNotFound(session_id)
        return s

    def status(self, session_id: str) -> dict[str, Any]:
        s = self.get(session_id)
        data = s.public_dict()
        container_id = self._container_id(s)
        data["container"] = {
            "id": (container_id or "")[:12],
            "present": container_id is not None,
            "health": self.docker.health(container_id) if container_id else "missing",
        }
        return data

    def stop(self, session_id: str) -> Session:
        s = self.get(session_id)
        container_id = self._container_id(s)
        self.store.update(session_id, state=st.STOPPING)
        if container_id:
            self.docker.stop(container_id, timeout=int(self.cfg.get("docker.stop_timeout_s", 15)))
        s = self.store.update(session_id, state=st.STOPPED, stopped_at=time.time())
        self.refresh_resource_ledger()
        self.admission.notify_all()
        return s  # type: ignore[return-value]

    def start(self, session_id: str) -> Session:
        s = self.get(session_id)
        if s.state == st.RUNNING and self.docker.container_running(
            self._container_id(s) or ""
        ):
            return s
        container_id = self._container_id(s)
        if container_id is None:
            # The container is gone - removed by hand, or pruned because the
            # image was rebuilt. The home volume is a separate object and is
            # still there, so the desktop comes back with the CURRENT image
            # and with the user's files. Without this a session whose
            # container vanished could never be started again: "Start" would
            # fail and the only way out would be to delete the session and
            # lose the data.
            log.warning("session %s has no container, recreating it", session_id)
            self._recreate_stale(s)
            return self.get(session_id)
        self.store.update(session_id, state=st.STARTING, error=None)
        self.docker.start(container_id)
        task = asyncio.create_task(self._await_ready(session_id))
        self._tasks[session_id] = task
        return self.get(session_id)

    def restart(self, session_id: str) -> Session:
        s = self.get(session_id)
        container_id = self._container_id(s)
        if container_id is None:
            raise SessionNotFound(f"{session_id}: container is gone")
        self.store.update(session_id, state=st.STOPPING)
        self.docker.stop(container_id, timeout=int(self.cfg.get("docker.stop_timeout_s", 15)))
        self.docker.start(container_id)
        self.store.update(session_id, state=st.STARTING, stopped_at=time.time(), error=None)
        task = asyncio.create_task(self._await_ready(session_id))
        self._tasks[session_id] = task
        self.admission.notify_all()
        return self.get(session_id)

    def delete(self, session_id: str, delete_data: bool = False) -> dict[str, Any]:
        s = self.get(session_id)
        container_id = self._container_id(s)
        volume_removed = False
        if container_id:
            self.store.update(session_id, state=st.STOPPING)
            self.docker.stop(container_id, timeout=int(self.cfg.get("docker.stop_timeout_s", 15)))
            self.docker.remove(container_id, remove_volume=False)
        if delete_data:
            volume_removed = self.docker.remove_volume(s.volume_name)
        self.store.delete(session_id)
        self.refresh_resource_ledger()
        self.admission.notify_all()
        return {
            "id": session_id,
            "deleted": True,
            "user_data_deleted": bool(delete_data),
            "volume": s.volume_name,
            "volume_removed": volume_removed,
            "note": (
                "home volume removed"
                if volume_removed
                else f"home volume '{s.volume_name}' was kept, remove it manually with "
                     f"'docker volume rm {s.volume_name}'"
            ),
        }

    # ----------------------------------------------------------- reconcile
    def reconcile(self) -> None:
        """Pick up containers that exist in Docker but not (or no longer) in the store."""
        known_ids: set[str] = set()
        for attrs in self.docker.list_sessions(self.cfg.name_prefix):
            name = (attrs.get("Name") or "").lstrip("/")
            labels = attrs.get("Config", {}).get("Labels") or {}
            sid = labels.get("webdesktop.session") or name[len(self.cfg.name_prefix) + 1:]
            known_ids.add(sid)
            if self.store.get(sid) is None:
                log.warning("adopting unknown container %s into the store", name)
                state = (attrs.get("State") or {}).get("Status")
                env = dict(
                    e.split("=", 1) for e in (attrs.get("Config", {}).get("Env") or []) if "=" in e
                )
                try:
                    vnc_port = int(env.get("VNC_PORT", "5900"))
                except ValueError:
                    vnc_port = 5900
                self.store.adopt(
                    Session(
                        id=sid,
                        owner=labels.get("webdesktop.owner", "unknown"),
                        state=st.RUNNING if state == "running" else st.STOPPED,
                        image=(attrs.get("Config", {}).get("Image") or ""),
                        container_name=name,
                        volume_name=self.cfg.volume_name(sid),
                        vnc_port=vnc_port,
                        display_num=DockerControl.display_for(vnc_port),
                        url_path=f"/s/{sid}/",
                        labels={"adopted": "true"},
                    )
                )
        # A session that is still CREATING or STARTING but has no container is
        # a leftover of a manager that died between the store write and the
        # container creation. It gets a grace period (the container needs a
        # moment to appear in the Docker API) and is then marked failed
        # instead of staying "starting" forever.
        stale_after = float(self.cfg.get("docker.ready_timeout_s", 90)) + 60.0
        for orphan in self.store.reconcile(known_ids, stale_after_s=stale_after):
            log.warning("session %s marked failed: %s", orphan.id, orphan.error)
        self.refresh_resource_ledger()

    def shutdown(self, stop_sessions: bool = False) -> None:
        """Cancel background watchers and, by default, park every session.

        Session containers are created through the Docker API and are therefore
        invisible to `docker compose down`, which then reports "Network
        webdesktop_sessions Resource is still in use". Stopping them here (and
        NOT removing them) releases the network while keeping the desktops and
        their home volumes: the next manager start resumes exactly the sessions
        that were running. See resume_interrupted().
        """
        for task in self._tasks.values():
            task.cancel()
        self._tasks.clear()

        if not stop_sessions:
            return

        try:
            # Bounded on purpose: compose's stop_grace_period is the outer
            # deadline, and we would rather SIGKILL a stubborn desktop than be
            # killed mid-shutdown and leave the network busy again.
            timeout = max(1, min(int(self.cfg.get("docker.stop_timeout_s", 15)), 5))
            stopped = self.docker.stop_session_containers(stop_timeout=timeout)
            if stopped:
                log.info("parked %d session container(s) on shutdown: %s",
                         len(stopped), ", ".join(stopped))
        except Exception as exc:  # noqa: BLE001 - shutdown must not raise
            log.warning("stopping sessions on shutdown failed: %s", exc)

    # ----------------------------------------------------------- resume
    def resume_interrupted(self) -> None:
        """Start back the sessions the store still believes are alive.

        Runs once at startup. The store is the record of intent: a session the
        user stopped through the API is STOPPED there and stays stopped, while a
        session that was running when the manager was stopped - or whose
        container was killed outright - is still RUNNING/STARTING in the store
        and is started again here. That is what makes `docker compose stop
        manager` (and a host reboot) harmless for the user.
        """
        for s in self.store.list((st.RUNNING, st.STARTING, st.STOPPING)):
            container_id = self._container_id(s)
            if container_id is None:
                # The container is gone - removed by hand, or pruned because
                # the image was rebuilt. The home volume is a separate object
                # and is still there, so the session comes back with the
                # CURRENT image and the user's files. Without this the session
                # would stay in the store as "running" with nothing behind it.
                log.warning("session %s has no container, recreating it", s.id)
                self._recreate_stale(s)
                continue
            if self.docker.container_running(container_id):
                continue
            try:
                self.docker.start(container_id)
                self.store.update(s.id, state=st.STARTING, error=None)
                task = asyncio.create_task(self._await_ready(s.id))
                self._tasks[s.id] = task
                log.info("resumed session %s (%s)", s.id, s.container_name)
            except DockerUnavailable as exc:
                # A container that cannot start because its network is gone -
                # the normal state after `docker compose down` + `up`, since
                # compose recreates the sessions network with a NEW id - is
                # replaced by a fresh container with the same name. The home
                # volume is a separate object and is kept, so no user data is
                # lost. See DockerControl.recreate_session_container.
                log.warning("resume of %s failed (%s); recreating the container",
                            s.id, exc)
                self._recreate_stale(s)

    def _recreate_stale(self, s: Session) -> None:
        """Replace a container stuck on a dead network and start it again."""
        per = self._per_session_cfg()
        sess_defaults = self.cfg.get("session_defaults", {})
        memory_mb = int(s.memory_limit_mb or per.get("memory_mb", 512))
        try:
            container_id = self.docker.recreate_session_container(
                name=s.container_name,
                image=s.image or sess_defaults.get("image", "webdesktop:lxde"),
                vnc_port=s.vnc_port,
                display_num=s.display_num,
                resolution=s.resolution,
                volume_name=s.volume_name,
                network=self.network,
                memory_mb=memory_mb,
                cpus=float(s.cpu_limit or per.get("cpus", 0.5) or 0),
                cpu_shares=int(per.get("cpu_shares", 512)),
                blkio_weight=int(per.get("blkio_weight", 500)),
                pids_limit=int(per.get("pids_limit", 512)),
                memory_swap_mb=int(per.get("memory_swap_mb", 0)),
                tmpfs_mb=int(per.get("tmpfs_mb", 64)),
                vnc_password=sess_defaults.get("vnc_password", ""),
                extra_env={str(k): str(v) for k, v in (sess_defaults.get("extra_env") or {}).items()},
                labels={"webdesktop.session": s.id, "webdesktop.owner": s.owner},
            )
            self.docker.start(container_id)
        except DockerUnavailable as exc:
            log.error("session %s cannot be resumed: %s", s.id, exc)
            self.store.update(s.id, state=st.FAILED, error=str(exc))
            return
        self.store.update(s.id, state=st.STARTING, error=None)
        task = asyncio.create_task(self._await_ready(s.id))
        self._tasks[s.id] = task
        log.info("session %s recovered with a fresh container (%s)", s.id, s.container_name)
