// Меню вкладки Flow слева: разделы доски, черновики Temp и профили —
// плюс переключение видимого канваса. Канвас у пунктов меню общий (один
// surface/zoom/pan), но у каждого пункта свой набор нод; сам канвас и
// состояние ноды живут в flow-canvas.js и flow-node-state.js.
//
// В ctx этот модуль кладёт initialActiveItem — пункт, восстановленный как
// открытый: от него flow-canvas.js берёт текущий flow. Остальное берёт сам
// по событию клика, поэтому порядок сборки ему не важен.
(function () {
    window.FlowNav = function (ctx) {
        const { flowGet, flowSet } = ctx;

        // мусорка справа от строки, как в списке сессий (.session-row/.session-delete,
        // см. SYSTEM/app.js): свой элемент рядом с кнопкой пункта, а не внутри неё
        function makeNavDeleteBtn() {
            const del = document.createElement('button');
            del.type = 'button';
            del.className = 'side-nav__delete';
            del.title = 'Delete';
            del.setAttribute('aria-label', 'Delete');
            del.innerHTML = `
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <polyline points="3 6 5 6 21 6"></polyline>
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                </svg>
            `;
            return del;
        }
        // onRemove чистит связанное хранилище (кастомные flows/temps/profiles) —
        // у встроенных пунктов (колонки доски, дефолтные профили) его
        // нет, и клик просто убирает строку из DOM до перезагрузки страницы
        function wrapNavItem(item, onRemove) {
            const row = document.createElement('div');
            row.className = 'side-nav__row';
            const del = makeNavDeleteBtn();
            del.addEventListener('click', async (e) => {
                e.stopPropagation();
                const title = item.dataset.flow || item.textContent;
                const ok = await App.confirmModal(`Remove "${title}" from the menu?`, { title: 'Delete menu item' });
                if (!ok) return;
                if (onRemove) onRemove();
                row.remove();
            });
            row.append(item, del);
            return row;
        }

        // меню Flows повторяет разделы доски
        const flowNav = document.getElementById('flowNav');
        for (const title of App.BOARD_COLUMNS) {
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'side-nav__item';
            item.dataset.flow = title;
            item.textContent = title;
            flowNav.append(wrapNavItem(item));
        }

        // кастомные flow-пункты (заведённые кнопкой + у «Flows»)
        // переживают перезагрузку отдельно от разделов доски
        const CUSTOM_FLOWS_KEY = 'flowCustomFlows';
        function loadCustomFlows() {
            return flowGet(CUSTOM_FLOWS_KEY, []);
        }
        function saveCustomFlows(list) {
            flowSet(CUSTOM_FLOWS_KEY, list);
        }
        function addFlowItem(title) {
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'side-nav__item';
            item.dataset.flow = title;
            item.textContent = title;
            const row = wrapNavItem(item, () => {
                saveCustomFlows(loadCustomFlows().filter((t) => t !== title));
            });
            // строка должна лечь в конец своей группы (Flows), а не в конец
            // всего меню — иначе клик по + после того, как отрисованы
            // следующие группы (Temp/Profiles), кидает новую строку под них
            flowNav.insertBefore(row, flowNav.querySelector('[data-flow-group="temp"]'));
        }
        for (const title of loadCustomFlows()) {
            addFlowItem(title);
        }
        const flowsAddBtn = document.getElementById('flowFlowsAddBtn');
        flowsAddBtn.addEventListener('click', () => {
            const title = prompt('Name of the new flow:');
            if (!title || !title.trim()) return;
            const name = title.trim();
            const custom = loadCustomFlows();
            if (custom.includes(name)) return;
            custom.push(name);
            saveCustomFlows(custom);
            addFlowItem(name);
        });

        // отдельная категория Temp — черновые кнопки, не связанные с колонками доски
        const tempTitle = document.createElement('h2');
        tempTitle.className = 'side-nav__title side-nav__title--collapsible';
        tempTitle.dataset.flowGroup = 'temp';
        const tempTitleText = document.createElement('span');
        tempTitleText.textContent = 'Temp';
        const tempAddBtn = document.createElement('button');
        tempAddBtn.type = 'button';
        tempAddBtn.className = 'side-nav__arrow side-nav__arrow--active';
        tempAddBtn.textContent = '+';
        tempAddBtn.title = 'Add draft';
        tempTitle.append(tempTitleText, tempAddBtn);
        flowNav.append(tempTitle);

        // кастомные черновики (заведённые кнопкой +) переживают перезагрузку
        const CUSTOM_TEMPS_KEY = 'flowCustomTemps';
        function loadCustomTemps() {
            return flowGet(CUSTOM_TEMPS_KEY, []);
        }
        function saveCustomTemps(list) {
            flowSet(CUSTOM_TEMPS_KEY, list);
        }
        function addTempItem(title) {
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'side-nav__item';
            item.dataset.flow = title;
            item.textContent = title;
            const row = wrapNavItem(item, () => {
                saveCustomTemps(loadCustomTemps().filter((t) => t !== title));
            });
            // строка должна лечь в конец своей группы (Temp), а не в конец
            // всего меню — та же причина, что и в addFlowItem выше
            flowNav.insertBefore(row, flowNav.querySelector('[data-flow-group="minions"]'));
        }
        for (const title of loadCustomTemps()) {
            addTempItem(title);
        }
        tempAddBtn.addEventListener('click', () => {
            const title = prompt('Name of the new draft:');
            if (!title || !title.trim()) return;
            const name = title.trim();
            const custom = loadCustomTemps();
            if (custom.includes(name)) return;
            custom.push(name);
            saveCustomTemps(custom);
            addTempItem(name);
        });

        // категория Profiles — у каждого свой личный Flow (собственный
        // канвас с изолированными нодами/рёбрами, как у любого пункта меню)
        const agentsTitle = document.createElement('h2');
        agentsTitle.className = 'side-nav__title side-nav__title--nav side-nav__title--collapsible';
        agentsTitle.dataset.flowGroup = 'minions';
        const agentsTitleText = document.createElement('span');
        agentsTitleText.textContent = 'Profiles';
        const agentsAddBtn = document.createElement('button');
        agentsAddBtn.type = 'button';
        agentsAddBtn.className = 'side-nav__arrow side-nav__arrow--active';
        agentsAddBtn.textContent = '+';
        agentsAddBtn.title = 'Add profile';
        agentsTitle.append(agentsTitleText, agentsAddBtn);
        flowNav.append(agentsTitle);

        const AGENT_ICONS = {
            'Secretary': '📋',
            'UI developer': '🎨',
            'Backend developer': '⚙️',
            'QA': '🐞',
            'HR': '🧑‍💼',
        };
        const DEFAULT_AGENT_ICON = '🧩';

        // кастомные профили (заведённые кнопкой +) переживают перезагрузку
        // отдельно от встроенных пяти — те всегда одни и те же
        const CUSTOM_AGENTS_KEY = 'flowCustomAgents';
        function loadCustomAgents() {
            return flowGet(CUSTOM_AGENTS_KEY, []);
        }
        function saveCustomAgents(list) {
            flowSet(CUSTOM_AGENTS_KEY, list);
        }

        function addAgentItem(title, icon, isCustom) {
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'side-nav__item side-nav__item--agent';
            item.dataset.flow = title;
            const iconEl = document.createElement('span');
            iconEl.className = 'side-nav__item-icon';
            iconEl.textContent = icon;
            item.append(iconEl, document.createTextNode(title));
            const row = wrapNavItem(item, isCustom ? () => {
                saveCustomAgents(loadCustomAgents().filter((t) => t !== title));
            } : null);
            flowNav.append(row);
        }

        for (const title of ['Secretary', 'UI developer', 'Backend developer', 'QA', 'HR']) {
            addAgentItem(title, AGENT_ICONS[title]);
        }
        for (const title of loadCustomAgents()) {
            addAgentItem(title, DEFAULT_AGENT_ICON, true);
        }

        agentsAddBtn.addEventListener('click', () => {
            const title = prompt('Name of the new profile:');
            if (!title || !title.trim()) return;
            const name = title.trim();
            const custom = loadCustomAgents();
            if (custom.includes(name)) return;
            custom.push(name);
            saveCustomAgents(custom);
            addAgentItem(name, DEFAULT_AGENT_ICON, true);
        });

        // последний открытый пункт меню переживает перезагрузку — при заходе
        // на вкладку подсвечиваем именно его, а не всегда один и тот же
        const ACTIVE_FLOW_KEY = 'flowActiveFlow';
        const savedActiveFlow = flowGet(ACTIVE_FLOW_KEY, 'New');
        const initialActiveItem = flowNav.querySelector(`.side-nav__item[data-flow="${CSS.escape(savedActiveFlow)}"]`) || flowNav.querySelector('.side-nav__item[data-flow="New"]');
        if (initialActiveItem) {
            initialActiveItem.classList.add('side-nav__item--active');
            const initialSessionSelect = document.getElementById('flowSessionSelect');
            if (initialSessionSelect) initialSessionSelect.hidden = initialActiveItem.dataset.flow !== '321';
        }
        ctx.initialActiveItem = initialActiveItem;

        // заголовки групп сворачиваются кликом, как гормошка;
        // по умолчанию все группы открыты
        function syncGroupCollapse(title) {
            const collapsed = title.classList.contains('side-nav__title--collapsed');
            let el = title.nextElementSibling;
            while (el && !el.classList.contains('side-nav__title')) {
                el.hidden = collapsed;
                el = el.nextElementSibling;
            }
        }
        for (const title of flowNav.querySelectorAll('.side-nav__title--collapsible')) {
            syncGroupCollapse(title);
        }
        flowNav.addEventListener('click', (e) => {
            if (e.target.closest('.side-nav__arrow')) return;
            const title = e.target.closest('.side-nav__title--collapsible');
            if (!title) return;
            title.classList.toggle('side-nav__title--collapsed');
            syncGroupCollapse(title);
        });

        // клик по пункту меню переключает подсветку и видимый канвас;
        // сам канвас общий (один surface/zoom/pan), но у каждого пункта
        // свой набор нод — переключение просто прячет чужие
        flowNav.addEventListener('click', (e) => {
            const btn = e.target.closest('.side-nav__item');
            if (!btn) return;
            for (const b of flowNav.querySelectorAll('.side-nav__item')) {
                b.classList.toggle('side-nav__item--active', b === btn);
            }
            flowSet(ACTIVE_FLOW_KEY, btn.dataset.flow);
            // выбор сессии показываем только на черновике «321» — остальным
            // разделам (включая другие черновики Temp) сессия чата не нужна
            const sessionSelect = document.getElementById('flowSessionSelect');
            if (sessionSelect) sessionSelect.hidden = btn.dataset.flow !== '321';
            if (ctx.setActiveFlow) ctx.setActiveFlow(btn.dataset.flow);
        });
    };
})();
