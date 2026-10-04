// Рёбра между нодами: геометрия дуги, создание и удаление, вставка ноды
// посередине ребра и протягивание нового ребра плюсом от ноды. Рёбра хранятся
// списком, а не в разметке, иначе ребро нельзя разрезать надвое.
//
// Раскладка нод по дереву, которая двигает координаты — в flow-layout.js.
(function () {
    window.FlowEdges = function (ctx) {
        const { surface, edgesLayer, edges, nodeFlow } = ctx;

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

            const newNode = ctx.nodeTemplate.content.firstElementChild.cloneNode(true);
            newNode.id = ctx.nextNodeId();
            surface.append(newNode);
            attachAddBottom(newNode);
            attachAddRight(newNode);
            ctx.populateNodeAgentSelects(newNode);
            nodeFlow.set(newNode, nodeFlow.get(from));
            newNode.style.left = Math.round(mid.x - newNode.offsetWidth / 2) + 'px';
            newNode.style.top = Math.round(mid.y - newNode.offsetHeight / 2) + 'px';
            ctx.savePosition(newNode);

            removeEdge(edge);
            createEdge(from, newNode, null, edge.direction);
            createEdge(newNode, to, null, edge.direction);
            ctx.afterNodeChange();
        }

        // точка крепления ребра на ноде — низ по центру для вертикали,
        // право по центру высоты для горизонтали; используется и при отрисовке
        // готового ребра (edgeGeometry), и здесь для тянущейся от плюса стрелки
        function anchorPoint(n, direction) {
            return direction === 'vertical'
                ? { x: n.offsetLeft + n.offsetWidth / 2, y: n.offsetTop + n.offsetHeight }
                : { x: n.offsetLeft + n.offsetWidth, y: n.offsetTop + n.offsetHeight / 2 };
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
            const pt = ctx.surfacePoint(e.clientX, e.clientY);
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
            ctx.saveGraph();
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
            const newNode = ctx.nodeTemplate.content.firstElementChild.cloneNode(true);
            newNode.id = ctx.nextNodeId(id);
            if (sessionId) newNode.dataset.session = sessionId;
            surface.append(newNode);
            attachAddBottom(newNode);
            attachAddRight(newNode);
            ctx.populateNodeAgentSelects(newNode);
            nodeFlow.set(newNode, nodeFlow.get(from));
            newNode.style.left = Math.round(from.offsetLeft + (from.offsetWidth - newNode.offsetWidth) / 2) + 'px';
            newNode.style.top = Math.round(from.offsetTop + from.offsetHeight + ctx.NODE_GAP_Y) + 'px';
            ctx.savePosition(newNode);
            createEdge(from, newNode, null, 'vertical');
            ctx.afterNodeChange();
            return newNode;
        }

        // плюс у правого края ноды — добавляет новый узел-заглушку справа
        // от текущего, по той же логике, что и attachAddBottom/addChildNode
        function attachAddRight(n) {
            n.querySelector('.flow-node__add-right').addEventListener('mousedown', (e) => startConnecting(e, n, 'horizontal'));
        }

        // добавляет дочерний узел справа — симметрично addChildNode
        function addChildNodeRight(from, id, sessionId) {
            const newNode = ctx.nodeTemplate.content.firstElementChild.cloneNode(true);
            newNode.id = ctx.nextNodeId(id);
            if (sessionId) newNode.dataset.session = sessionId;
            surface.append(newNode);
            attachAddBottom(newNode);
            attachAddRight(newNode);
            ctx.populateNodeAgentSelects(newNode);
            nodeFlow.set(newNode, nodeFlow.get(from));
            newNode.style.left = Math.round(from.offsetLeft + from.offsetWidth + ctx.NODE_GAP) + 'px';
            newNode.style.top = Math.round(from.offsetTop + (from.offsetHeight - newNode.offsetHeight) / 2) + 'px';
            ctx.savePosition(newNode);
            createEdge(from, newNode, null, 'horizontal');
            ctx.afterNodeChange();
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

        ctx.createEdge = createEdge;
        ctx.removeEdge = removeEdge;
        ctx.drawEdge = drawEdge;
        ctx.addChildNode = addChildNode;
        ctx.addChildNodeRight = addChildNodeRight;
        ctx.attachAddBottom = attachAddBottom;
        ctx.attachAddRight = attachAddRight;
        ctx.insertNodeOnEdge = insertNodeOnEdge;
    };
})();
