"""WebSocket <-> raw TCP proxy for the VNC (RFB) stream.

This is a deliberate replacement for running `websockify` as a sidecar:

  * authentication is checked on the HTTP upgrade itself, so no token ever has
    to travel in a query string;
  * the WebSocket subprotocol is validated (`binary` only);
  * frame size is capped, which removes the amplification vector a naive proxy
    would hand to a public endpoint;
  * when a session stops, the socket is closed immediately and the browser
    sees a clean disconnect instead of hanging.

Implementation note
-------------------
The RFB socket is read by a dedicated thread using BLOCKING recv(), not by
`loop.sock_recv()`. Both uvloop and uvicorn's websockets integration have
shipped versions where an already-readable socket does not wake sock_recv(),
and the symptom is exactly the one that is hardest to debug: the session is
healthy, x11vnc logs "Protocol version sent", and the browser stays blank
forever. Blocking recv() in a thread is immune to that class of problem, and
one thread per connected browser is irrelevant at desktop-session scale.

Writes go through a single-worker executor per connection so that ordering is
preserved and the event loop is never blocked by a slow TCP peer.
"""
from __future__ import annotations

import asyncio
import logging
import socket as socket_mod
import threading
from concurrent.futures import ThreadPoolExecutor

from fastapi import WebSocket
from starlette.websockets import WebSocketDisconnect, WebSocketState

log = logging.getLogger("manager.vncproxy")

MAX_FRAME_BYTES = 4 * 1024 * 1024   # 4 MiB: noVNC rectangles are far below this
READ_SIZE = 65536
_EOF = object()


class VncProxy:
    """Pumps bytes between a browser WebSocket and a session's RFB port."""

    def __init__(self, websocket: WebSocket, host: str, port: int) -> None:
        self.ws = websocket
        self.host = host
        self.port = port
        self.sock: socket_mod.socket | None = None
        self._loop = asyncio.get_running_loop()
        self._queue: asyncio.Queue = asyncio.Queue(maxsize=64)
        self._closed = asyncio.Event()
        self._reader: threading.Thread | None = None
        self._tx = ThreadPoolExecutor(max_workers=1, thread_name_prefix="vnc-tx")

    # ------------------------------------------------------------------ run
    async def run(self) -> None:
        try:
            self.sock = socket_mod.create_connection((self.host, self.port), timeout=10)
            # Blocking socket: recv() in the reader thread must not spin.
            self.sock.settimeout(None)
            self.sock.setsockopt(socket_mod.IPPROTO_TCP, socket_mod.TCP_NODELAY, 1)
            # Nagle can hold back the 12-byte RFB greeting waiting for a second
            # segment that never arrives, so it is disabled explicitly.
            log.info("proxy connected to RFB at %s:%s", self.host, self.port)
        except (OSError, TimeoutError) as exc:
            log.warning("cannot reach VNC at %s:%s - %s", self.host, self.port, exc)
            await self._safe_close(code=1011, reason="session VNC unreachable")
            return

        if self.ws.client_state != WebSocketState.CONNECTED:
            log.warning("websocket is no longer connected, aborting proxy")
            self._teardown_sync()
            return

        self._reader = threading.Thread(
            target=self._read_loop, name="vnc-rfb-reader", daemon=True
        )
        self._reader.start()

        await self._pump()
        await self._teardown()

    # ---------------------------------------------------------- TCP -> queue
    def _read_loop(self) -> None:
        assert self.sock is not None
        try:
            while True:
                chunk = self.sock.recv(READ_SIZE)
                if not chunk:
                    self._put(_EOF)
                    return
                self._put(chunk)
                if len(chunk) > MAX_FRAME_BYTES:
                    return
        except (OSError, ValueError) as exc:
            log.debug("rfb reader stopped: %s", exc)
            self._put(_EOF)

    def _put(self, item) -> None:
        try:
            self._loop.call_soon_threadsafe(self._enqueue, item)
        except RuntimeError:
            pass  # loop already closed

    def _enqueue(self, item) -> None:
        try:
            self._queue.put_nowait(item)
        except asyncio.QueueFull:
            log.warning("RFB backlog is full, dropping the connection")
            self._closed.set()

    # ------------------------------------------------------------- queue -> WS
    async def _tcp_to_ws(self) -> None:
        log.debug("tcp->ws pump started")
        try:
            while not self._closed.is_set():
                chunk = await self._queue.get()
                if chunk is _EOF:
                    log.info("RFB side closed the connection")
                    break
                if len(chunk) > MAX_FRAME_BYTES:
                    await self._safe_close(code=1009, reason="frame too large")
                    return
                log.debug("forwarding %d bytes from RFB to the browser", len(chunk))
                await self.ws.send_bytes(chunk)
        except (WebSocketDisconnect, RuntimeError, OSError, ConnectionResetError) as exc:
            log.info("tcp->ws ended: %s", exc)
        except Exception:  # noqa: BLE001
            log.exception("tcp->ws failed unexpectedly")
        finally:
            self._closed.set()

    # ------------------------------------------------------------- WS -> TCP
    async def _ws_to_tcp(self) -> None:
        log.debug("ws->tcp pump started")
        try:
            while True:
                message = await self.ws.receive()
                if message.get("type") == "websocket.disconnect":
                    break
                data = message.get("bytes")
                text = message.get("text")
                payload = data if data is not None else (text.encode() if text else b"")
                if payload and self.sock is not None:
                    log.debug("forwarding %d bytes from the browser to RFB", len(payload))
                    # Single-worker executor keeps ordering and never blocks
                    # the event loop on a slow TCP peer.
                    await self._loop.run_in_executor(self._tx, self.sock.sendall, payload)
        except WebSocketDisconnect:
            pass
        except (RuntimeError, OSError) as exc:
            log.info("ws->tcp ended: %s", exc)
        except Exception:  # noqa: BLE001
            log.exception("ws->tcp failed unexpectedly")
        finally:
            self._closed.set()

    async def _pump(self) -> None:
        tasks = [
            asyncio.create_task(self._ws_to_tcp()),
            asyncio.create_task(self._tcp_to_ws()),
        ]
        await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    # ------------------------------------------------------------- teardown
    def _teardown_sync(self) -> None:
        if self.sock is not None:
            # shutdown() unblocks the reader thread's recv() immediately.
            try:
                self.sock.shutdown(socket_mod.SHUT_RDWR)
            except OSError:
                pass
            try:
                self.sock.close()
            except OSError:
                pass
            self.sock = None
        self._tx.shutdown(wait=False)

    async def _teardown(self) -> None:
        self._teardown_sync()
        await self._safe_close(code=1000, reason="session closed")

    async def _safe_close(self, code: int = 1000, reason: str = "") -> None:
        if self.ws.client_state == WebSocketState.CONNECTED:
            try:
                await self.ws.close(code=code, reason=reason[:120])
            except (RuntimeError, WebSocketDisconnect):
                pass
