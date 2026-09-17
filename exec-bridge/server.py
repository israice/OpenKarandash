"""Generic host-side exec bridge.

Runs commands the containerized server.js cannot run itself, because the
target binary (opencode, pi, codex - CLI agents; potentially powershell.exe
for the Karandash screenshot) is installed on the real host, not inside the
container. Unlike claude-bridge (an OpenAI-compatible shim specific to
Claude/Hermes), this bridge knows nothing about any particular CLI: it is
handed an already fully-resolved cmd/args pair - target selection, WSL
shell-wrapping, model flags all stay in server.js - and only spawns it,
streams its stdout back as NDJSON, and can kill it.

Built on the standard library, same reasoning as claude-bridge/server.py:
runs with a bare python3 on the host, nothing to keep in sync with the
container image.

See DOCS/decisions/037-exec-bridge-для-cli-коннекторов.md and
DOCS/план-докеризации-коннекторов.md for the stage plan this is part of.
"""
from __future__ import annotations

import json
import logging
import os
import re
import subprocess
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from config import BridgeConfig

logger = logging.getLogger("exec_bridge.server")
CFG = BridgeConfig()

# тот же маркер, что REMOTE_PID_MARK в server.js - сервер оборачивает shell-цели
# (wsl.exe) командой echo этого маркера перед exec, чтобы позже убить дерево
# внутри виртуалки по настоящему PID, а не PID самого wsl.exe
REMOTE_PID_MARK = "__karandash_pid__"
_MARK_RE = re.compile(REMOTE_PID_MARK + r"(\d+)\s*")

_RUNS: dict[str, "Run"] = {}
_RUNS_LOCK = threading.Lock()


class Run:
    """Живое состояние одного запуска - то, что нужно, чтобы его прибить."""

    def __init__(self, proc: subprocess.Popen, cmd: str, shell_prefix: list[str] | None):
        self.proc = proc
        self.cmd = cmd
        # ['bash', '-lc'] когда исходная цель - wsl.exe (viaShell на стороне
        # server.js), иначе None - тогда убиваем сам процесс напрямую
        self.shell_prefix = shell_prefix
        self.remote_pid: str | None = None
        self.lock = threading.Lock()

    def kill(self) -> None:
        with self.lock:
            if self.shell_prefix is not None and self.remote_pid:
                # виртуалка живёт в своём PID-namespace - PID самого wsl.exe её не убьёт
                try:
                    subprocess.Popen(
                        [self.cmd, *self.shell_prefix, f"kill -TERM {self.remote_pid} 2>/dev/null"],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                    )
                except Exception:
                    pass
            if os.name == "nt" and self.proc.pid:
                # /T - вместе с потомками, /F - принудительно: сигналов на Windows нет
                try:
                    subprocess.Popen(
                        ["taskkill", "/pid", str(self.proc.pid), "/T", "/F"],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                    )
                except Exception:
                    pass
            try:
                self.proc.kill()
            except Exception:
                pass


class Handler(BaseHTTPRequestHandler):
    server_version = "exec-bridge/0.1"

    def log_message(self, fmt, *args):  # route access logs through logging
        logger.info("%s - %s", self.address_string(), fmt % args)

    def _authorized(self) -> bool:
        """Constant work regardless of outcome; empty token means auth is off."""
        if not CFG.auth_token:
            return True
        header = self.headers.get("Authorization", "")
        presented = header[7:] if header.startswith("Bearer ") else self.headers.get("X-Bridge-Token", "")
        return presented == CFG.auth_token

    def _send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _error(self, status: int, message: str) -> None:
        self._send_json(status, {"ok": False, "error": message})

    def do_GET(self):
        route = self.path.split("?")[0].rstrip("/") or "/"
        if route == "/health":
            self._send_json(200, {"status": "ok"})
            return
        self._error(404, f"unknown path {self.path}")

    def do_POST(self):
        if not self._authorized():
            self._error(401, "missing or invalid bridge token")
            return
        route = self.path.split("?")[0].rstrip("/")

        match = re.match(r"^/exec/([^/]+)/kill$", route)
        if match:
            self._handle_kill(match.group(1))
            return
        if route == "/exec":
            self._handle_exec()
            return
        self._error(404, f"unknown path {self.path}")

    def _handle_kill(self, run_id: str) -> None:
        with _RUNS_LOCK:
            run = _RUNS.get(run_id)
        if not run:
            # запуск уже завершился сам между отправкой Stop и приходом запроса -
            # это не ошибка, а нормальная гонка, убивать уже нечего
            self._send_json(200, {"ok": True, "note": "already finished"})
            return
        run.kill()
        self._send_json(200, {"ok": True})

    def _handle_exec(self) -> None:
        try:
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, json.JSONDecodeError) as exc:
            self._error(400, f"malformed request body: {exc}")
            return

        cmd = body.get("cmd")
        args = body.get("args")
        if not isinstance(cmd, str) or not cmd or not isinstance(args, list):
            self._error(400, "'cmd' (string) and 'args' (list) are required")
            return
        input_text = body.get("input") or ""
        timeout_s = (body.get("timeoutMs") or CFG.default_timeout * 1000) / 1000
        extra_env = body.get("env") if isinstance(body.get("env"), dict) else {}
        # не None - последний элемент args был собран server.js как shell-строка
        # (bash -lc "..."), а это - префикс без неё (['bash', '-lc']), нужный
        # бриджу только чтобы переиздать kill-команду в той же виртуалке
        shell_prefix = body.get("shellPrefix") if isinstance(body.get("shellPrefix"), list) else None

        run_id = uuid.uuid4().hex
        env = {**os.environ, **{str(k): str(v) for k, v in extra_env.items()}}

        try:
            proc = subprocess.Popen(
                [cmd, *args], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                stderr=subprocess.PIPE, text=True, bufsize=1, env=env,
            )
        except OSError as exc:
            self._error(502, f"{cmd} not found: {exc}")
            return

        run = Run(proc, cmd, shell_prefix)
        with _RUNS_LOCK:
            _RUNS[run_id] = run

        # NDJSON построчно, начиная с runId - сервер может звать kill, ещё не
        # дождавшись первой строки вывода; в духе NDJSON-потоков, уже принятых
        # в проекте у остальных CLI-коннекторов (AGENTS.md, PROJECTS/Chat)
        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()

        def emit(payload: dict) -> None:
            try:
                self.wfile.write((json.dumps(payload) + "\n").encode())
                self.wfile.flush()
            except Exception:
                pass  # клиент мог уже отвалиться - писать больше некуда

        emit({"type": "started", "runId": run_id})

        try:
            proc.stdin.write(input_text)
        except Exception:
            pass
        finally:
            try:
                proc.stdin.close()
            except Exception:
                pass

        stderr_chunks: list[str] = []

        def read_stderr():
            for line in iter(proc.stderr.readline, ""):
                nonlocal_line = line
                if shell_prefix is not None:
                    match = _MARK_RE.search(nonlocal_line)
                    if match:
                        run.remote_pid = match.group(1)
                        nonlocal_line = _MARK_RE.sub("", nonlocal_line)
                if nonlocal_line:
                    stderr_chunks.append(nonlocal_line)
            try:
                proc.stderr.close()
            except Exception:
                pass

        stderr_thread = threading.Thread(target=read_stderr, daemon=True)
        stderr_thread.start()

        timed_out = {"value": False}

        def on_timeout():
            if proc.poll() is None:
                timed_out["value"] = True
                run.kill()

        timer = threading.Timer(timeout_s, on_timeout)
        timer.start()
        code = None
        try:
            for line in iter(proc.stdout.readline, ""):
                if line.strip():
                    emit({"type": "line", "text": line.rstrip("\n")})
            try:
                proc.stdout.close()
            except Exception:
                pass
            code = proc.wait()
        finally:
            timer.cancel()
        stderr_thread.join(timeout=2)

        with _RUNS_LOCK:
            _RUNS.pop(run_id, None)

        emit({
            "type": "done",
            "code": code,
            "stderr": "".join(stderr_chunks).strip(),
            "timedOut": timed_out["value"],
        })
        self.close_connection = True


def main() -> None:
    logging.basicConfig(
        level=logging.DEBUG if CFG.debug else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    logger.info(
        "exec-bridge listening on http://%s:%s (auth=%s)",
        CFG.host, CFG.port, "on" if CFG.auth_token else "OFF",
    )
    ThreadingHTTPServer((CFG.host, CFG.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
