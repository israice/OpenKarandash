"""Web Linux Desktop - session manager.

Single entry point for:
  * /api/...          session management REST API (authenticated)
  * /s/<id>/...       noVNC client, per-session, owner-only (authenticated)
  * /ws/<id>/...      VNC WebSocket for one session (authenticated)
  * /healthz          liveness probe (unauthenticated, returns no secrets)

Run with:  python -m app.main
"""
from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import base64
import json
import posixpath
import re
import socket
import time
from pathlib import Path
from typing import Any
from urllib.parse import quote

import uvicorn
from fastapi import Depends, FastAPI, HTTPException, Query, Request, WebSocket, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import (
    HTMLResponse,
    JSONResponse,
    PlainTextResponse,
    RedirectResponse,
    Response,
    StreamingResponse,
)
from fastapi.staticfiles import StaticFiles

from . import auth, store as st
from .config import Config
from .docker_ctl import SESSION_HOME, DockerControl, DockerUnavailable
from .resources import ResourceMonitor
from .scheduler import AdmissionController, periodic_notify
from .service import CapacityError, SessionNotFound, SessionService
from .store import SessionStore
from .vncproxy import VncProxy

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
)
log = logging.getLogger("manager")

CONFIG = Config.load()
NOVNC_ROOT = Path(os.environ.get("NOVNC_ROOT", "/usr/share/novnc"))
DOCKER_NETWORK = os.environ.get("SESSION_NETWORK", "webdesktop_internal")


class _AuthenticatedStaticFiles(StaticFiles):
    """noVNC's assets are served through the same authenticated origin as the
    session pages, so a leaked URL is not a way around the login."""

    async def get_response(self, path: str, scope):  # type: ignore[override]
        request = Request(scope)
        try:
            auth.require_http(request)
        except HTTPException as exc:
            return Response(
                content=f'{{"detail":"{exc.detail}"}}',
                status_code=exc.status_code,
                media_type="application/json",
                headers=exc.headers or None,
            )
        return await super().get_response(path, scope)


# ============================================================ bootstrap
def _connect_docker() -> DockerControl | None:
    """Connect to the Docker API, tolerating a slow socket proxy on boot.

    The manager and docker-proxy start at the same time, so the very first
    attempts can fail while the proxy is still binding its port. Without this
    the manager would crash-loop on a perfectly normal cold start.

    Returns None when the Docker daemon is unreachable: the manager still
    starts and serves the UI, but session creation/deletion will fail with a
    clear error until Docker becomes available.
    """
    client = DockerControl(os.environ.get("DOCKER_HOST"))
    if not client.available:
        log.error(
            "Docker daemon is unreachable (%s). The manager UI will start, but "
            "session operations require Docker. Enable "
            '"Expose daemon on tcp://localhost:2375 without TLS" in Docker '
            "Desktop settings -> General.",
            os.environ.get("DOCKER_HOST", "default"),
        )
        return None
    log.info("connected to the Docker API")
    return client


def build_app() -> FastAPI:
    settings = auth.configure(CONFIG)

    monitor = ResourceMonitor(
        disk_path=os.environ.get("DOCKER_DATA_ROOT", "/var/lib/docker"),
        sample_interval=CONFIG.resource_sample_s,
    )
    store = SessionStore(CONFIG.get("manager.state_dir", "/var/lib/session-manager"))
    docker = _connect_docker()
    admission = AdmissionController(CONFIG, monitor)
    service = SessionService(CONFIG, store, docker, admission, DOCKER_NETWORK)

    @contextlib.asynccontextmanager
    async def lifespan(_app: FastAPI):
        if not settings.configured:
            raise RuntimeError(
                "the manager has no way to authenticate: auto-login is off and "
                "MANAGER_USER/MANAGER_PASSWORD are unset. Set MANAGER_AUTO_LOGIN=1 "
                "or provide credentials."
            )
        # Resume FIRST, reconcile second: a session whose container vanished
        # (removed by hand, or pruned after an image rebuild) is brought back
        # with its volume and the current image. Reconcile then only sees the
        # sessions that really could not be recovered.
        service.resume_interrupted()
        service.reconcile()
        service.refresh_resource_ledger()
        log.info(
            "manager ready: network=%s image=%s memory/session=%s MiB",
            DOCKER_NETWORK,
            CONFIG.get("session_defaults.image"),
            CONFIG.get("resources.per_session.memory_mb"),
        )
        if settings.auto_login:
            log.info(
                "auto-login is on: open http://HOST:%s/s/ in a browser and you "
                "are in, no password. Keep the manager on localhost or behind a "
                "proxy that does the authenticating (MANAGER_AUTO_LOGIN=0 turns "
                "auto-login off).",
                CONFIG.get("manager.port", 8080),
            )
        if not settings.has_credentials:
            log.warning(
                "MANAGER_PASSWORD / MANAGER_API_TOKEN are not set: scripts have "
                "no way to authenticate explicitly, they rely on auto-login too."
            )
        tasks = [
            asyncio.create_task(periodic_notify(admission, CONFIG.resource_sample_s)),
            asyncio.create_task(_reconcile_loop(service)),
        ]
        try:
            yield
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            # Park the session containers on the way out: `docker compose down` cannot
            # stop them (they are not compose services) and a running one keeps
            # the internal `sessions` network busy, which makes compose fail
            # with "Resource is still in use". They are stopped, never removed,
            # and the next manager start resumes them.
            service.shutdown(
                stop_sessions=bool(CONFIG.get("manager.stop_sessions_on_shutdown", True))
            )

    app = FastAPI(
        title="Web Linux Desktop - session manager",
        version="1.0.0",
        docs_url="/api/docs",
        redoc_url=None,
        openapi_url="/api/openapi.json",
        lifespan=lifespan,
    )
    app.state.service = service
    app.state.store = store
    app.state.docker = docker
    app.state.admission = admission
    app.state.monitor = monitor

    if CONFIG.get("manager.cors.enabled", False):
        app.add_middleware(
            CORSMiddleware,
            allow_origins=CONFIG.get("manager.cors.allowed_origins", []),
            allow_credentials=False,
            allow_methods=["GET", "POST", "DELETE"],
            allow_headers=["authorization", "content-type", "x-api-token"],
        )

    if not settings.configured:
        log.error(
            "REFUSING SAFE MODE: auto-login is off and MANAGER_USER / "
            "MANAGER_PASSWORD are not set."
        )

    # -------------------------------------------------------------- helpers
    def principal_of(request: Request):
        return auth.require_http(request)

    def base_url(request: Request) -> str:
        configured = CONFIG.get("manager.public_base_url", "")
        if configured:
            return configured.rstrip("/")
        return str(request.base_url).rstrip("/")

    def url_for(request: Request, session_id: str) -> str:
        return f"{base_url(request)}/s/{session_id}/"

    # ============================================================ health
    @app.get("/healthz", include_in_schema=False)
    async def healthz() -> dict[str, Any]:
        return {"status": "ok", "novnc": NOVNC_ROOT.is_dir(), "time": time.time()}

    @app.get("/api/whoami")
    async def whoami(p=Depends(principal_of)) -> dict[str, Any]:
        """Who the caller is, and whether that was automatic. Handy for the UI
        and for scripts that want to know if they need credentials."""
        return p.summary() | {"auto_login_enabled": settings.auto_login}

    # ============================================================ resources
    @app.get("/api/resources")
    async def resources(p=Depends(principal_of)) -> dict[str, Any]:
        running = [s for s in service.store.active() if s.state == st.RUNNING]
        service.refresh_resource_ledger()
        return admission.status(len(running))

    @app.get("/api/resources/sessions")
    async def session_usage(p=Depends(principal_of)) -> dict[str, Any]:
        """Per-session live usage. Sampling docker stats is expensive, so this
        endpoint is opt-in and never called by the UI automatically."""
        running = [s for s in service.store.active() if s.state == st.RUNNING]
        out = []
        for s in running:
            attrs = docker.find_by_name(s.container_name) or {}
            out.append(
                {
                    "id": s.id,
                    "owner": s.owner,
                    "container": s.container_name,
                    "health": docker.health(attrs.get("Id", "")) if attrs else "missing",
                    "stats": docker.stats(attrs["Id"]) if attrs else None,
                }
            )
        return {"sessions": out}

    # ============================================================ sessions
    @app.get("/api/sessions")
    async def list_sessions(
        state: str | None = Query(None, description="comma separated state filter"),
        p=Depends(principal_of),
    ) -> dict[str, Any]:
        wanted = [s.strip() for s in state.split(",")] if state else None
        items = service.store.list(wanted)
        visible = [s for s in items if p.may_access(s)]
        return {
            "sessions": [s.summary_dict() for s in visible],
            "total": len(items),
            "visible_to_you": len(visible),
            # What a new session would be cloned from.
            "template": service.template_info(),
        }

    @app.post("/api/sessions", status_code=status.HTTP_201_CREATED)
    async def create_session(request: Request, p=Depends(principal_of)) -> JSONResponse:
        body: dict[str, Any] = {}
        if await request.body():
            try:
                body = await request.json()
            except ValueError:
                raise HTTPException(status_code=400, detail="body must be JSON")

        resolution = str(body.get("resolution") or "").strip() or None
        if resolution and not _valid_resolution(resolution):
            raise HTTPException(
                status_code=400,
                detail=f"invalid resolution '{resolution}', expected WIDTHxHEIGHT "
                       f"(multiples of 8, 640x480 - 3840x2160, e.g. 1280x800)",
            )

        wait = body.get("wait")
        max_wait = float(wait) if wait not in (None, "") else None

        # A new session is cloned from the main one unless the caller asks
        # for a clean one.
        inherit = body.get("inherit", True)
        if isinstance(inherit, str):
            inherit = inherit.strip().lower() not in ("0", "false", "no", "off")
        else:
            inherit = bool(inherit)

        try:
            session = await service.create(
                owner=p.username,
                resolution=resolution,
                max_wait=max_wait,
                inherit=inherit,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        except CapacityError as exc:
            status_code = 429 if exc.reason in _OVERLOAD_REASONS else 503
            raise HTTPException(
                status_code=status_code,
                detail={"reason": exc.reason, "message": exc.detail},
            )

        payload = session.summary_dict()
        payload["url"] = url_for(request, session.id)
        payload["status_url"] = f"{base_url(request)}/api/sessions/{session.id}"
        return JSONResponse(payload, status_code=201)

    @app.get("/api/sessions/{session_id}")
    async def get_session(session_id: str, p=Depends(principal_of)) -> dict[str, Any]:
        _session_or_404(service, session_id, p)
        return service.status(session_id)

    @app.get("/api/sessions/{session_id}/url")
    async def session_url(session_id: str, request: Request, p=Depends(principal_of)) -> dict[str, Any]:
        _session_or_404(service, session_id, p)
        return {
            "id": session_id,
            "url": url_for(request, session_id),
            "websockify_path": f"/ws/{session_id}/",
        }

    @app.post("/api/sessions/{session_id}/stop")
    async def stop_session(session_id: str, p=Depends(principal_of)) -> dict[str, Any]:
        _session_or_404(service, session_id, p)
        # docker.stop() ждёт остановки контейнера до docker.stop_timeout_s (по
        # умолчанию 15 с) — это синхронный,I/O-блокирующий вызов, поэтому в
        # поток, иначе он замерзает весь event loop менеджера на время остановки.
        session = await asyncio.to_thread(service.stop, session_id)
        return session.summary_dict()

    @app.post("/api/sessions/{session_id}/start")
    async def start_session(session_id: str, p=Depends(principal_of)) -> dict[str, Any]:
        _session_or_404(service, session_id, p)
        try:
            session = service.start(session_id)
        except SessionNotFound as exc:
            raise HTTPException(status_code=404, detail=str(exc))
        return session.summary_dict()

    @app.post("/api/sessions/{session_id}/restart")
    async def restart_session(session_id: str, p=Depends(principal_of)) -> dict[str, Any]:
        _session_or_404(service, session_id, p)
        try:
            session = service.restart(session_id)
        except SessionNotFound as exc:
            raise HTTPException(status_code=404, detail=str(exc))
        return session.summary_dict()

    @app.delete("/api/sessions/{session_id}")
    async def delete_session(
        session_id: str,
        delete_data: bool = Query(
            False, description="also destroy the persistent home volume"
        ),
        p=Depends(principal_of),
    ) -> dict[str, Any]:
        _session_or_404(service, session_id, p)
        return await asyncio.to_thread(service.delete, session_id, delete_data=delete_data)

    @app.post("/api/sessions/{session_id}/exec")
    async def exec_in_session(session_id: str, request: Request, p=Depends(principal_of)):
        """Stream one argv command inside exactly one managed desktop."""
        session = _session_or_404(service, session_id, p)
        if docker is None or not docker.available:
            raise HTTPException(status_code=503, detail="Docker daemon is unavailable")
        try:
            body = await request.json()
        except ValueError:
            raise HTTPException(status_code=400, detail="body must be JSON")
        command = body.get("command")
        workdir = body.get("workdir") or "/home/desktop"
        env = body.get("env") or {}
        if not isinstance(command, list) or not command or not all(isinstance(x, str) and x for x in command):
            raise HTTPException(status_code=400, detail="command must be a non-empty argv list")
        if not isinstance(workdir, str) or not workdir.startswith("/") or ".." in workdir.split("/"):
            raise HTTPException(status_code=400, detail="workdir must be an absolute container path")
        if not isinstance(env, dict) or any(
            not isinstance(key, str) or not isinstance(value, str)
            or not (key == "GIT_TERMINAL_PROMPT" or key.startswith("GIT_CONFIG_"))
            for key, value in env.items()
        ):
            raise HTTPException(status_code=400, detail="env is limited to Git configuration variables")
        try:
            exec_id = await asyncio.to_thread(
                docker.exec_create, session.container_name, command, workdir, env
            )
        except (DockerUnavailable, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc))

        async def stream():
            try:
                iterator = iter(docker.exec_stream(exec_id))
                sentinel = object()
                def next_chunk():
                    try:
                        return next(iterator)
                    except StopIteration:
                        return sentinel
                while True:
                    chunk = await asyncio.to_thread(next_chunk)
                    if chunk is sentinel:
                        break
                    if chunk:
                        if isinstance(chunk, tuple):
                            chunk = b"".join(part for part in chunk if part)
                        raw = chunk if isinstance(chunk, bytes) else str(chunk).encode()
                        yield (json.dumps({
                            "type": "data", "data": base64.b64encode(raw).decode("ascii"),
                        }) + "\n").encode()
                info = await asyncio.to_thread(docker.exec_inspect, exec_id)
                yield json.dumps({
                    "type": "done", "code": info.get("ExitCode"), "exec_id": exec_id,
                }).encode() + b"\n"
            except Exception as exc:
                yield json.dumps({
                    "type": "error", "error": str(exc), "exec_id": exec_id,
                }).encode() + b"\n"

        return StreamingResponse(
            stream(), media_type="application/octet-stream", headers={"X-Exec-Id": exec_id}
        )

    @app.delete("/api/sessions/{session_id}/exec/{exec_id}")
    async def stop_exec(session_id: str, exec_id: str, p=Depends(principal_of)):
        session = _session_or_404(service, session_id, p)
        if docker is None or not docker.available:
            raise HTTPException(status_code=503, detail="Docker daemon is unavailable")
        try:
            await asyncio.to_thread(docker.exec_kill, session.container_name, exec_id)
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        return {"ok": True, "session_id": session.id, "exec_id": exec_id}

    @app.post("/api/sessions/{session_id}/make-main")
    async def make_main(session_id: str, p=Depends(principal_of)) -> dict[str, Any]:
        """Make this session the one new sessions are cloned from."""
        _session_or_404(service, session_id, p)
        session = service.set_main(session_id)
        return {"session": session.summary_dict(), "template": service.template_info()}

    @app.post("/api/sessions/{session_id}/unmake-main")
    async def unmake_main(session_id: str, p=Depends(principal_of)) -> dict[str, Any]:
        """Stop cloning new sessions from this one."""
        _session_or_404(service, session_id, p)
        session = service.unmake_main(session_id)
        return {"session": session.summary_dict(), "template": service.template_info()}

    @app.get("/api/template")
    async def template_info(p=Depends(principal_of)) -> dict[str, Any]:
        """The main session and the image new sessions are created from."""
        return service.template_info()

    @app.get("/api/sessions/{session_id}/logs")
    async def session_logs(
        session_id: str,
        tail: int = Query(200, ge=1, le=5000),
        p=Depends(principal_of),
    ) -> PlainTextResponse:
        _session_or_404(service, session_id, p)
        if docker is None or not docker.available:
            raise HTTPException(status_code=503, detail="Docker daemon is unavailable")
        attrs = docker.find_by_name(service.get(session_id).container_name)
        if not attrs:
            raise HTTPException(status_code=404, detail="container not found")
        raw = docker.client.containers.get(attrs["Id"]).logs(tail=tail)
        text = raw.decode("utf-8", "replace") if isinstance(raw, bytes) else str(raw)
        return PlainTextResponse(text)

    # ============================================================ session files
    @app.get("/api/sessions/{session_id}/files")
    async def list_session_files(
        session_id: str,
        path: str = Query(SESSION_HOME, description="directory inside the session"),
        p=Depends(principal_of),
    ) -> dict[str, Any]:
        """List a directory of the session's home volume.

        This is how a file gets out of the session: the manager reads it out
        of the container and the browser downloads it.
        """
        _session_or_404(service, session_id, p)
        target = _session_file_path(path)
        session = service.get(session_id)
        if docker is None or not docker.available:
            raise HTTPException(status_code=503, detail="Docker daemon is unavailable")
        try:
            entries = await asyncio.to_thread(
                docker.list_directory, session.container_name, target
            )
        except FileNotFoundError:
            raise HTTPException(status_code=404, detail=f"no such directory: {target}")
        except DockerUnavailable as exc:
            raise HTTPException(status_code=503, detail=str(exc))
        return {
            "path": target,
            "parent": _session_file_parent(target),
            "entries": entries,
        }

    @app.get("/api/sessions/{session_id}/files/download")
    async def download_session_file(
        session_id: str,
        path: str = Query(..., description="file inside the session"),
        p=Depends(principal_of),
    ) -> Response:
        """Download one file of the session's home volume to the host."""
        _session_or_404(service, session_id, p)
        target = _session_file_path(path)
        session = service.get(session_id)
        if docker is None or not docker.available:
            raise HTTPException(status_code=503, detail="Docker daemon is unavailable")
        try:
            data = await asyncio.to_thread(
                docker.read_file, session.container_name, target
            )
        except FileNotFoundError:
            raise HTTPException(status_code=404, detail=f"no such file: {target}")
        except DockerUnavailable as exc:
            raise HTTPException(status_code=503, detail=str(exc))
        name = target.rsplit("/", 1)[-1]
        return Response(
            content=data,
            media_type="application/octet-stream",
            headers={"Content-Disposition": _attachment(name)},
        )

    # ============================================================ noVNC UI
    @app.get("/", include_in_schema=False)
    async def root() -> RedirectResponse:
        return RedirectResponse("/s/")

    @app.get("/favicon.ico", include_in_schema=False)
    async def manager_favicon() -> Response:
        return Response(status_code=204)

    @app.get("/s/", include_in_schema=False)
    async def sessions_page(p=Depends(principal_of)) -> HTMLResponse:
        return HTMLResponse(_SESSIONS_HTML)

    if NOVNC_ROOT.is_dir():
        app.mount("/novnc", _AuthenticatedStaticFiles(directory=str(NOVNC_ROOT)), name="novnc")

    @app.get("/s/{session_id}/", include_in_schema=False)
    async def novnc_page(session_id: str, request: Request, p=Depends(principal_of)) -> HTMLResponse:
        _session_or_404(service, session_id, p)
        session = service.get(session_id)
        return HTMLResponse(_novnc_html(session_id, base_url(request)))

    @app.get("/s/{session_id}/vnc.html", include_in_schema=False)
    async def novnc_client(session_id: str, request: Request, p=Depends(principal_of)) -> HTMLResponse:
        """noVNC's own entry point, rewritten so it always autoconnects to the
        session's WebSocket and never asks for a VNC password in the browser.

        The page is served from /s/<id>/ so that the browser's credentials
        cover it, but noVNC's assets are referenced relatively. A <base> tag
        therefore redirects every relative asset URL to /novnc/, while the
        WebSocket path stays absolute so the socket still lands on this session.

        noVNC 1.x exposes its UI only as an ES module export, so there is no
        global `UI` to call: the page must be started through
        `UI.start({settings})`. Both noVNC's own bootstrap block and ours are
        replaced by a single `mandatory` settings block, which forces the
        endpoint and cannot be edited away from the settings panel.
        """
        _session_or_404(service, session_id, p)
        client = NOVNC_ROOT / "vnc.html"
        if not client.is_file():
            raise HTTPException(status_code=500, detail="noVNC client is not installed")
        html = client.read_text(encoding="utf-8")
        base_tag = f'<base href="{base_url(request).rstrip("/")}/novnc/">'
        html = html.replace("<head>", "<head>\n    " + base_tag, 1)
        ws_url = f"{base_url(request).replace('http', 'ws', 1)}/ws/{session_id}/"
        html = _novnc_bootstrap(html, ws_url)
        return HTMLResponse(html)

    @app.get("/s/{session_id}/favicon.ico", include_in_schema=False)
    async def favicon(session_id: str, p=Depends(principal_of)) -> Response:
        return Response(status_code=204)

    # ============================================================ websocket
    @app.websocket("/ws/{session_id}/")
    async def vnc_ws(websocket: WebSocket, session_id: str) -> None:
        # Auth is checked BEFORE the upgrade; a rejected client never gets a
        # WebSocket and therefore no pixels and no keyboard events.
        principal = None
        try:
            principal = auth.require_ws(websocket)
        except HTTPException:
            await websocket.close(code=1008, reason="authentication required")
            return

        try:
            session = service.get(session_id)
        except SessionNotFound:
            await websocket.close(code=1008, reason="unknown session")
            return

        if not principal.may_access(session):
            log.warning(
                "websocket denied: user=%r session=%s owner=%r",
                principal.username, session_id, session.owner,
            )
            await websocket.close(code=1008, reason="forbidden")
            return

        if session.state != st.RUNNING:
            await websocket.close(code=1008, reason="session is not running")
            return

        host, port = _session_endpoint(session, service.docker)
        # No separate "is the port open?" probe here on purpose: x11vnc serves
        # one client at a time and keeps abandoned connections in its client
        # list, so a connect-and-close probe right before the real connection
        # can starve the viewer that follows. The proxy's own connect() either
        # succeeds or produces a clean 1011 close.

        offered = websocket.headers.get("sec-websocket-protocol", "")
        protocols = [x.strip() for x in offered.split(",") if x.strip()]
        accept = "binary" if "binary" in protocols else (protocols[0] if protocols else None)
        await websocket.accept(subprotocol=accept)

        proxy = VncProxy(websocket, host, port)
        await proxy.run()

    return app


# ==================================================================== helpers
_NOVNC_BOOTSTRAP_MARK = "wd-session-bootstrap"

# noVNC's own inline bootstrap, in the shape it ships in 1.x: an inline module
# script in <head>. It is removed, otherwise two clients would fight over the
# same container and the viewer would end up blank. Scripts with `src`
# (error-handler.js) are left alone: they still catch and report failures.
_NOVNC_BOOTSTRAP_RE = re.compile(
    r"<script(?=[^>]*type=[\"']module[\"'])(?![^>]*\ssrc\s*=)[^>]*>.*?</script>",
    re.DOTALL | re.IGNORECASE,
)

# --------------------------------------------------------------------- JS
# Clipboard bridge, both directions.
#
# HOST -> SESSION
# noVNC never sends the browser's clipboard to the server on its own: the only
# built-in path is the clipboard panel in the control bar, and the text has to
# be pasted into that panel by hand.  This bridge hooks the paste gesture
# instead, so the text copied on the host lands in the session's X clipboard
# (RFB ClientCutText) and is pasted into whatever has the focus there.
#
# The guest chord is Shift+Ctrl+V: that is what LXTerminal means by
# Edit -> Paste.  GTK applications inside the session take Ctrl+V instead,
# but the clipboard holds the text either way, so they can paste it too.
# The browser's own Ctrl+V is translated into the chord above, so the user
# does not have to know the difference.
#
# SESSION -> HOST
# The other direction has no built-in path at all: x11vnc sends the session's
# CLIPBOARD selection as an RFB ServerCutText, noVNC catches it and puts the
# text into its own panel - the browser's clipboard is never touched, so
# "copy in Linux, paste on the host" does not work.  This bridge writes the
# text into the browser's clipboard instead.
#
# The async Clipboard API only works in a secure context (https, or localhost)
# and, in some browsers, only with a user gesture.  When it refuses, the text
# is offered in a small panel with a button: the click is the gesture, and the
# button also falls back to execCommand('copy') for a plain http page.
_CLIPBOARD_JS = r"""
// --- host clipboard -> session -------------------------------------------
const CLIP_KEYSYM_SHIFT = 0xffe1;      // Shift_L
const CLIP_KEYSYM_CONTROL = 0xffe3;    // Control_L
const CLIP_KEYSYM_V = 0x0056;          // 'V', the shifted keysym: x11vnc
                                       // derives the modifier state from
                                       // the keysym, so the lowercase one
                                       // would arrive without Shift.
let clipKeyHeld = false;               // a swallowed key press still has a
                                       // key release coming
let clipHandled = false;               // the paste event of the last gesture
                                       // has been dealt with
let clipField = null;                  // the hidden field the browser
                                       // pastes into

function clipboardSendGuest(rfb) {
    rfb.sendKey(CLIP_KEYSYM_SHIFT, 'ShiftLeft', true);
    rfb.sendKey(CLIP_KEYSYM_CONTROL, 'ControlLeft', true);
    rfb.sendKey(CLIP_KEYSYM_V, 'KeyV', true);
    rfb.sendKey(CLIP_KEYSYM_V, 'KeyV', false);
    rfb.sendKey(CLIP_KEYSYM_CONTROL, 'ControlLeft', false);
    rfb.sendKey(CLIP_KEYSYM_SHIFT, 'ShiftLeft', false);
}

function clipboardPush(text) {
    // The text has to be in the session BEFORE the paste key arrives there:
    // both travel over the same RFB connection, in this order.
    UI.rfb.clipboardPasteFrom(text);   // ClientCutText -> X clipboard
    clipboardSendGuest(UI.rfb);        // Shift+Ctrl+V in the session
    UI.showStatus('Clipboard sent to the session (' + text.length + ' chars)');
}

function clipboardIsPaste(ev) {
    if (!UI.rfb) return false;
    if (!(ev.ctrlKey || ev.metaKey) || ev.altKey) return false;
    // ev.code is the physical key and works with any keyboard layout, which
    // matters: on a non-Latin layout ev.key is a letter of that layout.
    if (ev.code !== 'KeyV' && ev.key !== 'v' && ev.key !== 'V') return false;
    if (ev.repeat) return false;
    // A text field keeps the browser's own paste: noVNC's clipboard panel
    // sends the text to the server by itself.
    const t = ev.target;
    if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' ||
              t.isContentEditable)) return false;
    return true;
}

function clipboardFocusField() {
    // The browser performs its paste into the focused field, and the canvas
    // is not editable.  A hidden field takes the paste instead, and the
    // paste event below picks the text up.
    if (!clipField) {
        clipField = document.createElement('textarea');
        clipField.setAttribute('aria-hidden', 'true');
        clipField.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;'
                                + 'opacity:0;border:0;padding:0;';
        document.body.appendChild(clipField);
    }
    clipField.focus();
}

function clipboardReleaseField() {
    if (clipField) {
        clipField.remove();
        clipField = null;
    }
    if (UI.rfb) UI.rfb.focus();
}

document.addEventListener('paste', (ev) => {
    // The host pasted.  This is the browser's own paste event, so it needs
    // neither a secure context nor the clipboard-read permission - it works
    // wherever the user pastes, including noVNC's clipboard panel.
    const text = ev.clipboardData ? ev.clipboardData.getData('text/plain') : '';
    if (clipField && ev.target === clipField) {
        ev.preventDefault();            // the hidden field is ours
    }
    if (!text || !UI.rfb) return;
    clipHandled = true;
    clipboardPush(text);
}, true);

document.addEventListener('keydown', (ev) => {
    if (!clipboardIsPaste(ev)) return;
    // noVNC must not forward the chord: the text has to be in the session
    // BEFORE the paste key arrives there.
    ev.stopImmediatePropagation();
    clipKeyHeld = true;
    clipHandled = false;
    clipboardFocusField();

    // Fallback for the browsers that do not perform a paste into a field
    // that was focused while the key was being pressed: read the clipboard
    // through the async API instead.
    setTimeout(async () => {
        if (clipHandled) { clipboardReleaseField(); return; }
        let text = null;
        try {
            if (navigator.clipboard && navigator.clipboard.readText) {
                text = await navigator.clipboard.readText();
            }
        } catch (err) {
            text = null;
        }
        clipboardReleaseField();
        if (!text) {
            UI.showStatus('Could not read the browser clipboard', 'warning');
            // The session may still hold something: paste that.
            clipboardSendGuest(UI.rfb);
            return;
        }
        clipboardPush(text);
    }, 250);
}, true);

document.addEventListener('keyup', (ev) => {
    if (!clipKeyHeld) return;
    if (ev.code !== 'KeyV' && ev.key !== 'v' && ev.key !== 'V') return;
    clipKeyHeld = false;
    ev.stopImmediatePropagation();
}, true);

// --- session clipboard -> host -------------------------------------------
let clipOutPanel = null;               // the fallback panel
let clipRfb = null;                    // the rfb the listener is attached to

function clipboardOutPanel() {
    if (!clipOutPanel) {
        clipOutPanel = document.createElement('div');
        clipOutPanel.style.cssText = 'position:fixed;right:14px;bottom:14px;z-index:10000;'
            + 'max-width:440px;padding:12px 14px;border-radius:8px;display:none;'
            + 'background:#1b2433;color:#e6ebf2;'
            + 'box-shadow:0 10px 28px rgba(0,0,0,.55);'
            + 'font:13px/1.45 system-ui,Segoe UI,Roboto,sans-serif;';
        document.body.appendChild(clipOutPanel);
    }
    return clipOutPanel;
}

function clipboardOutCopy(text) {
    // execCommand('copy') is the only thing that works on a plain http page
    // (an IP address, for instance): the text has to sit in a focused field.
    const field = document.createElement('textarea');
    field.value = text;
    field.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
    document.body.appendChild(field);
    field.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (err) { ok = false; }
    field.remove();
    if (ok) {
        clipboardOutPanel().style.display = 'none';
        UI.showStatus('Clipboard from the session copied to the host');
    } else {
        UI.showStatus('Could not write to the browser clipboard', 'warning');
    }
}

function clipboardOutOffer(text) {
    const panel = clipboardOutPanel();
    panel.textContent = '';
    const title = document.createElement('div');
    title.textContent = 'Text copied in the session - put it on the host clipboard:';
    const pre = document.createElement('pre');
    pre.style.cssText = 'max-height:160px;overflow:auto;margin:8px 0;padding:8px;'
        + 'white-space:pre-wrap;word-break:break-word;'
        + 'background:#111823;border-radius:4px;';
    pre.textContent = text.length > 2000 ? text.slice(0, 2000) + '...' : text;
    const copy = document.createElement('button');
    copy.textContent = 'Copy to clipboard';
    copy.style.cssText = 'background:#245c40;color:#d9f5e6;border:0;border-radius:6px;'
        + 'padding:6px 12px;cursor:pointer;font:inherit;';
    copy.addEventListener('click', () => clipboardOutCopy(text));
    const close = document.createElement('button');
    close.textContent = 'Close';
    close.style.cssText = 'background:#243044;color:#e6ebf2;border:0;border-radius:6px;'
        + 'padding:6px 12px;margin-left:8px;cursor:pointer;font:inherit;';
    close.addEventListener('click', () => { panel.style.display = 'none'; });
    panel.append(title, pre, copy, close);
    panel.style.display = 'block';
}

function clipboardOut(text) {
    if (!text) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => {
            UI.showStatus('Clipboard from the session copied to the host ('
                          + text.length + ' chars)');
            clipboardOutPanel().style.display = 'none';
        }).catch(() => clipboardOutOffer(text));
    } else {
        clipboardOutOffer(text);
    }
}

// The rfb object appears when the connection is established and is replaced
// on every reconnect, so the listener is (re)attached by polling for it.
function clipboardHook() {
    if (!UI.rfb || UI.rfb === clipRfb) return;
    clipRfb = UI.rfb;
    clipRfb.addEventListener('clipboard', (ev) => {
        clipboardOut(ev.detail ? ev.detail.text : '');
    });
}
setInterval(clipboardHook, 500);
"""


def _novnc_bootstrap(html: str, ws_url: str) -> str:
    """Replace noVNC's startup block with one that always autoconnects.

    noVNC >= 1.0 has no global `UI`: `app/ui.js` exports it as an ES module and
    the page starts it with `UI.start({settings: {defaults, mandatory}})`. A
    plain `UI.autoconnect()` therefore dies with "UI is not defined" and the
    browser shows an empty viewer with nothing wrong on screen.

    `mandatory` is the right place for the endpoint: noVNC forces those values
    and locks them in the settings panel, so a user cannot accidentally point
    the viewer at another machine or drag a password prompt back in.
    """
    html = _NOVNC_BOOTSTRAP_RE.sub(
        f"<!-- replaced by the manager ({_NOVNC_BOOTSTRAP_MARK}) -->", html
    )
    script = (
        f'<script type="module" id="{_NOVNC_BOOTSTRAP_MARK}">\n'
        f"import UI from './app/ui.js';\n"
        f"// session WebSocket: {ws_url}\n"
        "let mandatory = {\n"
        "    // The session's own WebSocket, absolute: the page itself lives under\n"
        "    // /s/<id>/ and only the assets are redirected by <base href>.\n"
        f"    path: '{ws_url}',\n"
        "    host: '', port: 0,\n"
        "    // Connect on load. Without this the user only gets the connect panel.\n"
        "    autoconnect: true,\n"
        "    bell: 'on',\n"
        "    view_only: false,\n"
        "    // A dropped WebSocket heals itself: the manager keeps the session\n"
        "    // alive, so retrying is almost always the right answer.\n"
        "    reconnect: true,\n"
        "    reconnect_delay: 2000,\n"
        "};\n"
        "// Scaling is a default, not mandatory: the window is rarely as large as\n"
        "// the session, and without it the browser grows scrollbars around the\n"
        "// desktop. 'remote' (resize the X display itself) stays selectable.\n"
        "let defaults = { resize: 'scale' };\n"
        "for (const [file, into] of [['./defaults.json', defaults],\n"
        "                            ['./mandatory.json', mandatory]]) {\n"
        "    try {\n"
        "        const r = await fetch(file);\n"
        "        if (r.ok) Object.assign(into, await r.json());\n"
        "    } catch (err) {\n"
        "        // The packaged JSON files are optional; the values above suffice.\n"
        "    }\n"
        "}\n"
        "UI.start({ settings: { defaults: defaults, mandatory: mandatory } });\n"
        + _CLIPBOARD_JS
        + "</script>\n"
    )
    if "</head>" in html:
        return html.replace("</head>", script + "</head>", 1)
    return script + html


_OVERLOAD_REASONS = {
    "max_sessions",
    "insufficient_free_memory",
    "insufficient_memory_headroom",
    "insufficient_disk",
    "host_overloaded",
    "queue_full",
    "queue_timeout",
}


def _session_or_404(service: SessionService, session_id: str, principal) -> st.Session:
    try:
        session = service.get(session_id)
    except SessionNotFound:
        raise HTTPException(status_code=404, detail="session not found")
    auth.require_session_access(principal, session)
    return session


def _session_endpoint(session: st.Session, docker: DockerControl) -> tuple[str, int]:
    """Resolve where the manager should connect to reach a session's RFB port.

    The port is published only on the internal Docker network, so the manager
    uses the compose network alias, never a host port.
    """
    host = f"{session.container_name}.{DOCKER_NETWORK}"
    try:
        socket.getaddrinfo(host, None)
    except OSError:
        host = session.container_name
    return host, session.vnc_port


def _valid_resolution(value: str) -> bool:
    """Accept anything Xvfb can actually drive.

    Multiples of 8 only: 800x600 and 1366x768 are multiples of 8 and are
    perfectly reasonable, while requiring 16 would reject standard formats.
    """
    m = re.fullmatch(r"(\d{3,5})x(\d{3,5})", value)
    if not m:
        return False
    w, h = int(m.group(1)), int(m.group(2))
    return 640 <= w <= 3840 and 480 <= h <= 2160 and w % 8 == 0 and h % 8 == 0


# The home volume of a session: the only place the file API may read from.
# The Docker API extracts files as root inside the container, so without this
# boundary /etc/shadow would be downloadable too.
# SESSION_HOME itself is defined in docker_ctl, next to the code that copies
# one session's home into another.


def _session_file_path(raw: str) -> str:
    """Normalise a path and keep it inside the session's home volume."""
    raw = (raw or "").strip()
    if not raw:
        return SESSION_HOME
    if not raw.startswith("/"):
        raw = "/" + raw
    path = posixpath.normpath(raw)
    if path != SESSION_HOME and not path.startswith(SESSION_HOME + "/"):
        raise HTTPException(
            status_code=400,
            detail=f"path must be inside {SESSION_HOME}",
        )
    return path


def _session_file_parent(path: str) -> str | None:
    """The directory to go up to, or None at the top of the home volume."""
    parent = posixpath.dirname(path)
    if parent == SESSION_HOME or not parent.startswith(SESSION_HOME):
        return None
    return parent


def _attachment(name: str) -> str:
    """Content-Disposition for a download.

    The plain filename has to be ASCII (HTTP headers are latin-1), the real
    name goes into filename* (RFC 5987), so a file called "шпаргалка.txt"
    keeps its name in the browser. Characters that could break the header are
    replaced.
    """
    plain = name.encode("ascii", "replace").decode("ascii")
    plain = "".join(
        ch if ch.isprintable() and ch not in '"\\' else "_" for ch in plain
    ) or "download"
    return f"attachment; filename=\"{plain}\"; filename*=UTF-8''{quote(name, safe='')}"


async def _reconcile_loop(service: SessionService) -> None:
    while True:
        await asyncio.sleep(20)
        try:
            service.reconcile()
        except Exception:  # noqa: BLE001
            log.exception("reconcile failed")


# ==================================================================== HTML
_SESSIONS_HTML = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Web Linux Desktop</title>
<style>
 :root{color-scheme:dark}
 body{background:#141a24;color:#e6ebf2;font:14px/1.5 system-ui,Segoe UI,Roboto,sans-serif;margin:0;padding:32px}
 h1{font-size:20px;margin:0 0 4px} .sub{color:#8a97a8;margin:0 0 28px}
 table{width:100%;border-collapse:collapse;max-width:1200px}
 th,td{text-align:left;padding:10px 12px;border-bottom:1px solid #263041;vertical-align:middle}
 th{color:#8a97a8;font-weight:500;font-size:12px;text-transform:uppercase;letter-spacing:.06em}
 .state{font-size:12px;padding:2px 8px;border-radius:10px;background:#243044;white-space:nowrap}
 .state.running{background:#173d2b;color:#63d29a}
 .state.failed{background:#4a1f24;color:#f08a8a}
 .state.starting,.state.creating{background:#3d3417;color:#d2c063}
 a{color:#6fb3ff;text-decoration:none} a:hover{text-decoration:underline}
 button{background:#243044;color:#e6ebf2;border:1px solid #33415a;border-radius:6px;
        padding:5px 10px;cursor:pointer;font:inherit} button:hover{background:#2d3b52}
 button:disabled{opacity:.45;cursor:not-allowed}
 button.danger{border-color:#5a2a30;color:#f0a0a0} button.danger:hover{background:#3a1f24}
 button.go{background:#173d2b;border-color:#245c40;color:#8fe0b4} button.go:hover{background:#1e4d36}
 /* Actions live in one cell so a long id never pushes them off-screen. */
 .actions{display:flex;gap:6px;flex-wrap:wrap}
 .actions button{padding:4px 9px;font-size:13px;white-space:nowrap}
 .empty{color:#8a97a8;padding:24px 0}
 .age{color:#8a97a8;font-size:12px;white-space:nowrap}
 code{background:#1d2532;padding:2px 6px;border-radius:4px}
 /* The main session: the one every new session is cloned from. */
 .card{border:1px solid #2c3a4f;border-radius:10px;padding:14px 16px 6px;
       margin:0 0 22px;background:#171e2b}
 .card-head{display:flex;align-items:baseline;gap:12px;margin-bottom:6px}
 .card-head b{font-size:15px}
 .card table{max-width:none}
 .tag{font-size:11px;padding:2px 8px;border-radius:10px;background:#173d2b;color:#63d29a}
</style></head><body>
<h1>Web Linux Desktop</h1>
<p class="sub">Session manager - one LXDE desktop per container, reached over noVNC. The main session above is the template every new session is cloned from.</p>
<p style="margin:0 0 20px"><button id="mk" style="font-size:15px;padding:8px 16px">+ Start a desktop</button>
 <span id="msg" class="sub" style="margin-left:10px"></span></p>
 <div class="card">
 <div class="card-head"><b>Main session</b><span class="tag">template</span>
 <span class="sub">every new session is cloned from it - its files, its settings and its
 programs. Sessions that already exist are not touched.</span></div>
 <table><thead><tr><th>Session</th><th>Owner</th><th>State</th><th>Resolution</th>
 <th>Limits</th><th>Uptime</th><th>Actions</th></tr></thead><tbody id="main-b">
 <tr><td colspan="7" class="empty">Loading...</td></tr></tbody></table>
 <p class="sub" id="main-info" style="margin:10px 0 8px"></p>
 </div>
<table id="t"><thead><tr><th>Session</th><th>Owner</th><th>State</th><th>Resolution</th>
<th>Limits</th><th>Uptime</th><th>Actions</th></tr></thead><tbody id="b">
<tr><td colspan="7" class="empty">Loading...</td></tr></tbody></table>
<p class="sub" style="margin-top:28px">
 Create a session: <code>curl -X POST http://HOST:8080/api/sessions</code><br>
 Then open the returned URL in a browser.
</p>
<script>
// One click -> one desktop. The browser is already logged in (auto-login), so
// nothing here has to know about passwords. Creating a session only registers
// it: the manager does NOT open the desktop automatically - the user opens it
// with "Open desktop" when they need it.
const mk=document.getElementById('mk'), msg=document.getElementById('msg');
mk.addEventListener('click',async()=>{
  mk.disabled=true; msg.textContent='Creating...';
  try{
    const r=await fetch('/api/sessions',{method:'POST',headers:{'Content-Type':'application/json'},
                                          body:JSON.stringify({wait:180})});
    const d=await r.json();
    if(!r.ok) throw new Error(typeof d.detail==='string'?d.detail:JSON.stringify(d.detail));
    msg.innerHTML=`created <code>${d.id}</code> - waiting for it to be ready...`;
    const wait=async()=>{
      const s=await (await fetch('/api/sessions/'+d.id)).json();
      if(s.state==='running'){
        msg.innerHTML=`session <code>${d.id}</code> is ready - click "Open desktop" when you need it`;
        mk.disabled=false;
        return;
      }
      if(s.state==='failed'){ msg.textContent='session failed, see its logs'; mk.disabled=false; return; }
      setTimeout(wait,1500);
    };
    wait();
  }catch(e){ msg.textContent=e.message; mk.disabled=false; }
});

// The list endpoint returns a summary, so every action below is a small
// POST/DELETE against the same session and then a repaint. No long-lived
// state is kept in JS: the page reloads the list every 5s anyway, which is
// what makes a restarted manager's state show up without a manual refresh.
async function act(id,verb,q){
  msg.textContent=verb+' '+id+'...';
  const r=await fetch('/api/sessions/'+id+(q||''),{
    method:verb==='DELETE'?'DELETE':'POST',
    headers:{'Accept':'application/json'}});
  let d=null; try{d=await r.json()}catch(e){}
  if(!r.ok){
    const det=d&&d.detail;
    msg.textContent=verb+' failed: HTTP '+r.status+
      (det?(typeof det==='string'?': '+det:': '+JSON.stringify(det)):'');
  }else if(verb==='DELETE'){
    msg.textContent='session '+id+' deleted'+(d&&d.note?' - '+d.note:'');
  }else if(verb==='make-main'){
    msg.textContent='session '+id+' is now the main session - new sessions are cloned from it';
  }else if(verb==='unmake-main'){
    msg.textContent='session '+id+' is no longer the main session';
  }else{
    msg.textContent=verb+' ok: '+id;
  }
  await load();
}

function actions(s){
  const running=s.state==='running';
  const busy=['starting','creating','stopping'].includes(s.state);
  // The Open button is a real link while the session is up; the WebSocket
  // refuses a non-running session, so offering the link then would only
  // produce a "session is not running" close code in the browser.
  const open=running?`<a href="/s/${s.id}/"><button class="go">Open desktop</button></a>`
                    :`<button class="go" disabled>Open desktop</button>`;
  const btn=(label,verb,enabled)=>`<button data-id="${s.id}" data-verb="${verb}"`+
                                   `${enabled?'':' disabled'}>${label}</button>`;
  return `<div class="actions">
    ${open}
    ${btn('Start','start',!busy&&!running)}
    ${btn('Stop','stop',running)}
    ${btn('Restart','restart',running)}
    ${s.role==='main'?btn('Unassign','unmake-main',true):btn('Make main','make-main',true)}
    ${btn('Delete','DELETE',true)}
  </div>`;
}

function row(s){
  const since=s.started_at||s.created_at;
  const age=since?Math.max(0,Math.round((Date.now()/1000-since)/60))+' min':'-';
  return `<tr>
  <td><code>${s.id}</code></td><td>${s.owner}</td>
  <td><span class="state ${s.state}">${s.state}</span></td>
  <td>${s.resolution}</td>
  <td>${s.memory_limit_mb} MiB / ${s.cpu_limit} CPU</td>
  <td class="age">${age}</td>
  <td>${actions(s)}</td></tr>`;
}

function ago(ts){
  if(!ts) return 'never';
  const m=Math.max(0,Math.round((Date.now()/1000-ts)/60));
  return m<1?'just now':m+' min ago';
}

// Wire the buttons by delegation: the row HTML is regenerated every 5s,
// so per-node listeners would have to be re-attached constantly.
function wire(body){
  for(const el of body.querySelectorAll('button[data-verb]')){
    el.addEventListener('click',()=>{
      const id=el.dataset.id, verb=el.dataset.verb;
      if(verb==='DELETE'){
        if(!confirm('Delete session '+id+' completely? The desktop, its home volume and every file in it are deleted forever and cannot be recovered.')) return;
        act(id,'DELETE','?delete_data=true');
      }else{
        act(id,verb,'/'+verb);
      }
    });
  }
}

async function load(){
  const b=document.getElementById('b'), mb=document.getElementById('main-b');
  try{
    const r=await fetch('/api/sessions',{headers:{'Accept':'application/json'}});
    if(!r.ok) throw new Error('HTTP '+r.status);
    const d=await r.json();
    const sessions=d.sessions||[];
    // The main session is shown above the list, not inside it.
    const main=sessions.find(s=>s.role==='main');
    const rest=sessions.filter(s=>s.role!=='main');
    if(main){ mb.innerHTML=row(main); }
    else{ mb.innerHTML='<tr><td colspan="7" class="empty">No main session yet - the first desktop you create will become the template.</td></tr>'; }
    const t=d.template||{};
    document.getElementById('main-info').textContent=main
      ? (t.image
          ? 'New sessions are cloned from it. Template image '+t.image+', published '+ago(t.published_at)+'.'
          : 'New sessions are cloned from it. The template image is published when the first new session is created.')
      : '';
    if(!rest.length){b.innerHTML='<tr><td colspan="7" class="empty">No sessions yet.</td></tr>';}
    else{b.innerHTML=rest.map(row).join('');}
    for(const body of [mb,b]) wire(body);
  }catch(e){b.innerHTML='<tr><td colspan="7" class="empty">'+e.message+'</td></tr>';}
}
load(); setInterval(load,5000);
</script></body></html>"""


def _novnc_html(session_id: str, base: str) -> str:
    ws = base.replace("http", "ws", 1) + f"/ws/{session_id}/"
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Desktop {session_id}</title>
<style>
 html,body{{margin:0;height:100%;background:#000;overflow:hidden}}
 #top{{position:fixed;top:0;left:0;right:0;height:30px;background:#141a24;
        color:#8a97a8;font:12px/30px system-ui,sans-serif;z-index:10;
        display:flex;justify-content:space-between;padding:0 12px}}
 #top a{{color:#6fb3ff;text-decoration:none}}
 #top button{{background:#243044;color:#e6ebf2;border:1px solid #33415a;
        border-radius:5px;padding:2px 9px;cursor:pointer;font:inherit;
        line-height:20px;vertical-align:middle}}
 #screen{{position:absolute;top:30px;left:0;right:0;bottom:0;display:flex;
         align-items:center;justify-content:center}}
 iframe{{width:100%;height:100%;border:0;display:block}}
 /* The Files panel is the way a file gets from the session to the host:
    the manager reads it out of the container, the browser downloads it. */
 #files{{position:fixed;top:30px;right:0;bottom:0;width:380px;z-index:20;
        background:#141a24;color:#e6ebf2;display:flex;flex-direction:column;
        border-left:1px solid #263041}}
 #files[hidden]{{display:none}}
 #files-head{{display:flex;align-items:center;gap:8px;padding:8px 12px;
        border-bottom:1px solid #263041;font:12px system-ui,sans-serif;
        color:#8a97a8}}
 #files-path{{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}}
 #files-head button{{background:#243044;color:#e6ebf2;border:1px solid #33415a;
        border-radius:5px;padding:2px 9px;cursor:pointer;font:inherit}}
 #files-list{{flex:1;overflow:auto;padding:4px 0;font:13px system-ui,sans-serif}}
 .frow{{display:flex;justify-content:space-between;gap:10px;padding:5px 12px}}
 .frow:hover{{background:#1d2532}}
 .frow a{{color:#6fb3ff;text-decoration:none}}
 .fdir{{color:#d2c063;cursor:pointer}}
 .fsize{{color:#8a97a8;font-size:11px;white-space:nowrap}}
</style></head><body>
<div id="top"><span>Desktop <b>{session_id}</b></span>
 <span><a href="/s/">all sessions</a> &middot;
  <button id="files-btn">Files</button> &middot; fullscreen works from the noVNC menu</span></div>
<div id="screen">
 <iframe id="f" src="/s/{session_id}/vnc.html" allow="clipboard-read; clipboard-write"
         allowfullscreen></iframe>
</div>
<div id="files" hidden>
 <div id="files-head"><span id="files-path">/home/desktop</span>
  <button id="files-close">Close</button></div>
 <div id="files-list"></div>
</div>
<script>
 // noVNC's own UI is enough; this wrapper only keeps the session list reachable
 // while the desktop fills the rest of the window - and adds the file panel
 // that lets a file leave the session for the host.
 const SID='{session_id}';
 const panel=document.getElementById('files'),
       list=document.getElementById('files-list'),
       pathLabel=document.getElementById('files-path');
 document.getElementById('files-btn').addEventListener('click',()=>openFiles(''));
 document.getElementById('files-close').addEventListener('click',()=>panel.hidden=true);

 function fmtSize(n){{
   if(n<1024) return n+' B';
   if(n<1048576) return (n/1024).toFixed(1)+' KB';
   return (n/1048576).toFixed(1)+' MB';
 }}

 async function openFiles(path){{
   panel.hidden=false;
   list.textContent='Loading...';
   try{{
     const r=await fetch('/api/sessions/'+SID+'/files?path='+encodeURIComponent(path));
     const d=await r.json();
     if(!r.ok) throw new Error(typeof d.detail==='string'?d.detail:JSON.stringify(d.detail));
     pathLabel.textContent=d.path;
     list.textContent='';
     if(d.parent){{
       const up=document.createElement('span');
       up.className='fdir'; up.textContent='.. up';
       up.addEventListener('click',()=>openFiles(d.parent));
       const row=document.createElement('div'); row.className='frow';
       row.appendChild(up); list.appendChild(row);
     }}
     if(!d.entries.length){{
       const empty=document.createElement('div');
       empty.className='fsize'; empty.style.padding='6px 12px';
       empty.textContent='(empty)';
       list.appendChild(empty);
     }}
     const base=d.path.replace(/\\/$/,'');
     for(const e of d.entries){{
       const row=document.createElement('div'); row.className='frow';
       const name=document.createElement(e.is_dir?'span':'a');
       if(e.is_dir){{
         name.className='fdir';
         name.textContent=e.name+'/';
         name.addEventListener('click',()=>openFiles(base+'/'+e.name));
       }} else {{
         name.href='/api/sessions/'+SID+'/files/download?path='
                 +encodeURIComponent(base+'/'+e.name);
         name.download=e.name;
         name.textContent=e.name;
       }}
       const size=document.createElement('span'); size.className='fsize';
       size.textContent=e.is_dir?'':fmtSize(e.size);
       row.appendChild(name); row.appendChild(size);
       list.appendChild(row);
     }}
   }}catch(err){{ list.textContent='Error: '+err.message; }}
 }}
</script></body></html>"""


app = build_app()


if __name__ == "__main__":
    uvicorn.run(
        "app.main:app",
        host="0.0.0.0",
        port=CONFIG.get("manager.port", 8080),
        log_level=str(CONFIG.get("logging.level", "info")).lower(),
        proxy_headers=True,
        forwarded_allow_ips="*",
        # asyncio, never uvloop: see manager/requirements.txt for why.
        loop="asyncio",
        ws="websockets",
        timeout_graceful_shutdown=10,
    )
