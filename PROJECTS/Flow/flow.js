// Вкладка Flow целиком: полотно с зумом и панорамированием плюс карточка ноды
// (стили — PROJECTS/Flow/flow.css, разметка — PROJECTS/Flow/flow.eta через
// /api/fragment/flow; #flowView в SYSTEM/index.html остаётся только контейнером).
// Сам этот файл — только сборка: хранилище состояния, порядок модулей и отложенные
// вызовы. Всё предметное разложено по темам в соседних файлах, каждый отвечает за
// одну: меню, полотно, состояние ноды, панели профиля, селекторы, рёбра, раскладка,
// правка в карточке, ноды сессии. Правило — DOCS/decisions/022, файл длиннее 400 строк
// делить; до этого деления здесь было 3126 строк на всё сразу.
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
        // sessionId нужен для id нод (flowNode_<сессия>_<позиция>): по нему же
        // перестройка отличает свои ноды от заведённых руками
        buildFromSession(flow, messages, sessionId) {
            if (buildSessionFlow) buildSessionFlow(flow, messages, sessionId);
            else pendingBuild = { flow, messages, sessionId };
        },
    };

    // состояние канваса с сервера — условие, снимающее заслон первой сборки
    // страницы (SYSTEM/boot.js): незагруженный Flow рисуется пустым, и страница
    // открылась бы наполовину собранной
    window.MissionBoot?.task('flow', init());
    async function waitForFlowMarkup() {
        const hardDeadline = Date.now() + 10000;
        while (!document.getElementById('flowCanvas')) {
            if (Date.now() > hardDeadline) return;
            await new Promise((r) => setTimeout(r, 50));
        }
    }
    async function init() {

    // хранилище вкладки Flow целиком — раньше localStorage, теперь БД
    // (см. /api/flow/state в PROJECTS/Flow/flow-server.js); ключи 1-в-1 со старыми именами
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
    // Разметка полотна приходит серверным фрагментом (PROJECTS/Flow/flow.eta →
    // /api/fragment/flow, hx-get на #flowBody), поэтому сначала ждём её появления:
    // без этого init трогал бы document и запускал FlowCanvas до того, как htmx
    // вставил ответ. Заслон boot.js её уже отслеживает, но порядок событий
    // здесь надёжнее, чем тайминг htmx:afterSettle.
    await waitForFlowMarkup();
    const startMeta = document.getElementById('flowNodeStartMeta');
    if (startMeta) {
        startMeta.textContent = '';
        const projectLine = document.createElement('span');
        projectLine.textContent = 'noname';
        const dateLine = document.createElement('span');
        dateLine.textContent = new Date().toLocaleString('ru-RU');
        startMeta.append(projectLine, dateLine);
    }

    // ctx — единственное место, где живёт общее состояние вкладки: элементы
    // канваса, вид (зум и смещение), набор нод и рёбер, счётчик id и отложенные
    // вызовы. Каждый модуль кладёт в него свои функции и берёт чужие оттуда же,
    // поэтому порядок сборки ниже важен только для того, что случается сразу
    // при загрузке (создание нод и первой дуги) — всё остальное случается по
    // событию, когда модули уже все на месте
    const ctx = {
        flowGet,
        flowSet,
        beginFlowBatch,
        flushFlowBatch,

        // элементы полотна и шаблон карточки — заполняет flow-canvas.js
        canvas: null,
        surface: null,
        edgesLayer: null,
        nodeTemplate: null,
        node: null,
        startNode: null,
        // зазоры между нодами и потолки масштаба: ими пользуется раскладка
        NODE_GAP: 0,
        NODE_GAP_Y: 0,
        MIN_SCALE: 0,
        MAX_SCALE: 0,
        START_X: 0,
        START_Y: 0,

        // вид полотна: зум и смещение. Общий механизм на все пункты меню,
        // у каждого пункта своя сохранённая пара (см. flow-canvas.js)
        view: { x: 0, y: 0, scale: 1 },
        // какой пункт меню открыт и какие ноды принадлежат какому канвасу
        currentFlow: 'New',
        nodeFlow: null,
        // граф: рёбра, рёбра в ожидании своей ноды сессии, счётчик id
        edges: [],
        pendingEdges: [],
        nodeSeq: 0,
        // идёт построение графа сессии. Каждая нода в одиночку зовёт раскладку,
        // сохранение и отрисовку дуг; на пятидесяти нодах это давало пять секунд
        // замершей вкладки, хотя нужен один пересчёт — в самом конце
        bulkBuild: false,
        // выделение ноды или ребра — по нему работает Delete
        selectedNode: null,
        selectedEdge: null,
        // отложенные вызовы, которые модули назначают при своей загрузке
        setActiveFlow: null,
        centerFlowNode: null,
        buildSessionFlow: null,
    };

    // Порядок сборки. Меню идёт первым: активный пункт оттуда становится
    // открытым канвасом. Полотно — вторым: от него модули нод берут канвас,
    // шаблон карточки и обе стартовые ноды. Дальше — всё, что работает по
    // событию и порядка не требует, но перечислено в порядке чтения: состояние
    // ноды, панели профиля, селекторы, рёбра, раскладка, ноды сессии,
    // правка в карточке
    window.FlowNav(ctx);
    window.FlowCanvas(ctx);
    window.FlowNodeState(ctx);
    window.FlowNodeTree(ctx);
    window.FlowPanelData(ctx);
    window.FlowPanels(ctx);
    window.FlowSelects(ctx);
    window.FlowEdges(ctx);
    window.FlowLayout(ctx);
    window.FlowSessionNode(ctx);
    window.FlowSessionBuild(ctx);
    window.FlowEdit(ctx);
    window.FlowPanelsEdit(ctx);

    // отложенные вызовы, которые модули записали в ctx, выносим в переменные
    // выше: их дёргает панель вкладок ещё до того, как init дошёл до конца
    centerFlowNode = ctx.centerFlowNode;
    buildSessionFlow = ctx.buildSessionFlow;

    // начальная пара нод канваса New: заглушка Start и карточка Секретаря,
    // соединённые готовой дугой из разметки (#flowEdgeStart)
    ctx.attachAddBottom(ctx.startNode);
    ctx.attachAddRight(ctx.startNode);
    ctx.attachAddBottom(ctx.node);
    ctx.attachAddRight(ctx.node);
    ctx.createEdge(ctx.startNode, ctx.node, document.getElementById('flowEdgeStart'), 'horizontal');

    // buildFromSession могли дёрнуть, пока грузилось состояние (см. pendingBuild
    // выше) — достраиваем граф теперь, когда buildSessionFlow готов
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
