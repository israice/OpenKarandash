# exec-bridge

Generic host-side process runner, so a containerized `server.js` can still
spawn CLI agents (`opencode`, `pi`, `codex`) and OS-level helpers (the
Karandash screenshot's `powershell.exe`) that live on the real host, not
inside the container.

```
server.js (container) --POST /exec--> exec-bridge (host, :8789) --> opencode / pi / codex / powershell.exe
```

Unlike `claude-bridge/` (an OpenAI-compatible shim specific to Claude/Hermes),
this bridge knows nothing about any particular CLI. `server.js` keeps every
bit of target-selection and argument-building logic it already has (which
binary, which WSL/Windows target, `--model`, the `shellLaunch` PID-marker
wrapper for `wsl.exe`) - it hands the bridge an already fully-resolved
`cmd`/`args` pair and only swaps its local `spawn()` for this HTTP call when
it itself runs in a container (`EXEC_MODE=remote`). See
`DOCS/decisions/037-exec-bridge-для-cli-коннекторов.md` and
`DOCS/план-докеризации-коннекторов.md` for the staged rollout this belongs to.

## Run

```bash
python3 server.py          # reads ./.env
```

Not yet auto-started by the watchdog (`SYSTEM/core/hermes-stack.js`) - that
wiring is part of a later stage, once `server.js` itself has a Dockerfile.
For now, start it by hand on the host while testing the container path.

## Settings (`.env`, all optional except the token once the port is exposed)

| Variable | Default | Meaning |
|---|---|---|
| `EXEC_BRIDGE_HOST` | `127.0.0.1` | Bind address. Leaving loopback makes the token optional (same rule as `claude-bridge`). |
| `EXEC_BRIDGE_PORT` | `8789` | Bind port - next free one after `claude-bridge`'s `8787`/`8788`. |
| `EXEC_BRIDGE_TOKEN` | *(empty = auth off)* | Shared secret `server.js` sends as `Authorization: Bearer <token>`. |
| `EXEC_BRIDGE_TIMEOUT` | `3600` | Fallback timeout (seconds) when a request sends no `timeoutMs`. |
| `EXEC_BRIDGE_DEBUG` | `0` | Verbose logging. |

## Protocol

- `GET /health` - unauthenticated liveness probe.
- `POST /exec` - body `{ cmd, args, input, env, timeoutMs, shellPrefix }`.
  Response is `Content-Type: application/x-ndjson`, one JSON object per line,
  streamed as the child process runs:
  - `{"type": "started", "runId": "..."}` - first line, before any output.
  - `{"type": "line", "text": "..."}` - one per stdout line.
  - `{"type": "done", "code": N, "stderr": "...", "timedOut": bool}` - last
    line; the connection closes right after.
- `POST /exec/<runId>/kill` - kills that run. Mirrors `server.js`'s own
  `killProcessTree`: if `shellPrefix` was given (the original target was
  `wsl.exe`), it re-invokes the same shell with `kill -TERM <pid>` against the
  PID the child echoed to stderr behind the `__karandash_pid__` marker
  (`wsl.exe`'s own PID is not the CLI's PID inside the VM); on Windows it also
  runs `taskkill /T /F` for good measure. A run that already finished before
  the kill arrives is not an error - it's a normal race with Stop.

## Known limits

- One process per `/exec` call, no session reuse - same model as the CLI
  connectors it fronts (`runOpenCode`/`runCodex`/`runPi` in `server.js`
  already re-send full history per turn; there is nothing to reuse).
- No streaming stdin - the whole `input` string is written once and the pipe
  is closed, matching every connector's actual usage today.
