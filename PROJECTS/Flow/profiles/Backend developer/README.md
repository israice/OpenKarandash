# Backend developer profile — a real Hermes profile

Unlike `profiles/QA/`, this folder is not a pi agent directory
(`PI_CODING_AGENT_DIR`) — it is a real Hermes profile directory, the
config shape Hermes itself reads for any `-p <profile>` (or a per-profile
gateway target). Hermes runs in Docker via claude-bridge, see
`DOCS/decisions/029`; why *this* worker got the Hermes shape while QA
stayed on the pi shape — `DOCS/decisions/033`.

## What is what

| File | Who reads it | Node panel |
|---|---|---|
| `config.yaml` — `model` | Hermes | **Model** |
| `config.yaml` — `toolsets` | Hermes | **Tools** |
| `config.yaml` — `approvals` | Hermes | **Permissions** |
| `config.yaml` — `delegation` | Hermes | **Agents** |
| `config.yaml` — `mcp.servers` | Hermes | **MCP** |
| `PERSONA.md` | Hermes — the one system-prompt-equivalent file (would be `SOUL.md` in a real Hermes profile; Hermes blocks agent writes to that exact filename, so the same content lives here instead — see below) | **System Prompt** and **Soul** (both point here — see below) |
| `skills/README.md` (placeholder) | — nothing yet | **Skills** |
| `memories/README.md` (placeholder), `config.yaml` — `memory` | — nothing yet / Hermes | **Memory** |
| — (no file) | — | **Thinking** — no Hermes-config equivalent of pi's `defaultThinkingLevel`; see below |

## Why System Prompt and Soul share one file

pi splits the system prompt into two files (`SYSTEM.md` replaces it,
`APPEND_SYSTEM.md` is appended); QA's card has two file icons because of
that split. Hermes has no such split — one file is the single
system-prompt-equivalent file. In a real Hermes profile that file would be
named `SOUL.md`; Hermes blocks agent writes to that exact filename
regardless of who asks, so this profile keeps the same content under the
unprotected name `PERSONA.md` instead — rename it to `SOUL.md` by hand if
the profile is ever wired to a real run. Both the **System Prompt** and
**Soul** panels of this card point their 📄 icon at `PERSONA.md`: two
panels, one real file, matching Hermes rather than forcing a QA-shaped
split that doesn't exist here.

## Why Thinking has no file icon

pi has `defaultThinkingLevel` in `settings.json`; Hermes has no direct
equivalent — reasoning depth is closer to a model/provider choice
(`config.yaml` → `model`/`agent`) than a standalone setting. Rather than
point the icon at a file that doesn't actually hold this concept, the
**Thinking** panel stays descriptive-only, the same honest reason QA's
Skills/Agents/Memory panels have no icon.

## What is missing

- Node panel fields (`flowBackendSoul`, `flowBackendPrompt`,
  `flowBackendThinking`, `flowBackendPermissions`, `flowBackendMcp`,
  `flowBackendModel`, `flowBackendTools`, `flowBackendSkills`,
  `flowBackendAgents`, `flowBackendMemory`) are not written into these
  files — the panel keeps its own text in Flow state, and the files are
  edited by hand through the same 📄 icon.
- `PERSONA.md` stands in for the real Hermes filename `SOUL.md`, which
  Hermes blocks this agent from writing (see the table above).
- `askHermes` in `server.js` does not yet route a turn through a
  per-profile Hermes gateway/config — real turns run on whatever Hermes
  target the server defaults to. Wiring a `-p`/config-path selection per
  worker is future work — the same documented gap `DOCS/decisions/028`
  left for pi and `askPi`'s `PI_CODING_AGENT_DIR`. See `DOCS/decisions/033`.
- `mcp.servers` entries in `config.yaml` name plausible real MCP packages
  by convention (`@modelcontextprotocol/server-*`) but are not all
  verified to exist on npm — unlike QA's `mcp.json`, which points at the
  real, installed `@playwright/mcp`. Treat them as a starting shape to
  correct once this profile is actually wired up.

Связано: `DOCS/decisions/028`, `DOCS/decisions/029`, `DOCS/decisions/033`.
