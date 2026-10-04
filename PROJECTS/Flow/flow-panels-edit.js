// Остальная работа с карточкой на живом полотне: открытие панелей личной ноды и
// правка их полей, меню «кто видит узел» и выбора иконки, тип ноды и область
// видимости, выделение ноды и ребра, удаление по Delete.
//
// Как и в flow-edit.js, здесь только обработчики: что они рисуют — в
// flow-panels.js и flow-panel-data.js, что удаляют — в flow-node-tree.js.
(function () {
    window.FlowPanelsEdit = function (ctx) {
        const { surface, canvas } = ctx;

        // --- панели личной ноды ---

        // выделение ноды кликом и удаление по Delete; стартовая и «Секретарь»
        // не удаляются — на них завязана логика центрирования канваса
        function selectNode(n) {
            if (ctx.selectedNode) ctx.selectedNode.classList.remove('flow-node--selected');
            ctx.selectedNode = n;
            if (ctx.selectedNode) ctx.selectedNode.classList.add('flow-node--selected');
        }

        // выделение ребра кликом по линии стрелки — так же меняет цвет и
        // удаляется по Delete; клик мимо линии (и мимо ноды) снимает выделение
        function selectEdge(edge) {
            if (ctx.selectedEdge) ctx.selectedEdge.path.setAttribute('stroke', '#6ea8fe');
            ctx.selectedEdge = edge;
            if (ctx.selectedEdge) ctx.selectedEdge.path.setAttribute('stroke', '#ffb84d');
        }

        ctx.edgesLayer.addEventListener('click', (e) => {
            const path = e.target.closest('path');
            const edge = path && ctx.edges.find((ed) => ed.path === path);
            if (!edge) return;
            e.stopPropagation(); // иначе клик всплывает в surface и тут же снимает выделение
            selectNode(null);
            selectEdge(edge);
        });

        surface.addEventListener('click', (e) => {
            if (e.target.closest('.flow-node__edit') || e.target.closest('.flow-node__add-bottom') || e.target.closest('.flow-node__add-right') || e.target.closest('select') || e.target.closest('.flow-node__scope') || e.target.closest('.flow-node__avatar-picker')) return;
            selectEdge(null);
            selectNode(e.target.closest('.flow-node'));
        });

        // пункт вертикального меню с data-panel показывает вместо правой
        // колонки карточки одноимённую панель, повторный клик возвращает её
        // назад. Высота карточки при этом меняется — зовём общий пересчёт
        // раскладки и дуг, иначе соседние ноды наедут друг на друга
        surface.addEventListener('click', (e) => {
            const item = e.target.closest('.flow-node__menu-item[data-panel]');
            if (!item) return;
            const n = item.closest('.flow-node');
            const panel = n.querySelector('.flow-node__panel--' + item.dataset.panel);
            if (!panel) return;
            const show = panel.hidden;
            for (const p of n.querySelectorAll('.flow-node__panel')) p.hidden = true;
            for (const b of n.querySelectorAll('.flow-node__menu-item[data-panel]')) {
                b.classList.remove('flow-node__menu-item--active');
                b.setAttribute('aria-pressed', 'false');
            }
            panel.hidden = !show;
            n.querySelector('.flow-node__main').hidden = show;
            item.classList.toggle('flow-node__menu-item--active', show);
            item.setAttribute('aria-pressed', show ? 'true' : 'false');
            if (show && item.dataset.panel === 'mcp') ctx.renderMcpPanel(n);
            // содержимое остальных панелей зависит от того, чья это карточка —
            // QA или Backend developer (см. ROOT_FIELDS в flow-panel-data.js): без
            // этой развилки Backend показывал бы текст QA
            const panelName = item.dataset.panel;
            if (show && ctx.FIELD_PANELS.includes(panelName)) {
                // у панели Model префикс классов llm: .flow-node__model — это
                // селектор модели в подвале карточки, занимать его нельзя
                const prefix = panelName === 'model' ? 'llm' : panelName;
                const rootFields = ctx.ROOT_FIELDS[n.id];
                // профиль без своей записи (Secretary, UI developer, HR) раньше
                // молча показывал поля QA и писал правки в его же хранилище —
                // теперь панель прямо говорит, что данных нет
                if (rootFields) ctx.renderFieldPanel(n, prefix, ...rootFields[panelName]);
                else {
                    const list = n.querySelector('.flow-node__' + prefix + '-list');
                    if (list) ctx.renderEmptyPanel(list, 'Nothing is filled in for this profile yet.');
                }
            }
            ctx.afterNodeChange();
        });

        // подключение MCP: отметка общая на все ноды QA, поэтому кнопку
        // перекрашиваем во всех открытых списках сразу. Перерисовывать список
        // целиком нельзя — сбросился бы набранный в поиске фильтр
        surface.addEventListener('click', (e) => {
            const btn = e.target.closest('.flow-node__mcp-toggle');
            if (!btn) return;
            // карточка каждой роли на странице ровно одна (личная нода держит
            // фиксированный id), поэтому отметку достаточно обновить внутри неё —
            // и не задеть тот же id в списке другой роли (у QA и Backend есть
            // совпадающие id, например slack)
            const n = btn.closest('.flow-node');
            const cfg = ctx.mcpConfigFor(n);
            const id = btn.closest('.flow-node__mcp').dataset.mcp;
            const connected = ctx.connectedMcps(n);
            const next = connected.includes(id) ? connected.filter((v) => v !== id) : [...connected, id];
            ctx.flowSet(cfg.stateKey, next);
            for (const row of n.querySelectorAll('.flow-node__mcp[data-mcp="' + id + '"]')) {
                ctx.setMcpButton(row.querySelector('.flow-node__mcp-toggle'), next.includes(id));
            }
        });

        // правка поля панели («душа», системный промпт): текст общий на все
        // ноды QA, поэтому то же поле в остальных открытых панелях обновляем
        // сразу, а не после перезагрузки. Панель, в которой печатают,
        // пропускаем — иначе прыгает курсор
        surface.addEventListener('input', (e) => {
            const input = e.target.closest('[data-store][data-field]');
            if (!input) return;
            const { store, field } = input.dataset;
            ctx.flowSet(store, { ...ctx.flowGet(store, {}), [field]: input.value });
            ctx.autoGrowField(input);
            for (const other of surface.querySelectorAll('[data-store="' + store + '"][data-field="' + field + '"]')) {
                if (other === input) continue;
                other.value = input.value;
                ctx.autoGrowField(other);
            }
        });

        // иконка md-файла у заголовка панели (Soul, MCP, System Prompt): открывает файл из
        // data-file тем же окном редактора, что и ноды-документы. Путь живёт в
        // разметке — так новой панели хватает своей кнопки, без правки скрипта.
        // MissionFiles — внутри обработчика, чтобы порядок загрузки файлов
        // ни на что не влиял
        surface.addEventListener('click', (e) => {
            const btn = e.target.closest('.flow-node__panel-file');
            if (!btn) return;
            if (btn.dataset.file && window.MissionFiles) window.MissionFiles.openFileModal(btn.dataset.file);
        });

        // поиск над списком: прячет строки, не совпавшие с запросом
        surface.addEventListener('input', (e) => {
            if (!e.target.matches('.flow-node__mcp-search')) return;
            const query = e.target.value.trim().toLowerCase();
            for (const row of e.target.closest('.flow-node__panel--mcp').querySelectorAll('.flow-node__mcp')) {
                row.hidden = Boolean(query) && !row.dataset.search.includes(query);
            }
        });

        // кнопка ноды-документа: открываем файл тем же окном, которым его
        // открывает клик по ноде-документу (MissionFiles — внутри обработчика,
        // чтобы порядок загрузки файлов ни на что не влиял)
        surface.addEventListener('click', (e) => {
            const btn = e.target.closest('.flow-node__open');
            if (!btn) return;
            const path = btn.closest('.flow-node').dataset.file;
            if (path && window.MissionFiles) window.MissionFiles.openFileModal(path);
        });

        // правка своей реплики в карточке уходит в саму сессию, а не только в
        // подпись ноды (§10 chat.md). Сервер отдаёт правку только для роли user
        // (см. /api/sessions/message/set): отказ откатывает поле и объясняет причину
        surface.addEventListener('focusout', async (e) => {
            const pre = e.target.closest('.flow-node__fact-text');
            if (!pre || pre.contentEditable !== 'true') return;
            const n = pre.closest('.flow-node');
            const text = pre.textContent;
            if (!n.dataset.session || text === pre.dataset.saved) return;
            const res = await App.api('/api/sessions/message/set', {
                id: n.dataset.session,
                position: Number(n.dataset.position),
                text,
            });
            if (res.ok) {
                pre.dataset.saved = text;
                ctx.setNodeTexts(n, n.querySelector('.flow-node__title').textContent, ctx.truncate(text, 200));
                return;
            }
            pre.textContent = pre.dataset.saved || '';
            App.confirmModal(res.error || 'The server did not respond', { title: 'Message not changed', confirmText: 'OK', cancelText: 'Close' });
        });

        // раскрытие секции меняет высоту ноды — соседей надо раздвинуть, а дуги
        // перерисовать. Событие toggle не всплывает, поэтому слушаем его в фазе
        // перехвата; самим раскрытием по-прежнему занимается браузер
        surface.addEventListener('toggle', (e) => {
            if (!e.target.classList?.contains('flow-node__fact')) return;
            ctx.layoutAllNodes();
            ctx.drawEdge();
        }, true);

        // --- меню «кто видит узел» и меню выбора иконки ---

        // меню «кто видит узел»: один открытый экземпляр на канвас,
        // клик по пункту красит кнопку выбранной иконкой и закрывает меню
        surface.addEventListener('click', (e) => {
            const scopeBtn = e.target.closest('.flow-node__scope-btn');
            const scopeItem = e.target.closest('.flow-node__scope-item');
            const openMenu = surface.querySelector('.flow-node__scope-menu:not([hidden])');

            if (scopeItem) {
                const btn = scopeItem.closest('.flow-node__scope').querySelector('.flow-node__scope-btn');
                btn.textContent = scopeItem.textContent.trim().split(' ')[0];
                btn.title = scopeItem.textContent.trim();
                scopeItem.closest('.flow-node__scope-menu').hidden = true;
                return;
            }

            if (openMenu && openMenu !== scopeBtn?.nextElementSibling) openMenu.hidden = true;
            if (scopeBtn) scopeBtn.nextElementSibling.hidden = !scopeBtn.nextElementSibling.hidden;
        });

        window.addEventListener('click', (e) => {
            if (e.target.closest('.flow-node__scope')) return;
            const openMenu = surface.querySelector('.flow-node__scope-menu:not([hidden])');
            if (openMenu) openMenu.hidden = true;
        });

        // меню выбора иконки узла: клик по аватару открывает набор иконок на его месте,
        // клик по иконке красит аватар выбранным символом и закрывает меню
        surface.addEventListener('click', (e) => {
            const avatarBtn = e.target.closest('.flow-node__avatar');
            const avatarItem = e.target.closest('.flow-node__avatar-item');
            const openMenu = surface.querySelector('.flow-node__avatar-menu:not([hidden])');

            if (avatarItem) {
                avatarItem.closest('.flow-node__avatar-picker').querySelector('.flow-node__avatar').textContent = avatarItem.dataset.avatar;
                avatarItem.closest('.flow-node__avatar-menu').hidden = true;
                return;
            }

            if (openMenu && openMenu !== avatarBtn?.nextElementSibling) openMenu.hidden = true;
            if (avatarBtn) avatarBtn.nextElementSibling.hidden = !avatarBtn.nextElementSibling.hidden;
        });

        window.addEventListener('click', (e) => {
            if (e.target.closest('.flow-node__avatar-picker')) return;
            const openMenu = surface.querySelector('.flow-node__avatar-menu:not([hidden])');
            if (openMenu) openMenu.hidden = true;
        });

        // --- тип ноды, область видимости, провайдер ---

        // цвет опции в раскрытом меню браузер не переносит на закрытый select сам —
        // красим его вручную цветом выбранной опции при каждой смене типа узла
        surface.addEventListener('change', (e) => {
            if (e.target.matches('.flow-node__provider')) {
                ctx.renderNodeModelEffort(e.target.closest('.flow-node'));
                return;
            }
            if (!e.target.matches('.flow-node__type')) return;
            e.target.style.color = e.target.selectedOptions[0].style.color;
            // блок вопросов имеет смысл только у типа Question
            const n = e.target.closest('.flow-node');
            const questions = n.querySelector('.flow-node__questions');
            if (questions) questions.hidden = e.target.value !== 'question';
            if (n.dataset.session) return; // тип ноды сессии задаёт построение
            const all = ctx.loadTypes();
            all[n.id] = e.target.value;
            ctx.flowSet(ctx.TYPES_KEY, all);
        });

        // toggle «Context on/off» в правой половине строки типа узла
        surface.addEventListener('click', (e) => {
            const toggle = e.target.closest('.flow-node__context-toggle');
            if (!toggle) return;
            const on = toggle.getAttribute('aria-pressed') !== 'true';
            toggle.setAttribute('aria-pressed', String(on));
            toggle.setAttribute('aria-label', on ? 'Context: on' : 'Context: off');
        });

        canvas.addEventListener('mousedown', (e) => {
            if (e.target.closest('.flow-node') || e.target.closest('#flowEdges')) return;
            selectNode(null);
            selectEdge(null);
        });

        // --- удаление ---

        window.addEventListener('keydown', (e) => {
            if (e.key !== 'Delete') return;
            // заголовок, подзаголовок и тело ноды правятся не в <input>, а как
            // contentEditable-спаны (EDITABLE_SELECTOR) — без этой проверки
            // Delete посреди набора текста удалял саму ноду вместе с текстом
            const active = document.activeElement;
            if (active && (['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName) || active.isContentEditable)) return;
            if (ctx.selectedEdge) {
                ctx.removeEdge(ctx.selectedEdge);
                ctx.selectedEdge = null;
                ctx.saveGraph();
                ctx.drawEdge();
                return;
            }
            // личная нода миньона — точка входа его канваса, удалять её нечем:
            // без неё канвас пустой, и вырастить новую цепочку не от чего
            if (!ctx.selectedNode || ctx.selectedNode === ctx.node || ctx.selectedNode === ctx.startNode) return;
            if (ctx.PERSONAL_ROOT_BY_ID[ctx.selectedNode.id]) return;
            ctx.deleteNode(ctx.selectedNode);
        });

        ctx.selectNode = selectNode;
        ctx.selectEdge = selectEdge;
    };
})();
