# ⚙️ Settings

**One gear, and behind it a live Claude CLI: found, connected, model picked — and the conversation continues even after a page reload.**

## 🧭 What this is

Settings is not a separate tab but the `settingsButton` gear in the right corner of the header (`.topbar > .settings`) and the `#settingsModal` dialog it opens. All of it lives in `PROJECTS/Settings/`: `settings.js` creates the markup itself (the gear, the menu, both dialogs) and drives the provider logic, while the styles are in `settings.css`. The shared state (`PROVIDERS`, `connections`, persistence to localStorage) lives in `SYSTEM/providers.js` and reaches this file through `window.App`, which `app.js` fills from there.

The section has exactly one, very concrete job: **connect the interface to the real Claude Code CLI on your machine**. The server looks for the CLI in Windows and in WSL, shows the environments it found, remembers the chosen one — and after that the Chat tab starts sending messages to a real model rather than into the void.

There are two levels of settings in the project, and it matters not to confuse them:

- **Interface** — everything you click in the browser: the connection, the model, the effort, the button order, the panel widths. It lives in the `localStorage` of the browser you work in. The server knows nothing about it.
- **Server** — the port, the path to the CLI, the path to the vault. It lives in the `.env` file at the project root. It is edited by hand only and is not reachable from the interface.

## 🎛 What can be configured

- **The provider.** The dialog has four cards, split into **Paid** (**Claude** — Anthropic, **Codex** — OpenAI) and **Free** (**OpenCode** — local and third-party models, **pi** — many providers through one CLI). Each has a "Connect" / "Disconnect" button.
- **The model.** A connected provider gets a selection row: the list of models, with the default one marked `(default)`. For Claude these are `claude-opus-5`, `claude-sonnet-5` (default), `claude-fable-5`, `claude-haiku-4-5`. OpenCode and pi have no hard-coded list at all: the server asks the CLI itself on connect (`opencode models`, `pi --list-models`), so what you see is whatever that CLI is logged into — and if it is logged into nothing, the row is not shown.
- **The effort.** Claude and pi — `low`, `medium` (default), `high`, `xhigh`, `max`. It goes to the CLI as `--effort` (Claude) or `--thinking` (pi); for the other providers the select is simply not shown.
- **Subscription limits.** For a connected Claude, the usage of the **5-hour** and **7-day** windows is shown right above the model selection — the percentage and the reset time. The data arrives with every CLI answer, so before the first request it honestly says "Data will appear after the first request".
- **The toolbar button order.** A long press (2 seconds) on any `.toolbar` button enables "wobble" mode — the buttons can be dragged with the mouse, `Esc` exits, and the order is saved. The gear does not take part in this: it sits outside `.toolbar`.
- **The session panel width** — also an appearance setting, and it also survives a reload (see the storage table).

The model and the effort are duplicated in the header of the active session on the Chat tab — those are the very same values, they are written to the same storage, and the next message in the current session will go out with the new parameters.

## 🔌 Connecting the Claude CLI

Pressing "Connect" on Claude starts a real reconnaissance rather than flipping a switch:

1. The page calls `POST /api/claude/detect`, and the button shows "Looking for Claude..." in the meantime.
2. The server runs `claude --version` in all suitable environments in parallel (a 15-second timeout each) and returns the ones that answered, together with their version.
3. Then it depends on how many were found: **one** environment — connect immediately; **several** — the `#pickerModal` dialog "Where to run the Claude CLI?" opens with a list; **none** — the same dialog with a hint that the CLI was not found and that a path can be given through `CLAUDE_BIN`.
4. The choice goes to `POST /api/claude/connect`, the server remembers the environment in memory and answers with a label and a version — which appear in the provider row as `Windows · CLI 2.1.245`.

Where exactly the server looks for the CLI depends on where it is running itself:

| Server runs in | Windows installation | WSL installation |
| --- | --- | --- |
| Windows | `claude` | `wsl.exe bash -lc "claude ..."` |
| WSL | `claude.exe` | `claude` |

If the `CLAUDE_BIN` variable is set, no search happens at all: exactly one environment remains, labelled `CLAUDE_BIN` with your path. WSL is invoked specifically through a login shell (`bash -lc`) — without it `~/.local/bin` is not in `PATH` and the CLI "disappears".

**The connection does not fall off.** The environment, the model, the effort and the CLI session id are saved in the browser. When the page opens, the state is restored, and if the server has restarted in the meantime the page quietly hands it the chosen environment again with a repeat `connect`. The "Disconnect" button removes the record and resets the active session.

## 📨 The Telegram bridge

The last card in the dialog. Its button behaves like the one of every other provider:
while the bridge is down it is a blue "Connect" that reveals two fields under it — the
bot API key (shown as dots — it is a password field) and the ids of the people the bot
may talk to, comma separated. Once the key works, the card shows "Connected @bot", the
fields stay open (the same way a connected provider keeps its model row) and the button
turns into "Disconnect": it wipes the key from `.env` and stops the polling, keeping the
ids. Both fields save themselves shortly after the last keystroke and land in `.env` as
`TELEGRAM_BOT_TOKEN` and `TELEGRAM_USER_IDS`; the key itself never travels back to the
browser — the field holds a mask, and sending the mask back unchanged means "do not
touch the saved key".

What the bridge does, once connected (`PROJECTS/Settings/telegram-server.js`):

- **Every finished run sends its last answer** to each listed user, headed by the
  session subject. That is the "the task is done" signal — the answer arrives even
  with every browser tab closed.
- **A reply to that message continues the same session.** The bridge remembers which
  of its messages belongs to which session; a message without a reply goes to the
  last session it wrote about. The model, the effort and the mode are taken from the
  session's previous turn, the CLI — from the session's own `target`.
- **Nobody else is heard.** Messages from ids outside `TELEGRAM_USER_IDS` are dropped
  without an answer: the bot is visible to all of Telegram, and this bridge starts a
  real agent in the project folder.
- **One run per session.** A second message into a session that is still working gets
  "⏳ still working" instead of a second parallel run.

Telegram is polled (`getUpdates`), not pushed to a webhook: a webhook needs a public
https address, and the server lives on localhost. Details — `DOCS/decisions/024`.

## 🖥 Server settings (`.env`)

`.env` is created automatically on the first run (`PORT=3001`) and is not tracked by git — it is the single place for the port and any secrets. Values from the file **do not overwrite** environment variables that are already set, which is why `PORT=3999 node server.js` keeps working.

| Variable | Default | Why |
| --- | --- | --- |
| `PORT` | `3001` | The server port. It is taken strictly from here, with no fallback to neighbouring ports: a second copy on the same folder would fight over `DATA/.sessions.db`/`DATA/.index.db` and overwrite `DATA/vault/`. If the port is busy, the server honestly exits. |
| `TELEGRAM_BOT_TOKEN` | not set | The Telegram bot key. Filled from Settings; with it empty the bridge simply does not start. |
| `TELEGRAM_USER_IDS` | not set | The ids the bot writes to and accepts messages from, comma separated. Also filled from Settings. |
| `CLAUDE_BIN` | not set | The path to the Claude CLI executable if it is not in `PATH`. If set, the Windows/WSL search is disabled. |
| `OBSIDIAN_VAULT` | the `vault/` folder in the project | An external Obsidian vault instead of the built-in one: this is where the server writes the project map that feeds search and the file editor. |
| `NO_RELOAD` | not set | `NO_RELOAD=1` disables the server's self-restart on edits to `server.js`. It is not part of the `.env` template but is read from there like the rest. |
| `SERVER_CHILD` | — | Internal: the server sets it on the child process itself. Do not touch by hand. |

The format is simple: `KEY=value`, lines starting with `#` and empty lines are skipped, and quotes around the value are optional.

## 🗄 Where things are stored

| What | Where | Key / file |
| --- | --- | --- |
| CLI environment, model, effort, session id | browser `localStorage` | `noname.claude` |
| The button order in the toolbars | `localStorage` | `toolbarOrder` |
| The session panel width | `localStorage` | `sessionsPanelWidth` |
| The camera, nodes, edges and agent in Flow | `localStorage` | `flowCanvasViews`, `flowNodePositions2`, `flowNodeGraph3`, `flowNodeSecretaryAgent` |
| The port, the CLI path, the vault path | a file on disk | `.env` at the project root |
| The chosen CLI environment | the server's memory | lost on restart, restored by the page |

Writes to `localStorage` are wrapped in `try/catch`: in private mode, or when storage is blocked, the interface keeps working — just without remembering anything.

## ✅ What works / what is planned

Genuinely working:

- finding, choosing and connecting the Claude CLI in Windows and WSL;
- choosing the model and the effort, with persistence and restoration;
- showing the CLI version, the environment and the subscription limits;
- dragging toolbar buttons and the other persisted appearance settings.
- The Telegram bridge: a finished run reports its answer, and a reply to it continues that session.

Still stubs — honestly, with no embellishment:

- **The dropdown menu entries.** `settings.js` creates the `#settingsMenu` menu with two "Placeholder_2" entries, a separator and a "Settings" entry. The styles and the closing handlers (click outside, `Esc`) are in place, but there is nothing to open it with: the `open()` function in `settings.js` is never called, and a click on the gear opens the settings dialog directly. The menu is groundwork for the future.
- **The Codex provider's chat.** Its "Connect" button is real now — same detect (Windows/WSL) → pick → connect flow as Claude — but sending a message to it returns a stub error ("Codex chat is not implemented yet"): the actual CLI invocation isn't wired up.
- **The "Provider" select** inside a connected provider's row, and the identical select in the session header, route real requests to Claude/OpenCode/pi/Codex's `/api/agent/*` — Codex just has nothing to answer with yet (see above).

## 📁 Files

| File | What it contains on this topic |
| --- | --- |
| `SYSTEM/index.html` | The `#settingsButton` button, the `#settingsMenu` menu, the `#settingsModal` and `#pickerModal` dialogs, the `.settings__*`, `.provider__*`, `.picker__*` styles |
| `PROJECTS/Settings/settings.js` | The markup for the gear and both dialogs, the provider logic, closing the menu on an outside click and on `Esc` |
| `PROJECTS/Settings/settings.css` | Styles for the button, the menu and the settings dialog |
| `PROJECTS/Settings/telegram-server.js` | The Telegram bridge: the `/api/telegram/*` routes, the `.env` keys, sending a finished run's answer and taking the reply back into the same session |
| `SYSTEM/providers.js` | The `PROVIDERS` list, `connections`, choosing the model and effort, the limits and the context gauge, persistence to `localStorage` (moved out of `app.js` by `DOCS/decisions/022`) |
| `SYSTEM/app.js` | Rendering the dialogs' shared parts and restoring the CLI connection on load; re-exports the providers into `window.App` |
| `server.js` | Loading `.env`, `TARGETS` for the CLI search, `detectInstalls()`, the `/api/claude/detect` and `/api/claude/connect` routes |
| `SYSTEM/toolbar-reorder.js` | Dragging toolbar buttons on a long press and saving the order |
| `SYSTEM/sidebar-resize.js` | The session panel width |
| `.env` | The port and secrets. Created by the server, not tracked by git |

---

Part of the Mission Control project. License — MIT.
