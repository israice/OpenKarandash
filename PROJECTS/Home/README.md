# 🏠 Home

**The main Mission Control screen: a live summary of sessions and the entry point to every other section.**

## 🧭 What this is

Home is the tab that opens first. Its toolbar button is `homeButton` (`data-view="home"`), and it is the only one that arrives from the page already pressed: `aria-pressed="true"`. The markup itself lives in `index.html` inside the `<main class="view view--home" id="defaultView">` block, and in `App.VIEWS` that element is registered under the key `home`.

The screen is built so that everything is visible at once without scrolling: `.view--home` occupies exactly `100vh` with `overflow: hidden`, and when there are many sessions only the lists inside the cards scroll.

## 📊 What is on screen

**Three statistics tiles** (`.dashboard`, pinned in the centre under the toolbar):

- **`runningCount`** — how many sessions are running right now; counted from the `.session-item--running` rows in the side list.
- **`totalCount`** — sessions in total.
- **`queuedCount`** — how many are queued; the number comes from the server together with the session list.

**Four observation cards** (`.observation`, a 2×2 grid):

| Card | What it shows |
|---|---|
| **Activity** | `obsMessages` — the total message count across all sessions, `obsToday` — sessions in the last 24 hours, `obsLastActive` — when the last activity happened ("just now", "12 min ago", "3 h ago" or a date) |
| **Providers** | `obsConnectionText`: either "Not connected · connect a provider in settings", or the connection note and the model name |
| **Active sessions** | `obsRunningList` — only the running ones; empty → "Nothing is running right now" |
| **Recent sessions** | `obsRecentList` — the six latest; empty → "No sessions yet" |

Rows in both lists are clickable: a click switches the interface to the PROJECTS tab and immediately opens the selected session.

## 🗺️ Mission Control sections

| Section | What it does | README |
|---|---|---|
| 🌊 **Flow** | A canvas of nodes and arrows — the execution flow diagram | [../Flow/README.md](../Flow/README.md) |
| 🗂️ **Kanban** | Task board in columns | [../Kanban/README.md](../Kanban/README.md) |
| 💬 **PROJECTS** | Chat with the assistant and the session list | [../PROJECTS/README.md](../PROJECTS/README.md) |
| 📚 **Book** | A card for every interface section, linking to its README | [../Book/README.md](../Book/README.md) |
| ✏️ **Karandash** | Commenting mode for interface elements | [../Karandash/README.md](../Karandash/README.md) |
| ⚙️ **Settings** | Application and provider settings | [../Settings/README.md](../Settings/README.md) |

## 🧰 The toolbar

The toolbar at the top left (`.toolbar` with `aria-label="Actions"`) holds five view buttons — Flow, Kanban, PROJECTS, Book, Home. The **Karandash** button adds itself: `PROJECTS/Karandash/karandash.js` creates a separate `.toolbar` and inserts it before the `#settings` block. On the right is the `settingsButton` gear.

- **Dragging buttons.** A long press on a button — exactly 2 seconds (`LONG_PRESS_MS = 2000`) — enables reorder mode: the toolbar gets the `toolbar--reorder` class and the button can be dragged between its neighbours. Moving the cursor more than 8 pixels before the timer fires cancels entering the mode, and a click after a drag does not switch tabs.
- **Exit with `Esc`.** At that moment the new order is saved to `localStorage` under the key `toolbarOrder` and restored on the next page load. The order is stored separately for each toolbar — its `aria-label` serves as the key.
- **The version button.** In the bottom right corner sits `appVersionButton` — a green badge such as `v0.0.6`, visible on every tab. The server substitutes `{{APP_VERSION}}` into it: that is the last line of the `DEV LOG` block in `VERSION.md`, the single source of truth about the version. A click opens the `versionModal` dialog with the full history (`{{VERSION_LIST}}`, newest first). The lines pass through `escapeHtml` in `server.js` — otherwise a `<` from a commit message would break the page.

## ⚙️ How it works

- **One page, no reloads.** All views sit side by side in `index.html`; `MissionTabs.show(name)` from `tabs.js` walks through `App.VIEWS`, leaves one element visible and sets `aria-pressed` on the toolbar buttons. Home needs nothing extra when shown — unlike Flow, which has to recompute its canvas.
- **The observation panel is rendered by the server.** Its markup is not built in the browser: `PROJECTS/Home/home-server.js` renders `home-observation.eta` (next to it) and htmx swaps that piece of the page in through `/api/fragment/home-observation`. Both files live in this folder — `server.js` only wires the route table in. The Providers card is the exception: its state exists only in the browser.
- **The summary is live.** `setInterval(loadSessions, 8000)` refreshes both the list and the observation panel every 8 seconds while the tab is open.
- **The client is split into independent `defer` files.** Home does not depend on `PROJECTS/Flow/flow.js` or `PROJECTS/Kanban/kanban.js`: one file failing does not take down the rest of the interface.

## ✅ What already works

- Counters for running, total and queued sessions.
- Cards for activity, provider state, active and recent sessions.
- Jumping from the list straight into the right chat session.
- Auto-refresh every 8 seconds.
- Reordering toolbar buttons with the order preserved.
- Version history on a click of the version badge.

## 🚧 Planned

- **Statistics tiles.** The styles already contain a `.stat-tile--placeholder` stub — a dashed frame for future metrics; it is not used in the Home markup yet.
- **Providers.** The card shows the connection state of the active provider — with no breakdown across several providers.
- **The gear menu.** Two entries in `#settingsMenu` are still literally called "Placeholder_2"; only one works so far — "Settings".
- **Side menu sections.** Clicking a `.side-nav__item` entry so far only logs `Section:` to the console.

---

This project is distributed under the **MIT** license.
