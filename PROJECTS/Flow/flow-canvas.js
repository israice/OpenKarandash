// Полотно вкладки Flow: зум колёсиком и кнопками, панорамирование перетаскиванием
// фона, сохранённый вид (x/y/scale) для каждого пункта меню. Сам механизм один на
// все канвасы — у пункта меню свои только ноды (nodeFlow) и свой сохранённый вид.
//
// В ctx этот модуль кладёт элементы полотна и шаблоны карточки (canvas, surface,
// edgesLayer, nodeTemplate, node, startNode), зазоры NODE_GAP/NODE_GAP_Y, потолки
// масштаба и три функции, которыми пользуются остальные: applyViewport(),
// surfacePoint() и setView(). Остальное состояние нод — в flow-node-state.js.
(function () {
    window.FlowCanvas = function (ctx) {
        const { flowGet, flowSet, view } = ctx;

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

        const GRID_SIZE = 28;

        // каждый пункт меню слева — свой канвас: свой набор нод (nodeFlow)
        // и свой zoom/pan (VIEWS), общий только сам механизм отрисовки
        const currentFlow = ctx.initialActiveItem ? ctx.initialActiveItem.dataset.flow : 'New';
        ctx.currentFlow = currentFlow;
        const nodeFlow = new Map();
        ctx.nodeFlow = nodeFlow;

        ctx.canvas = canvas;
        ctx.surface = surface;
        ctx.edgesLayer = document.getElementById('flowEdges');
        ctx.nodeTemplate = document.getElementById('flowNodeTemplate');
        ctx.MIN_SCALE = MIN_SCALE;
        ctx.MAX_SCALE = MAX_SCALE;
        ctx.START_X = START_X;
        ctx.START_Y = START_Y;

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
            views[currentFlow] = { x: view.x, y: view.y, scale: view.scale };
            flowSet(VIEW_KEY, views);
        }
        (() => {
            const saved = loadViews()[currentFlow];
            if (saved) {
                view.x = saved.x;
                view.y = saved.y;
                view.scale = saved.scale;
            }
        })();

        function applyViewport() {
            surface.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
            // фон-сетка на контейнере не привязана к слою узлов — двигаем и
            // масштабируем её тем же x/y/scale, иначе она разъедется с узлами
            canvas.style.backgroundPosition = `${view.x}px ${view.y}px`;
            canvas.style.backgroundSize = `${GRID_SIZE * view.scale}px ${GRID_SIZE * view.scale}px`;
            zoomValue.textContent = Math.round(view.scale * 100) + '%';
        }

        // масштабирование к точке под курсором, чтобы она осталась на месте
        function zoomAt(clientX, clientY, factor) {
            const rect = canvas.getBoundingClientRect();
            const px = clientX - rect.left;
            const py = clientY - rect.top;
            const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, view.scale * factor));
            view.x = px - (px - view.x) * (newScale / view.scale);
            view.y = py - (py - view.y) * (newScale / view.scale);
            view.scale = newScale;
            applyViewport();
            saveView();
        }

        canvas.addEventListener('wheel', (e) => {
            // внутри прокручиваемых частей ноды (текст раскрытой секции,
            // вертикальное меню личной ноды QA, списки её MCP и Soul) колесо листает их, а не зумит
            // канвас: иначе до конца длинного результата вызова и до нижних
            // кнопок меню не добраться. Но только пока там есть что листать —
            // над коротким содержимым колесо зумит, как и над всей картой
            const scrollable = e.target.closest('.flow-node__fact-text, .flow-node__menu, .flow-node__mcp-list, .flow-node__soul-list, .flow-node__prompt-list, .flow-node__thinking-list, .flow-node__permissions-list, .flow-node__tools-list, .flow-node__llm-list, .flow-node__skills-list, .flow-node__agents-list, .flow-node__memory-list');
            if (scrollable && scrollable.scrollHeight > scrollable.clientHeight) return;
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
        layoutReset.addEventListener('click', () => ctx.autoLayoutAndFit());
        // обнуление канваса: убираем всё, что накидали поверх нод по умолчанию
        // (на New это стартовая пара node/startNode, на остальных канвасах
        // дефолта нет — ensureRootNode сразу поставит пустую ноду-заглушку)
        canvasReset.addEventListener('click', async () => {
            const ok = await App.confirmModal('Remove all added nodes on this canvas?', { title: 'Clear canvas' });
            if (!ok) return;
            const keep = ctx.currentFlow === 'New' ? new Set([ctx.node, ctx.startNode]) : new Set();
            for (const n of [...nodeFlow.keys()]) {
                if (nodeFlow.get(n) === ctx.currentFlow && !keep.has(n)) ctx.deleteNode(n);
            }
            ctx.ensureRootNode(ctx.currentFlow);
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
            originX = view.x;
            originY = view.y;
            canvas.classList.add('flow-canvas--panning');
        });

        window.addEventListener('mousemove', (e) => {
            if (!panning) return;
            view.x = originX + (e.clientX - startX);
            view.y = originY + (e.clientY - startY);
            applyViewport();
        });

        window.addEventListener('mouseup', () => {
            if (panning) saveView();
            panning = false;
            canvas.classList.remove('flow-canvas--panning');
        });

        applyViewport();

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
        ctx.node = node;
        ctx.startNode = startNode;
        ctx.NODE_GAP = NODE_GAP;
        ctx.NODE_GAP_Y = NODE_GAP_Y;

        // клиентские координаты курсора -> локальные координаты surface
        // (те же, в которых живут left/top нод), с поправкой на pan/zoom канваса
        function surfacePoint(clientX, clientY) {
            const rect = canvas.getBoundingClientRect();
            return { x: (clientX - rect.left - view.x) / view.scale, y: (clientY - rect.top - view.y) / view.scale };
        }

        // подставить сохранённый (или исходный) вид канваса и применить его.
        // Зовут переключение пункта меню и раскладка с вписыванием (autoLayoutAndFit)
        function setView(flow, x, y, scale) {
            view.x = x !== undefined ? x : START_X;
            view.y = y !== undefined ? y : START_Y;
            view.scale = scale !== undefined ? scale : 1;
            applyViewport();
        }

        ctx.applyViewport = applyViewport;
        ctx.surfacePoint = surfacePoint;
        ctx.setView = setView;
        ctx.saveView = saveView;
    };
})();
