// Вкладка Flow: полотно с зумом и панорамированием плюс карточка ноды.
// Центрирование ноды отложено до первого показа вкладки — панель вкладок
// дёргает MissionFlow.center(), когда размеры канваса уже посчитаны.
(function () {
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

            // меню Flows повторяет разделы доски
            const flowNav = document.getElementById('flowNav');
            for (const title of App.BOARD_COLUMNS) {
                const item = document.createElement('button');
                item.type = 'button';
                item.className = 'side-nav__item';
                item.dataset.flow = title;
                item.textContent = title;
                flowNav.append(item);
            }

            // отдельная категория Temp — черновые кнопки, не связанные с колонками доски
            const tempTitle = document.createElement('h2');
            tempTitle.className = 'side-nav__title';
            tempTitle.textContent = 'Temp';
            flowNav.append(tempTitle);

            const sandboxItem = document.createElement('button');
            sandboxItem.type = 'button';
            sandboxItem.className = 'side-nav__item';
            sandboxItem.dataset.flow = 'sandbox';
            sandboxItem.textContent = 'sandbox';
            flowNav.append(sandboxItem);

            // канвас Flows: пока только полотно — zoom колёсиком/кнопками и pan перетаскиванием фона
            let centerFlowNode = null;
            (() => {
                const canvas = document.getElementById('flowCanvas');
                const surface = document.getElementById('flowSurface');
                const zoomValue = document.getElementById('flowZoomValue');
                const zoomIn = document.getElementById('flowZoomIn');
                const zoomOut = document.getElementById('flowZoomOut');
                const zoomReset = document.getElementById('flowZoomReset');

                const MIN_SCALE = 0.3;
                const MAX_SCALE = 2;
                const START_X = 0;
                const START_Y = 0;

                let scale = 1;
                let x = START_X;
                let y = START_Y;

                const GRID_SIZE = 28;

                // положение и зум канваса переживают перезагрузку страницы, как и
                // позиции нод — иначе при возврате на вкладку Flow пользователя каждый
                // раз кидает в исходную точку вместо того места, где он остановился
                const VIEW_KEY = 'flowCanvasView';
                function saveView() {
                    localStorage.setItem(VIEW_KEY, JSON.stringify({ x, y, scale }));
                }
                (() => {
                    try {
                        const saved = JSON.parse(localStorage.getItem(VIEW_KEY));
                        if (saved) {
                            x = saved.x;
                            y = saved.y;
                            scale = saved.scale;
                        }
                    } catch {}
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
                zoomReset.addEventListener('click', () => autoLayoutAndFit());

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

                // позиции нод переживают перезагрузку страницы через localStorage
                // v2: старые сохранённые позиции ставили новые ноды впритык к соседям —
                // сбрасываем кеш, чтобы раздвижка при вставке отработала на чистом layout'е
                const POS_KEY = 'flowNodePositions2';
                function loadPositions() {
                    try {
                        return JSON.parse(localStorage.getItem(POS_KEY)) || {};
                    } catch {
                        return {};
                    }
                }
                function savePosition(el) {
                    const all = loadPositions();
                    all[el.id] = { left: el.offsetLeft, top: el.offsetTop };
                    localStorage.setItem(POS_KEY, JSON.stringify(all));
                }

                // граф вставленных узлов (id-рёбра + счётчик id) переживает перезагрузку
                // отдельно от позиций — иначе после reload вставленная нода и её рёбра
                // просто пропадают, хотя left/top для неё уже сохранены
                // v2: старые графы сохранялись без direction — при восстановлении ребро
                // получало undefined и createEdge молча превращал его в 'horizontal',
                // из-за чего кнопка reset схлопывала любое дерево в одну строку
                const GRAPH_KEY = 'flowNodeGraph2';
                function loadGraph() {
                    try {
                        return JSON.parse(localStorage.getItem(GRAPH_KEY));
                    } catch {
                        return null;
                    }
                }
                function saveGraph() {
                    localStorage.setItem(GRAPH_KEY, JSON.stringify({
                        nodeSeq,
                        edges: edges.map((e) => ({ from: e.from.id, to: e.to.id, direction: e.direction })),
                    }));
                }

                // восстанавливаем клоны шаблона по id из графа и перестраиваем рёбра;
                // вызывается один раз при первом показе вкладки, до отрисовки рёбер
                function restoreGraph() {
                    const graph = loadGraph();
                    if (!graph || !graph.edges || !graph.edges.length) return;

                    const positions = loadPositions();
                    const byId = { [startNode.id]: startNode, [node.id]: node };
                    for (const e of graph.edges) {
                        for (const id of [e.from, e.to]) {
                            if (byId[id]) continue;
                            const clone = nodeTemplate.content.firstElementChild.cloneNode(true);
                            clone.id = id;
                            surface.append(clone);
                            attachAddBottom(clone);
                            attachAddRight(clone);
                            if (positions[id]) {
                                clone.style.left = positions[id].left + 'px';
                                clone.style.top = positions[id].top + 'px';
                            }
                            byId[id] = clone;
                        }
                    }
                    nodeSeq = Math.max(nodeSeq, graph.nodeSeq || 0);

                    for (const e of [...edges]) removeEdge(e);
                    for (const e of graph.edges) {
                        if (byId[e.from] && byId[e.to]) createEdge(byId[e.from], byId[e.to], null, e.direction);
                    }
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
                    drawEdge();
                };

                // рёбра между нодами хранятся списком, чтобы ребро можно было
                // разрезать надвое вставкой узла посередине
                const edgesLayer = document.getElementById('flowEdges');
                const nodeTemplate = document.getElementById('flowNodeTemplate');
                let nodeSeq = 0;
                const edges = [];

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

                // сдвигаем узел и всё, что от него отходит дальше по рёбрам,
                // на delta вправо (delta < 0 — влево, используется раздвижкой чужих
                // веток в pushAwayCollisions) — иначе после раздвижки ближайшего
                // соседа следующие за ним ноды остаются на месте и вставленный узел
                // наезжает на них визуально
                function shiftChainRight(startFrom, delta, seen) {
                    if (!delta) return;
                    startFrom.style.left = Math.round(startFrom.offsetLeft + delta) + 'px';
                    savePosition(startFrom);
                    for (const e of edges) {
                        if (e.from !== startFrom || seen.has(e.to)) continue;
                        seen.add(e.to);
                        shiftChainRight(e.to, delta, seen);
                    }
                }

                // та же каскадная раздвижка, но вниз — для вертикальных рёбер
                function shiftChainDown(startFrom, delta, seen) {
                    if (delta <= 0) return;
                    startFrom.style.top = Math.round(startFrom.offsetTop + delta) + 'px';
                    savePosition(startFrom);
                    for (const e of edges) {
                        if (e.from !== startFrom || seen.has(e.to)) continue;
                        seen.add(e.to);
                        shiftChainDown(e.to, delta, seen);
                    }
                }

                // разрезаем ребро надвое: клон шаблона встаёт в середину дуги,
                // старое ребро уступает место двум новым
                function insertNodeOnEdge(edge) {
                    const g = edgeGeometry(edge.from, edge.to, edge.direction);
                    const mid = edgeMidpoint(g);

                    const newNode = nodeTemplate.content.firstElementChild.cloneNode(true);
                    newNode.id = 'flowNode_' + (++nodeSeq) + '_' + Date.now();
                    surface.append(newNode);
                    attachAddBottom(newNode);
                    attachAddRight(newNode);
                    newNode.style.left = Math.round(mid.x - newNode.offsetWidth / 2) + 'px';
                    newNode.style.top = Math.round(mid.y - newNode.offsetHeight / 2) + 'px';

                    // новая нода встаёт между from и to — раздвигаем их, если места не хватает,
                    // чтобы она не легла поверх соседей; сдвиг from->to кладём каскадом
                    // на всю цепочку нод за to, чтобы не наехать и на них
                    const from = edge.from, to = edge.to;
                    if (edge.direction === 'vertical') {
                        const minTop = from.offsetTop + from.offsetHeight + NODE_GAP;
                        if (newNode.offsetTop < minTop) newNode.style.top = minTop + 'px';
                        const minToTop = newNode.offsetTop + newNode.offsetHeight + NODE_GAP;
                        const delta = minToTop - to.offsetTop;
                        if (delta > 0) shiftChainDown(to, delta, new Set([to]));
                    } else {
                        const minLeft = from.offsetLeft + from.offsetWidth + NODE_GAP;
                        if (newNode.offsetLeft < minLeft) newNode.style.left = minLeft + 'px';
                        const minToLeft = newNode.offsetLeft + newNode.offsetWidth + NODE_GAP;
                        const delta = minToLeft - to.offsetLeft;
                        if (delta > 0) shiftChainRight(to, delta, new Set([to]));
                    }

                    savePosition(newNode);

                    removeEdge(edge);
                    createEdge(from, newNode, null, edge.direction);
                    createEdge(newNode, to, null, edge.direction);
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
                    const btn = document.createElement('button');
                    btn.type = 'button';
                    btn.className = 'flow-node__add-bottom';
                    btn.textContent = '+';
                    btn.title = 'Добавить узел (или перетащить к другой ноде, чтобы соединить)';
                    n.append(btn);
                    btn.addEventListener('mousedown', (e) => startConnecting(e, n, 'vertical'));
                }

                // расставляет все нижние дочерние узлы `from` в один горизонтальный ряд,
                // чтобы новый добавленный узел не перекрывал уже существующие
                function layoutBottomChildren(from) {
                    const children = edges.filter((e) => e.from === from && e.direction === 'vertical').map((e) => e.to);
                    if (!children.length) return;
                    const totalWidth = children.reduce((sum, n) => sum + n.offsetWidth, 0) + NODE_GAP * (children.length - 1);
                    const top = Math.round(from.offsetTop + from.offsetHeight + NODE_GAP);
                    let left = Math.round(from.offsetLeft + (from.offsetWidth - totalWidth) / 2);
                    for (const child of children) {
                        child.style.left = left + 'px';
                        child.style.top = top + 'px';
                        savePosition(child);
                        layoutBottomChildren(child);
                        left += child.offsetWidth + NODE_GAP;
                    }
                }

                // раздвигаем чужие ветки, оказавшиеся под подросшим поддеревом
                // `subtreeRoot` (после layoutBottomChildren оно могло расшириться и
                // залезть на соседнюю группу) — иначе новый узел просто ложится
                // поверх чужих нод вместо того, чтобы потеснить их
                function pushAwayCollisions(subtreeRoot) {
                    const own = collectDescendants(subtreeRoot);
                    own.add(subtreeRoot);
                    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
                    for (const n of own) {
                        left = Math.min(left, n.offsetLeft);
                        top = Math.min(top, n.offsetTop);
                        right = Math.max(right, n.offsetLeft + n.offsetWidth);
                        bottom = Math.max(bottom, n.offsetTop + n.offsetHeight);
                    }
                    const centerX = (left + right) / 2;
                    const moved = new Set();
                    // несколько проходов: раздвинутая чужая ветка может задеть следующую
                    for (let pass = 0; pass < 3; pass++) {
                        let changed = false;
                        for (const n of surface.querySelectorAll('.flow-node')) {
                            if (own.has(n) || moved.has(n)) continue;
                            const overlapX = n.offsetLeft < right + NODE_GAP && n.offsetLeft + n.offsetWidth > left - NODE_GAP;
                            const overlapY = n.offsetTop < bottom && n.offsetTop + n.offsetHeight > top;
                            if (!overlapX || !overlapY) continue;
                            const seen = new Set([n]);
                            const nCenter = n.offsetLeft + n.offsetWidth / 2;
                            const delta = nCenter >= centerX
                                ? right + NODE_GAP - n.offsetLeft
                                : -(n.offsetLeft + n.offsetWidth + NODE_GAP - left);
                            shiftChainRight(n, delta, seen);
                            for (const s of seen) moved.add(s);
                            changed = true;
                        }
                        if (!changed) break;
                    }
                }

                function addChildNode(from) {
                    const newNode = nodeTemplate.content.firstElementChild.cloneNode(true);
                    newNode.id = 'flowNode_' + (++nodeSeq) + '_' + Date.now();
                    surface.append(newNode);
                    attachAddBottom(newNode);
                    attachAddRight(newNode);
                    newNode.style.left = Math.round(from.offsetLeft + (from.offsetWidth - newNode.offsetWidth) / 2) + 'px';
                    newNode.style.top = Math.round(from.offsetTop + from.offsetHeight + NODE_GAP) + 'px';
                    savePosition(newNode);
                    createEdge(from, newNode, null, 'vertical');
                    layoutBottomChildren(from);
                    pushAwayCollisions(from);
                    saveGraph();
                    drawEdge();
                }

                // плюс у правого края ноды — добавляет новый узел-заглушку справа
                // от текущего, по той же логике, что и attachAddBottom/addChildNode
                function attachAddRight(n) {
                    const btn = document.createElement('button');
                    btn.type = 'button';
                    btn.className = 'flow-node__add-right';
                    btn.textContent = '+';
                    btn.title = 'Добавить узел (или перетащить к другой ноде, чтобы соединить)';
                    n.append(btn);
                    btn.addEventListener('mousedown', (e) => startConnecting(e, n, 'horizontal'));
                }

                function addChildNodeRight(from) {
                    const newNode = nodeTemplate.content.firstElementChild.cloneNode(true);
                    newNode.id = 'flowNode_' + (++nodeSeq) + '_' + Date.now();
                    surface.append(newNode);
                    attachAddBottom(newNode);
                    attachAddRight(newNode);
                    newNode.style.left = Math.round(from.offsetLeft + from.offsetWidth + NODE_GAP) + 'px';
                    newNode.style.top = Math.round(from.offsetTop + (from.offsetHeight - newNode.offsetHeight) / 2) + 'px';
                    savePosition(newNode);
                    createEdge(from, newNode, null, 'horizontal');
                    pushAwayCollisions(newNode);
                    saveGraph();
                    drawEdge();
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

                // раскладка по дереву для кнопки reset. У каждой ноды не больше
                // одного входящего ребра (редактор всегда создаёт новый узел вместе
                // с единственным ребром к нему), поэтому весь граф — дерево, и вместо
                // того чтобы гадать координаты клетка за клеткой (так рёбра соседних
                // веток задевали друг друга), раскладываем по нему честно снизу вверх:
                // горизонтальное ребро продолжает цепочку вправо в той же строке,
                // вертикальное — открывает дочернюю цепочку строкой ниже, и каждое
                // поддерево получает свой непересекающийся диапазон колонок — поэтому
                // ветки никогда не наезжают друг на друга и рёбра не пересекаются
                function autoLayoutAndFit() {
                    const nodes = [...surface.querySelectorAll('.flow-node')];
                    if (!nodes.length) return;

                    const cellW = Math.max(...nodes.map((n) => n.offsetWidth)) + NODE_GAP;
                    const cellH = Math.max(...nodes.map((n) => n.offsetHeight)) + NODE_GAP;

                    const parentEdge = new Map();
                    for (const e of edges) if (!parentEdge.has(e.to)) parentEdge.set(e.to, e);

                    // горизонтальная цепочка — нода и её последовательные "правые"
                    // продолжения; вся цепочка держится в одной строке
                    const chainOf = new Map();
                    for (const n of nodes) {
                        if (chainOf.has(n)) continue;
                        let head = n;
                        let pe = parentEdge.get(head);
                        while (pe && pe.direction === 'horizontal') {
                            head = pe.from;
                            pe = parentEdge.get(head);
                        }
                        if (chainOf.has(head)) continue;
                        const chain = [head];
                        let cur = head;
                        for (;;) {
                            const next = edges.find((e) => e.from === cur && e.direction === 'horizontal');
                            if (!next) break;
                            chain.push(next.to);
                            cur = next.to;
                        }
                        for (const c of chain) chainOf.set(c, chain);
                    }

                    // дочерние цепочки — вертикальные рёбра от любой ноды этой цепочки;
                    // группируем по узлу-креплению (anchor), чтобы несколько прямых
                    // детей одного узла лечь вместе, а не вперемешку с детьми других узлов
                    function chainChildGroups(chain) {
                        const own = new Set(chain);
                        const byAnchor = new Map();
                        for (const e of edges) {
                            if (e.direction !== 'vertical' || !own.has(e.from)) continue;
                            if (!byAnchor.has(e.from)) byAnchor.set(e.from, { anchor: e.from, items: [] });
                            byAnchor.get(e.from).items.push(chainOf.get(e.to));
                        }
                        return [...byAnchor.values()].sort((a, b) => chain.indexOf(a.anchor) - chain.indexOf(b.anchor));
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
                                prevCol = Math.max(Math.round(start + (g.width - 1) / 2), prevCol + 1);
                            } else {
                                prevCol += 1;
                                cursor = Math.max(cursor, prevCol + 1);
                            }
                            memberCol[idx] = prevCol;
                        }
                        return { memberCol, cursor, prevCol };
                    }

                    const widthOf = new Map();
                    const groupsOf = new Map();
                    function measure(chain) {
                        if (widthOf.has(chain)) return widthOf.get(chain);
                        const groups = chainChildGroups(chain);
                        const byIdx = new Map(groups.map((g) => [chain.indexOf(g.anchor), g]));
                        for (const g of groups) g.width = g.items.reduce((sum, c) => sum + measure(c), 0);
                        const { cursor, prevCol } = layoutChainRow(chain, byIdx, 0);
                        const width = Math.max(chain.length, cursor, prevCol + 1);
                        widthOf.set(chain, width);
                        groupsOf.set(chain, byIdx);
                        return width;
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
                    }

                    measure(chainOf.get(startNode));
                    place(chainOf.get(startNode), 0, 0);
                    // ноды без пути от startNode — отдельными деревьями строками ниже
                    for (const n of nodes) {
                        const chain = chainOf.get(n);
                        if (seenChains.has(chain)) continue;
                        measure(chain);
                        place(chain, 0, maxRowSeen + 1);
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
                        const rowCenterY = row * cellH + cellH / 2;
                        n.style.left = Math.round(colCenterX - n.offsetWidth / 2) + 'px';
                        n.style.top = Math.round(rowCenterY - n.offsetHeight / 2) + 'px';
                        savePosition(n);
                    }
                    drawEdge();

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

                // перетаскивание ноды кликом за карточку (кроме кнопки редактирования);
                // позиция хранится прямо в left/top ноды — переживает панорамирование и зум
                let draggedNode = null;
                let dragStartX = 0;
                let dragStartY = 0;
                let dragOriginLeft = 0;
                let dragOriginTop = 0;
                let dragGroup = new Map(); // потомки ноды: node -> {left, top} на старте перетаскивания

                // поддерево, которое таскается вместе с `node`: сперва спускаемся только
                // по вертикальным рёбрам (боковые соседи самой node не в счёт), а дальше
                // от каждого найденного потомка забираем вообще всё, что растёт из него —
                // и вниз, и вправо, со всеми их собственными потомками
                function collectDescendants(node) {
                    const result = new Set();
                    const queue = [];
                    for (const e of edges) {
                        if (e.from === node && e.direction === 'vertical') {
                            result.add(e.to);
                            queue.push(e.to);
                        }
                    }
                    while (queue.length) {
                        const cur = queue.shift();
                        for (const e of edges) {
                            if (e.from === cur && !result.has(e.to)) {
                                result.add(e.to);
                                queue.push(e.to);
                            }
                        }
                    }
                    return result;
                }

                // минимальная дистанция между нодами при перетаскивании — не даём одной наехать на другую
                const MIN_NODE_DISTANCE = 24;
                function resolveCollisions(node, left, top, ignore) {
                    const w = node.offsetWidth, h = node.offsetHeight;
                    const others = surface.querySelectorAll('.flow-node');
                    // несколько проходов: раздвижение от одной ноды может зацепить соседнюю
                    for (let pass = 0; pass < 3; pass++) {
                        others.forEach((other) => {
                            if (other === node || (ignore && ignore.has(other))) return;
                            const exL = other.offsetLeft - MIN_NODE_DISTANCE;
                            const exT = other.offsetTop - MIN_NODE_DISTANCE;
                            const exR = other.offsetLeft + other.offsetWidth + MIN_NODE_DISTANCE;
                            const exB = other.offsetTop + other.offsetHeight + MIN_NODE_DISTANCE;
                            const r = left + w, b = top + h;
                            if (r <= exL || left >= exR || b <= exT || top >= exB) return;
                            const pushLeft = r - exL;
                            const pushRight = exR - left;
                            const pushUp = b - exT;
                            const pushDown = exB - top;
                            const min = Math.min(pushLeft, pushRight, pushUp, pushDown);
                            if (min === pushLeft) left -= pushLeft;
                            else if (min === pushRight) left += pushRight;
                            else if (min === pushUp) top -= pushUp;
                            else top += pushDown;
                        });
                    }
                    return { left, top };
                }

                surface.addEventListener('mousedown', (e) => {
                    if (e.target.closest('.flow-node__edit') || e.target.closest('.flow-node__add-bottom') || e.target.closest('.flow-node__add-right') || e.target.closest('select')) return;
                    const target = e.target.closest('.flow-node');
                    if (!target) return;
                    draggedNode = target;
                    dragStartX = e.clientX;
                    dragStartY = e.clientY;
                    dragOriginLeft = draggedNode.offsetLeft;
                    dragOriginTop = draggedNode.offsetTop;
                    dragGroup = new Map();
                    for (const n of collectDescendants(draggedNode)) {
                        dragGroup.set(n, { left: n.offsetLeft, top: n.offsetTop });
                    }
                    e.stopPropagation();
                });

                window.addEventListener('mousemove', (e) => {
                    if (!draggedNode) return;
                    let left = Math.round(dragOriginLeft + (e.clientX - dragStartX) / scale);
                    let top = Math.round(dragOriginTop + (e.clientY - dragStartY) / scale);
                    ({ left, top } = resolveCollisions(draggedNode, left, top, dragGroup));
                    draggedNode.style.left = left + 'px';
                    draggedNode.style.top = top + 'px';
                    const dx = left - dragOriginLeft, dy = top - dragOriginTop;
                    for (const [n, origin] of dragGroup) {
                        n.style.left = (origin.left + dx) + 'px';
                        n.style.top = (origin.top + dy) + 'px';
                    }
                    drawEdge();
                });

                window.addEventListener('mouseup', () => {
                    if (draggedNode) {
                        savePosition(draggedNode);
                        for (const n of dragGroup.keys()) savePosition(n);
                    }
                    draggedNode = null;
                    dragGroup = new Map();
                });

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
                    selectNode(null);
                    selectEdge(edge);
                });

                surface.addEventListener('click', (e) => {
                    if (e.target.closest('.flow-node__edit') || e.target.closest('.flow-node__add-bottom') || e.target.closest('.flow-node__add-right') || e.target.closest('select')) return;
                    selectEdge(null);
                    selectNode(e.target.closest('.flow-node'));
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
                    const positions = loadPositions();
                    delete positions[n.id];
                    localStorage.setItem(POS_KEY, JSON.stringify(positions));
                    selectedNode = null;
                    saveGraph();
                    drawEdge();
                }

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
            })();

            // категория «провайдер / модель / effort» ноды Секретаря — какой агент
            // её обслуживает. Выбор переживает перезагрузку через localStorage
            (() => {
                const providerSelect = document.getElementById('flowNodeSecretaryProvider');
                const modelSelect = document.getElementById('flowNodeSecretaryModel');
                const effortSelect = document.getElementById('flowNodeSecretaryEffort');

                const AGENT_KEY = 'flowNodeSecretaryAgent';
                function loadAgent() {
                    try {
                        return JSON.parse(localStorage.getItem(AGENT_KEY)) || {};
                    } catch {
                        return {};
                    }
                }
                function saveAgent(agent) {
                    localStorage.setItem(AGENT_KEY, JSON.stringify(agent));
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

    // центрируем один раз: канвас до первого показа скрыт и его размеры нулевые
    window.MissionFlow = {
        center() {
            if (!centerFlowNode) return;
            centerFlowNode();
            centerFlowNode = null;
        },
    };
})();
