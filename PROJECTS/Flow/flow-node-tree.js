// Жизнь ноды на канвасе: заглушка на пустом канвасе, удаление, видимость нод
// своего канваса и переключение канваса пунктом меню. Создание дочерних нод и
// рёбра — в flow-edges.js, содержимое карточки — в flow-node-state.js.
(function () {
    window.FlowNodeTree = function (ctx) {
        const { surface, nodeFlow, edges } = ctx;

        // ноды без пути от startNode и вообще без связей общий пересчёт не
        // двигает — но их раскладка всё равно нужна: после вставки ноды
        function afterNodeChange() {
            if (ctx.bulkBuild) return;
            ctx.layoutAllNodes();
            ctx.saveGraph();
            ctx.drawEdge();
        }

        // на канвасе миньона осталась общая заглушка от времён, когда своей
        // ноды у него не было, — иначе точек входа станет две. Узнать её по
        // заголовку нельзя: «Start» ставится только в момент создания и никуда
        // не сохраняется, после перезагрузки restoreGraph клонирует общий
        // шаблон и на карточке стоит его «New node». Признак — отсутствие
        // связей: всё, что пользователь вырастил сам, создано плюсом и держится
        // на ребре. Чистка разовая на канвас (список пройденных живёт в
        // состоянии), чтобы правило не удаляло одинокие ноды и дальше
        const PERSONAL_MIGRATED_KEY = 'flowPersonalRootsMigrated';
        function dropLegacyStub(flow) {
            const done = ctx.flowGet(PERSONAL_MIGRATED_KEY, []);
            if (done.includes(flow)) return;
            for (const n of [...nodeFlow.keys()]) {
                if (nodeFlow.get(n) !== flow) continue;
                if (ctx.PERSONAL_ROOT_BY_ID[n.id] || n === ctx.node || n === ctx.startNode || n.dataset.session) continue;
                if (edges.some((e) => e.from === n || e.to === n)) continue;
                deleteNode(n);
            }
            ctx.flowSet(PERSONAL_MIGRATED_KEY, [...done, flow]);
        }

        function deleteNode(n) {
            for (const e of [...edges]) {
                if (e.from === n || e.to === n) ctx.removeEdge(e);
            }
            n.remove();
            nodeFlow.delete(n);
            // ноды сессии в состоянии и не лежали (см. savePosition) — чистить нечего
            if (!n.dataset.session) {
                const types = ctx.loadTypes();
                if (types[n.id]) {
                    delete types[n.id];
                    ctx.flowSet(ctx.TYPES_KEY, types);
                }
                const positions = ctx.loadPositions();
                delete positions[n.id];
                ctx.flowSet(ctx.POS_KEY, positions);
                // тексты и вопросы удалённой ноды раньше оставались в состоянии
                // навсегда: их ключи привязаны к id, который больше никому не выдадут
                const texts = ctx.loadTexts();
                for (const field of ['title', 'subtitle', 'body']) delete texts[`${n.id}:${field}`];
                ctx.flowSet(ctx.TEXT_KEY, texts);
                const questions = ctx.loadQuestions();
                if (questions[n.id]) {
                    delete questions[n.id];
                    ctx.flowSet(ctx.QUESTIONS_KEY, questions);
                }
            }
            // выделение снимаем только со своей же ноды: живая перестройка графа
            // сессии удаляет чужие ноды и не должна сбрасывать выбор пользователя
            if (ctx.selectedNode === n) ctx.selectedNode = null;
            ctx.saveGraph();
            ctx.drawEdge();
        }

        // на пустом канвасе нечего показать и не от чего плюсовать — заводим
        // одну ноду-заглушку по центру, чтобы с неё можно было расти
        function ensureRootNode(flow, id, sessionId) {
            // у миньона со своей стартовой нодой заглушка не годится даже
            // на пустом канвасе: ищем и заводим именно его карточку по её id
            const personal = !id && ctx.PERSONAL_ROOTS[flow];
            if (personal) {
                id = personal.id;
                dropLegacyStub(flow);
            }
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
            const root = ctx.cloneNodeElement(id);
            root.id = ctx.nextNodeId(id);
            if (sessionId) root.dataset.session = sessionId;
            // у QA и Backend developer заголовок свой, из их собственного шаблона —
            // не перебиваем; у общего #flowNodeProfileTemplate его подставляет
            // applyPersonalMeta по имени профиля
            if (!ctx.PERSONAL_ROOT_BY_ID[root.id]) root.querySelector('.flow-node__title').textContent = 'Start';
            else ctx.applyPersonalMeta(root, flow);
            surface.append(root);
            ctx.fitNodeMenu(root);
            ctx.applyMenuOrder(root);
            ctx.attachAddBottom(root);
            ctx.attachAddRight(root);
            ctx.populateNodeAgentSelects(root);
            nodeFlow.set(root, flow);
            root.style.left = Math.round((ctx.canvas.clientWidth - root.offsetWidth) / 2) + 'px';
            root.style.top = Math.round((ctx.canvas.clientHeight - root.offsetHeight) / 2) + 'px';
            ctx.savePosition(root);
            ctx.saveGraph();
            return root;
        }

        // пустая нода-заглушка: не из сессии, ни с чем не соединена и ничего в
        // себе не несёт. Всё, что пользователь в неё вписал или чем связал,
        // выводит ноду из этой категории — такую не удаляем
        function isBlankPlaceholder(n) {
            if (n.dataset.session || n === ctx.node || n === ctx.startNode) return false;
            if (edges.some((e) => e.from === n || e.to === n)) return false;
            const texts = ctx.loadTexts();
            if (['title', 'subtitle', 'body'].some((f) => texts[`${n.id}:${f}`])) return false;
            return !ctx.loadQuestions()[n.id] && !ctx.loadTypes()[n.id];
        }

        // прячет ноды и рёбра всех канвасов, кроме flow — общая часть
        // первого показа вкладки (после restoreGraph) и переключения
        // пунктом меню, чтобы на старте не были видны чужие сохранённые ноды
        function applyFlowVisibility(flow) {
            for (const n of surface.querySelectorAll('.flow-node')) {
                n.style.display = nodeFlow.get(n) === flow ? '' : 'none';
                // нода, которую при создании померить не удалось (была скрыта),
                // получает ширину меню в момент, когда её наконец показали
                if (!n.style.display) ctx.fitNodeMenu(n);
            }
            for (const e of edges) {
                const visible = nodeFlow.get(e.from) === flow;
                e.path.style.display = visible ? '' : 'none';
                e.addBtn.style.display = visible ? '' : 'none';
            }
        }

        // записывает текст в title/body ноды и сразу сохраняет его в TEXT_KEY —
        // так же, как это делает ручное редактирование (см. flow-edit.js)
        function setNodeTexts(n, title, body) {
            const titleEl = n.querySelector('.flow-node__title');
            const bodyEl = n.querySelector('.flow-node__body');
            if (titleEl) titleEl.textContent = title;
            if (bodyEl) bodyEl.textContent = body;
            // текст ноды сессии — копия сообщения, хранить его незачем (см. savePosition)
            if (n.dataset.session) return;
            const all = ctx.loadTexts();
            if (titleEl) all[`${n.id}:title`] = title;
            if (bodyEl) all[`${n.id}:body`] = body;
            ctx.flowSet(ctx.TEXT_KEY, all);
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

        // переключение видимого канваса: сам механизм зума/панорамирования/
        // рёбер общий на все канвасы, переключение просто прячет чужие ноды
        // и рёбра и подставляет свой сохранённый zoom/pan
        function setActiveFlow(flow) {
            if (flow === ctx.currentFlow) return;
            ctx.saveView();
            ctx.currentFlow = flow;
            ctx.selectedNode = null;
            ctx.selectedEdge = null;
            ensureRootNode(flow);
            applyFlowVisibility(flow);
            // тот же пересчёт зазора, что и при первом restoreGraph — на этом
            // канвасе сохранённые позиции тоже могли остаться от старой,
            // более низкой разметки нод
            ctx.layoutAllNodes();
            const saved = ctx.flowGet('flowCanvasViews', {})[flow];
            ctx.setView(flow, saved ? saved.x : undefined, saved ? saved.y : undefined, saved ? saved.scale : undefined);
            ctx.drawEdge();
        }

        ctx.afterNodeChange = afterNodeChange;
        ctx.deleteNode = deleteNode;
        ctx.ensureRootNode = ensureRootNode;
        ctx.isBlankPlaceholder = isBlankPlaceholder;
        ctx.applyFlowVisibility = applyFlowVisibility;
        ctx.setNodeTexts = setNodeTexts;
        ctx.setNodeScope = setNodeScope;
        ctx.setActiveFlow = setActiveFlow;
    };
})();
