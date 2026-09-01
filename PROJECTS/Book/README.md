# 📚 Book

**Библиотека всех разделов интерфейса: карточка на каждую вкладку тулбара со ссылкой на её README.**

## 🧭 Что это

Book — вкладка тулбара (`bookButton`, `data-view="book"`). Разметка живёт в `SYSTEM/index.html` в блоке `<main class="view view--book" id="bookView">`, а в `App.VIEWS` этот элемент записан под ключом `book`.

Раньше этот список карточек был вкладкой «Projects» боковой панели Sessions (переключалась стрелками ←/→ рядом с Tasks). Теперь это отдельная страница верхнего меню, как Graph, Flow, Kanban и остальные.

## 🗂️ Что на экране

Сетка карточек (`#bookList`, класс `book-grid`) — по одной на каждую кнопку тулбара: Graph, Flow, Kanban, PROJECTS, Home, Book, Karandash, Settings, плюс разделы, добавленные кнопкой «+» (`SYSTEM/new-button.js`). Список пересобирается при каждом открытии вкладки — новая папка от кнопки «+» подхватывается сразу.

Клик по карточке открывает README её папки в общей модалке (`MissionGraph.openFileModal`, `PROJECTS/Graph/graph.js`) — она не привязана к конкретной вкладке, поэтому видна поверх Book.

## ⚙️ Как это устроено

- **Список строит `PROJECTS/Book/book-tab.js`.** Три таблицы-константы (`SOURCE_IDS`, `DESCRIPTIONS`, `README`) связывают id кнопки тулбара с описанием и путём до README.
- **Стили — в `PROJECTS/Book/book.css`** (сетка `.book-grid`), сами карточки используют классы `.project-card*` из `SYSTEM/styles/sessions.css`.
- **Открытие вкладки** — `SYSTEM/tabs.js` вызывает `MissionBookTab.show()` при клике на `bookButton`.

---

Проект распространяется по лицензии **MIT**.
