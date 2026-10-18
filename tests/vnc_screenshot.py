#!/usr/bin/env python3
"""
Minimal RFB (VNC) client used by the test suite.

It performs the full RFB 3.8 handshake (security type None or VNC
Authentication), requests a framebuffer update with Raw encoding and writes the
result as a PNG. This is a test helper, it is NOT part of the runtime.

Usage:
    python3 vnc_screenshot.py HOST PORT OUT.png [PASSWORD] [--rect X Y W H]
"""
import os
import socket
import struct
import sys
import zlib

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import des  # noqa: E402


# --------------------------------------------------------------------------- io
class Reader:
    def __init__(self, sock):
        self.s = sock
        self.buf = b""

    def need(self, n):
        while len(self.buf) < n:
            chunk = self.s.recv(65536)
            if not chunk:
                raise EOFError("connection closed by VNC server")
            self.buf += chunk

    def read(self, n):
        self.need(n)
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def u8(self):
        return self.read(1)[0]

    def u16(self):
        return struct.unpack(">H", self.read(2))[0]

    def u32(self):
        return struct.unpack(">I", self.read(4))[0]


def write_png(path, w, h, rgb):
    def chunk(tag, data):
        c = tag + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c))

    raw = bytearray()
    stride = w * 3
    for y in range(h):
        raw.append(0)                       # filter type 0
        raw += rgb[y * stride:(y + 1) * stride]
    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(bytes(raw), 6))
           + chunk(b"IEND", b""))
    with open(path, "wb") as f:
        f.write(png)


# ------------------------------------------------------------------- handshake
def vnc_auth(password, salt):
    """RFB VNC Authentication: DES-ECB of the challenge with the bit-reversed key."""
    pw = password.encode()[:8].ljust(8, b"\x00")
    return des.vnc_des_encrypt(pw, salt)


def handshake(sock, r, password=""):
    ver = r.read(12)
    if not ver.startswith(b"RFB "):
        raise RuntimeError(f"not an RFB server: {ver!r}")
    version = ver[4:11].decode("ascii", "replace")
    sock.sendall(b"RFB 003.008\n")

    count = r.u8()
    if count == 0:
        reason_len = r.u32()
        raise RuntimeError("server refused: " + r.read(reason_len).decode(errors="replace"))
    types = {r.u8() for _ in range(count)}
    if 2 in types:
        sock.sendall(bytes([2]))                       # VNC Authentication
        salt = r.read(16)
        sock.sendall(vnc_auth(password, salt))
        result = struct.unpack(">I", r.read(4))[0]
        if result != 0:
            raise RuntimeError("VNC authentication failed (wrong password?)")
    elif 1 in types:
        sock.sendall(bytes([1]))                       # None
        result = struct.unpack(">I", r.read(4))[0]
        if result != 0:
            raise RuntimeError("VNC security handshake failed")
    else:
        raise RuntimeError(f"no supported security type in {types}")
    return version


def init_and_capture(host, port, password="", rect=None, out="shot.png"):
    sock = socket.create_connection((host, port), timeout=15)
    sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    sock.settimeout(30)
    r = Reader(sock)
    ver = handshake(sock, r, password)

    sock.sendall(bytes([1]))                                    # ClientInit shared
    w, h = struct.unpack(">HH", r.read(4))
    pf = r.read(16)
    namelen = struct.unpack(">I", r.read(4))[0]
    r.read(namelen)

    bpp, depth, big_endian, true_colour = pf[0], pf[1], pf[2], pf[3]
    rmax, gmax, bmax = struct.unpack(">HHH", pf[4:10])
    rsh, gsh, bsh = pf[10], pf[11], pf[12]
    if not true_colour:
        raise RuntimeError("server does not advertise true colour")

    if rect is None:
        x, y, cw, ch = 0, 0, w, h
    else:
        x, y, cw, ch = rect
    cw = min(cw, w - x)
    ch = min(ch, h - y)

    # SetEncodings: Raw(0) only - we want pixel-exact data, no compression.
    sock.sendall(struct.pack(">BBHi", 2, 0, 1, 0))
    # FramebufferUpdateRequest (incremental=0)
    sock.sendall(struct.pack(">BBHHHH", 3, 0, x, y, cw, ch))

    fb = bytearray(w * h * 3)
    got = 0
    deadline_msgs = 0
    while True:
        msg = r.u8()
        if msg != 0:
            raise RuntimeError(f"unexpected server message type {msg}")
        r.read(1)                                              # padding
        nrects = r.u16()
        if nrects == 0:
            break
        for _ in range(nrects):
            rx, ry, rw, rh, enc = struct.unpack(">HHHHi", r.read(12))
            if enc != 0:
                # Skip any other encoding by closing and reporting.
                raise RuntimeError(f"unexpected encoding {enc}")
            data = r.read(rw * rh * 4)
            # Pixel layout comes from ServerInit (bit shifts + maxima), it is
            # NOT necessarily R,G,B in byte order. x11vnc on a little-endian
            # host typically reports shifts 16/8/0, i.e. BGRX in memory order.
            endian = "big" if big_endian else "little"
            for row in range(rh):
                base = (row * rw) * 4
                for col in range(rw):
                    val = int.from_bytes(data[base + col * 4: base + col * 4 + 4], endian)
                    o = ((ry + row) * w + (rx + col)) * 3
                    fb[o] = ((val >> rsh) & rmax) * 255 // rmax
                    fb[o + 1] = ((val >> gsh) & gmax) * 255 // gmax
                    fb[o + 2] = ((val >> bsh) & bmax) * 255 // bmax
            got += 1
        deadline_msgs += 1
        if got:
            break
        if deadline_msgs > 5:
            raise RuntimeError("no framebuffer update received")

    sock.close()
    cw_out, ch_out = cw, ch
    cropped = bytearray(cw_out * ch_out * 3)
    for row in range(ch_out):
        src = ((y + row) * w + x) * 3
        cropped[row * cw_out * 3:(row + 1) * cw_out * 3] = fb[src:src + cw_out * 3]
    write_png(out, cw_out, ch_out, cropped)
    return w, h, cw_out, ch_out, ver


if __name__ == "__main__":
    args = [a for a in sys.argv[1:]]
    rect = None
    if "--rect" in args:
        i = args.index("--rect")
        rect = tuple(int(v) for v in args[i + 1:i + 5])
        del args[i:i + 5]
    host, port, out = args[0], int(args[1]), args[2]
    pw = args[3] if len(args) > 3 else ""
    W, H, cw, ch, ver = init_and_capture(host, port, pw, rect, out)
    print(f"RFB {ver} | framebuffer {W}x{H} | saved {cw}x{ch} -> {out}")
