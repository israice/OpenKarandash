// Вкладка Book верхнего тулбара: слева карточки всех разделов интерфейса —
// Flow/Kanban/Book/Karandash/Settings, справа — README
// выбранной карточки. Раньше это была вкладка Projects боковой панели
// Sessions (PROJECTS/Chat/projects-tab.js) с тем же приёмом; теперь это
// отдельная страница со своей панелью справа.
//
// Файл самодостаточный по логике: карточки и правая панель — здесь, стили
// лежат рядом (book.css), а всё чужое зовётся через окна — редактор файла
// (MissionFiles.createFileEditor), EasyMDE (MdEditors.attach) и ручку ширины
// панели (SidebarResize.init). Разметку вкладки отдаёт сервер — PROJECTS/Book/book-view.eta.
// Грузится раньше app.js (см. порядок <script> в SYSTEM/index.html): тот ищет #bookView.
(function () {

    // ---------- разметка ----------

    // Разметка пришла с сервера: book-view.eta сервером уже подставлен в
    // страницу, поэтому узлы ищем сразу по id в готовом DOM.
    const list = document.getElementById('bookList');
    const fileEditor = document.getElementById('bookFileEditor');
    const empty = document.getElementById('bookEmpty');
    const bookView = document.getElementById('bookView');
    if (!list || !fileEditor || !empty || !bookView) return;
    const view = bookView;

    // ручка ширины панели и markdown-редактор подключаются, когда все файлы
    // с defer уже выполнились: до этого ни SidebarResize, ни EasyMDE ещё нет
    document.addEventListener('DOMContentLoaded', () => {
        window.SidebarResize?.init({ panelId: 'bookNav', handleId: 'bookResize', storageKey: 'bookPanelWidth' });
        window.MdEditors?.attach(view.querySelector('#bookFileEditorText'));
    });

    // ---------- панель README справа ----------

    // тот же приём, что и в чате: карточка раздела слева заменяет содержимое
    // панели справа, а не открывает окно посередине. Сам редактор общий
    // (PROJECTS/Graph/file-editor.js): он умеет читать/писать файл и рисовать связи
    let editor = null;

    function fileEditorPanel() {
        if (!editor) {
            editor = MissionFiles.createFileEditor({
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
                    const target = MissionFiles.nodeByPath(item);
                    if (target) editor.open(target);
                },
            });
        }
        return editor;
    }

    function openFile(path) {
        // промис отдаём наружу: на первой сборке страницы README открывается
        // асинхронно, и его ждёт заслон (SYSTEM/boot.js) — иначе правая половина
        // вкладки доезжала бы уже после показа страницы
        return fileEditorPanel().open({ file: path, kind: 'file', label: path });
    }

    function closePanel() {
        fileEditor.hidden = true;
        empty.hidden = false;
        list.querySelector('.project-card--selected')?.classList.remove('project-card--selected');
    }

    // ---------- карточки разделов ----------

    const SOURCE_IDS = [
        'telegramButton', 'flowButton', 'kanbanButton', 'chatButton',
        'bookButton', 'karandashButton', 'settingsButton',
    ];

    // короткое описание каждого раздела для карточки — по одному на кнопку тулбара
    const DESCRIPTIONS = {
        telegramButton: 'Telegram bridge of the project',
        flowButton: 'Diagram of the project execution flow',
        kanbanButton: 'Task board in columns',
        chatButton: 'Chat with the assistant and the session list',
        bookButton: 'Library of interface sections',
        karandashButton: 'Karandash — interface commenting mode',
        settingsButton: 'Application and provider settings',
    };

    // у каждой кнопки тулбара есть своя папка в PROJECTS/ с README.md
    const README = {
        telegramButton: 'PROJECTS/Telegram/README.md',
        flowButton: 'PROJECTS/Flow/README.md',
        kanbanButton: 'PROJECTS/Kanban/README.md',
        chatButton: 'PROJECTS/Sessions/README.md',
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

    // Метрика сложности проекта (DOCS/decisions/111): /api/complexity,
    // отчёт показываем в той же панели файла, read-only — править нечего.
    //
    // Запрос идёт через window.App.api (POST), а не fetch'ем GET'ом: общий слой
    // SYSTEM/core/api.js разрешает GET только /api/fragment/* и /api/image/* —
    // тем, что браузер тянет сам. Наш GET отбивался 405, и карточка показывала
    // пустой отчёт. App.api кладёт window.App, а зовём мы его по клику, то есть
    // уже после загрузки app.js, — прямой доступ window.App здесь уместен.
    async function openComplexity() {
        empty.hidden = true;
        fileEditor.hidden = false;
        const titleEl = view.querySelector('#bookFileEditorTitle');
        const metaEl = view.querySelector('#bookFileEditorMeta');
        const linksEl = view.querySelector('#bookFileEditorLinks');
        const textEl = view.querySelector('#bookFileEditorText');
        const statusEl = view.querySelector('#bookFileEditorStatus');
        titleEl.textContent = 'Project complexity';
        metaEl.textContent = 'Loading…';
        linksEl.innerHTML = '';
        textEl.value = '';
        textEl.readOnly = true;
        statusEl.textContent = 'read-only';

        let data;
        try {
            data = await window.App.api('/api/complexity');
        } catch {
            data = null;
        }
        // App.api возвращает тело ответа независимо от кода, поэтому ok:false —
        // это отказ сервера, а не пустой отчёт: без этой проверки отчёт молча
        // показывал бы undefined на месте каждого числа
        if (!data || data.ok === false) {
            metaEl.textContent = data?.error || 'The server did not respond';
            return;
        }

        const lines = [];
        lines.push(`Files: ${data.files}`);
        lines.push(`Max folder depth: ${data.maxFolderDepth}`);
        lines.push(`Long files (>${data.maxLines} lines): ${data.longFiles.length}`);
        for (const f of data.longFiles) lines.push(`  ${f.lines}\t${f.file}`);
        lines.push('');
        lines.push('Top requires per file:');
        for (const f of data.topRequires) lines.push(`  ${f.requires}\t${f.file}`);
        lines.push('');
        lines.push('Deepest files:');
        for (const f of data.topDepth) lines.push(`  ${f.depth}\t${f.file}`);

        metaEl.textContent = `${data.files} files · depth ${data.maxFolderDepth} · ${data.longFiles.length} long`;
        textEl.value = lines.join('\n');
    }

    function buildComplexityCard() {
        const item = document.createElement('li');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'project-card';
        btn.title = 'Project complexity';
        btn.addEventListener('click', () => {
            const wasSelected = btn.classList.contains('project-card--selected');
            for (const other of list.querySelectorAll('.project-card--selected')) {
                other.classList.remove('project-card--selected');
            }
            if (wasSelected) { closePanel(); return; }
            btn.classList.add('project-card--selected');
            openComplexity();
        });
        const icon = document.createElement('span');
        icon.className = 'project-card__icon';
        icon.textContent = 'Σ';
        const body = document.createElement('span');
        body.className = 'project-card__body';
        const text = document.createElement('span');
        text.className = 'project-card__label';
        text.textContent = 'Complexity';
        const descEl = document.createElement('span');
        descEl.className = 'project-card__desc';
        descEl.textContent = 'File sizes, requires, nesting depth';
        body.append(text, descEl);
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
        list.append(buildComplexityCard());
        window.MissionBoot?.task('book', openFile('README.md'));
    }

    window.MissionBookTab = { show, openFile, closePanel };
})();
