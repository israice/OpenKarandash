// Вкладка Graph: карта проекта, поиск по ней и окно с содержимым узла.
// Вынесено из index.html, который иначе разросся бы ещё на шесть сотен строк.
// Подключается с defer и ничего не ждёт от порядка загрузки: общее ядро берём
// из window.App в момент вызова, а не при старте файла.
(function () {
    'use strict';

    // ---------- граф проекта ----------

    const SVG_NS = 'http://www.w3.org/2000/svg';
    const graphCanvas = document.getElementById('graphCanvas');
    const graphSurface = document.getElementById('graphSurface');
    const graphEmpty = document.getElementById('graphEmpty');
    const graphEmptyTitle = document.getElementById('graphEmptyTitle');
    const graphEmptyHint = document.getElementById('graphEmptyHint');
    const graphPanel = document.getElementById('graphPanel');
    const graphSearch = document.getElementById('graphSearch');
    const graphChips = document.getElementById('graphChips');
    const graphHint = document.getElementById('graphHint');
    const graphDetails = document.getElementById('graphDetails');
    const graphDetailsTitle = document.getElementById('graphDetailsTitle');
    const graphDetailsMeta = document.getElementById('graphDetailsMeta');
    const graphDetailsBody = document.getElementById('graphDetailsBody');

    // виды узлов: подпись, цвет чипа и показывать ли по умолчанию.
    // функции и сессии включаются вручную — иначе граф не читается
    const GRAPH_KINDS = [
        { kind: 'file', label: 'файлы', color: '#6ea8fe', on: true },
        { kind: 'route', label: 'API', color: '#f0a868', on: true },
        { kind: 'section', label: 'секции', color: '#a78bfa', on: true },
        { kind: 'function', label: 'функции', color: '#7dd3a0', on: false },
        { kind: 'session', label: 'сессии', color: '#d97ba0', on: false },
        { kind: 'note', label: 'заметки', color: '#8a8f98', on: true },
        { kind: 'history', label: 'история', color: '#8a8f98', on: false },
    ];

    let graphBox = null;          // текущий viewBox: он же «уместить всё», он же зум
    let graphData = null;         // последний ответ сервера
    let graphNodes = [];          // узлы с координатами и ссылками на элементы
    let graphNeighbours = null;   // узел → соседи, считается один раз после рендера
    let graphLinks = [];          // рёбра: индексы узлов, по ним строится линия
    let nearLinks = [];           // рёбра выделенного соседства — рисуются отдельно
    let edgesElement = null;      // один path на все рёбра, второй — на подсвеченные
    let nearEdgesElement = null;
    let frameId = 0;              // текущий кадр анимации
    let alpha = 0;                // «температура» симуляции: с ней затухает движение
    let settled = false;          // раскладка успокоилась — камеру больше не двигаем
    let draggedNode = null;       // узел под мышью: его ведём руками, силы не трогают
    // выбор видов переживает перезагрузку. localStorage может быть недоступен
    // (приватное окно, запрет на данные сайта) — тогда просто берём умолчания
    const GRAPH_KINDS_KEY = 'graph.visibleKinds';

    function loadVisibleKinds() {
        try {
            const saved = JSON.parse(localStorage.getItem(GRAPH_KINDS_KEY));
            // пустой набор — тоже осознанный выбор, уважаем его
            if (Array.isArray(saved)) return new Set(saved.filter((kind) => GRAPH_KINDS.some((k) => k.kind === kind)));
        } catch {
            // повреждённое или недоступное хранилище — не повод падать
        }
        return new Set(GRAPH_KINDS.filter((k) => k.on).map((k) => k.kind));
    }

    function saveVisibleKinds() {
        try {
            localStorage.setItem(GRAPH_KINDS_KEY, JSON.stringify([...graphVisible]));
        } catch {
            // запись запрещена — фильтр просто не переживёт перезагрузку
        }
    }

    const graphVisible = loadVisibleKinds();

    function showGraphEmpty(title, hint) {
        graphEmptyTitle.textContent = title;
        graphEmptyHint.textContent = hint;
        graphCanvas.hidden = true;
        graphPanel.hidden = true;
        graphEmpty.hidden = false;
    }

    // карта уже собрана сервером к моменту старта, поэтому просто забираем её.
    // повторный вызов перерисовывает граф — этим пользуется обновление по SSE
    async function showGraph(force = false) {
        // данные уже есть — просто переигрываем раскладку заново, чтобы облако
        // узлов всегда оживало при открытии вкладки, а не только при смене видов
        if (graphData && !force) { renderGraph(graphData); return; }
        let data;
        try {
            const res = await fetch('/api/obsidian/graph', { method: 'POST' });
            data = await res.json();
        } catch {
            data = { ok: false, error: 'Сервер не ответил' };
        }
        if (!data.ok) {
            showGraphEmpty('Граф не собрался', data.error);
            return;
        }
        if (!data.notes.length) {
            showGraphEmpty('В vault нет заметок', 'Vault «' + data.vault + '» пуст: ни одного файла проекта и ни одной заметки.');
            return;
        }
        graphData = data;
        graphCanvas.hidden = false;
        graphEmpty.hidden = true;
        graphPanel.hidden = false;
        if (!graphChips.children.length) renderChips();
        renderGraph(data);
    }

    // граф перерисовывается после пересборки карты, но только если вкладка открыта:
    // считать раскладку для скрытого полотна незачем
    window.__onMapUpdate = () => {
        if (!document.getElementById('graphView').hidden) showGraph(true);
    };

    function renderChips() {
        for (const item of GRAPH_KINDS) {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'graph-chip';
            chip.style.color = item.color;
            chip.setAttribute('aria-pressed', String(graphVisible.has(item.kind)));
            const dot = document.createElement('span');
            dot.className = 'graph-chip__dot';
            chip.append(dot, item.label);
            chip.addEventListener('click', () => {
                if (graphVisible.has(item.kind)) graphVisible.delete(item.kind);
                else graphVisible.add(item.kind);
                chip.setAttribute('aria-pressed', String(graphVisible.has(item.kind)));
                saveVisibleKinds();
                renderGraph(graphData); // состав узлов изменился — раскладку считаем заново
            });
            graphChips.append(chip);
        }
    }

    // силовая раскладка: все узлы отталкиваются, ссылки стягивают.
    // O(n^2) на шаг, но шаги считаем один раз при отрисовке
    // Раскладка живая: силы считаются каждый кадр, пока граф не успокоится.
    // Так узлы плавно расходятся на глазах, а не появляются в готовой позиции,
    // и перетаскивание узла тянет за собой соседей — как в самом Obsidian.
    function buildLayout(notes, rawLinks) {
        const index = new Map(notes.map((note, i) => [note.path, i]));
        const nodes = notes.map((note, i) => {
            const angle = i * 2.399963; // золотой угол — стартовая спираль без комков
            const radius = 12 * Math.sqrt(i + 1);
            return {
                ...note,
                label: note.path.replace(/\.md$/, '').split('/').pop(),
                x: Math.cos(angle) * radius,
                y: Math.sin(angle) * radius,
                vx: 0,
                vy: 0,
                degree: 0,
            };
        });
        const links = rawLinks
            .map(([from, to]) => ({ a: index.get(from), b: index.get(to) }))
            .filter((link) => link.a !== undefined && link.b !== undefined);
        for (const link of links) {
            nodes[link.a].degree++;
            nodes[link.b].degree++;
        }
        return { nodes, links };
    }

    // один шаг симуляции. alpha — «температура»: с ней затухает движение,
    // иначе граф дрожал бы вечно и жёг батарею
    function simulationStep(alpha) {
        const nodes = graphNodes;
        for (let i = 0; i < nodes.length; i++) {
            const a = nodes[i];
            for (let j = i + 1; j < nodes.length; j++) {
                const b = nodes[j];
                let dx = a.x - b.x;
                let dy = a.y - b.y;
                let dist = Math.hypot(dx, dy);
                if (dist < 0.01) { dx = 0.1; dy = 0.1; dist = 0.14; } // узлы совпали — растащим
                const push = Math.min(600 / (dist * dist), 20) * alpha / dist;
                a.vx += dx * push;
                a.vy += dy * push;
                b.vx -= dx * push;
                b.vy -= dy * push;
            }
        }
        for (const link of graphLinks) {
            const a = nodes[link.a];
            const b = nodes[link.b];
            const pull = 0.02 * alpha;
            const dx = (b.x - a.x) * pull;
            const dy = (b.y - a.y) * pull;
            a.vx += dx;
            a.vy += dy;
            b.vx -= dx;
            b.vy -= dy;
        }
        for (const node of nodes) {
            // лёгкая гравитация к центру, иначе граф расползается. одиночек тянем
            // сильнее: их нечему удерживать, а разлетаясь, они растягивают вид
            const gravity = (node.degree ? 0.004 : 0.03) * alpha;
            node.vx -= node.x * gravity;
            node.vy -= node.y * gravity;

            if (node === draggedNode) { node.vx = 0; node.vy = 0; continue; } // его ведёт мышь
            node.x += node.vx;
            node.y += node.vy;
            node.vx *= 0.6; // трение: без него узлы проскакивают мимо равновесия
            node.vy *= 0.6;
        }
    }

    // все рёбра рисуем одним path: на каждом кадре обновляется один атрибут
    // вместо четырёх на каждую линию — иначе анимация упирается в работу с DOM
    function edgePath(list) {
        let d = '';
        for (const link of list) {
            const a = graphNodes[link.a];
            const b = graphNodes[link.b];
            d += `M${a.x.toFixed(1)} ${a.y.toFixed(1)}L${b.x.toFixed(1)} ${b.y.toFixed(1)}`;
        }
        return d;
    }

    function paintFrame() {
        edgesElement.setAttribute('d', edgePath(graphLinks));
        if (nearLinks.length) nearEdgesElement.setAttribute('d', edgePath(nearLinks));
        for (const node of graphNodes) {
            node.element.setAttribute('transform', `translate(${node.x.toFixed(1)} ${node.y.toFixed(1)})`);
        }
    }

    function runSimulation() {
        cancelAnimationFrame(frameId);
        alpha = 1;
        const tick = () => {
            // в начале считаем по нескольку шагов за кадр — разлёт заканчивается быстрее.
            // на больших графах шаг один: кадр важнее скорости укладки
            const steps = graphNodes.length > 150 ? 1 : (alpha > 0.6 ? 3 : 1);
            for (let i = 0; i < steps; i++) simulationStep(alpha);
            alpha *= 0.985;
            paintFrame();
            if (!settled) fitGraph(graphNodes); // пока раскладка едет, держим её в кадре
            if (alpha > 0.02 || draggedNode) {
                frameId = requestAnimationFrame(tick);
            } else {
                settled = true;
                frameId = 0;
            }
        };
        settled = false;
        frameId = requestAnimationFrame(tick);
    }

    // толчок после вмешательства пользователя: граф оживает, но ненадолго
    function reheat(level = 0.3) {
        alpha = Math.max(alpha, level);
        settled = true; // вид уже подобран — при подогреве камеру не двигаем
        if (!frameId) {
            const tick = () => {
                simulationStep(alpha);
                alpha *= 0.98;
                paintFrame();
                if (alpha > 0.02 || draggedNode) frameId = requestAnimationFrame(tick);
                else frameId = 0;
            };
            frameId = requestAnimationFrame(tick);
        }
    }

    function renderGraph(data) {
        // фильтр по видам применяем до раскладки: скрытые узлы не должны
        // расталкивать видимые, иначе картинка «дышит» при переключении чипов
        const visible = data.notes.filter((note) => graphVisible.has(note.kind));
        const allowed = new Set(visible.map((note) => note.path));
        const rawLinks = data.links.filter(([a, b]) => allowed.has(a) && allowed.has(b));

        cancelAnimationFrame(frameId);
        frameId = 0;
        nearLinks = [];

        if (!visible.length) {
            graphSurface.textContent = '';
            graphHint.textContent = 'Ни один вид не выбран';
            return;
        }

        const { nodes, links } = buildLayout(visible, rawLinks);
        graphNodes = nodes;
        graphLinks = links;
        graphSurface.textContent = '';

        edgesElement = document.createElementNS(SVG_NS, 'path');
        edgesElement.setAttribute('class', 'graph-links');
        nearEdgesElement = document.createElementNS(SVG_NS, 'path');
        nearEdgesElement.setAttribute('class', 'graph-links graph-links--near');
        graphSurface.append(edgesElement, nearEdgesElement);

        for (const node of nodes) {
            const radius = 3 + Math.min(node.degree, 12) * 0.6;
            const group = document.createElementNS(SVG_NS, 'g');
            group.setAttribute('class', `graph-node graph-node--${node.kind}${node.stale ? ' graph-node--stale' : ''}`);
            group.dataset.note = node.path;

            const circle = document.createElementNS(SVG_NS, 'circle');
            circle.setAttribute('r', radius);
            circle.dataset.note = node.path; // клик может прийти и по кружку, и по группе
            const title = document.createElementNS(SVG_NS, 'title');
            title.textContent = node.path;
            circle.append(title);

            const label = document.createElementNS(SVG_NS, 'text');
            label.setAttribute('class', 'graph-label');
            label.setAttribute('y', radius + 4.5);
            label.textContent = node.label;

            group.append(circle, label);
            node.element = group;
            node.labelElement = label;
            node.radius = radius;
            graphSurface.append(group);
        }

        // соседи считаем один раз: подсветка по наведению должна быть мгновенной
        graphNeighbours = new Map(nodes.map((node) => [node.path, new Set()]));
        for (const link of links) {
            graphNeighbours.get(nodes[link.a].path).add(nodes[link.b].path);
            graphNeighbours.get(nodes[link.b].path).add(nodes[link.a].path);
        }

        graphHint.textContent = `${nodes.length} узлов, ${links.length} связей`;
        paintFrame();
        fitGraph(nodes);
        runSimulation();
    }

    function fitGraph(nodes) {
        const xs = nodes.map((node) => node.x);
        const ys = nodes.map((node) => node.y);
        const pad = 40;
        const minX = Math.min(...xs) - pad;
        const minY = Math.min(...ys) - pad;
        let x = minX;
        let w = Math.max(Math.max(...xs) + pad - minX, 1);
        const h = Math.max(Math.max(...ys) + pad - minY, 1);

        // панели фильтров и деталей лежат поверх полотна: расширяем viewBox
        // на их долю, иначе граф уезжает под них
        const rect = graphCanvas.getBoundingClientRect();
        if (rect.width > 600) {
            const left = 244 / rect.width;
            const right = graphDetails.hidden ? 0 : 292 / rect.width;
            const full = w / Math.max(1 - left - right, 0.3);
            x -= full * left;
            w = full;
        }

        graphBox = { x, y: minY, w, h };
        applyGraphBox();
    }

    function applyGraphBox() {
        graphCanvas.setAttribute('viewBox', graphBox.x + ' ' + graphBox.y + ' ' + graphBox.w + ' ' + graphBox.h);
        // на общем плане подписи в 3.5px сливаются — показываем их только вблизи
        graphSurface.classList.toggle('graph--far', graphBox.w > 700);
    }

    // ---------- выбор узла и подсветка соседей ----------

    function nodeByPath(notePath) {
        return graphNodes.find((node) => node.path === notePath);
    }

    function showDetails(node) {
        for (const other of graphNodes) other.element.classList.toggle('graph-node--picked', other === node);
        graphDetailsTitle.textContent = node.label;
        graphDetailsMeta.textContent = [
            node.kind,
            node.file && node.line ? `${node.file}:${node.line}` : node.file,
            node.route,
            node.date,
            node.stale ? 'после сессии файлы менялись' : '',
        ].filter(Boolean).join(' · ');

        const neighbours = [...(graphNeighbours.get(node.path) || [])].sort();
        graphDetailsBody.textContent = '';
        if (neighbours.length) {
            const head = document.createElement('p');
            head.className = 'graph-details__section';
            head.textContent = `Связи (${neighbours.length})`;
            const list = document.createElement('ul');
            list.className = 'graph-details__list';
            for (const item of neighbours) {
                const li = document.createElement('li');
                const button = document.createElement('button');
                button.type = 'button';
                button.textContent = item.replace(/\.md$/, '').split('/').pop();
                button.addEventListener('click', () => {
                    const target = nodeByPath(item);
                    if (target) { showDetails(target); focusNode(target); }
                });
                li.append(button);
                list.append(li);
            }
            graphDetailsBody.append(head, list);
        }
        graphDetails.hidden = false;
    }

    // подводим камеру к узлу, масштаб не трогаем — так не теряется контекст
    function focusNode(node) {
        graphBox.x = node.x - graphBox.w / 2;
        graphBox.y = node.y - graphBox.h / 2;
        applyGraphBox();
    }

    function highlightNeighbours(notePath) {
        const near = notePath ? graphNeighbours.get(notePath) : null;
        for (const node of graphNodes) {
            node.element.classList.toggle('graph-node--near', Boolean(near && near.has(node.path)));
            node.element.classList.toggle('graph-node--hovered', node.path === notePath);
        }
        // рёбра соседства рисуем отдельным path поверх остальных
        nearLinks = notePath
            ? graphLinks.filter((link) => graphNodes[link.a].path === notePath || graphNodes[link.b].path === notePath)
            : [];
        nearEdgesElement.setAttribute('d', nearLinks.length ? edgePath(nearLinks) : '');
        graphSurface.classList.toggle('graph--focused', Boolean(notePath));
    }

    // слушатели вешаем один раз: renderGraph вызывается при каждом фильтре
    // и обновлении карты, внутри них подписываться нельзя
    // клик по узлу разбираем в pointerdown/pointerup, а не в click: из-за
    // setPointerCapture браузер шлёт click на полотно, и узел в event.target уже не найти
    function openNode(node) {
        showDetails(node);   // связи сбоку — обзор
        openFileModal(node); // содержимое узла — окно
    }

    graphSurface.addEventListener('pointerover', (event) => {
        const notePath = event.target.dataset && event.target.dataset.note;
        highlightNeighbours(notePath || null);
    });

    // курсор ушёл с полотна — pointerover больше не придёт, снимаем подсветку сами
    graphCanvas.addEventListener('pointerleave', () => {
        if (!draggedNode) highlightNeighbours(null);
    });

    document.getElementById('graphDetailsClose').addEventListener('click', () => {
        graphDetails.hidden = true;
        for (const node of graphNodes) node.element.classList.remove('graph-node--picked');
    });

    // ---------- окно с содержимым узла ----------

    const fileModal = document.getElementById('fileModal');
    const fileModalTitle = document.getElementById('fileModalTitle');
    const fileModalMeta = document.getElementById('fileModalMeta');
    const fileModalLinks = document.getElementById('fileModalLinks');
    const fileModalText = document.getElementById('fileModalText');
    const fileModalStatus = document.getElementById('fileModalStatus');
    const fileModalSave = document.getElementById('fileModalSave');

    let fileModalPath = null;   // что правим на диске
    let fileModalSaved = '';    // текст на момент открытия — по нему видно, есть ли правки

    // узел графа указывает либо на файл проекта (file, section, function, route),
    // либо на саму заметку vault (session, history, рукописные заметки)
    function nodeSource(node) {
        if (node.file) return { path: node.file, line: node.line };
        if (node.kind === 'file') return { path: node.label };
        return { path: 'vault/' + node.path };
    }

    async function openFileModal(node) {
        const source = nodeSource(node);
        fileModalPath = null;
        fileModalTitle.textContent = source.path;
        fileModalMeta.textContent = 'Загружаю…';
        fileModalText.value = '';
        fileModalText.readOnly = true;
        fileModalSave.disabled = true;
        fileModalStatus.textContent = '';
        renderModalLinks(node);
        App.openModal(fileModal); // окно открывает ядро: там управление фокусом

        let data;
        try {
            const res = await fetch('/api/file/read', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path: source.path }),
            });
            data = await res.json();
        } catch {
            data = { ok: false, error: 'Сервер не ответил' };
        }

        if (!data.ok) {
            fileModalMeta.textContent = data.error;
            return;
        }
        if (data.binary) {
            fileModalMeta.textContent = `Двоичный файл, ${Math.round(data.size / 1024)} КБ${data.note ? ' · ' + data.note : ''}`;
            return;
        }

        fileModalPath = data.path;
        fileModalSaved = data.text;
        fileModalText.value = data.text;
        fileModalText.readOnly = !data.editable;
        fileModalSave.disabled = true;
        fileModalMeta.textContent = [
            `${data.text.split('\n').length} строк`,
            `${Math.round(data.size / 1024)} КБ`,
            node.kind === 'section' || node.kind === 'function' ? `${node.kind} «${node.label}»` : node.kind,
            data.note,
        ].filter(Boolean).join(' · ');

        if (source.line) scrollToLine(source.line);
    }

    // для секции и функции показываем не начало файла, а нужное место
    function scrollToLine(line) {
        const lines = fileModalText.value.split('\n');
        // +1 за перевод строки перед нужной, иначе выделение начинается с него
        const before = lines.slice(0, line - 1).join('\n').length + (line > 1 ? 1 : 0);
        fileModalText.focus();
        fileModalText.setSelectionRange(before, before + (lines[line - 1] || '').length);
        // прокрутка курсора в textarea не гарантирована — считаем позицию сами
        const lineHeight = parseFloat(getComputedStyle(fileModalText).lineHeight) || 18;
        fileModalText.scrollTop = Math.max(0, (line - 3) * lineHeight);
    }

    function renderModalLinks(node) {
        fileModalLinks.textContent = '';
        const neighbours = [...(graphNeighbours && graphNeighbours.get(node.path) || [])].sort();
        for (const item of neighbours.slice(0, 40)) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'file-modal__link';
            button.textContent = item.replace(/\.md$/, '').split('/').pop();
            button.addEventListener('click', () => {
                const target = nodeByPath(item);
                if (target) { showDetails(target); focusNode(target); openFileModal(target); }
            });
            fileModalLinks.append(button);
        }
    }

    fileModalText.addEventListener('input', () => {
        fileModalSave.disabled = fileModalText.readOnly || fileModalText.value === fileModalSaved;
        fileModalStatus.textContent = fileModalSave.disabled ? '' : 'есть несохранённые правки';
    });

    fileModalSave.addEventListener('click', saveFileModal);

    // Ctrl+S привычнее кнопки, когда правишь код
    fileModalText.addEventListener('keydown', (event) => {
        if ((event.ctrlKey || event.metaKey) && event.key === 's') {
            event.preventDefault();
            if (!fileModalSave.disabled) saveFileModal();
        }
    });

    async function saveFileModal() {
        if (!fileModalPath) return;
        fileModalSave.disabled = true;
        fileModalStatus.textContent = 'Сохраняю…';
        const text = fileModalText.value;

        let data;
        try {
            const res = await fetch('/api/file/write', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path: fileModalPath, text }),
            });
            data = await res.json();
        } catch {
            data = { ok: false, error: 'Сервер не ответил' };
        }

        if (!data.ok) {
            fileModalStatus.textContent = data.error;
            fileModalSave.disabled = false;
            return;
        }
        fileModalSaved = text;
        fileModalStatus.textContent = 'Сохранено';
    }

    // ---------- поиск ----------

    let graphSearchTimer = null;

    graphSearch.addEventListener('input', () => {
        clearTimeout(graphSearchTimer);
        graphSearchTimer = setTimeout(runGraphSearch, 200); // ждём паузу в наборе
    });

    async function runGraphSearch() {
        const query = graphSearch.value.trim();
        if (!query) {
            graphSurface.classList.remove('graph--search');
            for (const node of graphNodes) {
                node.element.classList.remove('graph-node--hit');
            }
            graphHint.textContent = `${graphNodes.length} узлов, ${graphLinks.length} связей`;
            return;
        }

        let data;
        try {
            const res = await fetch('/api/search', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ q: query, limit: 40 }),
            });
            data = await res.json();
        } catch {
            data = { ok: false, error: 'Сервер не ответил' };
        }
        if (!data.ok) {
            graphHint.textContent = data.error;
            return;
        }

        // сервер отвечает ссылками на заметки — сопоставляем их с узлами графа
        const hits = new Set(data.hits.map((hit) => `${hit.ref}.md`));
        let shown = 0;
        for (const node of graphNodes) {
            const hit = hits.has(node.path);
            if (hit) shown++;
            node.element.classList.toggle('graph-node--hit', hit);
        }
        graphSurface.classList.add('graph--search');
        graphHint.textContent = data.hits.length
            ? `Найдено ${data.hits.length}, видно в графе ${shown}`
            : 'Ничего не найдено';
    }

    // зум колесом — к точке под курсором, как в виде Flow
    graphCanvas.addEventListener('wheel', (event) => {
        if (!graphBox) return;
        event.preventDefault();
        settled = true; // пользователь взял камеру в руки — автоподгонка кадра больше её не трогает
        const rect = graphCanvas.getBoundingClientRect();
        const factor = event.deltaY < 0 ? 0.85 : 1 / 0.85;
        const px = graphBox.x + ((event.clientX - rect.left) / rect.width) * graphBox.w;
        const py = graphBox.y + ((event.clientY - rect.top) / rect.height) * graphBox.h;
        graphBox.x = px - (px - graphBox.x) * factor;
        graphBox.y = py - (py - graphBox.y) * factor;
        graphBox.w *= factor;
        graphBox.h *= factor;
        applyGraphBox();
    }, { passive: false });

    let graphDrag = null;    // тянем полотно
    let dragMoved = false;   // отличаем перетаскивание от клика
    let pressedNode = null;  // узел, на котором нажали кнопку
    let pressStart = null;   // точка нажатия: от неё считаем, было ли движение
    const DRAG_SLOP = 4;     // столько пикселей прощаем дрожанию руки

    function movedFar(event) {
        if (!pressStart) return true;
        return Math.abs(event.clientX - pressStart.x) > DRAG_SLOP
            || Math.abs(event.clientY - pressStart.y) > DRAG_SLOP;
    }

    // экранные координаты в координаты графа: нужно, чтобы узел не убегал от курсора
    function toGraphPoint(event) {
        const rect = graphCanvas.getBoundingClientRect();
        return {
            x: graphBox.x + ((event.clientX - rect.left) / rect.width) * graphBox.w,
            y: graphBox.y + ((event.clientY - rect.top) / rect.height) * graphBox.h,
        };
    }

    graphCanvas.addEventListener('pointerdown', (event) => {
        if (!graphBox) return;
        dragMoved = false;
        // захват нужен, чтобы не терять указатель за краем полотна. если система
        // его уже отпустила, это не повод ронять весь обработчик и терять клик
        try {
            graphCanvas.setPointerCapture(event.pointerId);
        } catch {
            // работаем без захвата
        }

        // начали на узле — тянем узел, а соседи подтягиваются за ним следом
        pressStart = { x: event.clientX, y: event.clientY };

        const notePath = event.target.dataset && event.target.dataset.note;
        const node = notePath && nodeByPath(notePath);
        if (node) {
            pressedNode = node;
            draggedNode = node;
            graphSurface.classList.add('graph--dragging');
            reheat(0.35);
            return;
        }
        graphDrag = { x: event.clientX, y: event.clientY };
    });

    graphCanvas.addEventListener('pointermove', (event) => {
        if (draggedNode) {
            const point = toGraphPoint(event);
            draggedNode.x = point.x;
            draggedNode.y = point.y;
            if (movedFar(event)) dragMoved = true; // иначе дрожь руки съедала бы клик
            reheat(0.3); // пока тянем, симуляция не должна засыпать
            return;
        }
        if (!graphDrag) return;
        const rect = graphCanvas.getBoundingClientRect();
        graphBox.x -= ((event.clientX - graphDrag.x) / rect.width) * graphBox.w;
        graphBox.y -= ((event.clientY - graphDrag.y) / rect.height) * graphBox.h;
        graphDrag = { x: event.clientX, y: event.clientY };
        if (movedFar(event)) dragMoved = true;
        applyGraphBox();
    });

    function endDrag() {
        if (draggedNode) {
            draggedNode = null;
            graphSurface.classList.remove('graph--dragging');
            reheat(0.2); // отпустили — граф доукладывается сам
        }
        graphDrag = null;
        if (pressedNode && !dragMoved) openNode(pressedNode); // узел не тащили — значит выбрали
        pressedNode = null;
        pressStart = null;
    }

    graphCanvas.addEventListener('pointerup', endDrag);
    graphCanvas.addEventListener('pointercancel', endDrag);
    window.MissionGraph = {
        show(force) { showGraph(force); },
    };
})();
