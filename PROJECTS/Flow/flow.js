// Вкладка Flow целиком: полотно с зумом и панорамированием плюс карточка ноды
// (стили — PROJECTS/Flow/flow.css, разметка #flowView — в SYSTEM/index.html рядом с остальными видами).
// Центрирование ноды отложено до первого показа вкладки — панель вкладок
// дёргает MissionFlow.center(), когда размеры канваса уже посчитаны.
(function () {
            // window.MissionFlow публикуем сразу и синхронно: панель вкладок (tabs.js)
            // может дёрнуть center() ещё до того, как ниже отработает await загрузки
            // состояния с сервера — тогда центрирование просто откладывается флагом
            // pendingCenter и срабатывает, как только canvas будет готов
            let centerFlowNode = null;
            let buildSessionFlow = null;
            let pendingCenter = false;
            window.MissionFlow = {
                center() {
                    if (centerFlowNode) {
                        centerFlowNode();
                        centerFlowNode = null;
                    } else {
                        pendingCenter = true;
                    }
                },
                // вызывается из PROJECTS/Flow/flow-session-sync.js по кнопке в тулбаре
                buildFromSession(flow, messages, usage, extra) {
                    if (buildSessionFlow) buildSessionFlow(flow, messages, usage, extra);
                },
            };

            init();
            async function init() {

            // хранилище вкладки Flow целиком — раньше localStorage, теперь БД
            // (см. /api/flow/state в server.js); ключи 1-в-1 со старыми именами
            // localStorage, читаем их разом одним запросом при открытии страницы
            const { state = {} } = await App.api('/api/flow/state', {});
            const flowState = state;
            // разовая миграция: то, что ещё лежит в localStorage с прошлой версии,
            // перекладываем в БД и подчищаем за собой
            for (const key of ['flowCustomFlows', 'flowCustomTemps', 'flowCustomAgents', 'flowCanvasViews', 'flowNodeText', 'flowNodeQuestions', 'flowNodePositions2', 'flowNodeGraph3', 'flowNodeSecretaryAgent']) {
                if (flowState[key] !== undefined) continue;
                const raw = localStorage.getItem(key);
                if (raw === null) continue;
                try {
                    flowState[key] = JSON.parse(raw);
                    await App.api('/api/flow/state/set', { key, value: flowState[key] });
                } catch { /* битое значение — просто не переносим */ }
                localStorage.removeItem(key);
            }
            function flowGet(key, fallback) {
                return flowState[key] !== undefined ? flowState[key] : fallback;
            }
            function flowSet(key, value) {
                flowState[key] = value;
                App.api('/api/flow/state/set', { key, value });
            }

            // нода «New»: дата/время открытия и имя проекта
            const startMeta = document.getElementById('flowNodeStartMeta');
            if (startMeta) {
                startMeta.textContent = '';
                const projectLine = document.createElement('span');
                projectLine.textContent = 'noname';
                const dateLine = document.createElement('span');
                dateLine.textContent = new Date().toLocaleString('ru-RU');
                startMeta.append(projectLine, dateLine);
            }

            // мусорка справа от строки, как в списке сессий (.session-row/.session-delete,
            // см. SYSTEM/app.js): свой элемент рядом с кнопкой пункта, а не внутри неё
            function makeNavDeleteBtn() {
                const del = document.createElement('button');
                del.type = 'button';
                del.className = 'side-nav__delete';
                del.title = 'Удалить';
                del.setAttribute('aria-label', 'Удалить');
                del.innerHTML = `
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <polyline points="3 6 5 6 21 6"></polyline>
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                    </svg>
                `;
                return del;
            }
            // onRemove чистит связанное хранилище (кастомные flows/temps/minions) —
            // у встроенных пунктов (колонки доски, дефолтные minion'ы) его
            // нет, и клик просто убирает строку из DOM до перезагрузки страницы
            function wrapNavItem(item, onRemove) {
                const row = document.createElement('div');
                row.className = 'side-nav__row';
                const del = makeNavDeleteBtn();
                del.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    const title = item.dataset.flow || item.textContent;
                    const ok = await App.confirmModal(`Удалить «${title}» из меню?`, { title: 'Удалить пункт меню' });
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
                // следующие группы (Temp/Minions), кидает новую строку под них
                flowNav.insertBefore(row, flowNav.querySelector('[data-flow-group="temp"]'));
            }
            for (const title of loadCustomFlows()) {
                addFlowItem(title);
            }
            const flowsAddBtn = document.getElementById('flowFlowsAddBtn');
            flowsAddBtn.addEventListener('click', () => {
                const title = prompt('Имя нового flow:');
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
            tempAddBtn.title = 'Добавить черновик';
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
                const title = prompt('Имя нового черновика:');
                if (!title || !title.trim()) return;
                const name = title.trim();
                const custom = loadCustomTemps();
                if (custom.includes(name)) return;
                custom.push(name);
                saveCustomTemps(custom);
                addTempItem(name);
            });

            // категория Minions — у каждого свой личный Flow (собственный
            // канвас с изолированными нодами/рёбрами, как у любого пункта меню)
            const agentsTitle = document.createElement('h2');
            agentsTitle.className = 'side-nav__title side-nav__title--nav side-nav__title--collapsible';
            agentsTitle.dataset.flowGroup = 'minions';
            const agentsTitleText = document.createElement('span');
            agentsTitleText.textContent = 'Minions';
            const agentsAddBtn = document.createElement('button');
            agentsAddBtn.type = 'button';
            agentsAddBtn.className = 'side-nav__arrow side-nav__arrow--active';
            agentsAddBtn.textContent = '+';
            agentsAddBtn.title = 'Добавить minion';
            agentsTitle.append(agentsTitleText, agentsAddBtn);
            flowNav.append(agentsTitle);

            const AGENT_ICONS = {
                'Секретарь': '📋',
                'Разработчик UI': '🎨',
                'Разработчик backend': '⚙️',
                'QA': '🐞',
                'HR': '🧑‍💼',
            };
            const DEFAULT_AGENT_ICON = '🧩';

            // кастомные minion'ы (заведённые кнопкой +) переживают перезагрузку
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

            for (const title of ['Секретарь', 'Разработчик UI', 'Разработчик backend', 'QA', 'HR']) {
                addAgentItem(title, AGENT_ICONS[title]);
            }
            for (const title of loadCustomAgents()) {
                addAgentItem(title, DEFAULT_AGENT_ICON, true);
            }

            agentsAddBtn.addEventListener('click', () => {
                const title = prompt('Имя нового minion’а:');
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
                const initialSessionUsage = document.getElementById('flowSessionUsage');
                if (initialSessionUsage) initialSessionUsage.hidden = true;
                const initialSessionInfo = document.getElementById('flowSessionInfo');
                if (initialSessionInfo) initialSessionInfo.hidden = true;
                const initialSessionCopyId = document.getElementById('flowSessionCopyId');
                if (initialSessionCopyId) initialSessionCopyId.hidden = true;
            }

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
                // расход показываем только пока реально смотрим на ту сессию, из
                // которой его посчитали — при уходе с «321» просто прячем, а не
                // обнуляем текст: вернувшись на «321», buildFromSession перепишет его заново
                const sessionUsage = document.getElementById('flowSessionUsage');
                if (sessionUsage && btn.dataset.flow !== '321') sessionUsage.hidden = true;
                const sessionInfo = document.getElementById('flowSessionInfo');
                if (sessionInfo && btn.dataset.flow !== '321') sessionInfo.hidden = true;
                const sessionCopyId = document.getElementById('flowSessionCopyId');
                if (sessionCopyId && btn.dataset.flow !== '321') sessionCopyId.hidden = true;
                if (setActiveFlow) setActiveFlow(btn.dataset.flow);
            });
            let setActiveFlow = null;

            // канвас Flows: пока только полотно — zoom колёсиком/кнопками и pan перетаскиванием фона
            // (centerFlowNode и buildSessionFlow объявлены в начале файла — здесь их не переобъявляем,
            // иначе присваивания ниже уйдут в теневую переменную, а window.MissionFlow её не увидит)
            (() => {
                const canvas = document.getElementById('flowCanvas');
                const surface = document.getElementById('flowSurface');
                const zoomValue = document.getElementById('flowZoomValue');
                const zoomIn = document.getElementById('flowZoomIn');
                const zoomOut = document.getElementById('flowZoomOut');
                const layoutReset = document.getElementById('flowLayoutReset');
                const canvasReset = document.getElementById('flowCanvasReset');

                const MIN_SCALE = 0.3;
                const MAX_SCALE = 2;
                const START_X = 0;
                const START_Y = 0;

                let scale = 1;
                let x = START_X;
                let y = START_Y;

                const GRID_SIZE = 28;

                // каждый пункт меню слева — свой канвас: свой набор нод (nodeFlow)
                // и свой zoom/pan (VIEWS), общий только сам механизм отрисовки
                let currentFlow = initialActiveItem ? initialActiveItem.dataset.flow : 'New';
                const nodeFlow = new Map();

                // положение и зум канваса переживают перезагрузку страницы отдельно
                // для каждого пункта меню — иначе переключение на другой канвас или
                // возврат на вкладку Flow каждый раз кидает в исходную точку вместо
                // того места, где пользователь остановился
                const VIEW_KEY = 'flowCanvasViews';
                function loadViews() {
                    return flowGet(VIEW_KEY, {});
                }
                function saveView() {
                    const views = loadViews();
                    views[currentFlow] = { x, y, scale };
                    flowSet(VIEW_KEY, views);
                }
                (() => {
                    const saved = loadViews()[currentFlow];
                    if (saved) {
                        x = saved.x;
                        y = saved.y;
                        scale = saved.scale;
                    }
                })();

                function apply() {
                    surface.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
                    // фон-сетка на контейнере не привязана к слою узлов — двигаем и
                    // масштабируем её тем же x/y/scale, иначе она разъедется с узлами
                    canvas.style.backgroundPosition = `${x}px ${y}px`;
                    canvas.style.backgroundSize = `${GRID_SIZE * scale}px ${GRID_SIZE * scale}px`;
                    zoomValue.textContent = Math.round(scale * 100) + '%';
                }

                // масштабирование к точке под курсором, чтобы она осталась на месте
                function zoomAt(clientX, clientY, factor) {
                    const rect = canvas.getBoundingClientRect();
                    const px = clientX - rect.left;
                    const py = clientY - rect.top;
                    const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale * factor));
                    x = px - (px - x) * (newScale / scale);
                    y = py - (py - y) * (newScale / scale);
                    scale = newScale;
                    apply();
                    saveView();
                }

                canvas.addEventListener('wheel', (e) => {
                    e.preventDefault();
                    zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.1 : 1 / 1.1);
                }, { passive: false });

                zoomIn.addEventListener('click', () => {
                    const rect = canvas.getBoundingClientRect();
                    zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, 1.2);
                });
                zoomOut.addEventListener('click', () => {
                    const rect = canvas.getBoundingClientRect();
                    zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, 1 / 1.2);
                });
                // раскладка по дереву гарантированно без наложений — на случай,
                // если ноды уже наехали друг на друга (старая сохранённая позиция,
                // накопившийся сдвиг раздвижки и т.п.)
                layoutReset.addEventListener('click', () => autoLayoutAndFit());
                // обнуление канваса: убираем всё, что накидали поверх нод по умолчанию
                // (на New это стартовая пара node/startNode, на остальных канвасах
                // дефолта нет — ensureRootNode сразу поставит пустую ноду-заглушку)
                canvasReset.addEventListener('click', async () => {
                    const ok = await App.confirmModal('Удалить все добавленные ноды на этом канвасе?', { title: 'Очистить канвас' });
                    if (!ok) return;
                    const keep = currentFlow === 'New' ? new Set([node, startNode]) : new Set();
                    for (const n of [...nodeFlow.keys()]) {
                        if (nodeFlow.get(n) === currentFlow && !keep.has(n)) deleteNode(n);
                    }
                    ensureRootNode(currentFlow);
                });
                // drag-n-drop полотна: тянем только за пустой фон, не за ноду
                let panning = false;
                let startX = 0;
                let startY = 0;
                let originX = 0;
                let originY = 0;

                canvas.addEventListener('mousedown', (e) => {
                    if (e.target.closest('.flow-node') || e.target.closest('.flow-canvas__zoom') || e.target.closest('.flow-edge__add') || e.target.closest('#flowEdges')) return;
                    panning = true;
                    startX = e.clientX;
                    startY = e.clientY;
                    originX = x;
                    originY = y;
                    canvas.classList.add('flow-canvas--panning');
                });

                window.addEventListener('mousemove', (e) => {
                    if (!panning) return;
                    x = originX + (e.clientX - startX);
                    y = originY + (e.clientY - startY);
                    apply();
                });

                window.addEventListener('mouseup', () => {
                    if (panning) saveView();
                    panning = false;
                    canvas.classList.remove('flow-canvas--panning');
                });

                apply();

                // нода стартует по центру видимой area канваса. #flowCanvas в этот
                // момент ещё скрыт (view с display:none), его clientWidth/Height
                // нулевые — поэтому центрируем один раз при первом реальном показе
                // вкладки, когда размеры уже посчитаны layout'ом браузера
                const node = document.getElementById('flowNodeSecretary');
                const startNode = document.getElementById('flowNodeStart');
                const NODE_GAP = 96;
                // вертикальный зазор меньше горизонтального — цепочка шагов вниз
                // (см. buildSessionFlow) не должна растягиваться так же далеко,
                // как соседи по строке
                const NODE_GAP_Y = 40;
                nodeFlow.set(node, 'New');
                nodeFlow.set(startNode, 'New');

                // текст заголовка, строки под ним и тела ноды переживает перезагрузку
                // через localStorage, как и позиции; #flowNodeStartMeta не трогаем —
                // там дата/проект, подставляемые заново при каждой загрузке
                const TEXT_KEY = 'flowNodeText';
                const EDITABLE_SELECTOR = '.flow-node__title, .flow-node__subtitle, .flow-node__body';
                function loadTexts() {
                    return flowGet(TEXT_KEY, {});
                }
                function fieldName(el) {
                    if (el.classList.contains('flow-node__title')) return 'title';
                    if (el.classList.contains('flow-node__subtitle')) return 'subtitle';
                    return 'body';
                }
                function applyTexts(n) {
                    const saved = loadTexts();
                    for (const el of n.querySelectorAll(EDITABLE_SELECTOR)) {
                        if (el.id) continue;
                        const text = saved[`${n.id}:${fieldName(el)}`];
                        if (text !== undefined) el.textContent = text;
                    }
                }
                applyTexts(node);
                applyTexts(startNode);

                // вопросы под телом ноды — переменное число полей (кнопка + добавляет
                // ещё), поэтому хранятся отдельно от заголовка/тела/тела: там всегда
                // ровно одно значение на поле, а тут список произвольной длины
                const QUESTIONS_KEY = 'flowNodeQuestions';
                function loadQuestions() {
                    return flowGet(QUESTIONS_KEY, {});
                }
                function saveQuestionsFor(n) {
                    const all = loadQuestions();
                    all[n.id] = [...n.querySelectorAll('.flow-node__question-text')].map((q) => q.textContent);
                    flowSet(QUESTIONS_KEY, all);
                }
                function addQuestionField(group, text) {
                    const btn = group.querySelector('.flow-node__questions-add');
                    const field = document.createElement('div');
                    field.className = 'flow-node__question';
                    field.innerHTML = '<span class="flow-node__question-handle" aria-hidden="true">⠿</span><span class="flow-node__question-text" data-placeholder="Вопрос"></span>';
                    const textEl = field.querySelector('.flow-node__question-text');
                    textEl.contentEditable = 'false';
                    textEl.textContent = text || '';
                    group.insertBefore(field, btn);
                    return field;
                }
                // поле растянуто на всю ширину ноды (см. CSS), но текста в нём обычно
                // меньше — считаем прямоугольник именно текста, чтобы клик по пустому
                // месту справа от текста не включал редактирование
                function questionTextRect(field) {
                    const textEl = field.querySelector('.flow-node__question-text');
                    if (!textEl.textContent) return textEl.getBoundingClientRect();
                    const range = document.createRange();
                    range.selectNodeContents(textEl);
                    return range.getBoundingClientRect();
                }
                function applyQuestions(n) {
                    const saved = loadQuestions()[n.id];
                    if (!saved) return;
                    const group = n.querySelector('.flow-node__questions');
                    const fields = [...group.querySelectorAll('.flow-node__question')];
                    saved.forEach((text, i) => {
                        if (fields[i]) fields[i].querySelector('.flow-node__question-text').textContent = text;
                        else addQuestionField(group, text);
                    });
                }
                applyQuestions(node);
                applyQuestions(startNode);

                surface.addEventListener('input', (e) => {
                    const field = e.target.closest('.flow-node__question');
                    if (!field) return;
                    saveQuestionsFor(field.closest('.flow-node'));
                });
                surface.addEventListener('click', (e) => {
                    const addBtn = e.target.closest('.flow-node__questions-add');
                    if (!addBtn) return;
                    const group = addBtn.closest('.flow-node__questions');
                    const field = addQuestionField(group);
                    const textEl = field.querySelector('.flow-node__question-text');
                    textEl.contentEditable = 'true';
                    textEl.focus();
                    saveQuestionsFor(group.closest('.flow-node'));
                });
                surface.addEventListener('click', (e) => {
                    const field = e.target.closest('.flow-node__question');
                    if (!field) return;
                    const textEl = field.querySelector('.flow-node__question-text');
                    if (textEl.isContentEditable) return;
                    const rect = questionTextRect(field);
                    if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) return;
                    textEl.contentEditable = 'true';
                    textEl.focus();
                });
                surface.addEventListener('focusout', (e) => {
                    const field = e.target.closest('.flow-node__question');
                    if (!field) return;
                    field.querySelector('.flow-node__question-text').contentEditable = 'false';
                });

                // перетаскивание вопросов за ручку слева — тот же приём, что и у кнопок
                // тулбара (см. toolbar-reorder.js): долгое нажатие (>2с) включает "тряску",
                // в которой вопрос можно перетащить на новое место; выход — Esc
                const Q_LONG_PRESS_MS = 2000;
                const Q_MOVE_CANCEL_PX = 8;
                const Q_HANDLE_WIDTH = 26;
                let qPressTimer = null;
                let qPressStart = null;
                let qActiveGroup = null;
                let qDragField = null;

                function isQuestionHandle(e, field) {
                    const rect = field.getBoundingClientRect();
                    return e.clientX - rect.left < Q_HANDLE_WIDTH;
                }
                function clearQPress() {
                    clearTimeout(qPressTimer);
                    qPressTimer = null;
                    qPressStart = null;
                }
                function enterQuestionReorder(group) {
                    qActiveGroup = group;
                    group.classList.add('flow-node__questions--reorder');
                }
                function exitQuestionReorder() {
                    if (!qActiveGroup) return;
                    saveQuestionsFor(qActiveGroup.closest('.flow-node'));
                    qActiveGroup.classList.remove('flow-node__questions--reorder');
                    qActiveGroup = null;
                }
                function startQuestionDrag(field) {
                    qDragField = field;
                    field.classList.add('flow-node__question--dragging');
                }
                function stopQuestionDrag() {
                    if (!qDragField) return;
                    qDragField.classList.remove('flow-node__question--dragging');
                    qDragField = null;
                }
                function updateQuestionDrag(clientY) {
                    if (!qDragField || !qActiveGroup) return;
                    for (const sib of qActiveGroup.querySelectorAll('.flow-node__question')) {
                        if (sib === qDragField) continue;
                        const rect = sib.getBoundingClientRect();
                        if (clientY < rect.top + rect.height / 2) {
                            if (sib.previousElementSibling !== qDragField) qActiveGroup.insertBefore(qDragField, sib);
                            return;
                        }
                    }
                    const addBtn = qActiveGroup.querySelector('.flow-node__questions-add');
                    if (addBtn.previousElementSibling !== qDragField) qActiveGroup.insertBefore(qDragField, addBtn);
                }

                surface.addEventListener('pointerdown', (e) => {
                    const field = e.target.closest('.flow-node__question');
                    if (!field || !isQuestionHandle(e, field)) return;
                    const group = field.closest('.flow-node__questions');

                    if (qActiveGroup === group) {
                        e.preventDefault();
                        startQuestionDrag(field);
                        return;
                    }
                    if (qActiveGroup) return;

                    qPressStart = { x: e.clientX, y: e.clientY };
                    qPressTimer = setTimeout(() => {
                        qPressTimer = null;
                        enterQuestionReorder(group);
                        startQuestionDrag(field);
                    }, Q_LONG_PRESS_MS);
                });
                surface.addEventListener('pointermove', (e) => {
                    if (qPressTimer && qPressStart) {
                        if (Math.hypot(e.clientX - qPressStart.x, e.clientY - qPressStart.y) > Q_MOVE_CANCEL_PX) clearQPress();
                        return;
                    }
                    if (qDragField) {
                        e.preventDefault();
                        updateQuestionDrag(e.clientY);
                    }
                });
                surface.addEventListener('pointerup', () => {
                    clearQPress();
                    stopQuestionDrag();
                });
                window.addEventListener('keydown', (e) => {
                    if (e.key !== 'Escape' || !qActiveGroup) return;
                    stopQuestionDrag();
                    exitQuestionReorder();
                });

                // клик по заголовку, строке под ним или телу ноды превращает поле в
                // резиновое (растущее вместе с текстом) редактируемое; клик мимо — сохраняет
                surface.addEventListener('click', (e) => {
                    const field = e.target.closest(EDITABLE_SELECTOR);
                    if (!field || field.isContentEditable || field.id) return;
                    field.contentEditable = 'true';
                    field.focus();
                    // без этого курсор при входе в редактирование всегда прыгает
                    // в начало текста, а не встаёт туда, где кликнул пользователь
                    const range = document.caretRangeFromPoint
                        ? document.caretRangeFromPoint(e.clientX, e.clientY)
                        : document.caretPositionFromPoint
                            ? (() => {
                                const pos = document.caretPositionFromPoint(e.clientX, e.clientY);
                                const r = document.createRange();
                                r.setStart(pos.offsetNode, pos.offset);
                                return r;
                            })()
                            : null;
                    if (range) {
                        const sel = window.getSelection();
                        sel.removeAllRanges();
                        sel.addRange(range);
                    }
                });
                surface.addEventListener('focusout', (e) => {
                    const field = e.target.closest(EDITABLE_SELECTOR);
                    if (!field || field.id) return;
                    field.contentEditable = 'false';
                    const n = field.closest('.flow-node');
                    const all = loadTexts();
                    all[`${n.id}:${fieldName(field)}`] = field.textContent;
                    flowSet(TEXT_KEY, all);
                });

                // позиции нод переживают перезагрузку страницы через localStorage
                // v2: старые сохранённые позиции ставили новые ноды впритык к соседям —
                // сбрасываем кеш, чтобы раздвижка при вставке отработала на чистом layout'е
                const POS_KEY = 'flowNodePositions2';
                function loadPositions() {
                    return flowGet(POS_KEY, {});
                }
                function savePosition(el) {
                    const all = loadPositions();
                    all[el.id] = { left: el.offsetLeft, top: el.offsetTop };
                    flowSet(POS_KEY, all);
                }

                // граф вставленных узлов (id-рёбра + счётчик id) переживает перезагрузку
                // отдельно от позиций — иначе после reload вставленная нода и её рёбра
                // просто пропадают, хотя left/top для неё уже сохранены
                // v2: старые графы сохранялись без direction — при восстановлении ребро
                // получало undefined и createEdge молча превращал его в 'horizontal',
                // из-за чего кнопка reset схлопывала любое дерево в одну строку
                // v3: у каждой ноды теперь есть свой канвас (flow) — храним его
                // вместе с рёбрами, иначе после reload все ноды всех канвасов
                // окажутся смешаны в одном
                const GRAPH_KEY = 'flowNodeGraph3';
                function loadGraph() {
                    return flowGet(GRAPH_KEY, null);
                }
                function saveGraph() {
                    flowSet(GRAPH_KEY, {
                        nodeSeq,
                        nodes: [...nodeFlow.entries()]
                            .filter(([n]) => n !== startNode && n !== node)
                            .map(([n, flow]) => ({ id: n.id, flow })),
                        edges: edges.map((e) => ({ from: e.from.id, to: e.to.id, direction: e.direction })),
                    });
                }

                // восстанавливаем клоны шаблона по id из графа и перестраиваем рёбра;
                // вызывается один раз при первом показе вкладки, до отрисовки рёбер
                function restoreGraph() {
                    const graph = loadGraph();
                    if (!graph || !graph.edges || !graph.edges.length) return;

                    const positions = loadPositions();
                    const flowById = {};
                    for (const n of graph.nodes || []) flowById[n.id] = n.flow;

                    const byId = { [startNode.id]: startNode, [node.id]: node };
                    for (const e of graph.edges) {
                        for (const id of [e.from, e.to]) {
                            if (byId[id]) continue;
                            const clone = nodeTemplate.content.firstElementChild.cloneNode(true);
                            clone.id = id;
                            surface.append(clone);
                            attachAddBottom(clone);
                            attachAddRight(clone);
                            populateNodeAgentSelects(clone);
                            if (positions[id]) {
                                clone.style.left = positions[id].left + 'px';
                                clone.style.top = positions[id].top + 'px';
                            }
                            nodeFlow.set(clone, flowById[id] || 'New');
                            applyTexts(clone);
                            applyQuestions(clone);
                            byId[id] = clone;
                        }
                    }
                    nodeSeq = Math.max(nodeSeq, graph.nodeSeq || 0);

                    for (const e of [...edges]) removeEdge(e);
                    for (const e of graph.edges) {
                        if (byId[e.from] && byId[e.to]) createEdge(byId[e.from], byId[e.to], null, e.direction);
                    }

                    // позиции сохранены под старую высоту нод — если разметка ноды
                    // с тех пор выросла (например, добавили новое поле в шаблон),
                    // расстояние между соседями по сохранённым top/top съезжает и
                    // они наезжают друг на друга; пересчёт по факту занимаемого места
                    // возвращает исходный зазор NODE_GAP
                    layoutAllNodes();
                }

                centerFlowNode = () => {
                    const saved = loadPositions();
                    if (saved[node.id] && saved[startNode.id]) {
                        node.style.left = saved[node.id].left + 'px';
                        node.style.top = saved[node.id].top + 'px';
                        startNode.style.left = saved[startNode.id].left + 'px';
                        startNode.style.top = saved[startNode.id].top + 'px';
                    } else {
                        node.style.left = Math.round((canvas.clientWidth - node.offsetWidth) / 2) + 'px';
                        node.style.top = Math.round((canvas.clientHeight - node.offsetHeight) / 2) + 'px';
                        startNode.style.left = Math.round(node.offsetLeft - NODE_GAP - startNode.offsetWidth) + 'px';
                        startNode.style.top = Math.round(node.offsetTop + (node.offsetHeight - startNode.offsetHeight) / 2) + 'px';
                        savePosition(node);
                        savePosition(startNode);
                    }
                    restoreGraph();
                    applyFlowVisibility(currentFlow);
                    drawEdge();
                };

                // рёбра между нодами хранятся списком, чтобы ребро можно было
                // разрезать надвое вставкой узла посередине
                const edgesLayer = document.getElementById('flowEdges');
                const nodeTemplate = document.getElementById('flowNodeTemplate');
                let nodeSeq = 0;
                const edges = [];

                // провайдер/модель/effort у обычных узлов — тот же набор, что и у
                // Секретаря, но без сохранения в localStorage: как type/context/scope
                // выше, это визуальная заглушка, не переживающая перезагрузку
                function renderNodeModelEffort(n) {
                    const providerSelect = n.querySelector('.flow-node__provider');
                    const modelSelect = n.querySelector('.flow-node__model');
                    const effortSelect = n.querySelector('.flow-node__effort');
                    if (!providerSelect) return;
                    const provider = App.PROVIDERS.find((p) => p.id === providerSelect.value) || App.PROVIDERS[0];

                    modelSelect.innerHTML = '';
                    for (const model of provider.models) {
                        const option = document.createElement('option');
                        option.value = model;
                        option.textContent = model;
                        option.selected = model === provider.defaultModel;
                        modelSelect.append(option);
                    }

                    effortSelect.innerHTML = '';
                    effortSelect.hidden = !provider.efforts;
                    if (provider.efforts) {
                        for (const effort of provider.efforts) {
                            const option = document.createElement('option');
                            option.value = effort;
                            option.textContent = effort;
                            option.selected = effort === provider.defaultEffort;
                            effortSelect.append(option);
                        }
                    }
                }

                function populateNodeAgentSelects(n) {
                    const providerSelect = n.querySelector('.flow-node__provider');
                    if (!providerSelect) return;
                    for (const provider of App.PROVIDERS) {
                        const option = document.createElement('option');
                        option.value = provider.id;
                        option.textContent = provider.name;
                        providerSelect.append(option);
                    }
                    renderNodeModelEffort(n);
                }

                surface.addEventListener('change', (e) => {
                    if (!e.target.matches('.flow-node__provider')) return;
                    renderNodeModelEffort(e.target.closest('.flow-node'));
                });

                // геометрия дуги: сторона крепления фиксирована типом плюса, которым
                // ребро создано (горизонтальный — право/лево по центру высоты,
                // вертикальный — низ/верх по центру ширины), а не углом между
                // центрами нод — иначе при перетаскивании ноды крепление съезжало
                // бы на другую сторону вместо того, чтобы оставаться на своём входе/выходе
                function edgeGeometry(from, to, direction) {
                    const fromCX = from.offsetLeft + from.offsetWidth / 2;
                    const fromCY = from.offsetTop + from.offsetHeight / 2;
                    const toCX = to.offsetLeft + to.offsetWidth / 2;
                    const toCY = to.offsetTop + to.offsetHeight / 2;

                    let start, end, ux, uy;
                    if (direction === 'vertical') {
                        start = { x: fromCX, y: from.offsetTop + from.offsetHeight };
                        end = { x: toCX, y: to.offsetTop };
                        ux = 0; uy = 1;
                    } else {
                        start = { x: from.offsetLeft + from.offsetWidth, y: fromCY };
                        end = { x: to.offsetLeft, y: toCY };
                        ux = 1; uy = 0;
                    }

                    // изгиб считаем от зазора вдоль основной оси (dy для вертикали, dx для
                    // горизонтали), а не от полной диагонали до цели: раньше при дальнем
                    // соседе по боковой оси (несколько детей в разных колонках) диагональ
                    // была большой, изгиб упирался в потолок 80px с обеих сторон, суммарно
                    // получалось больше самого зазора между рядами — кривая начинала уходить
                    // вбок ещё внутри полосы соседних нод и залезала на них
                    const primary = direction === 'vertical' ? Math.abs(end.y - start.y) : Math.abs(end.x - start.x);
                    const bend = Math.min(primary * 0.4, 80);
                    return {
                        fromX: start.x, fromY: start.y,
                        toX: end.x, toY: end.y,
                        c1x: start.x + ux * bend, c1y: start.y + uy * bend,
                        c2x: end.x - ux * bend, c2y: end.y - uy * bend,
                    };
                }

                // точка на кубической кривой Безье при t=0.5 — туда ставим плюс
                function edgeMidpoint(g) {
                    const t = 0.5, mt = 0.5;
                    const x = mt ** 3 * g.fromX + 3 * mt * mt * t * g.c1x + 3 * mt * t * t * g.c2x + t ** 3 * g.toX;
                    const y = mt ** 3 * g.fromY + 3 * mt * mt * t * g.c1y + 3 * mt * t * t * g.c2y + t ** 3 * g.toY;
                    return { x, y };
                }

                function createEdge(from, to, existingPath, direction) {
                    const path = existingPath || document.createElementNS('http://www.w3.org/2000/svg', 'path');
                    if (!existingPath) {
                        path.setAttribute('fill', 'none');
                        path.setAttribute('stroke', '#6ea8fe');
                        path.setAttribute('stroke-width', '2');
                        path.setAttribute('marker-end', 'url(#flowArrowHead)');
                        path.style.pointerEvents = 'stroke';
                        edgesLayer.append(path);
                    }

                    const addBtn = document.createElement('button');
                    addBtn.type = 'button';
                    addBtn.className = 'flow-edge__add';
                    addBtn.textContent = '+';
                    addBtn.title = 'Вставить узел';
                    surface.append(addBtn);

                    const edge = { from, to, path, addBtn, direction: direction || 'horizontal' };

                    addBtn.addEventListener('click', () => insertNodeOnEdge(edge));

                    edges.push(edge);
                    return edge;
                }

                function removeEdge(edge) {
                    edges.splice(edges.indexOf(edge), 1);
                    edge.path.remove();
                    edge.addBtn.remove();
                }

                // разрезаем ребро надвое: клон шаблона встаёт в середину дуги,
                // старое ребро уступает место двум новым; точная позиция всё равно
                // тут же пересчитывается layoutAllNodes(), стартовая нужна только
                // чтобы edgeGeometry/nodeFlow увидели ноду на канвасе
                function insertNodeOnEdge(edge) {
                    const g = edgeGeometry(edge.from, edge.to, edge.direction);
                    const mid = edgeMidpoint(g);
                    const from = edge.from, to = edge.to;

                    const newNode = nodeTemplate.content.firstElementChild.cloneNode(true);
                    newNode.id = 'flowNode_' + (++nodeSeq) + '_' + Date.now();
                    surface.append(newNode);
                    attachAddBottom(newNode);
                    attachAddRight(newNode);
                    populateNodeAgentSelects(newNode);
                    nodeFlow.set(newNode, nodeFlow.get(from));
                    newNode.style.left = Math.round(mid.x - newNode.offsetWidth / 2) + 'px';
                    newNode.style.top = Math.round(mid.y - newNode.offsetHeight / 2) + 'px';
                    savePosition(newNode);

                    removeEdge(edge);
                    createEdge(from, newNode, null, edge.direction);
                    createEdge(newNode, to, null, edge.direction);
                    layoutAllNodes();
                    saveGraph();
                    drawEdge();
                }

                // точка крепления ребра на ноде — низ по центру для вертикали,
                // право по центру высоты для горизонтали; используется и при отрисовке
                // готового ребра (edgeGeometry), и здесь для тянущейся от плюса стрелки
                function anchorPoint(n, direction) {
                    return direction === 'vertical'
                        ? { x: n.offsetLeft + n.offsetWidth / 2, y: n.offsetTop + n.offsetHeight }
                        : { x: n.offsetLeft + n.offsetWidth, y: n.offsetTop + n.offsetHeight / 2 };
                }

                // клиентские координаты курсора -> локальные координаты surface
                // (те же, в которых живут left/top нод), с поправкой на pan/zoom канваса
                function surfacePoint(clientX, clientY) {
                    const rect = canvas.getBoundingClientRect();
                    return { x: (clientX - rect.left - x) / scale, y: (clientY - rect.top - y) / scale };
                }

                // перетаскивание плюса до другой ноды соединяет их существующим ребром;
                // короткий клик без сдвига (moved остаётся false) — старое поведение,
                // создать новый дочерний узел
                let connecting = null;

                function startConnecting(e, source, direction) {
                    e.stopPropagation();
                    e.preventDefault();
                    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                    path.setAttribute('fill', 'none');
                    path.setAttribute('stroke', '#6ea8fe');
                    path.setAttribute('stroke-width', '2');
                    path.setAttribute('stroke-dasharray', '5 4');
                    path.setAttribute('marker-end', 'url(#flowArrowHead)');
                    path.style.pointerEvents = 'none';
                    edgesLayer.append(path);
                    connecting = { source, direction, path, moved: false, startX: e.clientX, startY: e.clientY, target: null };
                }

                window.addEventListener('mousemove', (e) => {
                    if (!connecting) return;
                    if (Math.abs(e.clientX - connecting.startX) > 4 || Math.abs(e.clientY - connecting.startY) > 4) {
                        connecting.moved = true;
                    }
                    const anchor = anchorPoint(connecting.source, connecting.direction);
                    const pt = surfacePoint(e.clientX, e.clientY);
                    const ux = connecting.direction === 'vertical' ? 0 : 1;
                    const uy = connecting.direction === 'vertical' ? 1 : 0;
                    const bend = 40;
                    connecting.path.setAttribute('d',
                        `M${anchor.x},${anchor.y} C${anchor.x + ux * bend},${anchor.y + uy * bend} ${pt.x - ux * bend},${pt.y - uy * bend} ${pt.x},${pt.y}`);

                    const hovered = document.elementFromPoint(e.clientX, e.clientY)?.closest('.flow-node');
                    const target = hovered && hovered !== connecting.source ? hovered : null;
                    if (connecting.target !== target) {
                        if (connecting.target) connecting.target.classList.remove('flow-node--drop-target');
                        if (target) target.classList.add('flow-node--drop-target');
                        connecting.target = target;
                    }
                });

                window.addEventListener('mouseup', () => {
                    if (!connecting) return;
                    const { source, direction, moved, target, path } = connecting;
                    if (target) target.classList.remove('flow-node--drop-target');
                    path.remove();
                    connecting = null;

                    if (!moved) {
                        if (direction === 'vertical') addChildNode(source);
                        else addChildNodeRight(source);
                        return;
                    }
                    if (!target || edges.some((ed) => ed.from === source && ed.to === target)) return;
                    createEdge(source, target, null, direction);
                    saveGraph();
                    drawEdge();
                });

                // плюс у нижнего края ноды — добавляет новый узел-заглушку строго
                // под текущим и соединяет их ребром; вешаем на каждую ноду отдельно,
                // чтобы кнопка ездила вместе с нодой без пересчёта позиции в drawEdge
                function attachAddBottom(n) {
                    n.querySelector('.flow-node__add-bottom').addEventListener('mousedown', (e) => startConnecting(e, n, 'vertical'));
                }

                // добавляет дочерний узел снизу; точную сетку тут же расставляет
                // layoutAllNodes() по всему канвасу — так чинятся и все накопившиеся
                // наложения, а не только ветка вокруг `from`
                function addChildNode(from) {
                    const newNode = nodeTemplate.content.firstElementChild.cloneNode(true);
                    newNode.id = 'flowNode_' + (++nodeSeq) + '_' + Date.now();
                    surface.append(newNode);
                    attachAddBottom(newNode);
                    attachAddRight(newNode);
                    populateNodeAgentSelects(newNode);
                    nodeFlow.set(newNode, nodeFlow.get(from));
                    newNode.style.left = Math.round(from.offsetLeft + (from.offsetWidth - newNode.offsetWidth) / 2) + 'px';
                    newNode.style.top = Math.round(from.offsetTop + from.offsetHeight + NODE_GAP_Y) + 'px';
                    savePosition(newNode);
                    createEdge(from, newNode, null, 'vertical');
                    layoutAllNodes();
                    saveGraph();
                    drawEdge();
                    return newNode;
                }

                // плюс у правого края ноды — добавляет новый узел-заглушку справа
                // от текущего, по той же логике, что и attachAddBottom/addChildNode
                function attachAddRight(n) {
                    n.querySelector('.flow-node__add-right').addEventListener('mousedown', (e) => startConnecting(e, n, 'horizontal'));
                }

                // добавляет дочерний узел справа — симметрично addChildNode
                function addChildNodeRight(from) {
                    const newNode = nodeTemplate.content.firstElementChild.cloneNode(true);
                    newNode.id = 'flowNode_' + (++nodeSeq) + '_' + Date.now();
                    surface.append(newNode);
                    attachAddBottom(newNode);
                    attachAddRight(newNode);
                    populateNodeAgentSelects(newNode);
                    nodeFlow.set(newNode, nodeFlow.get(from));
                    newNode.style.left = Math.round(from.offsetLeft + from.offsetWidth + NODE_GAP) + 'px';
                    newNode.style.top = Math.round(from.offsetTop + (from.offsetHeight - newNode.offsetHeight) / 2) + 'px';
                    savePosition(newNode);
                    createEdge(from, newNode, null, 'horizontal');
                    layoutAllNodes();
                    saveGraph();
                    drawEdge();
                    return newNode;
                }

                function drawEdge() {
                    for (const edge of edges) {
                        const g = edgeGeometry(edge.from, edge.to, edge.direction);
                        edge.path.setAttribute('d', `M${g.fromX},${g.fromY} C${g.c1x},${g.c1y} ${g.c2x},${g.c2y} ${g.toX},${g.toY}`);
                        const mid = edgeMidpoint(g);
                        edge.addBtn.style.left = mid.x + 'px';
                        edge.addBtn.style.top = mid.y + 'px';
                    }
                }

                // раскладка по дереву всех нод текущего канваса разом — вызывается
                // после каждого добавления/вставки узла, поэтому чинит не только
                // только что тронутую ветку, а вообще все накопившиеся наложения.
                // У каждой ноды не больше одного входящего ребра (редактор всегда
                // создаёт новый узел вместе с единственным ребром к нему), поэтому
                // весь граф — дерево, и вместо того чтобы гадать координаты клетка
                // за клеткой (так рёбра соседних веток задевали друг друга),
                // раскладываем по нему честно снизу вверх: горизонтальное ребро
                // продолжает цепочку вправо в той же строке, вертикальное — открывает
                // дочернюю цепочку строкой ниже, и каждое поддерево получает свой
                // непересекающийся диапазон колонок — поэтому ветки никогда не
                // наезжают друг на друга и рёбра не пересекаются
                function layoutAllNodes() {
                    const nodes = [...surface.querySelectorAll('.flow-node')].filter((n) => nodeFlow.get(n) === currentFlow);
                    if (!nodes.length) return;

                    const cellW = Math.max(...nodes.map((n) => n.offsetWidth)) + NODE_GAP;

                    const parentEdge = new Map();
                    for (const e of edges) if (!parentEdge.has(e.to)) parentEdge.set(e.to, e);

                    // горизонтальная цепочка — нода и её последовательные "правые"
                    // продолжения; вся цепочка держится в одной строке
                    // узел может обзавестись больше чем одним исходящим горизонтальным
                    // ребром (кнопка "+" справа кликабельна повторно, drag-connect тоже
                    // не проверяет дубликаты) — тогда идти вверх по parentEdge можно только
                    // до тех пор, пока предок ещё не разобран в чужую цепочку, иначе "лишний"
                    // сосед остаётся без записи в chainOf и measure() падает на chain.length
                    // рёбра, реально ушедшие в продолжение цепочки вправо — остальные
                    // горизонтальные соседи того же узла (второй, третий "+" клик
                    // справа) в цепочку не помещаются и ниже отдаются chainRightExtras,
                    // которая кладёт их в ту же строку, следом за цепочкой, иначе такой
                    // узел проваливался на строку ниже — под соседей, а не рядом с ними
                    const usedChainEdge = new Set();
                    const chainOf = new Map();
                    for (const n of nodes) {
                        if (chainOf.has(n)) continue;
                        let head = n;
                        let pe = parentEdge.get(head);
                        while (pe && pe.direction === 'horizontal' && !chainOf.has(pe.from)) {
                            head = pe.from;
                            pe = parentEdge.get(head);
                        }
                        const chain = [head];
                        let cur = head;
                        for (;;) {
                            // соседей может быть больше одного (дубль-ребро от повторного
                            // клика/drag-connect) — из них следующий в цепочке всегда тот,
                            // что реально стоит правее на канвасе, а не тот, что раньше создан
                            const candidates = edges.filter((e) => e.from === cur && e.direction === 'horizontal');
                            if (!candidates.length) break;
                            const next = candidates.reduce((a, b) => (a.to.offsetLeft <= b.to.offsetLeft ? a : b));
                            usedChainEdge.add(next);
                            chain.push(next.to);
                            cur = next.to;
                        }
                        for (const c of chain) chainOf.set(c, chain);
                    }

                    // дочерние цепочки — только вертикальные рёбра от любой ноды этой
                    // цепочки; группируем по узлу-креплению (anchor), чтобы несколько
                    // прямых детей одного узла лечь вместе, а не вперемешку с детьми
                    // других узлов. Горизонтальные рёбра сюда не попадают — линия,
                    // выходящая вбок, обязана вести к соседу по той же строке
                    // (см. chainRightExtras), а не проваливаться на строку ниже.
                    // порядок детей внутри группы — по их текущему offsetLeft, а не по
                    // порядку создания рёбер: иначе перетаскивание ребёнка налево-направо
                    // не меняло раскладку, и кнопка ⤾ откатывала его обратно на старое место
                    function chainChildGroups(chain) {
                        const own = new Set(chain);
                        const byAnchor = new Map();
                        for (const e of edges) {
                            if (!own.has(e.from) || e.direction === 'horizontal') continue;
                            if (!byAnchor.has(e.from)) byAnchor.set(e.from, { anchor: e.from, items: [] });
                            byAnchor.get(e.from).items.push(chainOf.get(e.to));
                        }
                        for (const g of byAnchor.values()) {
                            g.items.sort((a, b) => a[0].offsetLeft - b[0].offsetLeft);
                        }
                        return [...byAnchor.values()].sort((a, b) => chain.indexOf(a.anchor) - chain.indexOf(b.anchor));
                    }

                    // "лишние" горизонтальные рёбра узла (второй, третий "+" клик справа
                    // помимо основного продолжения цепочки) — ведут вправо, в ту же
                    // строку, следом за самой цепочкой, а не вниз к следующему ряду
                    function chainRightExtras(chain) {
                        const own = new Set(chain);
                        const extras = [];
                        for (const e of edges) {
                            if (!own.has(e.from) || e.direction !== 'horizontal' || usedChainEdge.has(e)) continue;
                            extras.push(chainOf.get(e.to));
                        }
                        return extras.sort((a, b) => a[0].offsetLeft - b[0].offsetLeft);
                    }

                    // два прохода, как в классической раскладке дерева: сперва снизу
                    // вверх считаем ширину каждого поддерева в колонках (measure), затем
                    // сверху вниз раздаём абсолютные колонки (place). Внутри цепочки
                    // членов раньше просто нумеровали подряд (0,1,2…) — но если у
                    // раннего члена широкое поддерево детей, оно выпирает вправо дальше
                    // соседа по цепочке, и соседа со всей его веткой утаскивало далеко
                    // от родителя. Поэтому колонка каждого члена цепочки теперь считается
                    // из центра его СОБСТВЕННОЙ группы детей (если она есть), а не из
                    // индекса в цепочке — obе функции гоняют один и тот же проход:
                    // measure в относительных координатах (чтобы посчитать ширину),
                    // place — в абсолютных (чтобы расставить)
                    function layoutChainRow(chain, byIdx, minCol) {
                        const memberCol = [];
                        let cursor = minCol;
                        let prevCol = minCol - 1;
                        for (let idx = 0; idx < chain.length; idx++) {
                            const g = byIdx.get(idx);
                            if (g) {
                                const start = Math.max(cursor, prevCol + 1);
                                g.start = start;
                                cursor = start + g.width;
                                // центр держим дробным (не округляем) — иначе на чётной ширине
                                // группы Math.round всегда съезжал к правому ребёнку, и колонка
                                // родителя переставала совпадать с занятыми им колонками: цепочка
                                // после родителя резервировала на одну колонку меньше, чем он
                                // реально накрывал, и следующий брат наезжал на его же детей
                                memberCol[idx] = start + (g.width - 1) / 2;
                                prevCol = start + g.width - 1;
                            } else {
                                prevCol += 1;
                                cursor = Math.max(cursor, prevCol + 1);
                                memberCol[idx] = prevCol;
                            }
                        }
                        return { memberCol, cursor, prevCol };
                    }

                    const widthOf = new Map();
                    const groupsOf = new Map();
                    const extrasOf = new Map();
                    function measure(chain) {
                        if (widthOf.has(chain)) return widthOf.get(chain);
                        const groups = chainChildGroups(chain);
                        const byIdx = new Map(groups.map((g) => [chain.indexOf(g.anchor), g]));
                        for (const g of groups) g.width = g.items.reduce((sum, c) => sum + measure(c), 0);
                        const { cursor, prevCol } = layoutChainRow(chain, byIdx, 0);
                        const baseWidth = Math.max(chain.length, cursor, prevCol + 1);
                        const rightExtras = chainRightExtras(chain);
                        const extraWidth = rightExtras.reduce((sum, c) => sum + measure(c), 0);
                        widthOf.set(chain, baseWidth + extraWidth);
                        groupsOf.set(chain, byIdx);
                        extrasOf.set(chain, { list: rightExtras, baseWidth });
                        return baseWidth + extraWidth;
                    }

                    const colStart = new Map();
                    const rowOf = new Map();
                    const memberColOf = new Map();
                    const seenChains = new Set();
                    let maxRowSeen = -1;
                    function place(chain, minCol, chainRow) {
                        colStart.set(chain, minCol);
                        rowOf.set(chain, chainRow);
                        seenChains.add(chain);
                        maxRowSeen = Math.max(maxRowSeen, chainRow);
                        const byIdx = groupsOf.get(chain);
                        const { memberCol } = layoutChainRow(chain, byIdx, minCol);
                        memberColOf.set(chain, memberCol);
                        for (const [idx, g] of byIdx) {
                            let col = g.start;
                            for (const childChain of g.items) {
                                place(childChain, col, chainRow + 1);
                                col += widthOf.get(childChain);
                            }
                        }
                        // лишние горизонтальные ветки — сразу следом за цепочкой, в той
                        // же строке, а не ниже: строго родитель-справа, а не родитель-сверху
                        const { list: rightExtras, baseWidth } = extrasOf.get(chain);
                        let rightCol = minCol + baseWidth;
                        for (const extraChain of rightExtras) {
                            place(extraChain, rightCol, chainRow);
                            rightCol += widthOf.get(extraChain);
                        }
                    }

                    // startNode принадлежит только канвасу New — на остальных
                    // канвасах его цепочки нет вовсе, все ноды раскладываются
                    // ниже как отдельные деревья
                    const startChain = chainOf.get(startNode);
                    if (startChain) {
                        measure(startChain);
                        place(startChain, 0, 0);
                    }
                    // ноды без пути от startNode — отдельными деревьями строками ниже
                    for (const n of nodes) {
                        const chain = chainOf.get(n);
                        if (seenChains.has(chain)) continue;
                        measure(chain);
                        place(chain, 0, maxRowSeen + 1);
                    }

                    // высота строки — по самой высокой ноде именно в этой строке, а не
                    // во всём канвасе: иначе одна высокая нода где-нибудь в дереве
                    // раздвигала зазор между вообще всеми соседними строками, включая
                    // пары коротких нод, у которых с ней нет ничего общего
                    let rowY = 0;
                    const rowTop = [];
                    const rowHeight = [];
                    for (let row = 0; row <= maxRowSeen; row++) {
                        const h = Math.max(0, ...nodes.filter((n) => rowOf.get(chainOf.get(n)) === row).map((n) => n.offsetHeight));
                        rowTop[row] = rowY;
                        rowHeight[row] = h;
                        rowY += h + NODE_GAP_Y;
                    }

                    // left/top ставим по центру клетки, а не по краю: ноды разной
                    // ширины/высоты (например Secretary) иначе выравнивались по краю
                    // клетки, и центр съезжал — единственный ребёнок шёл не строго вниз,
                    // а стрелка в цепочке — не строго вправо
                    for (const n of nodes) {
                        const chain = chainOf.get(n);
                        const col = memberColOf.get(chain)[chain.indexOf(n)];
                        const row = rowOf.get(chain);
                        const colCenterX = col * cellW + cellW / 2;
                        const rowCenterY = rowTop[row] + rowHeight[row] / 2;
                        n.style.left = Math.round(colCenterX - n.offsetWidth / 2) + 'px';
                        n.style.top = Math.round(rowCenterY - n.offsetHeight / 2) + 'px';
                        savePosition(n);
                    }
                    drawEdge();
                }

                // раскладка по дереву + вписать всё в видимую область — для кнопки ⊞
                function autoLayoutAndFit() {
                    layoutAllNodes();
                    const nodes = [...surface.querySelectorAll('.flow-node')].filter((n) => nodeFlow.get(n) === currentFlow);
                    if (!nodes.length) return;

                    const contentW = Math.max(...nodes.map((n) => n.offsetLeft + n.offsetWidth));
                    const contentH = Math.max(...nodes.map((n) => n.offsetTop + n.offsetHeight));
                    const PADDING = 60;
                    const fitScale = Math.min(
                        (canvas.clientWidth - PADDING * 2) / contentW,
                        (canvas.clientHeight - PADDING * 2) / contentH,
                        1
                    );
                    scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, fitScale));
                    x = PADDING;
                    y = PADDING;
                    apply();
                    saveView();
                }

                attachAddBottom(startNode);
                attachAddRight(startNode);
                attachAddBottom(node);
                attachAddRight(node);
                createEdge(startNode, node, document.getElementById('flowEdgeStart'), 'horizontal');

                // выделение ноды кликом и удаление по Delete; стартовая и «Секретарь»
                // не удаляются — на них завязана логика центрирования канваса
                let selectedNode = null;
                function selectNode(n) {
                    if (selectedNode) selectedNode.classList.remove('flow-node--selected');
                    selectedNode = n;
                    if (selectedNode) selectedNode.classList.add('flow-node--selected');
                }

                // выделение ребра кликом по линии стрелки — так же меняет цвет и
                // удаляется по Delete; клик мимо линии (и мимо ноды) снимает выделение
                let selectedEdge = null;
                function selectEdge(edge) {
                    if (selectedEdge) selectedEdge.path.setAttribute('stroke', '#6ea8fe');
                    selectedEdge = edge;
                    if (selectedEdge) selectedEdge.path.setAttribute('stroke', '#ffb84d');
                }

                edgesLayer.addEventListener('click', (e) => {
                    const path = e.target.closest('path');
                    const edge = path && edges.find((ed) => ed.path === path);
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

                // цвет опции в раскрытом меню браузер не переносит на закрытый select сам —
                // красим его вручную цветом выбранной опции при каждой смене типа узла
                surface.addEventListener('change', (e) => {
                    if (!e.target.matches('.flow-node__type')) return;
                    e.target.style.color = e.target.selectedOptions[0].style.color;
                    // блок вопросов имеет смысл только у типа Question
                    const questions = e.target.closest('.flow-node').querySelector('.flow-node__questions');
                    if (questions) questions.hidden = e.target.value !== 'question';
                });

                // toggle «Context on/off» в правой половине строки типа узла
                surface.addEventListener('click', (e) => {
                    const toggle = e.target.closest('.flow-node__context-toggle');
                    if (!toggle) return;
                    const on = toggle.getAttribute('aria-pressed') !== 'true';
                    toggle.setAttribute('aria-pressed', String(on));
                    toggle.setAttribute('aria-label', on ? 'Контекст: включён' : 'Контекст: выключен');
                });

                canvas.addEventListener('mousedown', (e) => {
                    if (e.target.closest('.flow-node') || e.target.closest('#flowEdges')) return;
                    selectNode(null);
                    selectEdge(null);
                });

                function deleteNode(n) {
                    for (const e of [...edges]) {
                        if (e.from === n || e.to === n) removeEdge(e);
                    }
                    n.remove();
                    nodeFlow.delete(n);
                    const positions = loadPositions();
                    delete positions[n.id];
                    flowSet(POS_KEY, positions);
                    selectedNode = null;
                    saveGraph();
                    drawEdge();
                }

                // на пустом канвасе нечего показать и не от чего плюсовать — заводим
                // одну ноду-заглушку по центру, чтобы с неё можно было расти
                function ensureRootNode(flow) {
                    for (const n of nodeFlow.keys()) if (nodeFlow.get(n) === flow) return n;
                    const root = nodeTemplate.content.firstElementChild.cloneNode(true);
                    root.id = 'flowNode_' + (++nodeSeq) + '_' + Date.now();
                    root.querySelector('.flow-node__title').textContent = 'Start';
                    surface.append(root);
                    attachAddBottom(root);
                    attachAddRight(root);
                    populateNodeAgentSelects(root);
                    nodeFlow.set(root, flow);
                    root.style.left = Math.round((canvas.clientWidth - root.offsetWidth) / 2) + 'px';
                    root.style.top = Math.round((canvas.clientHeight - root.offsetHeight) / 2) + 'px';
                    savePosition(root);
                    saveGraph();
                    return root;
                }

                // прячет ноды и рёбра всех канвасов, кроме flow — общая часть
                // первого показа вкладки (после restoreGraph) и переключения
                // пунктом меню, чтобы на старте не были видны чужие сохранённые ноды
                function applyFlowVisibility(flow) {
                    for (const n of surface.querySelectorAll('.flow-node')) {
                        n.style.display = nodeFlow.get(n) === flow ? '' : 'none';
                    }
                    for (const e of edges) {
                        const visible = nodeFlow.get(e.from) === flow;
                        e.path.style.display = visible ? '' : 'none';
                        e.addBtn.style.display = visible ? '' : 'none';
                    }
                }

                // переключение видимого канваса: сам механизм зума/панорамирования/
                // рёбер общий на все канвасы, переключение просто прячет чужие ноды
                // и рёбра и подставляет свой сохранённый zoom/pan
                setActiveFlow = (flow) => {
                    if (flow === currentFlow) return;
                    saveView();
                    currentFlow = flow;
                    selectNode(null);
                    selectEdge(null);
                    ensureRootNode(flow);
                    applyFlowVisibility(flow);
                    // тот же пересчёт зазора, что и при первом restoreGraph — на этом
                    // канвасе сохранённые позиции тоже могли остаться от старой,
                    // более низкой разметки нод
                    layoutAllNodes();
                    const saved = loadViews()[flow];
                    x = saved ? saved.x : START_X;
                    y = saved ? saved.y : START_Y;
                    scale = saved ? saved.scale : 1;
                    apply();
                    drawEdge();
                };

                window.addEventListener('keydown', (e) => {
                    if (e.key !== 'Delete') return;
                    if (document.activeElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) return;
                    if (selectedEdge) {
                        removeEdge(selectedEdge);
                        selectedEdge = null;
                        saveGraph();
                        drawEdge();
                        return;
                    }
                    if (!selectedNode || selectedNode === node || selectedNode === startNode) return;
                    deleteNode(selectedNode);
                });

                // записывает текст в title/body ноды и сразу сохраняет его в TEXT_KEY —
                // так же, как это делает ручное редактирование через focusout выше
                function setNodeTexts(n, title, body) {
                    const titleEl = n.querySelector('.flow-node__title');
                    const bodyEl = n.querySelector('.flow-node__body');
                    const all = loadTexts();
                    if (titleEl) {
                        titleEl.textContent = title;
                        all[`${n.id}:title`] = title;
                    }
                    if (bodyEl) {
                        bodyEl.textContent = body;
                        all[`${n.id}:body`] = body;
                    }
                    flowSet(TEXT_KEY, all);
                }

                // строка под заголовком — модель/effort и (только у ответа) расход
                // токенов/денег/времени этого хода; та же строка, что пользователь
                // может отредактировать руками, поэтому пишем через TEXT_KEY
                function setNodeSubtitle(n, text) {
                    const subtitleEl = n.querySelector('.flow-node__subtitle');
                    if (!subtitleEl) return;
                    subtitleEl.textContent = text;
                    const all = loadTexts();
                    all[`${n.id}:subtitle`] = text;
                    flowSet(TEXT_KEY, all);
                }

                // ставит ноде пометку из меню «кто видит узел» (.flow-node__scope) —
                // теми же текстом/title, что и клик по пункту меню вручную
                function setNodeScope(n, scope) {
                    const item = n.querySelector(`.flow-node__scope-item[data-scope="${scope}"]`);
                    const btn = n.querySelector('.flow-node__scope-btn');
                    if (!item || !btn) return;
                    btn.textContent = item.textContent.trim().split(' ')[0];
                    btn.title = item.textContent.trim();
                }

                // ставит ноде тип из select .flow-node__type — той же покраской
                // и скрытием блока вопросов, что и ручная смена типа выше
                function setNodeType(n, type) {
                    const select = n.querySelector('.flow-node__type');
                    if (!select) return;
                    select.value = type;
                    select.style.color = select.selectedOptions[0].style.color;
                    const questions = n.querySelector('.flow-node__questions');
                    if (questions) questions.hidden = type !== 'question';
                }

                // 1000 -> «1k»: расход показываем компактно, точные цифры — в подсказке
                function formatTokens(n) {
                    if (!n) return '0';
                    return n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(n);
                }
                function formatCost(usd) {
                    if (!usd) return null;
                    return '$' + usd.toFixed(usd < 0.01 ? 4 : 3);
                }
                function formatDuration(ms) {
                    if (!ms) return null;
                    return ms >= 1000 ? (ms / 1000).toFixed(1) + 'с' : ms + 'мс';
                }
                function totalTokensOf(m) {
                    return (m.inputTokens || 0) + (m.outputTokens || 0) + (m.cacheReadTokens || 0) + (m.cacheCreationTokens || 0);
                }

                // значок по имени инструмента — чтобы цепочку шагов можно было
                // читать по силуэту, не вчитываясь в каждый заголовок
                const TOOL_ICONS = {
                    Bash: '💻', Read: '📖', Write: '📝', Edit: '✏️', NotebookEdit: '📓',
                    Grep: '🔍', Glob: '🗂️', WebFetch: '🌐', WebSearch: '🔎',
                    Task: '🤖', TodoWrite: '✅',
                };

                // вход инструмента — JSON целиком (см. tool_input на сервере), но на
                // ноде нужна не сырая структура, а то же самое, что человек прочитал
                // бы в терминале: команда, путь к файлу, паттерн — без обрезки в 120
                // символов, как было в toolLabel() для строки статуса чата
                function toolInputSummary(toolName, toolInputJson) {
                    if (!toolInputJson) return null;
                    let input;
                    try { input = JSON.parse(toolInputJson); } catch { return toolInputJson; }
                    if (toolName === 'Task') {
                        return [input.subagent_type, input.description].filter(Boolean).join(': ') || JSON.stringify(input);
                    }
                    if (typeof input.command === 'string') return input.command;
                    if (typeof input.file_path === 'string') {
                        const bits = [input.file_path];
                        if (input.offset) bits.push(`со строки ${input.offset}`);
                        if (input.limit) bits.push(`${input.limit} строк`);
                        return bits.join(' · ');
                    }
                    if (typeof input.pattern === 'string') {
                        return [input.pattern, input.path && `в ${input.path}`, input.glob].filter(Boolean).join(' · ');
                    }
                    if (typeof input.url === 'string') return input.url;
                    if (typeof input.query === 'string') return input.query;
                    if (typeof input.prompt === 'string') return input.prompt;
                    return JSON.stringify(input);
                }

                // результат вызова — потенциально длинный (до 4000 символов, см. clip
                // на сервере), поэтому не запихиваем его в body всегда открытым: строка-
                // переключатель прямо на ноде, полный текст разворачивается по клику
                // тут же, а не в hover-подсказке, которую легко не заметить
                function setToolResultView(n, resultText, isError) {
                    n.querySelector('.flow-node__tool-result')?.remove();
                    if (!resultText) return;
                    const wrap = document.createElement('div');
                    wrap.className = 'flow-node__tool-result' + (isError ? ' flow-node__tool-result--error' : '');
                    const toggle = document.createElement('button');
                    toggle.type = 'button';
                    toggle.className = 'flow-node__tool-result-toggle';
                    const label = isError ? '⚠ Результат (ошибка)' : 'Результат';
                    toggle.textContent = `${label} ▾`;
                    const pre = document.createElement('div');
                    pre.className = 'flow-node__tool-result-text';
                    pre.textContent = resultText;
                    pre.hidden = true;
                    toggle.addEventListener('click', (e) => {
                        e.stopPropagation();
                        pre.hidden = !pre.hidden;
                        toggle.textContent = `${label} ${pre.hidden ? '▾' : '▴'}`;
                    });
                    wrap.append(toggle, pre);
                    n.append(wrap);
                }

                // строит граф канваса `flow` из сообщений сессии: белый текст (роли
                // user/assistant) идёт цепочкой вправо, серый текст (роли tool/thinking —
                // шаги и рассуждения между вопросом и ответом) — вертикальной цепочкой
                // под ним, потому что белый текст — причина, по которой они появились.
                // usage — сводка по всей сессии (см. /api/sessions/messages), показываем
                // её рядом с выбором сессии, а не на отдельной ноде
                // подпись стоп-причины хода — только для значений, о которых стоит
                // предупредить (обрыв по лимиту токенов, отказ модели и т.п.); обычное
                // завершение (end_turn/tool_use) ничем не примечательно и не показывается
                const STOP_REASON_LABELS = {
                    max_tokens: '⚠ Обрыв по лимиту токенов',
                    refusal: '⚠ Отказ модели',
                    pause_turn: '⏸ Приостановлено',
                };

                buildSessionFlow = (flow, messages, usage, extra = {}) => {
                    setActiveFlow(flow);
                    for (const n of [...nodeFlow.keys()]) {
                        if (nodeFlow.get(n) === flow) deleteNode(n);
                    }

                    let lastWhite = null;
                    let lastGray = null;
                    // шаги субагента (Task) CLI шлёт в тот же стрим, помечая их
                    // parentToolUseId — id того самого вызова Task. toolUseIdToNode
                    // связывает id вызова с уже отрисованной нодой (в т.ч. вложенной
                    // на любую глубину), subChainTail — последний узел вложенной цепочки
                    // под каждым родителем, чтобы шаги субагента росли вниз друг под
                    // другом, а не все разом цеплялись к одной ноде Task
                    const toolUseIdToNode = new Map();
                    const subChainTail = new Map();
                    for (const m of messages) {
                        if (m.role === 'tool' || m.role === 'thinking') {
                            const nested = m.parentToolUseId && toolUseIdToNode.has(m.parentToolUseId);
                            const from = nested
                                ? (subChainTail.get(m.parentToolUseId) || toolUseIdToNode.get(m.parentToolUseId))
                                : (lastGray || lastWhite);
                            if (!from) continue;
                            const gray = addChildNode(from);
                            if (nested) subChainTail.set(m.parentToolUseId, gray);
                            else lastGray = gray;
                            if (m.toolUseId) toolUseIdToNode.set(m.toolUseId, gray);
                            setNodeScope(gray, 'system');
                            setNodeType(gray, 'system');
                            // вложенный шаг субагента визуально отличается от шагов
                            // верхнего уровня — стрелка перед заголовком и своя рамка
                            gray.classList.toggle('flow-node--sidechain', nested);
                            if (m.role === 'thinking') {
                                // рассуждения — заголовок описывает тип содержимого (как
                                // «Вопрос»/«Ответ» у белых нод), тело — текст целиком без
                                // обрезки (сервер уже ужал его при записи до разумных 4000)
                                setNodeTexts(gray, nested ? '↳ Мысли' : 'Мысли', m.text);
                                setNodeSubtitle(gray, '');
                                const avatar = gray.querySelector('.flow-node__avatar');
                                if (avatar) avatar.textContent = '🧠';
                            } else {
                                // заголовок — реальное имя инструмента («Bash», «Read», …),
                                // а не общее слово «Шаг»; тело — настоящая команда/путь/паттерн
                                // из tool_input целиком, а не обрезанная до 120 символов строка
                                // статуса чата. У старых сессий (записаны до этой доработки)
                                // tool_name/tool_input могло не быть — тогда откатываемся
                                // на то, что есть: имя инструмента из начала text
                                const title = m.toolName || m.text.split(' ')[0] || 'Инструмент';
                                const body = toolInputSummary(m.toolName, m.toolInput) || m.text;
                                setNodeTexts(gray, nested ? `↳ ${title}` : title, body);
                                setNodeSubtitle(gray, m.toolError ? '⚠ Ошибка' : '');
                                const avatar = gray.querySelector('.flow-node__avatar');
                                if (avatar) avatar.textContent = m.toolError ? '⚠️' : (TOOL_ICONS[m.toolName] || '🧩');
                                setToolResultView(gray, m.toolResult, !!m.toolError);
                            }
                        } else {
                            lastWhite = lastWhite ? addChildNodeRight(lastWhite) : ensureRootNode(flow);
                            setNodeTexts(lastWhite, m.role === 'user' ? 'Вопрос' : 'Ответ', m.text);
                            setNodeScope(lastWhite, 'system');
                            setNodeType(lastWhite, 'system');
                            // родительские ноды цепочки (вопрос/ответ) отличаются от шагов
                            // под ними не только позицией (вправо, а не вниз), но и своей
                            // иконкой — по роли, а не по инструменту, как у серых узлов
                            const whiteAvatar = lastWhite.querySelector('.flow-node__avatar');
                            if (whiteAvatar) whiteAvatar.textContent = m.role === 'user' ? '👤' : '🤖';
                            // модель/effort хода и — только там, где CLI их реально прислал
                            // (строка ответа, см. finishExchange на сервере) — расход этого хода
                            const bits = [];
                            if (m.model) bits.push(m.effort ? `${m.model} · ${m.effort}` : m.model);
                            const tokens = totalTokensOf(m);
                            if (tokens) bits.push(`🪙 ${formatTokens(tokens)}`);
                            const cost = formatCost(m.costUsd);
                            if (cost) bits.push(`💵 ${cost}`);
                            const duration = formatDuration(m.durationMs);
                            if (duration) bits.push(`⏱ ${duration}`);
                            const stopLabel = STOP_REASON_LABELS[m.stopReason];
                            if (stopLabel) bits.push(stopLabel);
                            setNodeSubtitle(lastWhite, bits.join(' · '));
                            // разбивка по кэшу — в подсказке над телом токенов: сумма уже
                            // показана компактно, но входные/выходные/кэш-чтение/кэш-запись
                            // раньше нигде не были видны по отдельности
                            const cacheBits = [];
                            if (m.inputTokens) cacheBits.push(`вход ${formatTokens(m.inputTokens)}`);
                            if (m.outputTokens) cacheBits.push(`выход ${formatTokens(m.outputTokens)}`);
                            if (m.cacheReadTokens) cacheBits.push(`кэш-чтение ${formatTokens(m.cacheReadTokens)}`);
                            if (m.cacheCreationTokens) cacheBits.push(`кэш-запись ${formatTokens(m.cacheCreationTokens)}`);
                            const subtitleEl = lastWhite.querySelector('.flow-node__subtitle');
                            if (subtitleEl) subtitleEl.title = cacheBits.join(' · ');
                            lastGray = null;
                        }
                    }
                    if (!lastWhite) ensureRootNode(flow);
                    autoLayoutAndFit();

                    // сводка по сессии целиком — в тулбаре рядом с выбором сессии
                    const usageEl = document.getElementById('flowSessionUsage');
                    if (usageEl) {
                        const total = usage ? totalTokensOf({ inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheReadTokens: usage.cacheReadTokens, cacheCreationTokens: usage.cacheCreationTokens }) : 0;
                        if (usage && total) {
                            const bits = [`🪙 ${formatTokens(total)}`];
                            const cost = formatCost(usage.costUsd);
                            if (cost) bits.push(`💵 ${cost}`);
                            if (extra.contextPercent != null) bits.push(`📊 ${extra.contextPercent}% контекста`);
                            usageEl.textContent = bits.join(' · ');
                            usageEl.hidden = false;
                            const cacheBits = [];
                            if (usage.cacheReadTokens) cacheBits.push(`кэш-чтение ${formatTokens(usage.cacheReadTokens)}`);
                            if (usage.cacheCreationTokens) cacheBits.push(`кэш-запись ${formatTokens(usage.cacheCreationTokens)}`);
                            usageEl.title = cacheBits.length
                                ? `Расход выбранной сессии: токены и стоимость (${cacheBits.join(' · ')})`
                                : 'Расход выбранной сессии: токены и стоимость';
                        } else {
                            usageEl.hidden = true;
                        }
                    }

                    // сведения о сессии (system/init) и лимиты подписки — кнопкой (i)
                    // рядом: раньше эти данные вообще нигде не сохранялись и не
                    // показывались, теперь видны в подсказке по клику/наведению
                    const infoEl = document.getElementById('flowSessionInfo');
                    if (infoEl) {
                        const info = extra.sessionInfo;
                        const rl = extra.rateLimit;
                        const lines = [];
                        if (info?.cwd) lines.push(`Папка: ${info.cwd}`);
                        if (info?.permissionMode) lines.push(`Режим разрешений: ${info.permissionMode}`);
                        if (info?.tools?.length) lines.push(`Инструменты: ${info.tools.join(', ')}`);
                        if (info?.mcpServers?.length) lines.push(`MCP: ${info.mcpServers.join(', ')}`);
                        if (info?.slashCommands?.length) lines.push(`Слэш-команды: ${info.slashCommands.join(', ')}`);
                        if (rl) lines.push(`Лимиты подписки: ${JSON.stringify(rl)}`);
                        infoEl.title = lines.join('\n');
                        infoEl.hidden = lines.length === 0;
                    }

                    // кнопка копирования ID выбранной сессии — видна, только пока
                    // сессия реально выбрана (как и сведения о сессии выше)
                    const copyIdEl = document.getElementById('flowSessionCopyId');
                    const sessionSelectEl = document.getElementById('flowSessionSelect');
                    if (copyIdEl) copyIdEl.hidden = !sessionSelectEl?.value;
                };
            })();

            // категория «провайдер / модель / effort» ноды Секретаря — какой агент
            // её обслуживает. Выбор переживает перезагрузку через localStorage
            (() => {
                const providerSelect = document.getElementById('flowNodeSecretaryProvider');
                const modelSelect = document.getElementById('flowNodeSecretaryModel');
                const effortSelect = document.getElementById('flowNodeSecretaryEffort');

                const AGENT_KEY = 'flowNodeSecretaryAgent';
                function loadAgent() {
                    return flowGet(AGENT_KEY, {});
                }
                function saveAgent(agent) {
                    flowSet(AGENT_KEY, agent);
                }

                const saved = loadAgent();

                for (const provider of App.PROVIDERS) {
                    const option = document.createElement('option');
                    option.value = provider.id;
                    option.textContent = provider.name;
                    option.selected = provider.id === (saved.provider || App.PROVIDERS[0].id);
                    providerSelect.append(option);
                }

                function renderModelAndEffort() {
                    const provider = App.PROVIDERS.find((p) => p.id === providerSelect.value);
                    modelSelect.innerHTML = '';
                    for (const model of provider.models) {
                        const option = document.createElement('option');
                        option.value = model;
                        option.textContent = model;
                        option.selected = model === (saved.provider === provider.id && saved.model ? saved.model : provider.defaultModel);
                        modelSelect.append(option);
                    }

                    effortSelect.innerHTML = '';
                    effortSelect.hidden = !provider.efforts;
                    if (provider.efforts) {
                        for (const effort of provider.efforts) {
                            const option = document.createElement('option');
                            option.value = effort;
                            option.textContent = effort;
                            option.selected = effort === (saved.provider === provider.id && saved.effort ? saved.effort : provider.defaultEffort);
                            effortSelect.append(option);
                        }
                    }
                }

                renderModelAndEffort();

                providerSelect.addEventListener('change', () => {
                    renderModelAndEffort();
                    saveAgent({ provider: providerSelect.value, model: modelSelect.value, effort: effortSelect.value });
                });
                modelSelect.addEventListener('change', () => {
                    saveAgent({ provider: providerSelect.value, model: modelSelect.value, effort: effortSelect.value });
                });
                effortSelect.addEventListener('change', () => {
                    saveAgent({ provider: providerSelect.value, model: modelSelect.value, effort: effortSelect.value });
                });
            })();

            // window.MissionFlow.center() уже могли дёрнуть, пока грузилось состояние
            // выше (см. pendingCenter в начале файла) — обрабатываем этот случай сразу
            // после того, как canvas собран и centerFlowNode получил реальное значение
            if (pendingCenter && centerFlowNode) {
                pendingCenter = false;
                centerFlowNode();
                centerFlowNode = null;
            }
            }
})();
