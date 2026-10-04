// Состояние карточки ноды и сохранённый граф: заголовок/подзаголовок/тело,
// тип ноды, вопросы, позиции на канвасе, рёбра и счётчик id. Всё это переживает
// перезагрузку страницы в flow_state (см. flow-server.js), а ноды сессии — нет:
// они целиком выводятся из сообщений и рисуются заново при каждом построении.
//
// Сюда же — клонирование карточки из шаблона и восстановление графа после
// перезагрузки. Создание, удаление и видимость нод — в flow-node-tree.js,
// наполнение содержимым ноды сессии — в flow-session.js.
(function () {
    window.FlowNodeState = function (ctx) {
        const { flowGet, flowSet, nodeFlow } = ctx;

        // ноды сессии (dataset.session) в состояние Flow не попадают вовсе —
        // ни позицией, ни текстом, ни ребром. Хранить их значило бы держать
        // вторую копию переписки, и на большой сессии flowNodeText перерастал
        // лимит тела запроса (readJson, 100 КБ) — запись состояния молча
        // обрывалась вся целиком

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
            // у ноды может не быть блока вопросов вовсе (личная карточка миньона)
            const group = n.querySelector('.flow-node__questions');
            if (!group) return;
            const fields = [...group.querySelectorAll('.flow-node__question')];
            saved.forEach((text, i) => {
                if (fields[i]) fields[i].querySelector('.flow-node__question-text').textContent = text;
                else addQuestionField(group, text);
            });
        }

        // позиции нод переживают перезагрузку страницы через localStorage
        // v2: старые сохранённые позиции ставили новые ноды впритык к соседям —
        // сбрасываем кеш, чтобы раздвижка при вставке отработала на чистом layout'е
        const POS_KEY = 'flowNodePositions2';
        function loadPositions() {
            return flowGet(POS_KEY, {});
        }
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
                nodeSeq: ctx.nodeSeq,
                nodes: [...nodeFlow.entries()]
                    .filter(([n]) => n !== ctx.startNode && n !== ctx.node && !n.dataset.session)
                    .map(([n, flow]) => ({ id: n.id, flow })),
                // ребро между двумя нодами сессии не сохраняем — оно и так
                // выводится из сообщений. А вот ребро, которым пользователь
                // привязал свою ноду к ноде сессии, — единственное, что помнит
                // её место в цепочке, и его беречь надо: id ноды сессии
                // детерминированный, после перестройки он тот же самый
                edges: ctx.edges
                    .filter((e) => !e.from.dataset.session || !e.to.dataset.session)
                    .map((e) => ({ from: e.from.id, to: e.to.id, direction: e.direction })),
            });
        }

        // id ноды. У заведённых руками — прежний счётчик со временем создания;
        // ноды сессии просят свой (flowNode_<сессия>_<позиция>, см. flow-session.js),
        // и он держится за конкретное сообщение: живая перестройка по нему находит
        // уже стоящую ноду и обновляет её, вместо того чтобы снести и создать заново
        function nextNodeId(id) {
            return id || 'flowNode_' + (++ctx.nodeSeq) + '_' + Date.now();
        }

        // PERSONAL_ROOTS: у миньона может быть своя стартовая нода — не общая
        // заглушка ensureRootNode, а собственная карточка со своей разметкой.
        // Id фиксированный: по нему же её узнаёт восстановление графа
        // после перезагрузки и берёт тот же шаблон, а не общий.
        // Secretary/UI developer/HR делят один и тот же шаблон карточки
        // (#flowNodeProfileTemplate) вместо ещё трёх копий разметки QA/Backend —
        // содержимое в него кладёт applyProfileMeta по PROFILE_META (см. ниже)
        const PERSONAL_ROOTS = {
            'QA': { id: 'flowNodeQaRoot', template: 'flowNodeQaTemplate' },
            'Backend developer': { id: 'flowNodeBackendRoot', template: 'flowNodeBackendTemplate' },
            'Secretary': { id: 'flowNodeSecretaryRoot', template: 'flowNodeProfileTemplate' },
            'UI developer': { id: 'flowNodeUiRoot', template: 'flowNodeProfileTemplate' },
            'HR': { id: 'flowNodeHrRoot', template: 'flowNodeProfileTemplate' },
        };
        const PERSONAL_ROOT_BY_ID = {};
        for (const root of Object.values(PERSONAL_ROOTS)) PERSONAL_ROOT_BY_ID[root.id] = root;
        // заголовок/подзаголовок общего шаблона (#flowNodeProfileTemplate) в
        // разметке пустые — у QA и Backend developer они уже вписаны в их
        // собственном шаблон. Подставляем их здесь по имени профиля
        const PROFILE_META = {
            'Secretary': { title: 'Secretary', subtitle: 'Dispatcher agent · Entry point' },
            'UI developer': { title: 'UI developer', subtitle: 'Interface & client code · Entry point' },
            'HR': { title: 'HR', subtitle: 'People & onboarding · Entry point' },
        };

        // вызывается и при первом создании личной ноды (ensureRootNode), и при
        // восстановлении графа после перезагрузки (restoreGraph) — в обоих
        // случаях клон общего шаблона приходит с пустыми title/subtitle
        function applyPersonalMeta(root, flow) {
            const meta = PROFILE_META[flow];
            if (!meta) return;
            const title = root.querySelector('.flow-node__title');
            const subtitle = root.querySelector('.flow-node__subtitle');
            if (title && !title.textContent) title.textContent = meta.title;
            if (subtitle && !subtitle.textContent) subtitle.textContent = meta.subtitle;
        }

        // клон карточки под конкретный id: личной ноде — её шаблон, всем
        // остальным — общий
        function cloneNodeElement(id) {
            const personal = PERSONAL_ROOT_BY_ID[id];
            const tpl = personal ? document.getElementById(personal.template) : ctx.nodeTemplate;
            return (tpl || ctx.nodeTemplate).content.firstElementChild.cloneNode(true);
        }

        // ширина вертикального меню личной ноды — по самой длинной надписи
        // кнопки. Набор кнопок ещё будет меняться, и держать число в CSS руками
        // значит подгонять его после каждой правки: меряем max-content самого
        // меню и отдаём результат карточке переменной --flow-node-menu, из
        // которой считаются и ширина колонки, и место под неё (см. flow.css).
        // Меню выведено из потока, поэтому на высоту карточки это не влияет
        function fitNodeMenu(n) {
            const menu = n.querySelector('.flow-node__menu');
            if (!menu || n.style.getPropertyValue('--flow-node-menu')) return;
            menu.style.width = 'max-content';
            const width = menu.offsetWidth;
            menu.style.width = '';
            // ноль означает, что нода сейчас скрыта (чужой канвас) и померить
            // нечего — вернёмся к этому, когда её покажут (applyFlowVisibility)
            if (!width) return;
            n.style.setProperty('--flow-node-menu', width + 'px');
        }

        // восстанавливаем клоны шаблона по id из графа и перестраиваем рёбра;
        // вызывается один раз при первом показе вкладки, до отрисовки рёбер
        function restoreGraph() {
            const graph = loadGraph();
            if (!graph || !graph.nodes || !graph.nodes.length) return;

            const positions = loadPositions();
            const flowById = {};
            for (const n of graph.nodes || []) flowById[n.id] = n.flow;

            const byId = { [ctx.startNode.id]: ctx.startNode, [ctx.node.id]: ctx.node };
            // идём по списку нод, а не по концам рёбер: нода без единой связи
            // (одиночная заглушка, только что заведённый узел) тоже сохранена,
            // и раньше она молча пропадала при каждой перезагрузке страницы.
            // Концы рёбер, которых в списке нет, — это ноды сессии: их создаст
            // построение графа, а ребро до тех пор ждёт (см. pendingEdges)
            for (const id of Object.keys(flowById)) {
                if (byId[id]) continue;
                const clone = cloneNodeElement(id);
                clone.id = id;
                applyPersonalMeta(clone, flowById[id]);
                ctx.surface.append(clone);
                fitNodeMenu(clone);
                ctx.applyMenuOrder(clone);
                ctx.attachAddBottom(clone);
                ctx.attachAddRight(clone);
                ctx.populateNodeAgentSelects(clone);
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
            ctx.nodeSeq = Math.max(ctx.nodeSeq, graph.nodeSeq || 0);

            for (const e of [...ctx.edges]) ctx.removeEdge(e);
            ctx.pendingEdges = [];
            for (const e of graph.edges || []) {
                if (!byId[e.from] || !byId[e.to]) { ctx.pendingEdges.push(e); continue; } // ждёт своей ноды сессии
                // второе входящее ребро в ту же ноду (старый граф, заведённый до
                // запрета такого соединения) раскладка не учитывает и рисует
                // стрелкой не в ту сторону — отбрасываем его при восстановлении,
                // как теперь и не даём создать заново
                if (ctx.edges.some((ed) => ed.to === byId[e.to])) continue;
                ctx.createEdge(byId[e.from], byId[e.to], null, e.direction);
            }

            // позиции сохранены под старую высоту нод — если разметка ноды
            // с тех пор выросла (например, добавили новое поле в шаблон),
            // расстояние между соседями по сохранённым top/top съезжает и
            // они наезжают друг на друга; пересчёт по факту занимаемого места
            // возвращает исходный зазор NODE_GAP
            ctx.layoutAllNodes();
        }

        // ставит ноде тип из select .flow-node__type — той же покраской
        // и скрытием блока вопросов, что и ручная смена типа (в flow-edit.js)
        function setNodeType(n, type) {
            const select = n.querySelector('.flow-node__type');
            if (!select) return;
            select.value = type;
            select.style.color = select.selectedOptions[0].style.color;
            const questions = n.querySelector('.flow-node__questions');
            if (questions) questions.hidden = type !== 'question';
        }

        ctx.applyTexts = applyTexts;
        ctx.applyQuestions = applyQuestions;
        ctx.addQuestionField = addQuestionField;
        ctx.questionTextRect = questionTextRect;
        ctx.saveQuestionsFor = saveQuestionsFor;
        ctx.loadTexts = loadTexts;
        ctx.loadTypes = loadTypes;
        ctx.loadQuestions = loadQuestions;
        ctx.loadPositions = loadPositions;
        ctx.savePosition = savePosition;
        ctx.saveGraph = saveGraph;
        ctx.nextNodeId = nextNodeId;
        ctx.PERSONAL_ROOTS = PERSONAL_ROOTS;
        ctx.PERSONAL_ROOT_BY_ID = PERSONAL_ROOT_BY_ID;
        ctx.applyPersonalMeta = applyPersonalMeta;
        ctx.cloneNodeElement = cloneNodeElement;
        ctx.fitNodeMenu = fitNodeMenu;
        ctx.restoreGraph = restoreGraph;
        ctx.setNodeType = setNodeType;
        ctx.EDITABLE_SELECTOR = EDITABLE_SELECTOR;
        ctx.TEXT_KEY = TEXT_KEY;
        ctx.TYPES_KEY = TYPES_KEY;
        ctx.QUESTIONS_KEY = QUESTIONS_KEY;
        ctx.POS_KEY = POS_KEY;

        // ноды, чей текст и вопросы уже сохранены, восстанавливаем сразу —
        // дальше их перекроет построение графа, если это ноды сессии
        applyTexts(ctx.node);
        applyTexts(ctx.startNode);
        applyQuestions(ctx.node);
        applyQuestions(ctx.startNode);

        // первый показ вкладки: центрируем стартовую ноду и поднимаем сохранённый
        // граф. #flowCanvas в этот момент ещё скрыт, его размеры нулевые —
        // поэтому момент выбирает панель вкладок (MissionFlow.center)
        ctx.centerFlowNode = () => {
            const saved = loadPositions();
            if (saved[ctx.node.id] && saved[ctx.startNode.id]) {
                ctx.node.style.left = saved[ctx.node.id].left + 'px';
                ctx.node.style.top = saved[ctx.node.id].top + 'px';
                ctx.startNode.style.left = saved[ctx.startNode.id].left + 'px';
                ctx.startNode.style.top = saved[ctx.startNode.id].top + 'px';
            } else {
                ctx.node.style.left = Math.round((ctx.canvas.clientWidth - ctx.node.offsetWidth) / 2) + 'px';
                ctx.node.style.top = Math.round((ctx.canvas.clientHeight - ctx.node.offsetHeight) / 2) + 'px';
                ctx.startNode.style.left = Math.round(ctx.node.offsetLeft - ctx.NODE_GAP - ctx.startNode.offsetWidth) + 'px';
                ctx.startNode.style.top = Math.round(ctx.node.offsetTop + (ctx.node.offsetHeight - ctx.startNode.offsetHeight) / 2) + 'px';
                savePosition(ctx.node);
                savePosition(ctx.startNode);
            }
            restoreGraph();
            // личная нода миньона должна стоять и тогда, когда страницу
            // перезагрузили прямо на его канвасе: setActiveFlow при таком
            // заходе не срабатывает. Общую заглушку здесь не заводим — на
            // канвасе сессии («321») она осталась бы лишней нодой рядом
            // с построенным графом
            if (PERSONAL_ROOTS[ctx.currentFlow]) ctx.ensureRootNode(ctx.currentFlow);
            ctx.applyFlowVisibility(ctx.currentFlow);
            ctx.drawEdge();
        };
    };
})();
