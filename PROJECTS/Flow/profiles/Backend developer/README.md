# Backend developer profile — a real agent profile

Unlike `profiles/QA/`, this folder is not a pi agent directory
(`PI_CODING_AGENT_DIR`) — it is a real agent profile directory, the config
shape a worker is given when it is launched. Why *this* worker got this
shape while QA stayed on the pi shape.

## What is what

| File | Who reads it | Node panel |
|---|---|---|
| `config.yaml` — `model` | agent | **Model** |
| `config.yaml` — `toolsets` | agent | **Tools** |
| `config.yaml` — `approvals` | agent | **Permissions** |
| `config.yaml` — `delegation` | agent | **Agents** |
| `config.yaml` — `mcp.servers` | agent | **MCP** |
| `PERSONA.md` | agent — the one system-prompt file (see below) | **System Prompt** and **Soul** (both point here — see below) |
| `skills/README.md` (placeholder) | — nothing yet | **Skills** |
| `memories/README.md` (placeholder), `config.yaml` — `memory` | — nothing yet / agent | **Memory** |
| — (no file) | — | **Thinking** — no config equivalent of pi's `defaultThinkingLevel`; see below |

## Why System Prompt and Soul share one file

pi splits the system prompt into two files (`SYSTEM.md` replaces it,
`APPEND_SYSTEM.md` is appended); QA's card has two file icons because of
that split. This profile format has no such split — one file is the single
system prompt. Both the **System Prompt** and **Soul** panels of this card
point their 📄 icon at `PERSONA.md`: two panels, one real file, rather than
forcing a QA-shaped split that doesn't exist here.

## Why Thinking has no file icon

pi has `defaultThinkingLevel` in `settings.json`; this format has no direct
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
- `server.js` does not route a turn through a per-profile config — real
  turns run on whatever agent the server defaults to. Wiring a config-path
  selection per worker is future work — the same documented gap
  `DOCS/decisions/028` left for pi.
- `mcp.servers` entries in `config.yaml` name plausible real MCP packages
  by convention (`@modelcontextprotocol/server-*`) but are not all
  verified to exist on npm — unlike QA's `mcp.json`, which points at the
  real, installed `@playwright/mcp`. Treat them as a starting shape to
  correct once this profile is actually wired up.

Связано: `DOCS/decisions/028`.