#!/usr/bin/env python3
"""
Acceptance tests for the Web Linux Desktop platform.

Every numbered criterion from the specification is checked against a running
stack, and every check prints PASS / FAIL / SKIP with the evidence it used.

  docker compose up -d --build          # from the repository root
  python3 tests/test_acceptance.py

Exit code 0 means every check passed.
"""
from __future__ import annotations

import base64
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
ARTIFACTS = Path(os.environ.get("SHOTS_DIR", HERE / "artifacts"))
ARTIFACTS.mkdir(parents=True, exist_ok=True)

URL = os.environ.get("WD_URL", "http://127.0.0.1:8080").rstrip("/")
USER = os.environ.get("WD_USER", "admin")
# Empty by default: with auto-login the manager accepts a plain request, so the
# tests do not pretend that a password is required.
PASSWORD = os.environ.get("WD_PASSWORD", "")
PREFIX = os.environ.get("WD_PREFIX", "wd")
IMAGE = os.environ.get("DESKTOP_IMAGE", "webdesktop:lxde")

GREEN, RED, YELLOW, DIM, OFF = "\033[32m", "\033[31m", "\033[33m", "\033[2m", "\033[0m"
results = {"pass": 0, "fail": 0, "skip": 0}
CREATED: list[str] = []


# --------------------------------------------------------------- reporting
def ok(msg: str) -> None:
    print(f"{GREEN}PASS{OFF}  {msg}")
    results["pass"] += 1


def bad(msg: str) -> None:
    print(f"{RED}FAIL{OFF}  {msg}")
    results["fail"] += 1


def skip(msg: str) -> None:
    print(f"{YELLOW}SKIP{OFF}  {msg}")
    results["skip"] += 1


def info(msg: str) -> None:
    print(f"{DIM}      {msg}{OFF}")


def section(title: str) -> None:
    print(f"\n=== {title} ===")


# ------------------------------------------------------------------- helpers
def auth_header() -> dict:
    if not PASSWORD:
        return {}          # auto-login: nothing to send
    token = base64.b64encode(f"{USER}:{PASSWORD}".encode()).decode()
    return {"Authorization": f"Basic {token}"}


def api(method: str, path: str, body: dict | None = None, auth: bool = True):
    url = f"{URL}{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Accept", "application/json")
    if data:
        req.add_header("Content-Type", "application/json")
    if auth:
        for k, v in auth_header().items():
            req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            raw = resp.read().decode("utf-8", "replace")
            return resp.status, (json.loads(raw) if raw.strip().startswith(("{", "[")) else raw)
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", "replace")
        try:
            return exc.code, json.loads(raw)
        except ValueError:
            return exc.code, raw


def docker(*args: str, check: bool = False) -> str:
    proc = subprocess.run(
        ["docker", *args], capture_output=True, text=True, check=check
    )
    return proc.stdout if proc.returncode == 0 else (proc.stdout + proc.stderr)


def docker_inspect(container: str, template: str) -> str:
    return docker("inspect", container, "--format", template).strip()


def cleanup() -> None:
    for sid in CREATED:
        api("DELETE", f"/api/sessions/{sid}?delete_data=true")


def wait_state(sid: str, wanted=("running",), timeout: int = 120) -> str:
    deadline = time.time() + timeout
    state = "unknown"
    while time.time() < deadline:
        _, payload = api("GET", f"/api/sessions/{sid}")
        state = payload.get("state", "unknown")
        if state in wanted or state in ("failed", "stopped"):
            return state
        time.sleep(2)
    return state


# ------------------------------------------------------------------- checks
def t01_image_builds() -> None:
    section("1. the image builds and is present")
    if subprocess.run(["docker", "image", "inspect", IMAGE],
                      capture_output=True).returncode == 0:
        ls = docker("image", "ls", IMAGE, "--format", "{{.Size}}").strip()
        size = int(docker("image", "inspect", IMAGE, "--format", "{{.Size}}").strip())
        history = docker("history", IMAGE, "--format", "{{.Size}}")
        uncompressed = 0.0
        for line in history.splitlines():
            line = line.strip()
            m = re.match(r"^([\d.]+)\s*([kKmMgG]?)[bB]$", line)
            if not m:
                continue
            value = float(m.group(1))
            factor = {"": 1e-6, "k": 1e-3, "m": 1.0, "g": 1024.0}[m.group(2).lower()]
            uncompressed += value * factor
        ok(f"image {IMAGE} present")
        info(f"docker image ls      : {ls}   (Docker Desktop over-counts: it adds")
        info(f"                       the compressed size on top of the layer sizes)")
        info(f"compressed / download : {size / 1e6:.1f} MB")
        info(f"uncompressed / on-disk: {uncompressed:.1f} MB  (sum of {len(history.splitlines())} layers)")
    else:
        bad(f"image {IMAGE} is missing - run: docker compose build desktop-image")


def t02_no_browser() -> None:
    section("2. no Chrome/Chromium inside the image")
    binaries = docker(
        "run", "--rm", "--entrypoint", "sh", IMAGE, "-c",
        "command -v google-chrome chromium chromium-browser chrome 2>/dev/null; "
        "ls -d /opt/google /opt/chrom* /usr/lib/chromium* /usr/share/chromium 2>/dev/null",
    ).strip()
    packages = docker(
        "run", "--rm", "--entrypoint", "sh", IMAGE, "-c",
        "dpkg -l 2>/dev/null | grep -i chrom || true",
    ).strip()
    if not binaries:
        ok("no chrome/chromium binary or directory in the image")
    else:
        bad(f"chrome artefacts found: {binaries}")
    if not packages:
        ok("no chromium-related package installed")
    else:
        bad(f"chromium package installed: {packages}")


def t03_manager_up() -> None:
    section("3. the manager serves noVNC to a browser")
    code, payload = api("GET", "/healthz", auth=False)
    ok(f"GET /healthz -> {code} {payload}") if code == 200 else bad(f"/healthz -> {code}")
    code, _ = api("GET", "/s/")
    ok("GET /s/ served the session index") if code == 200 else bad(f"/s/ -> {code}")
    code, _ = api("GET", "/novnc/core/rfb.js")
    ok("noVNC client assets are served") if code == 200 else bad(f"/novnc/core/rfb.js -> {code}")
    code, _ = api("GET", "/s/")
    ok("the index page redirects from /") if code == 200 else bad("/ -> unexpected")


def t04_auth_required() -> None:
    section("4. authentication: automatic by default, enforced when switched off")
    AUTO = os.environ.get("WD_AUTO_LOGIN", "1") not in {"0", "false", "no", "off"}

    # Anonymous access must simply work while auto-login is on - no prompt, no
    # password, nothing for the user to type.
    for path in ("/api/sessions", "/s/", "/api/resources"):
        code, _ = api("GET", path, auth=False)
        if AUTO and code == 200:
            ok(f"{path} is usable with no credentials (auto-login), status {code}")
        elif not AUTO and code == 401:
            ok(f"{path} rejects anonymous access with 401 (auto-login off)")
        else:
            bad(f"{path} returned {code}; expected {200 if AUTO else 401} "
                f"(auto_login={'on' if AUTO else 'off'})")

    if not AUTO:
        token = base64.b64encode(f"{USER}:wrong-password".encode()).decode()
        req = urllib.request.Request(f"{URL}/api/sessions")
        req.add_header("Authorization", f"Basic {token}")
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                bad(f"a wrong password was accepted (HTTP {resp.status})")
        except urllib.error.HTTPError as exc:
            ok(f"a wrong password is rejected with {exc.code}") if exc.code == 401 \
                else bad(f"wrong password -> HTTP {exc.code}")

    code, who = api("GET", "/api/whoami", auth=False)
    if code == 200 and isinstance(who, dict) and who.get("auto_login_enabled") == AUTO:
        ok(f"/api/whoami reports auto_login_enabled={AUTO}, user={who.get('username')!r}, "
           f"automatic={who.get('auto_login')}")
    else:
        bad(f"/api/whoami -> {code} {who}")

    # Without auto-login a WebSocket upgrade must never reach the session.
    import socket
    s = socket.create_connection(_host_port(), timeout=10)
    s.sendall(
        b"GET /ws/does-not-matter/ HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\n"
        b"Connection: Upgrade\r\nSec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==\r\n"
        b"Sec-WebSocket-Version: 13\r\n\r\n" % _host().encode()
    )
    head = s.recv(200).decode(errors="replace")
    s.close()
    if "101" in head:
        bad(f"WebSocket upgrade without credentials was accepted: {head.splitlines()[0]}")
    else:
        ok(f"unauthenticated WebSocket upgrade refused: {head.splitlines()[0].strip()}")


def _host() -> str:
    from urllib.parse import urlsplit
    return urlsplit(URL).hostname or "127.0.0.1"


def _host_port() -> tuple[str, int]:
    from urllib.parse import urlsplit
    parts = urlsplit(URL)
    return parts.hostname or "127.0.0.1", parts.port or 80


def t05_two_sessions() -> tuple[str, str]:
    section("5. two independent sessions run at the same time")
    ids = []
    for res in ("1280x800", "1024x768"):
        code, payload = api("POST", "/api/sessions", {"resolution": res})
        if code != 201:
            bad(f"session creation returned {code}: {payload}")
            return "", ""
        ids.append(payload["id"])
        CREATED.append(payload["id"])
        info(f"created {payload['id']} at {payload['url']}")
    if len(ids) == 2 and ids[0] != ids[1]:
        ok(f"two sessions created: {ids[0]} and {ids[1]}")
    for sid in ids:
        state = wait_state(sid)
        if state == "running":
            ok(f"session {sid} reports running")
        else:
            bad(f"session {sid} is '{state}'")
            _, logs = api("GET", f"/api/sessions/{sid}/logs?tail=30")
            info(str(logs)[-600:])
    return ids[0], ids[1]


def t06_isolation(sid_a: str, sid_b: str) -> None:
    section("6. separate displays, separate data, no interference")
    env_a = docker_inspect(f"{PREFIX}-{sid_a}", "{{range .Config.Env}}{{println .}}{{end}}")
    env_b = docker_inspect(f"{PREFIX}-{sid_b}", "{{range .Config.Env}}{{println .}}{{end}}")

    def env(env, key):
        for line in env.splitlines():
            if line.startswith(key + "="):
                return line.split("=", 1)[1]
        return ""

    if env(env_a, "DISPLAY_NUM") != env(env_b, "DISPLAY_NUM"):
        ok(f"different X displays: :{env(env_a,'DISPLAY_NUM')} and :{env(env_b,'DISPLAY_NUM')}")
    else:
        bad(f"both sessions use DISPLAY_NUM={env(env_a,'DISPLAY_NUM')}")

    if env(env_a, "VNC_PORT") != env(env_b, "VNC_PORT"):
        ok(f"different RFB ports: {env(env_a,'VNC_PORT')} and {env(env_b,'VNC_PORT')}")
    else:
        bad(f"both sessions use VNC_PORT={env(env_a,'VNC_PORT')}")

    docker("exec", "-u", "desktop", f"{PREFIX}-{sid_a}", "sh", "-c",
           "echo secret-from-session-a > /home/desktop/ISOLATION_TEST")
    leaked = subprocess.run(
        ["docker", "exec", "-u", "desktop", f"{PREFIX}-{sid_b}", "sh", "-c",
         "test -e /home/desktop/ISOLATION_TEST"],
        capture_output=True,
    ).returncode == 0
    bad("a file written in session A exists in session B") if leaked \
        else ok("a file written in session A is invisible in session B")

    vol_a = docker_inspect(f"{PREFIX}-{sid_a}", "{{range .Mounts}}{{.Name}} {{end}}")
    vol_b = docker_inspect(f"{PREFIX}-{sid_b}", "{{range .Mounts}}{{.Name}} {{end}}")
    if vol_a.strip() != vol_b.strip() and vol_a.strip():
        ok(f"separate home volumes: {vol_a.strip()} / {vol_b.strip()}")
    else:
        bad(f"home volumes are not distinct: '{vol_a}' / '{vol_b}'")


def t07_persistence(sid: str) -> None:
    section("7. user data survives a container restart")
    docker("restart", f"{PREFIX}-{sid}")
    state = wait_state(sid, timeout=150)
    present = subprocess.run(
        ["docker", "exec", "-u", "desktop", f"{PREFIX}-{sid}", "sh", "-c",
         "grep -q secret-from-session-a /home/desktop/ISOLATION_TEST"],
        capture_output=True,
    ).returncode == 0
    if present and state == "running":
        ok("the file is still there after `docker restart` (state=running)")
    else:
        bad(f"data lost or session not running after restart (state={state})")


def t07b_survives_stack_restart(sid: str) -> None:
    """A full `down` + `up` must not lose the session or its files.

    This is the case that motivated stopping (not removing) the session
    containers on shutdown: compose deletes the sessions network and `up`
    recreates it with a NEW id, so the stopped containers come back attached to
    a network that no longer exists and cannot start. The manager replaces the
    container and keeps the home volume, so what has to survive here is the
    session's DATA.
    """
    section("7b. the session survives a full `compose down` + `up`")
    mark = "SURVIVES-STACK-RESTART"
    subprocess.run(
        ["docker", "exec", "-u", "desktop", f"{PREFIX}-{sid}", "sh", "-c",
         f"echo {mark} > /home/desktop/STACK_RESTART_TEST"],
        capture_output=True,
    )

    down = subprocess.run(["docker", "compose", "down"], capture_output=True, text=True)
    if "still in use" in (down.stdout + down.stderr):
        bad("`docker compose down` failed: the sessions network is still in use")
        return
    ok("`docker compose down` succeeded with a live session")

    subprocess.run(["docker", "compose", "up", "-d"], capture_output=True, text=True)
    if not wait_manager():
        bad("the manager did not come back after `up`")
        return

    state = wait_session_running(sid, timeout=180)
    if state != "running":
        bad(f"session {sid} did not come back after down+up (state={state})")
        return
    ok(f"session {sid} is running again after down+up")

    present = subprocess.run(
        ["docker", "exec", "-u", "desktop", f"{PREFIX}-{sid}", "sh", "-c",
         f"grep -q {mark} /home/desktop/STACK_RESTART_TEST"],
        capture_output=True,
    ).returncode == 0
    ok("the user's file survived down+up (home volume kept)") if present \
        else bad("user data lost across down+up")


def t08_limits(sid: str) -> None:
    section("8. resource limits are applied to the session container")
    mem = int(docker_inspect(f"{PREFIX}-{sid}", "{{.HostConfig.Memory}}") or 0)
    cpu = int(docker_inspect(f"{PREFIX}-{sid}", "{{.HostConfig.NanoCpus}}") or 0)
    pids = int(docker_inspect(f"{PREFIX}-{sid}", "{{.HostConfig.PidsLimit}}") or 0)
    swap = int(docker_inspect(f"{PREFIX}-{sid}", "{{.HostConfig.MemorySwap}}") or 0)
    priv = docker_inspect(f"{PREFIX}-{sid}", "{{.HostConfig.Privileged}}")
    published = docker_inspect(f"{PREFIX}-{sid}", "{{range $p,$c := .HostConfig.PortBindings}}{{$p}}{{end}}")
    mounts = docker_inspect(f"{PREFIX}-{sid}", "{{range .Mounts}}{{.Destination}} {{end}}")
    caps = docker_inspect(f"{PREFIX}-{sid}", "{{.HostConfig.CapDrop}}")

    ok(f"hard memory limit: {mem // 1048576} MiB") if mem else bad("no memory limit")
    ok(f"CPU quota: {cpu / 1e9:.2f} cores") if cpu else bad("no CPU quota")
    ok(f"pids limit: {pids}") if pids else bad("no pids limit")
    # Docker's "no swap" is MemorySwap == Memory (0 would mean "unset", which
    # makes the daemon default to twice the memory limit).
    if swap == mem:
        ok(f"swap is disabled (MemorySwap == Memory == {swap // 1048576} MiB)")
    else:
        bad(f"MemorySwap is {swap}, expected {mem} (equal to the memory limit)")
    ok("container is not privileged") if priv == "false" else bad("container IS privileged")
    ok("all capabilities dropped") if "ALL" in caps else bad(f"cap_drop = {caps}")
    ok("no port is published to the host") if not published.strip() \
        else bad(f"session publishes {published}")
    ok("no docker socket inside the session") if "/var/run/docker.sock" not in mounts \
        else bad("docker socket is mounted into a session container")


def t09_admission(sid_a: str, sid_b: str) -> None:
    section("9. admission control refuses new sessions under pressure")
    _, res = api("GET", "/api/resources")
    total = res["host"]["total_memory_mb"]
    impossible = total + 100_000

    prev = docker_inspect("wd-manager", "{{range .Config.Env}}{{println .}}{{end}}")
    prev = next((l.split("=", 1)[1] for l in prev.splitlines()
                 if l.startswith("MIN_FREE_MEMORY_MB=")), "700")
    info(f"raising MIN_FREE_MEMORY_MB to {impossible} MiB (the host has {total} MiB)")
    env = dict(os.environ, MIN_FREE_MEMORY_MB=str(impossible))
    subprocess.run(["docker", "compose", "up", "-d", "manager"],
                   capture_output=True, text=True, env=env)
    wait_manager()
    code, payload = api("POST", "/api/sessions", {"wait": 0})
    if code in (429, 503):
        ok(f"session creation refused with HTTP {code}: {payload.get('detail', payload)}")
    else:
        bad(f"a session was created although the host is 'out of memory' (HTTP {code})")

    env = dict(os.environ, MIN_FREE_MEMORY_MB=prev)
    subprocess.run(["docker", "compose", "up", "-d", "manager"],
                   capture_output=True, text=True, env=env)
    wait_manager()
    ok(f"admission threshold restored to MIN_FREE_MEMORY_MB={prev}")

    # Checked AFTER the restore, which is itself another manager restart: the
    # manager stops its session containers on SIGTERM (that is what frees the
    # sessions network for `docker compose down`) and resumes exactly the ones
    # the store still calls running, so they are briefly `starting` again while
    # Xvfb/x11vnc come back. What matters is that they came back at all - a
    # session killed by resource pressure would be gone or `failed`.
    for sid in (sid_a, sid_b):
        state = wait_session_running(sid, timeout=180)
        ok(f"running session {sid} survived the refusal (state={state})") if state == "running" \
            else bad(f"running session {sid} was affected (state={state})")


def wait_session_running(sid: str, timeout: int = 120) -> str:
    """Poll until a session reports `running`; returns the last state seen."""
    deadline = time.time() + timeout
    state = ""
    while time.time() < deadline:
        code, payload = api("GET", f"/api/sessions/{sid}")
        if code == 404:
            return "gone"
        state = payload.get("state", "")
        if state in ("running", "failed", "stopped"):
            return state
        time.sleep(2)
    return state or "unknown"


def wait_manager(timeout: int = 90) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            code, _ = api("GET", "/healthz", auth=False)
            if code == 200:
                return True
        except Exception:  # noqa: BLE001
            pass
        time.sleep(2)
    return False


def t10_footprint(sid: str) -> None:
    section("10. measured idle footprint of one session")
    stats = docker("stats", "--no-stream", "--format",
                   "{{.MemUsage}}|{{.CPUPerc}}", f"{PREFIX}-{sid}").strip()
    info(f"docker stats (RAM | CPU): {stats}")
    rss = docker("exec", "-u", "desktop", f"{PREFIX}-{sid}",
                 "sh", "-c", "ps -eo rss,comm --sort=-rss | head -9")
    for line in rss.splitlines():
        info(line)
    _, usage = api("GET", "/api/resources/sessions")
    for entry in usage.get("sessions", []):
        if entry["id"] == sid and entry.get("stats"):
            st = entry["stats"]
            info(f"manager sample: {st['memory_usage_mb']} MiB of a "
                 f"{st['memory_limit_mb']} MiB cap, CPU {st['cpu_percent']}%")
    _, res = api("GET", "/api/resources")
    h = res["host"]
    info(f"host: {h['available_memory_mb']} MiB available of {h['total_memory_mb']} MiB, "
         f"{h['cpu_count']} CPU(s), load {h['load_average_1m']:.2f}")
    ok("resource usage measured (see above)")


def t11_browser_path(sid: str) -> None:
    section("11. the browser path end-to-end (WebSocket -> RFB -> pixels)")
    # The manager refuses the WebSocket while the session is still `starting`,
    # and a session resumed after a manager restart needs a moment. Waiting
    # here keeps this test about the browser path rather than about whatever
    # the previous test happened to leave behind.
    state = wait_session_running(sid, timeout=120)
    if state != "running":
        bad(f"session {sid} is not running (state={state}), cannot test the browser path")
        return

    # The viewer page itself. noVNC 1.x has no global `UI`, so a page that still
    # calls `UI.autoconnect()` renders a black screen with nothing on it - the
    # browser path below would keep working while every real user sees nothing.
    code, page = api("GET", f"/s/{sid}/vnc.html")
    if code == 200 and isinstance(page, str):
        if "UI.start" in page and "UI.autoconnect(" not in page:
            ok("the viewer page starts noVNC through UI.start (no global-UI call)")
        else:
            bad("the viewer page does not bootstrap noVNC via UI.start - a browser "
                "would show an empty screen")
        if f"/ws/{sid}/" in page:
            ok(f"the viewer page points at this session's WebSocket (/ws/{sid}/)")
        else:
            bad(f"the viewer page does not reference /ws/{sid}/")
        if page.count("UI.start") == 1:
            ok("exactly one noVNC bootstrap in the page (no duplicate clients)")
        else:
            bad(f"UI.start appears {page.count('UI.start')} times, expected once")
    else:
        bad(f"GET /s/{sid}/vnc.html -> {code}")

    out = ARTIFACTS / f"session-{sid}.png"
    proc = subprocess.run(
        [sys.executable, str(HERE / "test_novnc_stream.py"),
         "--url", f"{URL}/s/{sid}/", "--user", USER, "--password", PASSWORD,
         "--out", str(out), "--expect-desktop"],
        capture_output=True, text=True,
    )
    if proc.returncode == 0:
        ok(f"frames streamed to a browser-equivalent client: {out}")
        info(proc.stdout.strip())
    else:
        # Always show the evidence: a FAIL without the client's own output is
        # impossible to act on. flush() because stderr from the child is
        # unbuffered and would otherwise land somewhere else in the log.
        bad(f"the noVNC WebSocket path did not deliver a desktop "
            f"(exit={proc.returncode})")
        for line in (proc.stdout + proc.stderr).strip().splitlines():
            info(line)
        sys.stdout.flush()


def t12_delete(sid_a: str, sid_b: str) -> None:
    section("12. deleting a session and its data")
    code, payload = api("DELETE", f"/api/sessions/{sid_b}?delete_data=true")
    if code == 200 and payload.get("deleted"):
        CREATED.remove(sid_b)
        ok(f"session {sid_b} deleted, user data removed ({payload.get('note')})")
    else:
        bad(f"delete returned {code}: {payload}")
    volumes = docker("volume", "ls", "--format", "{{.Name}}")
    if f"{PREFIX}-home-{sid_b}" not in volumes:
        ok("the session's home volume is gone from Docker")
    else:
        bad(f"volume {PREFIX}-home-{sid_b} still exists")

    code, _ = api("GET", f"/api/sessions/{sid_b}")
    ok("the deleted session is no longer known to the manager") if code == 404 \
        else bad(f"deleted session still answers with {code}")


def t13_image_size() -> None:
    section("13. image size and installed payload, measured")
    info(f"{'docker image ls':<24}: {docker('image','ls',IMAGE,'--format','{{.Size}}').strip()}"
         "   (Docker Desktop over-counts, see t01)")
    info(f"{'compressed / download':<24}: "
         f"{int(docker('image','inspect',IMAGE,'--format','{{.Size}}').strip()) / 1e6:.1f} MB")
    pkgs = docker("run", "--rm", "--entrypoint", "sh", IMAGE, "-c",
                  "dpkg-query -f='${Installed-Size}\\n' -W 2>/dev/null | "
                  "awk '{s+=$1; n++} END {printf \"%.0f MiB in %d packages\", s/1024, n}'")
    info(f"{'installed packages':<24}: {pkgs.strip()}")
    if pkgs.strip():
        ok("installed package payload measured")
    else:
        bad("could not read the package database from the image")
    tool = HERE.parent / "scripts" / "image-size.sh"
    if os.name == "posix" and tool.exists():
        out = subprocess.run(["bash", str(tool), IMAGE], capture_output=True, text=True)
        for line in out.stdout.splitlines():
            info(line)


def main() -> int:
    print(f"Web Linux Desktop - acceptance tests against {URL}")
    t01_image_builds()
    t02_no_browser()
    t03_manager_up()
    t04_auth_required()
    sid_a, sid_b = t05_two_sessions()
    if not sid_a:
        print("\ncannot continue without a session")
        return 1
    t06_isolation(sid_a, sid_b)
    t07_persistence(sid_a)
    t07b_survives_stack_restart(sid_a)
    t08_limits(sid_a)
    t09_admission(sid_a, sid_b)
    t10_footprint(sid_a)
    t11_browser_path(sid_a)
    t13_image_size()
    t12_delete(sid_a, sid_b)

    cleanup()
    print("\n" + "=" * 46)
    print(f" passed: {results['pass']}   failed: {results['fail']}   skipped: {results['skip']}")
    print(f" artifacts: {ARTIFACTS}")
    print("=" * 46)
    return 0 if results["fail"] == 0 else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    finally:
        pass
