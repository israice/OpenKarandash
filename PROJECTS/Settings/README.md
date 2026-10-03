# ⚙️ Settings

**One gear, and behind it a live CLI: found, connected, model picked — and the conversation continues even after a page reload.**

## 🧭 What this is

Settings is not a separate tab but the `settingsButton` gear in the right corner of the header (`.topbar > .settings`) and the `#settingsModal` dialog it opens. All of it lives in `PROJECTS/Settings/`: `settings.js` creates the markup itself (the gear, the menu, both dialogs) and drives the provider logic, while the styles are in `settings.css`. The shared state (`PROVIDERS`, `connections`, persistence to localStorage) lives in `SYSTEM/providers.js` and reaches this file through `window.App`, which `app.js` fills from there.

The section has exactly one, very concrete job: **connect the interface to the real CLI on your machine**. The server looks for the CLI on this machine, remembers the one it found — and after that the Sessions tab starts sending messages to a real model rather than into the void.

The agent of the project is **OpenCode**, and the card list holds exactly one card: Claude, Codex and pi were removed from the project by the owner's decision (`DOCS/decisions/074`, `075`). The four dropdowns in the session header stayed in place — with a single CLI the first of them shows one option, and the place is still needed if another CLI ever comes back.

There are two levels of settings in the project, and it matters not to confuse them:

- **Interface** — everything you click in the browser: the connection, the model, the button order, the panel widths. It lives in the `localStorage` of the browser you work in. The server knows nothing about it.
- **Server** — the port, the path to the CLI, the path to the vault. It lives in the `.env` file at the project root. It is edited by hand only and is not reachable from the interface.

## 🎛 What can be configured

- **The provider.** The dialog has one card: **OpenCode** — local and third-party models, with a "Connect" / "Disconnect" button.
- **The model.** It is picked in four dropdowns in one row — **CLI / Gateway / Provider / Model**. That is one cascade over the model name the CLI reports, not four independent choices: `openrouter/stealth/space-bunny-alpha` is gateway `openrouter` (where the request goes), provider `stealth` (who is behind it) and model `space-bunny-alpha`. A short name with no middle level (`opencode/claude-sonnet-5`) leaves the provider with a single dash and it goes inactive. The row sits twice: as a showcase at the top of the Providers tab (visible whether or not anything is connected) and under the card of a connected provider. OpenCode has no hard-coded list at all: the server asks the CLI itself on connect (`opencode models --refresh`), so what you see is whatever that CLI is logged into — before the first connect the cascade is built from the single default model of the project.
- **The toolbar button order.** A long press (2 seconds) on any `.toolbar` button enables "wobble" mode — the buttons can be dragged with the mouse, `Esc` exits, and the order is saved. The gear does not take part in this: it sits outside `.toolbar`.
- **The session panel width** — also an appearance setting, and it also survives a reload (see the storage table).

The same four dropdowns stand in the header of the active session on the Sessions tab. It is not a copy: all three rows come from one factory (`SYSTEM/model-cascade.js`), write the choice through one function and read it back from the same storage — so a change in any of them is visible in the other two at once, survives a page reload, and the next message in the current session goes out with the new one.

## 🔌 Connecting a CLI

Pressing "Connect" starts a real reconnaissance rather than flipping a switch:

1. The page calls `POST /api/agent/detect` with the provider's name in the body, and the button shows "Looking for …" in the meantime.
2. The server runs `<cli> --version` in all suitable environments in parallel (a 15-second timeout each) and returns the ones that answered, together with their version.
3. Then it depends on how many were found: **one** environment — connect immediately; **several** — the `#pickerModal` dialog "Where should the CLI run?" opens with a list; **none** — the same dialog with a hint that the CLI was not found and that a path can be given through the matching environment variable.
4. The choice goes to `POST /api/agent/connect`; the server remembers the environment in memory and answers with a label, a version and the list of models the CLI itself reported.

Where the server looks for the CLI (on the example of OpenCode): `opencode.exe` in `PATH`, and if it is not there — in `~/.opencode/bin/opencode.exe`. The path can also be given explicitly: `OPENCODE_BIN` in `.env`. If it is set, the search stops there and that one path is used, labelled with the name of the variable.

**The connection does not fall off.** The environment, the model and the CLI session id are saved in the browser. When the page opens, the state is restored, and if the server has restarted in the meantime the page quietly hands it the chosen environment again with a repeat `connect`. The "Disconnect" button removes the record and resets the active session.

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
  last session it wrote about. The model and the mode are taken from the
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
| `OPENCODE_BIN` | not set | The path to the OpenCode executable if it is not in `PATH`. If set, its search in `PATH` is disabled. |
| `OBSIDIAN_VAULT` | the `vault/` folder in the project | An external Obsidian vault instead of the built-in one: this is where the server writes the project map that feeds search and the file editor. |
| `NO_RELOAD` | not set | `NO_RELOAD=1` disables the server's self-restart on edits to `server.js`. It is not part of the `.env` template but is read from there like the rest. |
| `SERVER_CHILD` | — | Internal: the server sets it on the child process itself. Do not touch by hand. |

The format is simple: `KEY=value`, lines starting with `#` and empty lines are skipped, and quotes around the value are optional.

## 🗄 Where things are stored

| What | Where | Key / file |
| --- | --- | --- |
| CLI environment, model, session id | browser `localStorage` | `noname.opencode` |
| The model picked in the four dropdowns, before any connect | `localStorage` | `noname.model.opencode` |
| The button order in the toolbars | `localStorage` | `toolbarOrder` |
| The session panel width | `localStorage` | `sessionsPanelWidth` |
| The camera, nodes, edges and agent in Flow | `localStorage` | `flowCanvasViews`, `flowNodePositions2`, `flowNodeGraph3`, `flowNodeSecretaryAgent` |
| The port, the CLI path, the vault path | a file on disk | `.env` at the project root |
| The chosen CLI environment | the server's memory | lost on restart, restored by the page |

Writes to `localStorage` are wrapped in `try/catch`: in private mode, or when storage is blocked, the interface keeps working — just without remembering anything.

## ✅ What works / what is planned

Genuinely working:

- finding and connecting the CLI on this machine;
- choosing the model, with persistence and restoration;
- showing the CLI version and the environment it runs in;
- dragging toolbar buttons and the other persisted appearance settings.
- The Telegram bridge: a finished run reports its answer, and a reply to it continues that session.

Still stubs — honestly, with no embellishment:

- **The dropdown menu entries.** `settings.js` creates the `#settingsMenu` menu with two "Placeholder_2" entries, a separator and a "Settings" entry. The styles and the closing handlers (click outside, `Esc`) are in place, but there is nothing to open it with: the `open()` function in `settings.js` is never called, and a click on the gear opens the settings dialog directly. The menu is groundwork for the future.
- **The "Provider" level** in the session header.** It narrows the model list under the chosen gateway, and with one CLI it has nothing to choose: the choice is between the supplier and nothing.
- **The `effort` select.** It is gone together with the last CLI that took one (`DOCS/decisions/075`).

## 📁 Files

| File | What it contains on this topic |
| --- | --- |
| `SYSTEM/index.html` | The `#settingsButton` button, the `#settingsMenu` menu, the `#settingsModal` and `#pickerModal` dialogs, the `.settings__*`, `.provider__*`, `.picker__*` styles |
| `PROJECTS/Settings/settings.js` | The markup for the gear and both dialogs, the provider logic, closing the menu on an outside click and on `Esc` |
| `PROJECTS/Settings/settings.css` | Styles for the button, the menu and the settings dialog |
| `PROJECTS/Settings/telegram-server.js` | The Telegram bridge: the `/api/telegram/*` routes, the `.env` keys, sending a finished run's answer and taking the reply back into the same session |
| `SYSTEM/providers.js` | The `PROVIDERS` list, `connections`, the context gauge, persistence to `localStorage` (moved out of `app.js` by `DOCS/decisions/022`) |
| `SYSTEM/model-cascade.js` | The four-dropdown model cascade as one factory, the saved choice behind it (`applyModelChoice`, `modelOf`, `onModelChoice`) and the row in the session header. Styles — `SYSTEM/styles/model-cascade.css` |
| `SYSTEM/app.js` | Rendering the dialogs' shared parts and restoring the CLI connection on load; re-exports the providers into `window.App` |
| `server.js` | Loading `.env`, the `*_TARGETS` of every connector for the CLI search, the `AGENTS` table, the `/api/agent/detect`, `/api/agent/connect` and `/api/agent/disconnect` routes |
| `SYSTEM/toolbar-reorder.js` | Dragging toolbar buttons on a long press and saving the order |
| `SYSTEM/sidebar-resize.js` | The session panel width |
| `.env` | The port and secrets. Created by the server, not tracked by git |

---

Part of the Mission Control project. License — MIT.
