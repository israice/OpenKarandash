        // Построение графа сессии на канвасе: белый текст (роли user/assistant) идёт
// цепочкой вправо, серый (роль tool, шаги между вопросом и ответом) —
// вертикальной цепочкой под ним, потому что белый текст — причина, по которой
// эти шаги вообще появились. Содержимое каждой ноды — в flow-session-node.js.
(function () {
    window.FlowSessionBuild = function (ctx) {
        const { nodeFlow, edges } = ctx;

        // ребро, которым пользователь привязал свою ноду к ноде сессии, пережило
        // перезагрузку, а его нода сессии появляется только сейчас — досоздаём.
        // То, чему ноды всё ещё нет (выбрана другая сессия), остаётся ждать
        function applyPendingEdges() {
            if (!ctx.pendingEdges.length) return;
            const byId = new Map([...nodeFlow.keys()].map((n) => [n.id, n]));
            ctx.pendingEdges = ctx.pendingEdges.filter((e) => {
                const from = byId.get(e.from);
                const to = byId.get(e.to);
                if (!from || !to) return true;
                if (!edges.some((x) => x.to === to)) ctx.createEdge(from, to, null, e.direction);
                return false;
            });
        }

        // строка-шаг, а не реплика: вызов инструмента и событие хода (пометки
        // recordNotice, системные события CLI) — в цепочку шагов вниз, как и в
        // ленте Sessions, а не в главную цепочку вопросов и ответов
        function isStepRow(m) {
            return m.role === 'tool' || m.role === 'system';
        }

        // строит граф канваса `flow` из сообщений сессии
        function buildSessionNodes(flow, messages, sessionId) {
            ctx.setActiveFlow(flow);
            // выбор другой сессии в списке (#flowSessionSelect) должен показывать
            // ЕЁ граф, а не добавлять его поверх прежнего: ноды предыдущей
            // просмотренной сессии на этом канвасе никак иначе не убираются —
            // без этой чистки переключение выглядело так, будто канвас не
            // изменился (старое дерево оставалось на месте, новое пряталось
            // среди/позади него после общей autoLayoutAndFit)
            for (const n of [...nodeFlow.keys()]) {
                if (nodeFlow.get(n) === flow && n.dataset.session && n.dataset.session !== sessionId) ctx.deleteNode(n);
            }
            // на пустом канвасе заглушка заводится «чтобы было от чего расти»
            // (ensureRootNode). Графу сессии расти есть от чего и без неё, а
            // оставшись, она копится: канвас обрастал пустыми карточками от
            // прошлых открытий, и одна такая уже успела уехать в сохранённое
            // состояние — поэтому убираем не только что созданную, а любую
            // пустую и ни с чем не связанную ноду этого канваса
            if (messages.length) {
                for (const n of [...nodeFlow.keys()]) {
                    if (nodeFlow.get(n) === flow && ctx.isBlankPlaceholder(n)) ctx.deleteNode(n);
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
                } else if (isStepRow(m)) {
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
                        if (inEdge) ctx.removeEdge(inEdge);
                        ctx.createEdge(parent, node, null, direction);
                    }
                } else if (!parent) {
                    node = ctx.ensureRootNode(flow, id, sessionId);
                } else {
                    // пометку ставим до создания ребра: savePosition/saveGraph
                    // внутри addChildNode* уже должны видеть ноду как сессионную
                    node = direction === 'vertical' ? ctx.addChildNode(parent, id, sessionId) : ctx.addChildNodeRight(parent, id, sessionId);
                }

                ctx.applySessionNode(node, m);

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
                for (const filePath of ctx.messageFilePaths(m)) {
                    const fileId = `${prefix}file_${ctx.pathKey(filePath)}`;
                    let fileNode = files.get(filePath) || mine.get(fileId);
                    if (!fileNode) {
                        fileNode = ctx.addChildNodeRight(node, fileId, sessionId);
                    } else {
                        const inEdge = edges.find((e) => e.to === fileNode);
                        if (!inEdge || inEdge.from !== node) {
                            if (inEdge) ctx.removeEdge(inEdge);
                            ctx.createEdge(node, fileNode, null, 'horizontal');
                        }
                    }
                    mine.delete(fileId);
                    files.set(filePath, fileNode);
                    ctx.applyFileNode(fileNode, filePath);
                }

                if (m.toolUseId) byToolUse.set(m.toolUseId, node);
                if (branch) lastInBranch.set(branch, node);
                else if (isStepRow(m)) lastGray = node;
                else { lastWhite = node; lastGray = null; }
            }

            // сообщение исчезло (сессия перечитана короче) — его нода уходит с ним
            for (const n of mine.values()) ctx.deleteNode(n);
            applyPendingEdges();
            // канвас без единой ноды: заводим заглушку, чтобы было от чего расти
            ctx.ensureRootNode(flow);
            // единственные за всё построение сохранение и раскладка: отдельные
            // ноды их не звали (bulkBuild), иначе на полусотне сообщений вкладка
            // замирала на несколько секунд
            ctx.saveGraph();
            ctx.autoLayoutAndFit();
        }

        // Вход вкладки в построение: на время массового построения отложенные
        // записи состояния копятся и уходят одним заходом, а каждая нода не
        // зовёт раскладку и сохранение сама (bulkBuild)
        ctx.buildSessionFlow = (flow, messages, sessionId) => {
            ctx.beginFlowBatch();
            ctx.bulkBuild = true;
            try {
                buildSessionNodes(flow, messages, sessionId);
            } finally {
                ctx.bulkBuild = false;
                // падение посреди построения не должно оставить запись состояния
                // выключенной навсегда — иначе канвас перестанет сохраняться молча
                ctx.flushFlowBatch();
            }
        };
    };
})();
