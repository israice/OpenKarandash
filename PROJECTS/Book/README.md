# 📚 Book

**A library of every interface section: one card per toolbar tab, opening its README in the panel on the right.**

## 🧭 What this is

Book is a toolbar tab (`bookButton`, `data-view="book"`). Everything the tab consists of lives in this folder: the script `book-tab.js` (markup included) and the styles `book.css`. `SYSTEM/index.html` only holds the toolbar button and the `<link>` to `book.css`; the `#bookView` element is built by the script itself and registered in `App.VIEWS` under the key `book`.

This card list used to be the "Projects" tab of the Sessions side panel (switched with the ←/→ arrows next to Tasks). Now it is a separate top-menu page, like Graph, Flow, Kanban and the rest.

## 🗂️ What is on screen

On the left — a side panel (`#bookNav`, `#bookList`) with one card per toolbar button: Graph, Flow, Kanban, PROJECTS, Home, Book, Karandash, Settings, plus the sections added with the "+" button (`SYSTEM/new-button.js`). The list is rebuilt every time the tab is opened, so a new folder from the "+" button is picked up immediately.

On the right — the README of the selected card in an editable panel (`#bookFileEditor`), saved automatically after a pause in typing. Clicking the selected card again closes the panel. With nothing selected the panel shows the hint `#bookEmpty`.

## ⚙️ How it works

- **The whole tab is `PROJECTS/Book/book-tab.js`.** It inserts its own markup before `#chatView`, builds the cards from three constant tables (`SOURCE_IDS`, `DESCRIPTIONS`, `README`) and drives the panel on the right.
- **Styles are in `PROJECTS/Book/book.css`;** the cards themselves reuse the `.project-card*` classes from `SYSTEM/styles/sessions.css`.
- **What is borrowed from elsewhere** is called through windows, inside functions — never at file top level: `MissionGraph.createFileEditor` / `MissionGraph.nodeByPath` (the file editor of the Graph tab, `PROJECTS/Graph/graph.js`), `MdEditors.attach` (EasyMDE, `PROJECTS/Graph/md-editors.js`) and `SidebarResize.init` (the panel width handle, `SYSTEM/sidebar-resize.js`).
- **Opening the tab** — `SYSTEM/tabs.js` calls `MissionBookTab.show()` when `bookButton` is clicked.
- **Load order** — `book-tab.js` is connected before `SYSTEM/app.js`, because `app.js` looks up `#bookView` for `App.VIEWS` at startup.

## 🔌 What is published

`window.MissionBookTab` — `show()` (rebuild the cards and open the project README), `openFile(path)`, `closePanel()`.

---

This project is distributed under the **MIT** license.
