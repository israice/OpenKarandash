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
            // та же отсрочка для построения графа из сессии: flow-session-sync.js
            // зовёт buildFromSession при загрузке страницы, когда состояние канваса
            // могло ещё не доехать с сервера — запоминаем аргументы и строим после init
            let pendingBuild = null;
            window.MissionFlow = {
                center() {
                    if (centerFlowNode) {
                        centerFlowNode();
                        centerFlowNode = null;
                    } else {
                        pendingCenter = true;
                    }
                },
                // вызывается из PROJECTS/Flow/flow-session-sync.js по кнопке в тулбаре.
                // sessionId нужен для id нод (flowNode_<сессия>_<позиция>): по нему
                // перестройка отличает свои ноды от заведённых руками
                buildFromSession(flow, messages, sessionId) {
                    if (buildSessionFlow) buildSessionFlow(flow, messages, sessionId);
                    else pendingBuild = { flow, messages, sessionId };
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
            // построение графа сессии трогает позиции, тексты и граф на каждой ноде —
            // без накопления сессия в 200 сообщений давала сотни POST подряд. На время
            // построения копим тронутые ключи и шлём их один раз в конце: ключей всего
            // четыре, а /api/flow/state/set принимает ровно одну пару за запрос
            // (серверную половину этап не трогает — см. TASKS.md)
            let flowBatch = null;
            function flowSet(key, value) {
                flowState[key] = value;
                if (flowBatch) flowBatch.add(key);
                else App.api('/api/flow/state/set', { key, value });
            }
            function beginFlowBatch() {
                if (!flowBatch) flowBatch = new Set();
            }
            function flushFlowBatch() {
                const keys = flowBatch;
                flowBatch = null;
                if (!keys) return;
                for (const key of keys) App.api('/api/flow/state/set', { key, value: flowState[key] });
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
                // следующие группы (Temp/Minions), кидает новую строку под них
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
            agentsAddBtn.title = 'Add minion';
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

            for (const title of ['Secretary', 'UI developer', 'Backend developer', 'QA', 'HR']) {
                addAgentItem(title, AGENT_ICONS[title]);
            }
            for (const title of loadCustomAgents()) {
                addAgentItem(title, DEFAULT_AGENT_ICON, true);
            }

            agentsAddBtn.addEventListener('click', () => {
                const title = prompt('Name of the new minion:');
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
                    // внутри раскрытой секции ноды колесо листает её текст, а не зумит
                    // канвас: иначе до конца длинного результата вызова не добраться.
                    // Но только пока там есть что листать — над короткой секцией
                    // колесо должно зумить, как и над всей остальной картой
                    const fact = e.target.closest('.flow-node__fact-text');
                    if (fact && fact.scrollHeight > fact.clientHeight) return;
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
                    const ok = await App.confirmModal('Remove all added nodes on this canvas?', { title: 'Clear canvas' });
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

                // тип узла (.flow-node__type) — свойство ноды, а не украшение: на нём
                // держится гейт «ask_human» (§7 chat.md), поэтому выбор переживает
                // перезагрузку. Ноды сессии сюда не попадают: им тип ставит построение
                const TYPES_KEY = 'flowNodeTypes';
                function loadTypes() {
                    return flowGet(TYPES_KEY, {});
                }
                function applyNodeType(n) {
                    const type = loadTypes()[n.id];
                    if (type) setNodeType(n, type);
                }

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
                    field.innerHTML = '<span class="flow-node__question-handle" aria-hidden="true">⠿</span><span class="flow-node__question-text" data-placeholder="Question"></span>';
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
                    // правка текста ноды сессии живёт до ближайшей перестройки графа
                    // и в состояние не пишется — она всё равно будет перезаписана
                    // сообщением (правка самой сессии — этап 3 в TASKS.md)
                    if (n.dataset.session) return;
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
                // ноды сессии (dataset.session) в состояние Flow не попадают вовсе —
                // ни позицией, ни текстом, ни ребром: они целиком выводятся из сообщений
                // и рисуются заново при каждом построении (buildSessionFlow). Хранить их
                // значило бы держать вторую копию переписки, и на большой сессии
                // flowNodeText перерастал лимит тела запроса (readJson, 100 КБ) —
                // запись состояния молча обрывалась вся целиком
                function savePosition(el) {
                    if (el.dataset.session) return;
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
                            .filter(([n]) => n !== startNode && n !== node && !n.dataset.session)
                            .map(([n, flow]) => ({ id: n.id, flow })),
                        // ребро между двумя нодами сессии не сохраняем — оно и так
                        // выводится из сообщений. А вот ребро, которым пользователь
                        // привязал свою ноду к ноде сессии, — единственное, что помнит
                        // её место в цепочке, и его беречь надо: id ноды сессии
                        // детерминированный, после перестройки он тот же самый
                        edges: edges
                            .filter((e) => !e.from.dataset.session || !e.to.dataset.session)
                            .map((e) => ({ from: e.from.id, to: e.to.id, direction: e.direction })),
                    });
                }

                // восстанавливаем клоны шаблона по id из графа и перестраиваем рёбра;
                // вызывается один раз при первом показе вкладки, до отрисовки рёбер
                function restoreGraph() {
                    const graph = loadGraph();
                    if (!graph || !graph.nodes || !graph.nodes.length) return;

                    const positions = loadPositions();
                    const flowById = {};
                    for (const n of graph.nodes || []) flowById[n.id] = n.flow;

                    const byId = { [startNode.id]: startNode, [node.id]: node };
                    // идём по списку нод, а не по концам рёбер: нода без единой связи
                    // (одиночная заглушка, только что заведённый узел) тоже сохранена,
                    // и раньше она молча пропадала при каждой перезагрузке страницы.
                    // Концы рёбер, которых в списке нет, — это ноды сессии: их создаст
                    // построение графа, а ребро до тех пор ждёт (см. pendingEdges)
                    for (const id of Object.keys(flowById)) {
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
                        applyNodeType(clone);
                        byId[id] = clone;
                    }
                    nodeSeq = Math.max(nodeSeq, graph.nodeSeq || 0);

                    for (const e of [...edges]) removeEdge(e);
                    pendingEdges = [];
                    for (const e of graph.edges || []) {
                        if (!byId[e.from] || !byId[e.to]) { pendingEdges.push(e); continue; } // ждёт своей ноды сессии
                        // второе входящее ребро в ту же ноду (старый граф, заведённый до
                        // запрета такого соединения) раскладка не учитывает и рисует
                        // стрелкой не в ту сторону — отбрасываем его при восстановлении,
                        // как теперь и не даём создать заново
                        if (edges.some((ed) => ed.to === byId[e.to])) continue;
                        createEdge(byId[e.from], byId[e.to], null, e.direction);
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
                // рёбра из сохранённого графа, чья нода сессии на канвасе ещё не появилась:
                // ждут ближайшего построения графа (см. applyPendingEdges)
                let pendingEdges = [];
                // идёт построение графа сессии. Каждая нода в одиночку зовёт раскладку,
                // сохранение и отрисовку дуг; на пятидесяти нодах это давало пять секунд
                // замершей вкладки, хотя нужен один пересчёт — в самом конце
                let bulkBuild = false;
                function afterNodeChange() {
                    if (bulkBuild) return;
                    layoutAllNodes();
                    saveGraph();
                    drawEdge();
                }

                // id ноды. У заведённых руками — прежний счётчик со временем создания;
                // ноды сессии просят свой (flowNode_<сессия>_<позиция>, см. buildSessionFlow),
                // и он держится за конкретное сообщение: живая перестройка по нему находит
                // уже стоящую ноду и обновляет её, вместо того чтобы снести и создать заново
                function nextNodeId(id) {
                    return id || 'flowNode_' + (++nodeSeq) + '_' + Date.now();
                }

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

                // геометрия дуги: сторона крепления идёт от типа плюса, которым ребро
                // создано (горизонтальный — право/лево по центру высоты, вертикальный —
                // низ/верх по центру ширины), а не от угла между центрами нод — при обычной
                // раскладке цель всегда лежит по нужную сторону, и крепление держится своего
                // входа/выхода. Меняется сторона только когда цель всё же оказалась
                // не там (см. ниже) — иначе кривая рисовалась бы задом наперёд
                function edgeGeometry(from, to, direction) {
                    const fromCX = from.offsetLeft + from.offsetWidth / 2;
                    const fromCY = from.offsetTop + from.offsetHeight / 2;
                    const toCX = to.offsetLeft + to.offsetWidth / 2;
                    const toCY = to.offsetTop + to.offsetHeight / 2;

                    // раскладка держит цель по нужную сторону от источника всегда (вправо —
                    // та же строка, вниз — ниже), но общий файл сессии — законное исключение:
                    // на него ведут рёбра сразу от нескольких шагов, и не для каждого из них
                    // цель окажется строго справа/снизу. Крепление в таком случае перекладываем
                    // на противоположную сторону — иначе кривая гнулась бы назад через ноду
                    let start, end, ux, uy;
                    if (direction === 'vertical') {
                        if (to.offsetTop + to.offsetHeight / 2 < from.offsetTop) {
                            start = { x: fromCX, y: from.offsetTop };
                            end = { x: toCX, y: to.offsetTop + to.offsetHeight };
                            ux = 0; uy = -1;
                        } else {
                            start = { x: fromCX, y: from.offsetTop + from.offsetHeight };
                            end = { x: toCX, y: to.offsetTop };
                            ux = 0; uy = 1;
                        }
                    } else {
                        if (to.offsetLeft + to.offsetWidth / 2 < from.offsetLeft) {
                            start = { x: from.offsetLeft, y: fromCY };
                            end = { x: to.offsetLeft + to.offsetWidth, y: toCY };
                            ux = -1; uy = 0;
                        } else {
                            start = { x: from.offsetLeft + from.offsetWidth, y: fromCY };
                            end = { x: to.offsetLeft, y: toCY };
                            ux = 1; uy = 0;
                        }
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
                    addBtn.title = 'Insert node';
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
                    newNode.id = nextNodeId();
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
                    afterNodeChange();
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

                    // у ноды с уже существующим входящим ребром не может появиться второе:
                    // раскладка (layoutAllNodes) держит позицию только по первому родителю,
                    // и второе ребро рисовалось бы поверх места, которое диктует направление
                    // совсем другой связи — стрелка «вправо» упиралась в ноду не в той строке,
                    // «вниз» — в ноду не под источником. Поэтому такую цель не подсвечиваем
                    // и не даём в неё соединиться вовсе
                    const hovered = document.elementFromPoint(e.clientX, e.clientY)?.closest('.flow-node');
                    const hasParent = hovered && edges.some((ed) => ed.to === hovered);
                    const target = hovered && hovered !== connecting.source && !hasParent ? hovered : null;
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
                    if (!target || edges.some((ed) => ed.to === target)) return;
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
                function addChildNode(from, id, sessionId) {
                    const newNode = nodeTemplate.content.firstElementChild.cloneNode(true);
                    newNode.id = nextNodeId(id);
                    if (sessionId) newNode.dataset.session = sessionId;
                    surface.append(newNode);
                    attachAddBottom(newNode);
                    attachAddRight(newNode);
                    populateNodeAgentSelects(newNode);
                    nodeFlow.set(newNode, nodeFlow.get(from));
                    newNode.style.left = Math.round(from.offsetLeft + (from.offsetWidth - newNode.offsetWidth) / 2) + 'px';
                    newNode.style.top = Math.round(from.offsetTop + from.offsetHeight + NODE_GAP_Y) + 'px';
                    savePosition(newNode);
                    createEdge(from, newNode, null, 'vertical');
                    afterNodeChange();
                    return newNode;
                }

                // плюс у правого края ноды — добавляет новый узел-заглушку справа
                // от текущего, по той же логике, что и attachAddBottom/addChildNode
                function attachAddRight(n) {
                    n.querySelector('.flow-node__add-right').addEventListener('mousedown', (e) => startConnecting(e, n, 'horizontal'));
                }

                // добавляет дочерний узел справа — симметрично addChildNode
                function addChildNodeRight(from, id, sessionId) {
                    const newNode = nodeTemplate.content.firstElementChild.cloneNode(true);
                    newNode.id = nextNodeId(id);
                    if (sessionId) newNode.dataset.session = sessionId;
                    surface.append(newNode);
                    attachAddBottom(newNode);
                    attachAddRight(newNode);
                    populateNodeAgentSelects(newNode);
                    nodeFlow.set(newNode, nodeFlow.get(from));
                    newNode.style.left = Math.round(from.offsetLeft + from.offsetWidth + NODE_GAP) + 'px';
                    newNode.style.top = Math.round(from.offsetTop + (from.offsetHeight - newNode.offsetHeight) / 2) + 'px';
                    savePosition(newNode);
                    createEdge(from, newNode, null, 'horizontal');
                    afterNodeChange();
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
                    // цепочка, которую сейчас меряем. Комментарий выше обещает дерево,
                    // но у ноды может оказаться и два входящих ребра (повторный drag-connect,
                    // накопленные сборки на одном канвасе) — тогда цепочки ссылаются друг
                    // на друга по кругу, и measure→measure не заканчивается вовсе:
                    // вкладка падала с «Maximum call stack size exceeded». Повторный вход
                    // отдаёт 0 — ветка уже учтена тем вызовом, который её и меряет
                    const measuring = new Set();
                    function measure(chain) {
                        if (widthOf.has(chain)) return widthOf.get(chain);
                        if (measuring.has(chain)) return 0;
                        measuring.add(chain);
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
                        measuring.delete(chain);
                        return baseWidth + extraWidth;
                    }

                    const colStart = new Map();
                    const rowOf = new Map();
                    const memberColOf = new Map();
                    const seenChains = new Set();
                    let maxRowSeen = -1;
                    function place(chain, minCol, chainRow) {
                        // та же защита, что и в measure: цепочку, уже получившую колонку,
                        // второй раз не расставляем — иначе тот же круг ссылок зацикливает
                        if (seenChains.has(chain)) return;
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
                    const n = e.target.closest('.flow-node');
                    const questions = n.querySelector('.flow-node__questions');
                    if (questions) questions.hidden = e.target.value !== 'question';
                    if (n.dataset.session) return; // тип ноды сессии задаёт построение
                    const all = loadTypes();
                    all[n.id] = e.target.value;
                    flowSet(TYPES_KEY, all);
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
                        setNodeTexts(n, n.querySelector('.flow-node__title').textContent, truncate(text, 200));
                        return;
                    }
                    pre.textContent = pre.dataset.saved || '';
                    App.confirmModal(res.error || 'The server did not respond', { title: 'Message not changed', confirmText: 'OK', cancelText: 'Close' });
                });

                // кнопка ноды-документа: открываем файл тем же окном, которым его
                // открывает клик по узлу графа (MissionGraph — внутри обработчика,
                // чтобы порядок загрузки файлов ни на что не влиял)
                surface.addEventListener('click', (e) => {
                    const btn = e.target.closest('.flow-node__open');
                    if (!btn) return;
                    const path = btn.closest('.flow-node').dataset.file;
                    if (path && window.MissionGraph) MissionGraph.openFileModal(path);
                });

                // раскрытие секции меняет высоту ноды — соседей надо раздвинуть, а дуги
                // перерисовать. Событие toggle не всплывает, поэтому слушаем его в фазе
                // перехвата; самим раскрытием по-прежнему занимается браузер
                surface.addEventListener('toggle', (e) => {
                    if (!e.target.classList?.contains('flow-node__fact')) return;
                    layoutAllNodes();
                    drawEdge();
                }, true);

                function deleteNode(n) {
                    for (const e of [...edges]) {
                        if (e.from === n || e.to === n) removeEdge(e);
                    }
                    n.remove();
                    nodeFlow.delete(n);
                    // ноды сессии в состоянии и не лежали (см. savePosition) — чистить нечего
                    if (!n.dataset.session) {
                        const types = loadTypes();
                        if (types[n.id]) {
                            delete types[n.id];
                            flowSet(TYPES_KEY, types);
                        }
                        const positions = loadPositions();
                        delete positions[n.id];
                        flowSet(POS_KEY, positions);
                        // тексты и вопросы удалённой ноды раньше оставались в состоянии
                        // навсегда: их ключи привязаны к id, который больше никому не выдадут
                        const texts = loadTexts();
                        for (const field of ['title', 'subtitle', 'body']) delete texts[`${n.id}:${field}`];
                        flowSet(TEXT_KEY, texts);
                        const questions = loadQuestions();
                        if (questions[n.id]) {
                            delete questions[n.id];
                            flowSet(QUESTIONS_KEY, questions);
                        }
                    }
                    // выделение снимаем только со своей же ноды: живая перестройка графа
                    // сессии удаляет чужие ноды и не должна сбрасывать выбор пользователя
                    if (selectedNode === n) selectedNode = null;
                    saveGraph();
                    drawEdge();
                }

                // на пустом канвасе нечего показать и не от чего плюсовать — заводим
                // одну ноду-заглушку по центру, чтобы с неё можно было расти
                function ensureRootNode(flow, id, sessionId) {
                    // с готовым id заглушка не годится: зовущий (buildSessionFlow) просит
                    // ноду именно под своё сообщение, а не любую уже стоящую на канвасе
                    if (!id) {
                        for (const n of nodeFlow.keys()) if (nodeFlow.get(n) === flow) return n;
                    } else {
                        for (const n of nodeFlow.keys()) {
                            if (n.id !== id) continue;
                            // нода могла приехать из сохранённого состояния (restoreGraph)
                            // без пометки — без неё её текст пошёл бы в flow_state, то есть
                            // переписка снова копилась бы второй копией (см. savePosition)
                            if (sessionId) n.dataset.session = sessionId;
                            return n;
                        }
                    }
                    const root = nodeTemplate.content.firstElementChild.cloneNode(true);
                    root.id = nextNodeId(id);
                    if (sessionId) root.dataset.session = sessionId;
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
                    if (titleEl) titleEl.textContent = title;
                    if (bodyEl) bodyEl.textContent = body;
                    // текст ноды сессии — копия сообщения, хранить его незачем (см. savePosition)
                    if (n.dataset.session) return;
                    const all = loadTexts();
                    if (titleEl) all[`${n.id}:title`] = title;
                    if (bodyEl) all[`${n.id}:body`] = body;
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

                // вид ноды сессии по роли сообщения: эмодзи в аватар, цвет — классом
                // .flow-node--kind-* (см. flow.css), заголовок карточки. Роли те же,
                // что записывает сервер (см. listMessages в server.js). Select
                // .flow-node__type не трогаем: это словарь пользователя для его
                // собственной разметки, а не тип факта из сессии
                const NODE_KINDS = {
                    user: { emoji: '👤', kind: 'user', title: 'Question' },
                    assistant: { emoji: '💬', kind: 'assistant', title: 'Answer' },
                    thinking: { emoji: '💭', kind: 'thinking', title: 'Reasoning' },
                    hook: { emoji: '🪝', kind: 'hook', title: 'Hook' },
                    system: { emoji: '🖥️', kind: 'system', title: 'System event' },
                    unknown: { emoji: '❔', kind: 'unknown', title: 'Unrecognized event' },
                    top_level: { emoji: '❔', kind: 'unknown', title: 'Event of unknown type' },
                };

                // семейства инструментов; первое совпадение выигрывает, поэтому префикс
                // mcp__ стоит выше собственных имён — инструмент MCP-сервера может
                // называться как угодно, включая Read или Task
                const TOOL_KINDS = [
                    [/^mcp__/, '🔌', 'tool-mcp'],
                    [/^(WebSearch|WebFetch)$/, '🌐', 'tool-web'],
                    [/^(Read|Write|Edit|NotebookEdit)$/, '📄', 'tool-file'],
                    [/^(Bash|PowerShell)$/, '⌨️', 'tool-shell'],
                    [/^Task$/, '🤖', 'tool-task'],
                    [/^AskUserQuestion$/, '🙋', 'tool-ask'],
                    [/^(Grep|Glob)$/, '🔍', 'tool-search'],
                ];

                function nodeKindOf(m) {
                    if (m.role !== 'tool') return NODE_KINDS[m.role] || NODE_KINDS.unknown;
                    const name = m.toolName || 'Tool';
                    for (const [re, emoji, kind] of TOOL_KINDS) {
                        if (re.test(name)) return { emoji, kind, title: name };
                    }
                    return { emoji: '🔧', kind: 'tool', title: name };
                }

                // ставит ноде вид: класс семейства (ровно один на ноду), пометку ошибки
                // и эмодзи в аватар — тем же способом, что и ручной выбор иконки в меню
                function setNodeKind(n, kind, emoji, isError) {
                    for (const c of [...n.classList]) {
                        if (c.startsWith('flow-node--kind-')) n.classList.remove(c);
                    }
                    n.classList.add('flow-node--kind-' + kind);
                    n.classList.toggle('flow-node--error', !!isError);
                    const avatar = n.querySelector('.flow-node__avatar');
                    if (avatar) avatar.textContent = emoji;
                }

                // toolInput приходит сериализованным JSON (см. recordStep в server.js) —
                // печатаем читаемо, многострочные значения (old_string/new_string правок
                // кода) настоящими переносами, а не как «\n» внутри одной строки.
                // Копия из PROJECTS/Feed/page.js: прямой зависимости Flow от Feed быть
                // не может — Feed это страница кнопки «+», её удаляют из меню
                // (DOCS/decisions/016)
                function formatJsonValue(value, indent) {
                    const pad = '  '.repeat(indent);
                    const childPad = '  '.repeat(indent + 1);
                    if (value === null || value === undefined) return 'null';
                    if (Array.isArray(value)) {
                        if (value.length === 0) return '[]';
                        const items = value.map((v) => `${childPad}${formatJsonValue(v, indent + 1)}`);
                        return `[\n${items.join(',\n')}\n${pad}]`;
                    }
                    if (typeof value === 'object') {
                        const keys = Object.keys(value);
                        if (keys.length === 0) return '{}';
                        const items = keys.map((k) => `${childPad}${JSON.stringify(k)}: ${formatJsonValue(value[k], indent + 1)}`);
                        return `{\n${items.join(',\n')}\n${pad}}`;
                    }
                    if (typeof value === 'string' && value.includes('\n')) {
                        const lines = value.split('\n').map((line) => childPad + line);
                        return `"""\n${lines.join('\n')}\n${childPad}"""`;
                    }
                    return JSON.stringify(value);
                }
                function prettyJson(raw) {
                    if (!raw) return '';
                    try { return formatJsonValue(JSON.parse(raw), 0); } catch { return raw; }
                }
                function truncate(s, n) { return s && s.length > n ? `${s.slice(0, n)}…` : (s || ''); }

                // три секции шага: что вошло, что произошло, что вышло. Пустые не
                // показываем — у реплики пользователя нет ни аргументов, ни результата
                function sessionFacts(m) {
                    const input = m.role === 'user'
                        // в Chat-режиме модели уходит не то, что видно в чате, а текст с
                        // приклеенной преамбулой (server.js) — показываем реально отправленное
                        ? (m.inputSent && m.inputSent !== m.text ? m.inputSent : '')
                        : prettyJson(m.toolInput);
                    return [
                        ['Input', input, false],
                        ['What happened', m.text || '', false],
                        ['Output', m.toolResult || '', !!m.toolError],
                    ];
                }

                // гармошка в карточке: нативный <details>, своего JS на раскрытие нет.
                // Секции сверяются по подписи и переиспользуются — иначе живая
                // перестройка закрывала бы раскрытую секцию раз в секунду
                function applyNodeFacts(n, m) {
                    const sections = sessionFacts(m).filter(([, text]) => text);
                    let box = n.querySelector('.flow-node__facts');
                    if (!sections.length) {
                        if (box) box.remove();
                        return;
                    }
                    if (!box) {
                        box = document.createElement('div');
                        box.className = 'flow-node__facts';
                        n.querySelector('.flow-node__body').after(box);
                    }
                    const items = [];
                    for (const [label, text, isError] of sections) {
                        let item = [...box.children].find((el) => el.dataset.label === label);
                        if (!item) {
                            item = document.createElement('details');
                            item.className = 'flow-node__fact';
                            item.dataset.label = label;
                            const summary = document.createElement('summary');
                            summary.className = 'flow-node__fact-summary';
                            summary.textContent = label;
                            const pre = document.createElement('pre');
                            pre.className = 'flow-node__fact-text';
                            item.append(summary, pre);
                        }
                        item.classList.toggle('flow-node__fact--error', isError);
                        const pre = item.querySelector('.flow-node__fact-text');
                        // «свои слова» правятся прямо здесь и уходят в саму сессию
                        // (см. focusout ниже); остальные секции — запись факта, только чтение.
                        // Присваиваем, только если значение меняется: переустановка
                        // contentEditable у поля в фокусе сбивает каретку, а перестройка
                        // при живом ходе идёт раз в секунду
                        const editable = m.role === 'user' && label === 'What happened';
                        const want = editable ? 'true' : 'false';
                        if (pre.contentEditable !== want) pre.contentEditable = want;
                        pre.classList.toggle('flow-node__fact-text--editable', editable);
                        // пока поле в фокусе, живая перестройка не должна затирать набранное
                        if (pre.textContent !== text && document.activeElement !== pre) {
                            pre.textContent = text;
                            pre.dataset.saved = text;
                        }
                        items.push(item);
                    }
                    for (const el of [...box.children]) {
                        if (!items.includes(el)) el.remove();
                    }
                    // порядок восстанавливаем только когда он вправду нарушен: секция
                    // «что вышло» появляется позже остальных, когда сервер дописывает
                    // результат вызова. append переносит узел (удаляет и вставляет
                    // заново), а перенос снимает фокус — правка реплики во время живого
                    // хода теряла бы каретку на каждой перестройке
                    const ordered = items.length === box.children.length
                        && items.every((el, i) => box.children[i] === el);
                    if (!ordered) box.append(...items);
                }

                // файл, которого коснулся шаг: путь берём из аргументов вызова.
                // Разделители приводим к одному виду — иначе один и тот же файл,
                // названный то абсолютным путём, то относительным, даст две ноды
                function toolFilePath(m) {
                    if (m.role !== 'tool' || !m.toolInput) return null;
                    try {
                        const input = JSON.parse(m.toolInput);
                        if (input.file_path) return String(input.file_path).split('\\').join('/');
                        // вызов Skill читает целиком SKILL.md в контекст — тот же факт,
                        // что и Read, только путь не приходит полем, а собирается по
                        // имени навыка. Скоуп «plugin:skill»/«dir:skill» неоднозначен
                        // (без плагина или лишней папки не собрать верный путь без
                        // догадок) — на таких молчим, чем дорисовывать наугад
                        if (m.toolName === 'Skill' && input.skill && !String(input.skill).includes(':')) {
                            return `.claude/skills/${input.skill}/SKILL.md`;
                        }
                        return null;
                    } catch { return null; }
                }

                // пути документов, которых коснулось сообщение. Обычный шаг — один путь
                // из toolInput.file_path (Read/Edit/…). CLAUDE.md и файл авто-памяти в
                // трассу так не попадают вовсе: CLI подмешивает их в системный промпт до
                // первого хода агента, вызова инструмента под это нет (см. TASKS.md,
                // «Чего в плане нет и почему», и DOCS/decisions/019 — единственный честный
                // канал для такого факта это хук). SessionStart-хук
                // (.claude/hooks/context-files-node.js) сообщает реально загруженные им
                // файлы списком в stdout — эта функция достаёт их из строки роли hook
                function messageFilePaths(m) {
                    const single = toolFilePath(m);
                    if (single) return [single];
                    if (m.role !== 'hook' || !m.toolResult) return [];
                    try {
                        const parsed = JSON.parse(m.toolResult);
                        if (!Array.isArray(parsed.contextFiles)) return [];
                        return parsed.contextFiles.map((p) => String(p).split('\\').join('/'));
                    } catch { return []; }
                }

                // короткий детерминированный ключ пути: сам путь в id ноды не положить —
                // слэши и точки ломают селектор, а хэша хватает, чтобы одна и та же
                // строка всегда давала одну и ту же ноду
                function pathKey(path) {
                    let h = 0;
                    for (let i = 0; i < path.length; i++) h = (Math.imul(h, 31) + path.charCodeAt(i)) | 0;
                    return (h >>> 0).toString(36);
                }

                // нода документа: заголовок — имя файла, тело — полный путь, кнопка
                // открывает его в том же окне файла, что и клик по узлу графа
                function applyFileNode(n, path) {
                    setNodeTexts(n, path.split('/').pop(), path);
                    setNodeKind(n, 'doc', '🗒️', false);
                    setNodeScope(n, 'system');
                    setNodeType(n, 'system');
                    n.dataset.file = path;
                    if (!n.querySelector('.flow-node__open')) {
                        const btn = document.createElement('button');
                        btn.type = 'button';
                        btn.className = 'flow-node__open';
                        btn.textContent = 'Open file';
                        n.querySelector('.flow-node__body').after(btn);
                    }
                }

                // пустая нода-заглушка: не из сессии, ни с чем не соединена и ничего в
                // себе не несёт. Всё, что пользователь в неё вписал или чем связал,
                // выводит ноду из этой категории — такую не удаляем
                function isBlankPlaceholder(n) {
                    if (n.dataset.session || n === node || n === startNode) return false;
                    if (edges.some((e) => e.from === n || e.to === n)) return false;
                    const texts = loadTexts();
                    if (['title', 'subtitle', 'body'].some((f) => texts[`${n.id}:${f}`])) return false;
                    return !loadQuestions()[n.id] && !loadTypes()[n.id];
                }

                // ребро, которым пользователь привязал свою ноду к ноде сессии, пережило
                // перезагрузку, а его нода сессии появляется только сейчас — досоздаём.
                // То, чему ноды всё ещё нет (выбрана другая сессия), остаётся ждать
                function applyPendingEdges() {
                    if (!pendingEdges.length) return;
                    const byId = new Map([...nodeFlow.keys()].map((n) => [n.id, n]));
                    pendingEdges = pendingEdges.filter((e) => {
                        const from = byId.get(e.from);
                        const to = byId.get(e.to);
                        if (!from || !to) return true;
                        if (!edges.some((x) => x.to === to)) createEdge(from, to, null, e.direction);
                        return false;
                    });
                }

                // содержимое ноды сессии целиком — вид, заголовок, тело и секции
                function applySessionNode(n, m) {
                    // позиция строки в сессии — адрес для правки текста на сервере
                    n.dataset.position = m.position;
                    const kind = nodeKindOf(m);
                    // в теле — только превью: полный текст живёт в секции «what happened»
                    setNodeTexts(n, kind.title, truncate(m.text, 200));
                    setNodeKind(n, kind.kind, kind.emoji, m.toolError);
                    applyNodeFacts(n, m);
                    setNodeScope(n, 'system');
                    setNodeType(n, 'system');
                }

                // строит граф канваса `flow` из сообщений сессии: белый текст (роли
                // user/assistant) идёт цепочкой вправо, серый текст (роль tool, шаги
                // между вопросом и ответом) — вертикальной цепочкой под ним, потому что
                // белый текст — причина, по которой эти шаги вообще появились
                buildSessionFlow = (flow, messages, sessionId) => {
                    beginFlowBatch();
                    bulkBuild = true;
                    try {
                        buildSessionNodes(flow, messages, sessionId);
                    } finally {
                        bulkBuild = false;
                        // падение посреди построения не должно оставить запись состояния
                        // выключенной навсегда — иначе канвас перестанет сохраняться молча
                        flushFlowBatch();
                    }
                };

                function buildSessionNodes(flow, messages, sessionId) {
                    setActiveFlow(flow);
                    // выбор другой сессии в списке (#flowSessionSelect) должен показывать
                    // ЕЁ граф, а не добавлять его поверх прежнего: ноды предыдущей
                    // просмотренной сессии на этом канвасе никак иначе не убираются —
                    // без этой чистки переключение выглядело так, будто канвас не
                    // изменился (старое дерево оставалось на месте, новое пряталось
                    // среди/позади него после общей autoLayoutAndFit)
                    for (const n of [...nodeFlow.keys()]) {
                        if (nodeFlow.get(n) === flow && n.dataset.session && n.dataset.session !== sessionId) deleteNode(n);
                    }
                    // на пустом канвасе заглушка заводится «чтобы было от чего расти»
                    // (ensureRootNode). Графу сессии расти есть от чего и без неё, а
                    // оставшись, она копится: канвас обрастал пустыми карточками от
                    // прошлых открытий, и одна такая уже успела уехать в сохранённое
                    // состояние — поэтому убираем не только что созданную, а любую
                    // пустую и ни с чем не связанную ноду этого канваса
                    if (messages.length) {
                        for (const n of [...nodeFlow.keys()]) {
                            if (nodeFlow.get(n) === flow && isBlankPlaceholder(n)) deleteNode(n);
                        }
                    }

                    // ноды этой сессии узнаются по префиксу id (см. nextNodeId): сообщение,
                    // которое уже стоит на канвасе, переиспользуется и лишь обновляется —
                    // иначе раскрытая гармошка и выделение схлопывались бы при каждой живой
                    // перестройке (раз в секунду, см. flow-session-sync.js). Всё, что
                    // пользователь вставил руками, префикса не имеет и не трогается вовсе
                    const prefix = `flowNode_${sessionId}_`;
                    const mine = new Map();
                    for (const n of nodeFlow.keys()) {
                        if (nodeFlow.get(n) === flow && n.dataset.session === sessionId) mine.set(n.id, n);
                    }

                    let lastWhite = null;            // конец главной цепочки вправо
                    let lastGray = null;             // конец текущей цепочки шагов вниз
                    const byToolUse = new Map();     // toolUseId -> нода этого вызова
                    const lastInBranch = new Map();  // parentToolUseId -> конец ветки субагента
                    const files = new Map();         // путь файла -> его единственная нода

                    for (let i = 0; i < messages.length; i++) {
                        const m = messages[i];
                        // адрес ноды — позиция строки в базе, а не номер в массиве:
                        // по ней же идёт правка сообщения (/api/sessions/message/set)
                        const id = prefix + (m.position ?? i);
                        // шаг субагента принадлежит не главной цепочке, а ноде вызова,
                        // внутри которого он произошёл (единственная настоящая причинная
                        // связь, которая есть в базе, — см. TASKS.md)
                        const branch = m.parentToolUseId && byToolUse.has(m.parentToolUseId) ? m.parentToolUseId : null;

                        let parent, direction;
                        if (branch) {
                            parent = lastInBranch.get(branch) || byToolUse.get(branch);
                            direction = 'vertical';
                        } else if (m.role === 'tool') {
                            parent = lastGray || lastWhite;
                            direction = 'vertical';
                        } else {
                            parent = lastWhite;
                            direction = 'horizontal';
                        }
                        // сессия может начаться не с реплики (первым идёт хук или tool) —
                        // тогда цепляемся к тому, что уже есть, а самая первая нода станет корнем
                        if (!parent) parent = lastGray || lastWhite;

                        let node = mine.get(id);
                        if (node) {
                            mine.delete(id);
                            // родитель мог измениться задним числом: tool_use_id/parent_tool_use_id
                            // сервер дописывает отдельным UPDATE уже после самой строки
                            const inEdge = edges.find((e) => e.to === node);
                            // ребро, пришедшее от ноды пользователя, — его вставка в
                            // цепочку (плюс на ребре). Чинить её нельзя: перестройка
                            // выкинула бы вставленную ноду из графа через секунду
                            const fromUser = inEdge && !inEdge.from.dataset.session;
                            if (parent && !fromUser && (!inEdge || inEdge.from !== parent || inEdge.direction !== direction)) {
                                if (inEdge) removeEdge(inEdge);
                                createEdge(parent, node, null, direction);
                            }
                        } else if (!parent) {
                            node = ensureRootNode(flow, id, sessionId);
                        } else {
                            // пометку ставим до создания ребра: savePosition/saveGraph
                            // внутри addChildNode* уже должны видеть ноду как сессионную
                            node = direction === 'vertical' ? addChildNode(parent, id, sessionId) : addChildNodeRight(parent, id, sessionId);
                        }

                        applySessionNode(node, m);

                        // документ, которого коснулся шаг: одна нода на путь во всей
                        // сессии. У неё, как и у любой другой ноды, ровно одно входящее
                        // ребро — от САМОГО СВЕЖЕГО использования (сообщения идут по
                        // порядку, поэтому «свежее» здесь — просто «текущее» на этом
                        // проходе). Раньше ребро добавлялось от каждого использования и
                        // копилось: на сессии с десятком правок одного файла в общую ноду
                        // документа сходилось столько же стрелок из совершенно разных
                        // веток дерева — раскладка умеет держать позицию только по одному
                        // родителю, а остальные рёбра рисовались поверх, задевая чужие
                        // ноды. Один родитель, который просто переезжает к новому
                        // использованию, — и лишних стрелок нет в принципе
                        for (const filePath of messageFilePaths(m)) {
                            const fileId = `${prefix}file_${pathKey(filePath)}`;
                            let fileNode = files.get(filePath) || mine.get(fileId);
                            if (!fileNode) {
                                fileNode = addChildNodeRight(node, fileId, sessionId);
                            } else {
                                const inEdge = edges.find((e) => e.to === fileNode);
                                if (!inEdge || inEdge.from !== node) {
                                    if (inEdge) removeEdge(inEdge);
                                    createEdge(node, fileNode, null, 'horizontal');
                                }
                            }
                            mine.delete(fileId);
                            files.set(filePath, fileNode);
                            applyFileNode(fileNode, filePath);
                        }

                        if (m.toolUseId) byToolUse.set(m.toolUseId, node);
                        if (branch) lastInBranch.set(branch, node);
                        else if (m.role === 'tool') lastGray = node;
                        else { lastWhite = node; lastGray = null; }
                    }

                    // сообщение исчезло (сессия перечитана короче) — его нода уходит с ним
                    for (const n of mine.values()) deleteNode(n);
                    applyPendingEdges();
                    // канвас без единой ноды: заводим заглушку, чтобы было от чего расти
                    ensureRootNode(flow);
                    // единственные за всё построение сохранение и раскладка: отдельные
                    // ноды их не звали (bulkBuild), иначе на полусотне сообщений вкладка
                    // замирала на несколько секунд
                    saveGraph();
                    autoLayoutAndFit();
                }
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

            // buildFromSession могли дёрнуть, пока грузилось состояние (см. pendingBuild
            // в начале файла) — достраиваем граф теперь, когда buildSessionFlow готов
            if (pendingBuild) {
                buildSessionFlow(pendingBuild.flow, pendingBuild.messages, pendingBuild.sessionId);
                pendingBuild = null;
            }

            // window.MissionFlow.center() уже могли дёрнуть, пока грузилось состояние
            // выше (см. pendingCenter в начале файла) — обрабатываем этот случай сразу
            // после того, как canvas собран и centerFlowNode получил реальное значение
            if (pendingCenter && centerFlowNode) {
                pendingCenter = false;
                centerFlowNode();
                centerFlowNode = null;
            }

            // сигнал «вкладка Flow готова»: состояние доехало, меню и канвас собраны,
            // активный flow восстановлен. Слушает flow-session-sync.js — до этого
            // момента строить граф из сессии рано (активный flow ещё неизвестен)
            document.dispatchEvent(new CustomEvent('flow-ready'));
            }
})();
