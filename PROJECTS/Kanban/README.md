# 🗂️ Kanban

A task board in five columns. For now it is a skeleton: the columns are there, the cards are not, but a task can already be started from here.

## 🧭 What this is

One of the Mission Control tabs — the `kanbanButton` toolbar button, the `kanbanView` view, the code in `PROJECTS/Kanban/kanban.js` (30 lines). It is meant to be a board along which a task travels from "New" to "Done".

Right now the section is honestly in its initial state: the board draws the columns and can do exactly one thing — start a new session with a task. Everything else is still ahead.

## ✅ What it can already do

- **Draws five columns** — `New`, `In Progress`, `Checking`, `Validator`, `Done`. The list comes from `App.BOARD_COLUMNS` (`app.js`), and the board is built on page load.
- **Shows a counter** on each column — for now this is a static `0` in the markup, computed from nothing.
- **The "+" button in the `New` column** — asks for the task text through `prompt()` and starts a separate Claude session with it.
- **Horizontal scrolling of the board** and vertical scrolling inside a column — the layout will hold up if there are more columns or cards.

What the board **cannot** do: there are no cards at all, no drag and drop, no state is stored anywhere and nothing goes to the server. The body of every column says "Empty for now" — that is literally text in the markup.

## 🚀 How to use it

| Action | What happens |
|---|---|
| The `Kanban` button in the toolbar | The board opens (`MissionTabs.show('kanban')`) |
| "+" in the `New` column | A browser `prompt` appears: "Task for the new session:" |
| Type text and press OK | The interface switches to the Chat tab and a new session starts in `Action` mode with that task |
| Empty input or Cancel | Nothing happens |

Only the `New` column has a "+" button — the other four do not.

The task travels the same path as a comment from Karandash mode: through `App.startCommentSession()`, which sends a request to `/api/claude/ask`. So no card is created — a **session** is created, and from there you work with it in the chat.

## 🔧 How it works

**The board's data lives right in the code.** The board has no database and no API:

- the column names — the `BOARD_COLUMNS` array in `app.js`, exported through `window.App`;
- the column contents — the string `Empty for now` in the template inside `PROJECTS/Kanban/kanban.js`;
- the `0` counter — also a literal in the template.

There is not a single board-related route in `server.js`. Reloading the page returns the board to exactly the same state — there is simply nothing to save yet.

**The markup** is minimal: `index.html` contains only an empty container

```html
<div class="view view--board" id="kanbanView" hidden>
    <div class="board" id="board"></div>
</div>
```

Everything else — the `.board__column` columns, the `.board__header` headers, the `.board__count` counters, the `.board__add` button and the `.board__body` body — is assembled in a loop by `kanban.js` and appended to `#board`. The styles are in `PROJECTS/Kanban/kanban.css`, linked from `index.html` with its own `<link>`.

**Showing the tab** is `tabs.js`'s job: it hides every view except the requested one and sets `aria-pressed` on the button. No additional initialisation is called for Kanban when it is shown — the board was built once, on load.

## 🗺️ Planned

- Task cards: creation, display, binding to a session.
- Dragging cards between columns.
- A live task counter in the column header.
- Storing the board state on the server so it survives a reload.
- Replacing the browser `prompt()` with a proper input field.

## 📁 Files

| File | What it does |
|---|---|
| `PROJECTS/Kanban/kanban.js` | Builds the columns and wires up the "+" handler |
| `PROJECTS/Kanban/kanban.css` | Board styles: `.view--board`, `.board*` |
| `SYSTEM/index.html` | The `#kanbanView` / `#board` container, the `kanbanButton` button, loading `kanban.css` and `kanban.js` |
| `SYSTEM/app.js` | `BOARD_COLUMNS`, `VIEWS.kanban`, `startCommentSession()` |
| `SYSTEM/tabs.js` | Switching to the `kanban` view |

---

License — MIT.
