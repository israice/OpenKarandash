// Редактор файла проекта: чтение, правка, автосохранение и связи узла карты.
// Раньше это была нижняя половина вкладки Graph (PROJECTS/Graph/graph.js);
// саму вкладку с полотном из проекта убрали, а редактор остался — им живут
// панель README во вкладке Book, панель файла в Chat и ноды-документы Flow
// (DOCS/decisions/023). Серверная половина там же, где была: graph-server.js.
// Подключается с defer и ничего не ждёт от порядка загрузки: общее ядро берём
// из window.App в момент вызова, а не при старте файла.
(function () {
    'use strict';

    // ---------- карта проекта ----------

    // Узлы и связи vault нужны редактору для списка связей узла и переходов по
    // ним. Раньше карту забирала отрисовка графа при открытии вкладки; теперь
    // тянем сами — лениво, при первом открытии файла, и заново после пересборки
    let mapPromise = null;
    let mapNodes = [];
    let mapNeighbours = new Map();

    async function loadMap() {
        let data;
        try {
            const res = await fetch('/api/obsidian/graph', { method: 'POST' });
            data = await res.json();
        } catch {
            data = { ok: false };
        }
        mapNodes = [];
        mapNeighbours = new Map();
        // карта не собралась — редактор всё равно откроет файл, просто без связей
        if (!data.ok) return;
        mapNodes = data.notes.map((note) => ({
            ...note,
            label: note.path.replace(/\.md$/, '').split('/').pop(),
        }));
        mapNeighbours = new Map(mapNodes.map((node) => [node.path, new Set()]));
        for (const [from, to] of data.links) {
            const near = mapNeighbours.get(from);
            const far = mapNeighbours.get(to);
            if (!near || !far) continue; // связь на узел, которого в карте нет
            near.add(to);
            far.add(from);
        }
    }

    function ensureMap() {
        if (!mapPromise) mapPromise = loadMap();
        return mapPromise;
    }

    function nodeByPath(notePath) {
        return mapNodes.find((node) => node.path === notePath);
    }

    // сервер пересобрал карту (событие 'map' по SSE) — прежняя устарела.
    // заберём заново при следующем открытии файла, а не прямо сейчас:
    // пересборка идёт после каждой правки, а панель открыта далеко не всегда
    window.__onMapUpdate = () => { mapPromise = null; };

    // ---------- содержимое файла: просмотр и правка ----------
    // Общая логика (загрузка, сохранение, Ctrl+S) переиспользуется тремя местами:
    // окном-модалкой, панелью справа в чате и панелью README во вкладке Book

    // узел карты указывает либо на файл проекта (file, section, function, route),
    // либо на саму заметку vault (session, history, рукописные заметки)
    function nodeSource(node) {
        if (node.file) return { path: node.file, line: node.line };
        if (node.kind === 'file') return { path: node.label };
        return { path: 'DATA/vault/' + node.path };
    }

    // для секции и функции показываем не начало файла, а нужное место
    function scrollToLine(textEl, line) {
        const lines = textEl.value.split('\n');
        // +1 за перевод строки перед нужной, иначе выделение начинается с него
        const before = lines.slice(0, line - 1).join('\n').length + (line > 1 ? 1 : 0);
        textEl.focus();
        textEl.setSelectionRange(before, before + (lines[line - 1] || '').length);
        // прокрутка курсора в textarea не гарантирована — считаем позицию сами
        const lineHeight = parseFloat(getComputedStyle(textEl).lineHeight) || 18;
        textEl.scrollTop = Math.max(0, (line - 3) * lineHeight);
    }

    // { titleEl, metaEl, linksEl, textEl, statusEl, saveEl } — элементы окна или панели.
    // onOpen вызывается перед загрузкой файла — там показывают окно/панель.
    // onLinkClick(path) решает, чем открыть связанный узел — тем же способом
    function makeFileEditor({ titleEl, metaEl, linksEl, textEl, statusEl, saveEl, onOpen, onLinkClick, autosave }) {
        let path = null;   // что правим на диске
        let saved = '';    // текст на момент открытия — по нему видно, есть ли правки
        let autosaveTimer = null;
        let opened = null; // узел в панели прямо сейчас: карта грузится дольше, чем открывается файл

        // связи узла живут в карте проекта, а её приходится ждать по сети.
        // за это время в панели мог открыться другой файл — тогда список не наш
        async function renderLinks(node) {
            linksEl.textContent = '';
            await ensureMap();
            if (opened !== node) return;
            const neighbours = [...(mapNeighbours.get(node.path) || [])].sort();
            for (const item of neighbours.slice(0, 40)) {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'file-modal__link';
                button.textContent = item.replace(/\.md$/, '').split('/').pop();
                button.addEventListener('click', () => onLinkClick(item));
                linksEl.append(button);
            }
        }

        async function open(node) {
            const source = nodeSource(node);
            opened = node;
            path = null;
            titleEl.textContent = source.path;
            metaEl.textContent = 'Loading…';
            textEl.value = '';
            textEl.readOnly = true;
            if (saveEl) saveEl.disabled = true;
            statusEl.textContent = '';
            clearTimeout(autosaveTimer);
            renderLinks(node);
            onOpen();

            let data;
            try {
                const res = await fetch('/api/file/read', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path: source.path }),
                });
                data = await res.json();
            } catch {
                data = { ok: false, error: 'The server did not respond' };
            }

            if (!data.ok) {
                metaEl.textContent = data.error;
                return;
            }
            if (data.binary) {
                metaEl.textContent = `Binary file, ${Math.round(data.size / 1024)} KB${data.note ? ' · ' + data.note : ''}`;
                return;
            }

            path = data.path;
            saved = data.text;
            textEl.value = data.text;
            textEl.readOnly = !data.editable;
            if (saveEl) saveEl.disabled = true;
            metaEl.textContent = [
                `${data.text.split('\n').length} lines`,
                `${Math.round(data.size / 1024)} KB`,
                node.kind === 'section' || node.kind === 'function' ? `${node.kind} «${node.label}»` : node.kind,
                data.note,
            ].filter(Boolean).join(' · ');

            if (source.line) scrollToLine(textEl, source.line);
        }

        async function save() {
            if (!path) return;
            clearTimeout(autosaveTimer);
            if (saveEl) saveEl.disabled = true;
            statusEl.textContent = 'Saving…';
            const text = textEl.value;

            let data;
            try {
                const res = await fetch('/api/file/write', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path, text }),
                });
                data = await res.json();
            } catch {
                data = { ok: false, error: 'The server did not respond' };
            }

            if (!data.ok) {
                statusEl.textContent = data.error;
                if (saveEl) saveEl.disabled = false;
                return;
            }
            saved = text;
            statusEl.textContent = 'Saved';
        }

        textEl.addEventListener('input', () => {
            const dirty = !textEl.readOnly && textEl.value !== saved;
            if (autosave) {
                // сохраняем без кнопки — но не на каждое нажатие, а после паузы в наборе
                clearTimeout(autosaveTimer);
                if (dirty) {
                    statusEl.textContent = 'unsaved changes';
                    autosaveTimer = setTimeout(save, 800);
                }
                return;
            }
            saveEl.disabled = !dirty;
            statusEl.textContent = dirty ? 'unsaved changes' : '';
        });

        if (saveEl) saveEl.addEventListener('click', save);

        // Ctrl+S привычнее кнопки, когда правишь код
        textEl.addEventListener('keydown', (event) => {
            if ((event.ctrlKey || event.metaKey) && event.key === 's') {
                event.preventDefault();
                if (autosave || !saveEl.disabled) save();
            }
        });

        return { open };
    }

    // окно-модалка: ею открывают файл с чужого экрана — например, ноду-документ Flow
    const fileModal = document.getElementById('fileModal');
    const fileModalEditor = makeFileEditor({
        titleEl: document.getElementById('fileModalTitle'),
        metaEl: document.getElementById('fileModalMeta'),
        linksEl: document.getElementById('fileModalLinks'),
        textEl: document.getElementById('fileModalText'),
        statusEl: document.getElementById('fileModalStatus'),
        saveEl: document.getElementById('fileModalSave'),
        onOpen: () => App.openModal(fileModal), // окно открывает ядро: там управление фокусом
        onLinkClick: (item) => {
            const target = nodeByPath(item);
            if (target) openFileModal(target);
        },
    });

    function openFileModal(node) {
        return fileModalEditor.open(node);
    }

    // панель справа в чате: заменяет содержимое чата, как выбор сессии, —
    // вместо окна посередине
    const chatFileEditor = document.getElementById('chatFileEditor');
    const chatMessages = document.getElementById('chatMessages');
    const chatComposer = document.getElementById('chatComposer');
    const chatFilePanelEditor = makeFileEditor({
        titleEl: document.getElementById('chatFileEditorTitle'),
        metaEl: document.getElementById('chatFileEditorMeta'),
        linksEl: document.getElementById('chatFileEditorLinks'),
        textEl: document.getElementById('chatFileEditorText'),
        statusEl: document.getElementById('chatFileEditorStatus'),
        saveEl: document.getElementById('chatFileEditorSave'),
        onOpen: () => {
            chatMessages.hidden = true;
            chatComposer.hidden = true;
            chatFileEditor.hidden = false;
        },
        onLinkClick: (item) => {
            const target = nodeByPath(item);
            if (target) chatFilePanelEditor.open(target);
        },
    });

    function closeFilePanel() {
        chatFileEditor.hidden = true;
        chatMessages.hidden = false;
        chatComposer.hidden = false;
        document.querySelector('.project-card--selected')?.classList.remove('project-card--selected');
    }

    window.MissionFiles = {
        // открыть панель редактирования произвольного файла по пути
        openFile(path) { chatFilePanelEditor.open({ file: path, kind: 'file', label: path }); },
        // то же, но окном поверх страницы: панель живёт внутри вкладки Chat, а звать
        // редактор файла нужно и с чужого экрана — Flow открывает так свои ноды-документы
        openFileModal(path) { fileModalEditor.open({ file: path, kind: 'file', label: path }); },
        closeFilePanel,
        // тот же редактор файла, но для чужой панели: вкладка Book собирает свою
        // сама (PROJECTS/Book/book-tab.js), а разметку узлов карты знает этот файл
        createFileEditor: makeFileEditor,
        nodeByPath,
    };
})();
