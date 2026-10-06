# 📚 Book

**A library of every interface section: one card per toolbar tab, opening its README in the panel on the right.**

## 🧭 What this is

Book is a toolbar tab (`bookButton`, `data-view="book"`). Everything the tab consists of lives in this folder: the markup `book-view.eta`, the script `book-tab.js` and the styles `book.css`. `SYSTEM/index.html` only holds the container `<div id="bookView">{{BOOK_VIEW}}</div>` and the `<link>` to `book.css`: the server renders `book-view.eta` into the page on the spot of that placeholder and also serves it as `/api/fragment/book-view`. The tab is registered in `App.VIEWS` under the key `book`.

This card list used to be the "Projects" tab of the Sessions side panel (switched with the ←/→ arrows next to Tasks). Now it is a separate top-menu page, like Flow, Kanban and the rest.

## 🗂️ What is on screen

On the left — a side panel (`#bookNav`, `#bookList`) with one card per toolbar button: Flow, Kanban, PROJECTS, Book, Karandash, Settings, plus the sections added with the "+" button (`SYSTEM/new-button.js`). The list is rebuilt every time the tab is opened, so a new folder from the "+" button is picked up immediately.

On the right — the README of the selected card in an editable panel (`#bookFileEditor`), saved automatically after a pause in typing. Clicking the selected card again closes the panel. With nothing selected the panel shows the hint `#bookEmpty`.

## ⚙️ How it works

- **The markup is `PROJECTS/Book/book-view.eta`; the server renders it** (book-server.js: `renderView()` for the page, `/api/fragment/book-view` for the route). **The logic is `PROJECTS/Book/book-tab.js`** — it builds the cards from three constant tables (`SOURCE_IDS`, `DESCRIPTIONS`, `README`) and drives the panel on the right; it no longer draws the markup and no longer inserts anything into the page.
- **Styles are in `PROJECTS/Book/book.css`;** the cards themselves reuse the `.project-card*` classes from `SYSTEM/styles/sessions.css`.
- **What is borrowed from elsewhere** is called through windows, inside functions — never at file top level: `MissionFiles.createFileEditor` / `MissionFiles.nodeByPath` (the shared file editor, `PROJECTS/Graph/file-editor.js`), `MdEditors.attach` (EasyMDE, `PROJECTS/Graph/md-editors.js`) and `SidebarResize.init` (the panel width handle, `SYSTEM/sidebar-resize.js`).
- **Opening the tab** — `SYSTEM/tabs.js` calls `MissionBookTab.show()` when `bookButton` is clicked.
- **Load order is no longer a constraint for the tab element.** `book-tab.js` used to have to be connected before `SYSTEM/app.js`, because it built `#bookView` itself and `app.js` looked that id up at startup. Now the element comes with the page markup, before any script runs. `app.js` and `PROJECTS/Chat/chat.js` are `<script type="module">`: module scripts without `async` are deferred and run in document order together with `defer` (`DOCS/decisions/022`), and `book-tab.js` still sits before `app.js`.

## 🔌 What is published

`window.MissionBookTab` — `show()` (rebuild the cards and open the project README), `openFile(path)`, `closePanel()`.

---

This project is distributed under the **MIT** license.
