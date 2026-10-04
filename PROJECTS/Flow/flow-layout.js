// Раскладка нод текущего канваса по дереву рёбер. У каждой ноды не больше
// одного входящего ребра (редактор всегда создаёт новый узел вместе с
// единственным ребром к нему), поэтому граф — дерево, и координаты не угадываются
// клетка за клеткой (так рёбра соседних веток задевали друг друга), а
// раздаются честно снизу вверх: горизонтальное ребро продолжает цепочку вправо
// в той же строке, вертикальное открывает дочернюю цепочку строкой ниже.
(function () {
    window.FlowLayout = function (ctx) {
        const { surface, edges, nodeFlow } = ctx;

        function layoutAllNodes() {
            const nodes = [...surface.querySelectorAll('.flow-node')].filter((n) => nodeFlow.get(n) === ctx.currentFlow);
            if (!nodes.length) return;

            const cellW = Math.max(...nodes.map((n) => n.offsetWidth)) + ctx.NODE_GAP;

            const parentEdge = new Map();
            for (const e of edges) if (!parentEdge.has(e.to)) parentEdge.set(e.to, e);

            // горизонтальная цепочка — нода и её последовательные "правые"
            // продолжения; вся цепочка держится в одной строке.
            // Узел может обзавестись больше чем одним исходящим горизонтальным
            // ребром (кнопка "+" справа кликабельна повторно, drag-connect тоже
            // не проверяет дубликаты) — тогда идти вверх по parentEdge можно только
            // до тех пор, пока предок ещё не разобран в чужую цепочку, иначе "лишний"
            // сосед остаётся без записи в chainOf и measure() падает на chain.length.
            // Рёбра, реально ушедшие в продолжение цепочки вправо, помечаем в
            // usedChainEdge: остальные горизонтальные соседи того же узла (второй,
            // третий "+" клик справа) в цепочку не помещаются и ниже отдаются
            // chainRightExtras, которая кладёт их в ту же строку, следом за
            // цепочкой, иначе такой узел проваливался на строку ниже — под
            // соседей, а не рядом с ними
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
            // Порядок детей внутри группы — по их текущему offsetLeft, а не по
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
            // индекса в цепочке — обе функции гоняют один и тот же проход:
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
            const startChain = chainOf.get(ctx.startNode);
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
                rowY += h + ctx.NODE_GAP_Y;
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
                ctx.savePosition(n);
            }
            ctx.drawEdge();
        }

        // раскладка по дереву + вписать всё в видимую область — для кнопки ⊞
        function autoLayoutAndFit() {
            layoutAllNodes();
            const nodes = [...surface.querySelectorAll('.flow-node')].filter((n) => nodeFlow.get(n) === ctx.currentFlow);
            if (!nodes.length) return;

            const contentW = Math.max(...nodes.map((n) => n.offsetLeft + n.offsetWidth));
            const contentH = Math.max(...nodes.map((n) => n.offsetTop + n.offsetHeight));
            const PADDING = 60;
            const fitScale = Math.min(
                (ctx.canvas.clientWidth - PADDING * 2) / contentW,
                (ctx.canvas.clientHeight - PADDING * 2) / contentH,
                1
            );
            const scale = Math.max(ctx.MIN_SCALE, Math.min(ctx.MAX_SCALE, fitScale));
            ctx.setView(ctx.currentFlow, PADDING, PADDING, scale);
            ctx.saveView();
        }

        ctx.layoutAllNodes = layoutAllNodes;
        ctx.autoLayoutAndFit = autoLayoutAndFit;
    };
})();
