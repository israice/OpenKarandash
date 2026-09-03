// Вкладка Book верхнего тулбара: слева карточки всех разделов интерфейса —
// Graph/Flow/Kanban/PROJECTS/Home/Book/Karandash/Settings, справа — README
// выбранной карточки. Раньше это была вкладка Projects боковой панели
// Sessions (PROJECTS/Chat/projects-tab.js) с тем же приёмом; теперь это
// отдельная страница со своей панелью справа.
//
// Файл самодостаточный: свою разметку он вставляет сам, стили лежат рядом
// (book.css), а всё чужое зовётся через окна — редактор файла из графа
// (MissionGraph.createFileEditor), EasyMDE (MdEditors.attach) и ручку ширины
// панели (SidebarResize.init). Грузится раньше app.js (см. порядок <script>
// в SYSTEM/index.html): тот на старте ищет #bookView для App.VIEWS.
(function () {

    // ---------- разметка ----------

    const view = document.createElement('div');
    view.className = 'view view--side view--book';
    view.id = 'bookView';
    view.hidden = true;
    view.innerHTML = `
        <nav class="side-nav" id="bookNav" aria-label="Book">
            <h2 class="side-nav__title side-nav__title--nav"><span>Book</span></h2>
            <ul class="session-list project-cards" id="bookList"></ul>
            <div class="session-resize" id="bookResize" aria-hidden="true"></div>
        </nav>
        <div class="view__content">
            <p class="book-empty" id="bookEmpty">Select a section on the left</p>
            <div class="chat__file-editor" id="bookFileEditor" hidden>
                <div class="chat__file-editor-header">
                    <h2 class="chat__file-editor-title" id="bookFileEditorTitle"></h2>
                    <p class="file-modal__meta" id="bookFileEditorMeta"></p>
                </div>
                <div class="file-modal__links" id="bookFileEditorLinks"></div>
                <textarea class="file-modal__text" id="bookFileEditorText" spellcheck="false" aria-label="File contents"></textarea>
                <div class="file-modal__footer">
                    <span class="file-modal__status" id="bookFileEditorStatus"></span>
                </div>
            </div>
        </div>
    `;
    // вкладки лежат подряд в одном контейнере — встаём на прежнее место, перед
    // Projects. Разметки нет — вкладку показать некуда, дальше идти незачем
    const chatView = document.getElementById('chatView');
    if (!chatView) return;
    chatView.parentElement.insertBefore(view, chatView);

    const list = view.querySelector('#bookList');
    const fileEditor = view.querySelector('#bookFileEditor');
    const empty = view.querySelector('#bookEmpty');

    // ручка ширины панели и markdown-редактор подключаются, когда все файлы
    // с defer уже выполнились: до этого ни SidebarResize, ни EasyMDE ещё нет
    document.addEventListener('DOMContentLoaded', () => {
        window.SidebarResize?.init({ panelId: 'bookNav', handleId: 'bookResize', storageKey: 'bookPanelWidth' });
        window.MdEditors?.attach(view.querySelector('#bookFileEditorText'));
    });

    // ---------- панель README справа ----------

    // тот же приём, что и в чате: карточка раздела слева заменяет содержимое
    // панели справа, а не открывает окно посередине. Сам редактор — из графа:
    // он умеет читать/писать файл и рисовать связи узла
    let editor = null;

    function fileEditorPanel() {
        if (!editor) {
            editor = MissionGraph.createFileEditor({
                titleEl: view.querySelector('#bookFileEditorTitle'),
                metaEl: view.querySelector('#bookFileEditorMeta'),
                linksEl: view.querySelector('#bookFileEditorLinks'),
                textEl: view.querySelector('#bookFileEditorText'),
                statusEl: view.querySelector('#bookFileEditorStatus'),
                autosave: true,
                onOpen: () => {
                    empty.hidden = true;
                    fileEditor.hidden = false;
                },
                onLinkClick: (item) => {
                    const target = MissionGraph.nodeByPath(item);
                    if (target) editor.open(target);
                },
            });
        }
        return editor;
    }

    function openFile(path) {
        fileEditorPanel().open({ file: path, kind: 'file', label: path });
    }

    function closePanel() {
        fileEditor.hidden = true;
        empty.hidden = false;
        list.querySelector('.project-card--selected')?.classList.remove('project-card--selected');
    }

    // ---------- карточки разделов ----------

    const SOURCE_IDS = [
        'graphButton', 'flowButton', 'kanbanButton', 'chatButton', 'homeButton',
        'bookButton', 'karandashButton', 'settingsButton',
    ];

    // короткое описание каждого раздела для карточки — по одному на кнопку тулбара
    const DESCRIPTIONS = {
        graphButton: 'Project map: files, functions and the links between them',
        flowButton: 'Diagram of the project execution flow',
        kanbanButton: 'Task board in columns',
        chatButton: 'Chat with the assistant and the session list',
        homeButton: 'Home screen, overall project view',
        bookButton: 'Library of interface sections',
        karandashButton: 'Karandash — interface commenting mode',
        settingsButton: 'Application and provider settings',
    };

    // у каждой кнопки тулбара есть своя папка в PROJECTS/ с README.md
    const README = {
        graphButton: 'PROJECTS/Graph/README.md',
        flowButton: 'PROJECTS/Flow/README.md',
        kanbanButton: 'PROJECTS/Kanban/README.md',
        chatButton: 'PROJECTS/Chat/README.md',
        homeButton: 'PROJECTS/Home/README.md',
        bookButton: 'PROJECTS/Book/README.md',
        karandashButton: 'PROJECTS/Karandash/README.md',
        settingsButton: 'PROJECTS/Settings/README.md',
    };

    // данных о реальном создании/версии карточек пока нет — генерируем правдоподобные
    // один раз за показ, чтобы карточки не прыгали при пересборке
    function fakeCardMeta() {
        const daysAgo = Math.floor(Math.random() * 60);
        const created = new Date(Date.now() - daysAgo * 86400000);
        const date = created.toLocaleDateString('ru-RU');
        const time = created.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
        const version = `v0.${Math.floor(Math.random() * 9) + 1}.${Math.floor(Math.random() * 20)}`;
        return `${date} ${time} · ${version}`;
    }

    // встроенные разделы (SOURCE_IDS) плюс папки, заведённые кнопкой «+»
    // (SYSTEM/new-button.js) — те помечают свою кнопку тулбара data-readme
    function collectEntries() {
        const entries = [];
        for (const id of SOURCE_IDS) {
            const source = document.getElementById(id);
            if (!source) continue;
            entries.push({ source, readme: README[id], desc: DESCRIPTIONS[id] || '' });
        }
        for (const source of document.querySelectorAll('.toolbar [data-readme]')) {
            entries.push({ source, readme: source.dataset.readme, desc: 'User section' });
        }
        return entries;
    }

    function buildCard({ source, readme, desc }) {
        const label = source.title || source.getAttribute('aria-label') || '';
        const item = document.createElement('li');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'project-card';
        btn.title = label;
        btn.addEventListener('click', () => {
            if (!readme) { source.click(); return; }
            if (btn.classList.contains('project-card--selected')) {
                btn.classList.remove('project-card--selected');
                closePanel();
            } else {
                for (const other of list.querySelectorAll('.project-card--selected')) {
                    other.classList.remove('project-card--selected');
                }
                btn.classList.add('project-card--selected');
                openFile(readme);
            }
        });
        const icon = document.createElement('span');
        icon.className = 'project-card__icon';
        icon.innerHTML = source.innerHTML;
        const body = document.createElement('span');
        body.className = 'project-card__body';
        const text = document.createElement('span');
        text.className = 'project-card__label';
        text.textContent = label;
        const descEl = document.createElement('span');
        descEl.className = 'project-card__desc';
        descEl.textContent = desc;
        const meta = document.createElement('span');
        meta.className = 'project-card__meta';
        meta.textContent = fakeCardMeta();
        body.append(text, descEl, meta);
        btn.append(icon, body);
        item.append(btn);
        return item;
    }

    // пересобираем при каждом открытии вкладки — новая папка от кнопки «+»
    // могла появиться уже после предыдущего показа; справа сразу показываем
    // README из корня проекта, как раньше делала вкладка Projects
    function show() {
        list.innerHTML = '';
        for (const entry of collectEntries()) list.append(buildCard(entry));
        openFile('README.md');
    }

    window.MissionBookTab = { show, openFile, closePanel };
})();
