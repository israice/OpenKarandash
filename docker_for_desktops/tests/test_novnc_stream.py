#!/usr/bin/env python3
"""
End-to-end test of the browser path: HTTP Basic -> WebSocket upgrade -> RFB
handshake over WebSocket frames -> framebuffer update -> PNG.

This exercises exactly what noVNC does in a browser, using nothing but the
Python standard library, and proves that a session is reachable through the
manager alone (no direct VNC port involved).

  python3 test_novnc_stream.py --url http://host:8080/s/<id>/ \
      --user admin --password secret --out shot.png [--expect-desktop]

Exit code 0 on success. With --expect-desktop the PNG is additionally checked
for a rendered desktop (wallpaper gradient, desktop icons, a task panel).
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import os
import socket
import ssl
import struct
import sys
import time
import urllib.parse
import zlib

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import des  # noqa: E402

DEBUG = os.environ.get("WD_TEST_DEBUG") == "1"


def dbg(*a) -> None:
    if DEBUG:
        print("[debug]", *a, file=sys.stderr)


# ---------------------------------------------------------------- WebSocket
OP_CONT, OP_TEXT, OP_BINARY = 0x0, 0x1, 0x2
OP_CLOSE, OP_PING, OP_PONG = 0x8, 0x9, 0xA


class WS:
    def __init__(self, sock: socket.socket) -> None:
        self.sock = sock
        self.buf = b""

    def _recv(self, n: int) -> bytes:
        while len(self.buf) < n:
            chunk = self.sock.recv(65536)
            dbg(f"socket recv -> {len(chunk)} bytes")
            if not chunk:
                raise EOFError("connection closed")
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        dbg(f"_recv({n}) -> {out[:24]!r}")
        return out

    def send(self, payload: bytes, opcode: int = OP_BINARY) -> None:
        mask = os.urandom(4)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        n = len(payload)
        header = bytes([0x80 | opcode])
        if n < 126:
            header += bytes([0x80 | n])
        elif n < (1 << 16):
            header += bytes([0x80 | 126]) + struct.pack(">H", n)
        else:
            header += bytes([0x80 | 127]) + struct.pack(">Q", n)
        self.sock.sendall(header + mask + masked)
        dbg(f"sent frame opcode={opcode:#x} len={n}: {payload[:32]!r}")

    def recv(self) -> bytes:
        out = b""
        while True:
            b0, b1 = self._recv(2)
            fin = b0 & 0x80
            opcode = b0 & 0x0F
            masked = b1 & 0x80
            length = b1 & 0x7F
            if length == 126:
                length = struct.unpack(">H", self._recv(2))[0]
            elif length == 127:
                length = struct.unpack(">Q", self._recv(8))[0]
            mask = self._recv(4) if masked else b""
            payload = self._recv(length)
            if masked:
                payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))

            if opcode == OP_PING:
                self.send(payload, OP_PONG)
                continue
            if opcode == OP_PONG:
                continue
            if opcode == OP_CLOSE:
                raise EOFError(
                    "server closed the WebSocket "
                    f"(code {struct.unpack('>H', payload[:2])[0] if len(payload) >= 2 else '?'})"
                )
            out += payload
            if fin:
                return out


def websocket_connect(url: str, user: str, password: str, timeout: float = 20.0) -> WS:
    parts = urllib.parse.urlsplit(url)
    host = parts.hostname or "127.0.0.1"
    port = parts.port or (443 if parts.scheme == "https" else 80)
    path = parts.path or "/"
    if parts.query:
        path += "?" + parts.query

    sock = socket.create_connection((host, port), timeout=timeout)
    sock.settimeout(timeout)
    if parts.scheme == "https":
        ctx = ssl.create_default_context()
        sock = ctx.wrap_socket(sock, server_hostname=host)
    dbg(f"tcp connected to {host}:{port}, sending upgrade for {path}")

    key = base64.b64encode(os.urandom(16)).decode()
    token = base64.b64encode(f"{user}:{password}".encode()).decode()
    request = (
        f"GET {path} HTTP/1.1\r\n"
        f"Host: {host}:{port}\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {key}\r\n"
        "Sec-WebSocket-Version: 13\r\n"
        "Sec-WebSocket-Protocol: binary\r\n"
        f"Authorization: Basic {token}\r\n"
        "Origin: http://%s:%d\r\n" % (host, port)
        + "\r\n"
    )
    sock.sendall(request.encode())

    raw = b""
    while b"\r\n\r\n" not in raw:
        chunk = sock.recv(4096)
        if not chunk:
            raise RuntimeError("connection closed during the WebSocket handshake")
        raw += chunk
    head, _, rest = raw.partition(b"\r\n\r\n")
    status = head.split(b"\r\n")[0].decode(errors="replace")
    if "101" not in status:
        raise RuntimeError(f"WebSocket upgrade refused: {status} | {head.decode(errors='replace')[:300]}")
    expected = base64.b64encode(
        hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()
    ).decode()
    if expected.lower().encode() not in head.lower():
        raise RuntimeError("Sec-WebSocket-Accept mismatch")
    if b"sec-websocket-protocol" not in head.lower():
        raise RuntimeError("server did not accept the 'binary' subprotocol")

    ws = WS(sock)
    ws.buf = rest
    dbg(f"upgrade ok ({status.strip()}), {len(rest)} buffered byte(s) after headers")
    return ws


# ---------------------------------------------------------------------- RFB
class RFBOverWS:
    """RFB stream reader on top of the WebSocket message reader.

    WebSocket messages are NOT message boundaries for RFB: a single RFB byte
    stream is chopped into arbitrary chunks. Everything is therefore pushed
    through one byte buffer here - reading `count` and then `count` bytes of
    security types must not consume the second byte twice, nor block waiting
    for a message that will never come.
    """

    def __init__(self, ws: WS) -> None:
        self.ws = ws
        self._buf = b""

    def recv_exact(self, n: int) -> bytes:
        while len(self._buf) < n:
            chunk = self.ws.recv()
            if not chunk:
                raise EOFError("RFB stream ended before enough data arrived")
            self._buf += chunk
        out, self._buf = self._buf[:n], self._buf[n:]
        return out

    def send(self, data: bytes) -> None:
        self.ws.send(data)

    def handshake(self, password: str = "") -> str:
        dbg("waiting for the RFB greeting")
        version = self.recv_exact(12)
        if not version.startswith(b"RFB "):
            raise RuntimeError(f"not an RFB stream: {version!r}")
        ver = version[4:11].decode()
        self.send(b"RFB 003.008\n")

        count = self.recv_exact(1)[0]
        if count == 0:
            n = struct.unpack(">I", self.recv_exact(4))[0]
            raise RuntimeError("server refused: " + self.recv_exact(n).decode(errors="replace"))
        types = set(self.recv_exact(count))
        if 2 in types:
            self.send(b"\x02")
            salt = self.recv_exact(16)
            pw = password.encode()[:8].ljust(8, b"\x00")
            self.send(des.vnc_des_encrypt(pw, salt))
            result = struct.unpack(">I", self.recv_exact(4))[0]
            if result != 0:
                raise RuntimeError("VNC authentication failed")
        elif 1 in types:
            self.send(b"\x01")
            if struct.unpack(">I", self.recv_exact(4))[0] != 0:
                raise RuntimeError("security handshake failed")
        else:
            raise RuntimeError(f"no usable security type in {sorted(types)}")
        return ver

    def init(self) -> tuple[int, int, tuple, str]:
        self.send(b"\x01")                       # ClientInit, shared
        w, h = struct.unpack(">HH", self.recv_exact(4))
        pf = self.recv_exact(16)
        nlen = struct.unpack(">I", self.recv_exact(4))[0]
        name = self.recv_exact(nlen).decode(errors="replace")
        rmax, gmax, bmax = struct.unpack(">HHH", pf[4:10])
        pixel = (pf[0], pf[1], pf[2], pf[3], pf[10], pf[11], pf[12], rmax, gmax, bmax)
        return w, h, pixel, name

    def send_client_cut_text(self, text: str) -> None:
        """ClientCutText (RFB message 6): what a viewer sends when the user
        pastes into the session.  x11vnc turns it into the X clipboard."""
        data = text.encode()
        self.send(b"\x06" + b"\x00\x00\x00" + struct.pack(">I", len(data)) + data)

    def set_raw_encoding(self) -> None:
        """Ask for raw updates only, so the reader below can skip them."""
        self.send(struct.pack(">BBHi", 2, 0, 1, 0))              # SetEncodings raw

    def wait_server_cut_text(self, timeout: float = 20.0, allow_empty: bool = False) -> str:
        """Wait for a ServerCutText (RFB message 3).

        That is what x11vnc sends when the CLIPBOARD selection inside the
        session changes - the text the browser puts on the host clipboard.

        An EMPTY cut text is what x11vnc sends when the selection is unset
        (the owner died, nothing was ever copied): it carries no text, so it
        is skipped unless the caller asks for it.
        """
        self.set_raw_encoding()
        deadline = time.time() + timeout
        previous = self.ws.sock.gettimeout()
        self.ws.sock.settimeout(timeout)
        try:
            while time.time() < deadline:
                msg = self.recv_exact(1)[0]
                if msg == 3:                       # ServerCutText
                    self.recv_exact(3)
                    length = struct.unpack(">I", self.recv_exact(4))[0]
                    text = self.recv_exact(length).decode("utf-8", "replace")
                    if text or allow_empty:
                        return text
                    continue
                if msg == 0:                       # FramebufferUpdate
                    self.recv_exact(1)
                    nrects = struct.unpack(">H", self.recv_exact(2))[0]
                    for _ in range(nrects):
                        _rx, _ry, rw, rh, enc = struct.unpack(">HHHHi", self.recv_exact(12))
                        if enc != 0:
                            raise RuntimeError(
                                f"unexpected encoding {enc}: the client must ask "
                                "for raw updates before reading the stream"
                            )
                        self.recv_exact(rw * rh * 4)
                elif msg == 1:                     # SetColourMapEntries
                    self.recv_exact(1)
                    _first, ncolours = struct.unpack(">HH", self.recv_exact(4))
                    self.recv_exact(ncolours * 6)
                elif msg == 2:                     # Bell
                    continue
                else:
                    raise RuntimeError(f"unexpected server message {msg}")
        except (socket.timeout, TimeoutError) as exc:
            raise TimeoutError("no ServerCutText within the timeout") from exc
        finally:
            self.ws.sock.settimeout(previous)
        raise TimeoutError("no ServerCutText within the timeout")

    def request_raw_framebuffer(self, x=0, y=0, w=None, h=None) -> tuple[int, int]:
        self.set_raw_encoding()
        if w is None:
            w = h = 0xFFFF                                     # "as big as possible"
        self.send(struct.pack(">BBHHHH", 3, 0, x, y, w, h))

        msg = self.recv_exact(1)[0]
        if msg != 0:
            raise RuntimeError(f"unexpected server message {msg}")
        self.recv_exact(1)
        nrects = struct.unpack(">H", self.recv_exact(2))[0]
        fb = bytearray()
        dims = (0, 0)
        for _ in range(nrects):
            rx, ry, rw, rh, enc = struct.unpack(">HHHHi", self.recv_exact(12))
            if enc != 0:
                raise RuntimeError(f"unexpected encoding {enc} (manager must force raw)")
            fb += self.recv_exact(rw * rh * 4)
            dims = (rw, rh)
        return dims, fb


# ---------------------------------------------------------------------- PNG
def write_png(path: str, w: int, h: int, rgb: bytes) -> None:
    def chunk(tag: bytes, data: bytes) -> bytes:
        c = tag + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)

    raw = bytearray()
    stride = w * 3
    for y in range(h):
        raw.append(0)
        raw += rgb[y * stride:(y + 1) * stride]
    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n")
        f.write(chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)))
        f.write(chunk(b"IDAT", zlib.compress(bytes(raw), 6)))
        f.write(chunk(b"IEND", b""))


def looks_like_desktop(w: int, h: int, rgb: bytes) -> tuple[bool, str]:
    """A rendered LXDE desktop: coloured wallpaper, icons, a panel at the bottom.

    Works on the raw RGB buffer, so it needs no image library at all.
    """
    step = max(1, w // 320)          # subsample: the checks are statistical

    def px(x: int, y: int) -> tuple[int, int, int]:
        o = (y * w + x) * 3
        return rgb[o], rgb[o + 1], rgb[o + 2]

    colors: set[tuple[int, int, int]] = set()
    for y in range(0, h, step):
        for x in range(0, w, step):
            colors.add(px(x, y))

    # 1. not a blank screen
    if len(colors) < 24:
        return False, f"only {len(colors)} distinct colours - looks like a blank screen"

    # 2. wallpaper: the upper half is not a flat colour
    upper = {px(x, y) for y in range(0, h // 2, step) for x in range(0, w, step)}
    if len(upper) < 8:
        return False, "upper half is a flat colour - no wallpaper"

    # 3. a panel strip along the bottom edge (predominantly dark)
    panel = [px(x, h - 14) for x in range(0, w, step)]
    dark = sum(1 for p in panel if sum(p) < 260)
    if dark < len(panel) * 0.6:
        return False, "bottom strip is not a task panel"

    # 4. desktop icons: light label pixels in the left margin
    bright = 0
    for y in range(0, h - 40, step):
        for x in range(0, 160, step):
            if sum(px(x, y)) > 560:
                bright += 1
    if bright < 120:
        return False, "no icon labels found on the left edge"

    return True, f"{len(colors)} colours, wallpaper + panel + icons detected at {w}x{h}"


# --------------------------------------------------------------------- main
def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True, help="session URL, e.g. http://host:8080/s/<id>/")
    ap.add_argument("--ws", default="", help="WebSocket URL; derived from --url when empty")
    ap.add_argument("--user", required=True)
    ap.add_argument("--password", default="")
    ap.add_argument("--out", default="desktop.png")
    ap.add_argument("--expect-desktop", action="store_true")
    ap.add_argument("--clipboard", default="",
                    help="text to send as ClientCutText (what a browser paste does)")
    ap.add_argument("--expect-clipboard", default="",
                    help="text the session is expected to send back as ServerCutText")
    args = ap.parse_args()

    ws_url = args.ws
    if not ws_url:
        # /s/<id>/... -> /ws/<id>/
        parts = urllib.parse.urlsplit(args.url)
        segments = parts.path.split("/")
        if "s" in segments:
            i = segments.index("s")
            sid = segments[i + 1]
            ws_url = urllib.parse.urlunsplit(
                (parts.scheme, parts.netloc, f"/ws/{sid}/", "", "")
            )
        else:
            ws_url = args.url

    try:
        ws = websocket_connect(ws_url, args.user, args.password)
        rfb = RFBOverWS(ws)
        version = rfb.handshake(args.password)
        w, h, pixel, name = rfb.init()
        if args.expect_clipboard:
            # The other direction: the session sends its clipboard to the
            # viewer. The clipboard inside the session is changed by the
            # caller (a real user presses Ctrl+C), so this only waits for it.
            try:
                got = rfb.wait_server_cut_text(timeout=25)
            except TimeoutError as exc:
                print(f"ERROR: {exc}", file=sys.stderr)
                return 1
            if got.strip() != args.expect_clipboard.strip():
                print(
                    f"ERROR: the session sent {got!r}, expected "
                    f"{args.expect_clipboard!r}",
                    file=sys.stderr,
                )
                return 1
            print(f"ServerCutText received: {got!r}")
            return 0
        if args.clipboard:
            rfb.send_client_cut_text(args.clipboard)
            print(f"sent ClientCutText: {args.clipboard!r}")
            # x11vnc processes the message in its input loop; give it a
            # moment to take ownership of the X clipboard before the
            # connection goes away.
            time.sleep(1.5)
        (rw, rh), framebuffer = rfb.request_raw_framebuffer()
    except Exception as exc:  # noqa: BLE001
        print(f"ERROR: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1

    bpp, depth, big_endian, true_colour, rsh, gsh, bsh, rmax, gmax, bmax = pixel
    endian = "big" if big_endian else "little"
    rgb = bytearray(rw * rh * 3)
    for i in range(rw * rh):
        val = int.from_bytes(framebuffer[i * 4:i * 4 + 4], endian)
        rgb[i * 3] = ((val >> rsh) & rmax) * 255 // rmax
        rgb[i * 3 + 1] = ((val >> gsh) & gmax) * 255 // gmax
        rgb[i * 3 + 2] = ((val >> bsh) & bmax) * 255 // bmax

    write_png(args.out, rw, rh, bytes(rgb))
    print(
        f"RFB {version} | desktop '{name}' | {w}x{h} screen, got {rw}x{rh} "
        f"| {bpp}bpp depth {depth} | saved {args.out}"
    )

    if args.expect_desktop:
        good, why = looks_like_desktop(rw, rh, bytes(rgb))
        if not good:
            print(f"ERROR: screenshot does not look like a desktop: {why}", file=sys.stderr)
            return 1
        print(f"desktop content verified: {why}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
