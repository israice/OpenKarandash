# claude-bridge

OpenAI-compatible HTTP shim that lets Hermes talk to Claude through the local
`claude` CLI — **no Anthropic API key, no OAuth provider in Hermes**.

```
browser ──► Hermes dashboard ──► Hermes core
                                    │  POST /v1/chat/completions
                                    ▼
                          claude-bridge  (host, :8787)
                                    │
                    ┌───────────────┴───────────────┐
              `claude` (WSL)                 `claude.exe` (Windows)
```

The bridge runs **on the host**, not in Docker, because the CLI it drives is
installed there.

How the container reaches it depends on the Docker flavour, and the stock
compose file's `network_mode: host` is misleading under Docker Desktop: there
"host" means the network of Docker's own Linux VM, not the WSL/Windows machine,
so neither `127.0.0.1` nor a published port works. The repo-root
`docker-compose.hermes.yml` therefore puts the services on a bridge network and
points Hermes at `host.docker.internal:8788` via `CLAUDE_BRIDGE_URL` (this
project's bridge port is 8788, not the stock 8787 — see `DOCS/decisions/029`).

## Why not the bundled `anthropic` provider

That profile points at `api.anthropic.com` and needs an API key or OAuth token.
This path uses neither: Claude is reached only through the already-installed
CLI on the host.

## Run

```bash
python3 server.py          # reads ./.env
```

Normally you do not start it by hand: the OpenKarandash watchdog (`node server.js`,
see `SYSTEM/core/hermes-stack.js`) starts the bridge and Hermes itself and stops
them on Ctrl+C. `./hermes-start.sh` at the repo root starts just the bridge and
Hermes manually (WSL).

## Settings (`.env`, all optional except the token)

| Variable | Default | Meaning |
|---|---|---|
| `CLAUDE_BRIDGE_TOKEN` | *(empty = auth off)* | Shared secret Hermes sends as `Authorization: Bearer`. Required by Hermes' provider resolution. |
| `CLAUDE_BRIDGE_BACKEND` | `cli` | `cli` — one `claude -p` per request; `acp` — long-lived `claude-agent-acp` with session reuse. See "Backends". |
| `CLAUDE_BRIDGE_ACP_BINARY` | *(bundled)* | Path to `claude-agent-acp`; defaults to the npm install under `node_modules/.bin`. |
| `CLAUDE_BRIDGE_ACP_CONFIG_DIR` | `./claude-config` | `CLAUDE_CONFIG_DIR` for the ACP agent — isolates it from the host user's skills and MCP servers. |
| `CLAUDE_BRIDGE_TARGET` | `wsl` | `wsl` → the Linux `claude` (from a Windows host via `wsl.exe -e bash -lc`); `windows` → `claude.exe`. OpenKarandash sets it to whatever Claude installation is connected in Settings. |
| `CLAUDE_BRIDGE_BINARY` | *(auto)* | Absolute path to the CLI, overriding target-based discovery. |
| `CLAUDE_BRIDGE_HOST` | `127.0.0.1` | Bind address. Leaving loopback makes the token mandatory. |
| `CLAUDE_BRIDGE_PORT` | `8787` | Bind port. |
| `CLAUDE_BRIDGE_CWD` | repo root | Working directory the CLI sees as the project. |
| `CLAUDE_BRIDGE_MODEL` | `sonnet` | Model used when the request names none. |
| `CLAUDE_BRIDGE_TIMEOUT` | `600` | Per-turn timeout, seconds. |
| `CLAUDE_BRIDGE_DEBUG` | `0` | Log the spawned argv. |

## Endpoints

- `GET /health` — unauthenticated liveness probe
- `GET /v1/models` — `claude-bridge-sonnet` / `-opus` / `-haiku`; any other id is
  passed to `claude --model` verbatim
- `POST /v1/chat/completions` — non-streaming and SSE streaming

## Backends

Both are implemented and pass the same test suite (streaming, tool calls,
images, multi-turn, concurrency).

**`cli` (default)** — `claude -p` per request. Stateless, no Node dependency.

**`acp`** — one `claude-agent-acp` subprocess, sessions reused across requests.
The OpenAI wire is stateless, so sessions are keyed by the history that produced
them: a request extending a known session continues it and sends only the new
message.

Measured on the same 4-turn conversation (single run, so treat as indicative):

| | turn 1 | turns 2-4 | cache write total | cache read total | weighted input equivalent* |
|---|---|---|---|---|---|
| `cli` | 4.2 s | 3.5–3.9 s | 2 925 | 34 763 | **7 133** |
| `acp` | 10.7 s | 1.7–2.0 s | 5 634 | 53 558 | 12 398 |

\* cache write ×1.25, cache read ×0.1 relative to input tokens.

**ACP is roughly twice as fast per follow-up turn, but costs more, not less.**
The expectation going in was the opposite — that a fresh CLI process per request
would re-pay for the prompt cache each time. It does not: Anthropic caches by
prefix server-side, so the CLI backend writes the cache once and reads it on
every later turn even across processes.

**ACP is experimental and not recommended.** Two problems beyond cost:

1. It cannot be reduced to a bare model. `tools: []`, `disallowedTools` and
   `settingSources: []` passed through `session/new`'s
   `_meta.claudeCode.options` do not take effect, so the agent keeps its own
   toolbox — and the model then trusts those schemas over the bridge's text
   protocol, telling Hermes its tools do not exist.
2. It inherits the operator's MCP servers. A session opened for a Hermes chat
   listed Gmail and Google Drive tools; the CLI backend, with
   `--strict-mcp-config`, does not.

Use `cli` unless you are experimenting.

## How the CLI is driven

`claude -p` with:

- `--system-prompt-file` — **replaces** Claude Code's own agent preamble instead
  of appending to it. A file, not `--system-prompt <text>`: the prompt plus tool
  schemas exceeds the ~32k Windows command-line limit (`WinError 206`). It is
  written to `DATA/bridge-tmp/` on the shared drive and its path translated for
  the target side of WSL interop. Hermes ships its own system prompt and toolbox, so the CLI's
  identity is dead weight billed on every turn (~30k → ~9k prompt tokens).
- `--disallowed-tools …` — **the list must be exhaustive** (see `BUILTIN_TOOLS`
  in `config.py`). Naming a tool there drops its SCHEMA from the prompt, not
  just its execution rights. An incomplete list cost ~9k tokens per request and
  broke tool calling outright: the model trusted the schemas it could still see
  over the bridge's text protocol, announced "my real tools are ListAgents,
  Workflow, ..." and refused Hermes' tools as imaginary. Complete, the model
  reports NONE and overhead drops to ~490 tokens.
- `--setting-sources "" --strict-mcp-config --no-session-persistence` — the host
  user's settings, skills and MCP servers stay out, so the bridge answers the
  same way regardless of local machine state.

## Tool calling

Hermes sends OpenAI `tools` and expects `tool_calls` back. Claude Code headless
cannot accept a caller's tool schemas, so `tool_protocol.py` puts them in the
system prompt and asks for a single JSON object, which is parsed back into
proper `tool_calls` (`finish_reason: "tool_calls"`). The same technique Hermes
itself uses for ACP agents in `agent/acp_openai_bridge.py`.

Earlier assistant turns that carried `tool_calls` are replayed into the
transcript in that same JSON shape, not as a readable `Tool call: name(args)`
line: the model treats its own previous turns as examples, and after two rounds
rendered as prose it answered the third with `Tool call: terminal({...})` text,
which the parser rejected — the turn ended with tool requests delivered to the
user as the answer. That drifted form is now parsed too (only when the whole
reply is made of such calls), as a safety net.

The protocol is repeated at the END of the turn as well. Stated only in the
system prompt it loses to the CLI's own agent framing, and the model answers
"I don't have a weather tool" instead of requesting one.

Whatever stands last in the transcript, the model copies in front of its own
reply — first the `Assistant:` cue, then (seen live, and the reason a whole
session ended after twelve read-only turns) the protocol reminder itself. Both
are stripped before parsing, in either order, and a request object trailed by
nothing but that echo is still a request. Prose around the object is not: that
stays a conversation. A reply that mentions `tool_calls` and still fails to
parse is logged as a warning — otherwise such a turn just ends silently.

Prose and a request now travel together. The rule used to be "text OR object",
so a reply like "continuing, I'll generalise the code now" followed by the
object was delivered as speech: the turn ended on an announcement and the work
never happened (session `hermes-docker-mtqx7psv`, twice in a row). An OpenAI
assistant message carries `content` and `tool_calls` at once, so `split_reply`
keeps the sentence as the message content and executes the object. The object
counts only when it starts its own line and ends the reply — one inside a
sentence stays an example. The protocol text now says this outright, and warns
that announcing a plan without the object ends the turn.

Broken JSON is repaired rather than refused. The model drops a closing bracket
mid-object as readily as at the end — live: `…"context": 8}]}`, with the call
object never closed, which sent the whole request to the user as text. The
parser walks the string with a bracket stack (string literals skipped), closes
whatever a stray closer left open, and appends the rest at the end. Only
structure changes; the data is untouched, so the repaired text is safe to parse.

The shape drifts too, so the parser accepts the forms that are unambiguously a
request: a bare list of calls with no `tool_calls` wrapper (this ended session
`hermes-docker-mtqy9nps` mid-work), arguments laid out beside `name` instead of
inside `arguments`, and either of those truncated by a dropped bracket. Prose
around any of them still makes it a conversation, and `known` drops names that
are not offered tools.

A name that is not an offered tool is answered, not swallowed. Dropping it
silently left the call list empty, so the whole object went to the user as prose
and the turn ended having done nothing — and the model, told nothing, asked for
the same tool again (`process_manage` three turns running, 07:13-07:14). Two
steps now: a miss that is only cosmetic — different separator or case
(`search-files`, `Read_File`), or a one-character typo — is matched to the real
tool and executed; a genuinely absent name returns `No such tool: … Available
tools: …` as the assistant message, which the model reads on its next turn. Any
prose it wrote in front of the call is kept above that line.

While tools are offered, streaming deltas are **buffered**: whether a reply is a
tool call is only known once it ends, and a half-streamed JSON object must never
reach Hermes as assistant text.

## Reasoning

Claude emits its thinking as its own block type, not as answer text, so the
bridge collects `thinking_delta` alongside the text and returns it as
`reasoning_content` — on the message for a plain completion, as its own chunk
when streaming. Without it a Hermes session shows bare tool steps with nothing
between them, and every `reasoning` column in Hermes' own store stays empty.

## Images

Messages go in as stream-json, so OpenAI `image_url` parts (data: URLs and http
URLs) become native Anthropic image blocks. Every `user` line in that stream
starts its own turn, so the whole conversation is packed into ONE user message —
a role-labelled transcript plus the image blocks.

## Known limits

- Tool calling rides a text convention, not a native schema channel.
- A model that ignores the format degrades to a plain text answer rather than
  erroring. Hallucinated tool names are dropped before they reach Hermes.
- Each request is a fresh CLI process, so there is no server-side session reuse
  between turns; the full history is re-sent every time.
- The ACP backend is not implemented — see the repo README.
