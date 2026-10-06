// Режим комментариев к элементам интерфейса. Кнопка в тулбаре — не здесь: её
// разметка лежит в SYSTEM/topbar.eta вместе со всем верхним меню, а скрипт
// реализует только её поведение. Дублировать кнопку он больше не может —
// статичный узел шаблона не снимается, и вторая копия осталась бы поверх первой
// навсегда. Свою разметку скрипт рисует ровно одну: рамку наведения и попап
// комментария. Наведение рисует рамку, колесо поднимает выбор к родителю, клик
// открывает поле — комментарий уходит отдельной сессией.
(function () {
    // ---------- разметка ----------

    // Все слушатели скрипта — на одном сигнале, и снимаются разом. Кнопка в
    // тулбаре и document переживают горячую перезагрузку этого файла: второй
    // экземпляр навесил бы на них свои поверх старых, и клик по кнопке
    // переключал бы режим дважды — то есть не переключал бы вовсе.
    const listeners = new AbortController();
    const ON = { signal: listeners.signal };

    // кнопка — из шаблона верхнего меню, скрипт её только оживляет
    const karandashButton = document.getElementById('karandashButton');

    const frame = document.createElement('div');
    frame.className = 'hover-frame';
    frame.id = 'hoverFrame';
    frame.hidden = true;
    document.body.appendChild(frame);

    const popover = document.createElement('div');
    popover.className = 'comment-popover';
    popover.id = 'commentPopover';
    popover.setAttribute('role', 'dialog');
    popover.setAttribute('aria-modal', 'false');
    popover.setAttribute('aria-label', 'Comment on element');
    popover.hidden = true;
    popover.innerHTML = `
        <div class="comment-popover__target" id="commentTarget"></div>
        <textarea class="comment-popover__field" id="commentField" placeholder="Comment on element..."></textarea>
        <div class="mode-switch" id="commentMode" role="radiogroup" aria-label="Send mode" data-active="Action">
            <span class="mode-switch__thumb" aria-hidden="true"></span>
            <button type="button" class="mode-switch__option" role="radio" aria-checked="false" data-mode="Chat" tabindex="-1">Chat</button>
            <button type="button" class="mode-switch__option" role="radio" aria-checked="true" data-mode="Action" tabindex="0">Action</button>
            <button type="button" class="mode-switch__option mode-switch__option--soon" role="radio" aria-checked="false" data-mode="Loop" tabindex="-1" disabled title="Coming Soon">Loop</button>
        </div>
        <div class="comment-popover__actions">
            <button type="button" class="comment-popover__button" id="commentCancel">Cancel</button>
            <button type="button" class="comment-popover__button comment-popover__button--primary" id="commentSave">Send</button>
        </div>
    `;
    document.body.appendChild(popover);

    const popoverTarget = popover.querySelector('#commentTarget');
    const field = popover.querySelector('#commentField');
    const commentCancel = popover.querySelector('#commentCancel');
    const commentSave = popover.querySelector('#commentSave');

    // Подсказка кнопки — не «Karandash», а тот провайдер и та модель, с
    // которыми уйдёт следующий ход (window.App.getActiveProviderId /
    // getActiveModel — тот же порядок, что и у отправки хода). Само имя кнопки
    // не меняем: id, aria-label и класс остаются «Karandash», по ним её
    // находят и режим комментариев, и агент, когда про неё говорят.
    // Пересчитываем при каждом наведении и фокусе, а не по событию смены
    // провайдера: подсказка нужна ровно тогда, когда на неё смотрят, и так
    // она всегда верна — сменил человек провайдера в шапке или подключил
    // нового, ничего ждать не надо.
    function refreshTitle() {
        const app = window.App;
        if (!app) return;
        const providerId = app.getActiveProviderId?.();
        const model = app.getActiveModel?.();
        const text = [providerId, model].filter(Boolean).join(' / ') || 'Karandash';
        karandashButton.title = text;
    }

    karandashButton.addEventListener('mouseenter', refreshTitle, ON);
    karandashButton.addEventListener('focus', refreshTitle, ON);
    refreshTitle();

    // режим отправки комментария: те же Chat/Action/Loop, что и в композере
    // вкладки Sessions. Переключатель один на оба места — стиль общий
    // (SYSTEM/styles/mode-switch.css, .mode-switch), свой компонент в каждом
    // разошёлся бы при первой же правке
    const commentMode = popover.querySelector('#commentMode');
    const commentModeOptions = [...commentMode.querySelectorAll('.mode-switch__option')].filter((o) => !o.disabled);

    function setCommentMode(mode) {
        commentMode.dataset.active = mode;
        for (const option of commentModeOptions) {
            const active = option.dataset.mode === mode;
            option.setAttribute('aria-checked', String(active));
            option.tabIndex = active ? 0 : -1;
        }
    }

    commentMode.addEventListener('click', (e) => {
        const option = e.target.closest('.mode-switch__option');
        if (option) setCommentMode(option.dataset.mode);
    }, ON);

    // стрелками переключаемся между опциями, как в обычной группе радиокнопок
    commentMode.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        const current = commentModeOptions.findIndex((o) => o.dataset.mode === commentMode.dataset.active);
        const next = commentModeOptions[(current + (e.key === 'ArrowRight' ? 1 : -1) + commentModeOptions.length) % commentModeOptions.length];
        setCommentMode(next.dataset.mode);
        next.focus();
    }, ON);

    // ---------- режим комментариев ----------

    // исключаем только собственный слой режима — рамку и окно комментария.
    // всё остальное на странице комментируется, включая меню настроек
    const OWN_UI = '.hover-frame, .comment-popover';

    // отступы окна комментария от элемента и от края экрана
    const POPOVER_GAP = 10;
    const VIEWPORT_EDGE_MARGIN = 8;

    let karandashMode = false;
    let picked = null;

    // Описание элемента для задачи живёт в соседнем файле element-desc.js: это
    // самостоятельная работа (подпись, путь по предкам, ориентиры), а режим
    // наведения её только вызывает. Здесь — только приём элемента кадра, о
    // котором описание ничего не знает.
    const describeElement = (el) => window.KarandashDesc.describe(el, hostFrame(el.ownerDocument));

    // ---------- спуск в свои кадры ----------
    //
    // Общая поддержка кадров своего origin — на случай, если где-то на странице
    // снова появится <iframe> (сейчас на всей странице их нет: вкладка Kanban
    // больше не встраивает доску отдельным кадром, DOCS/decisions/032). Пока
    // кадра нет, весь код ниже простаивает и не влияет на обычные элементы.
    //
    // Сам кадр при этом прозрачен для указателя (karandash.css) — иначе он забирает
    // события мыши себе и режим над ним слепнет. Поэтому elementFromPoint кадр не
    // возвращает, и попадание в него мы считаем сами, по его прямоугольнику.

    // документ кадра, если он наш; чужой origin бросает исключение — там нам нечего делать
    function frameDoc(frameEl) {
        try {
            return frameEl.contentDocument || null;
        } catch {
            return null;
        }
    }

    function frameAt(x, y) {
        for (const el of document.querySelectorAll('iframe')) {
            const r = el.getBoundingClientRect();
            if (x >= r.left && x < r.right && y >= r.top && y < r.bottom && frameDoc(el)) return el;
        }
        return null;
    }

    // кадр нашей страницы, внутри которого лежит этот документ
    function hostFrame(doc) {
        if (doc === document) return null;
        for (const frameEl of document.querySelectorAll('iframe')) {
            if (frameDoc(frameEl) === doc) return frameEl;
        }
        return null;
    }

    // смещение документа элемента относительно нашего окна: для элементов внутри
    // кадра рамку надо рисовать со сдвигом на его позицию
    function documentOffset(el) {
        const host = hostFrame(el.ownerDocument);
        if (!host) return { x: 0, y: 0 };
        const r = host.getBoundingClientRect();
        return { x: r.left, y: r.top };
    }

    // элемент под курсором с заходом внутрь своих кадров
    function elementAt(x, y) {
        const frameEl = frameAt(x, y);
        if (!frameEl) return document.elementFromPoint(x, y);
        const r = frameEl.getBoundingClientRect();
        // внутри кадра координаты считаются от его собственного окна
        return frameDoc(frameEl).elementFromPoint(x - r.left, y - r.top) || frameEl;
    }

    // клик по иконке попадает в <path> внутри <svg> — поднимаемся до кнопки,
    // которая её содержит. Самостоятельные SVG-фигуры (например стрелки Flow)
    // кнопкой не обёрнуты — их оставляем как есть, иначе не по чему кликнуть
    const SVG_NS = 'http://www.w3.org/2000/svg';

    function resolve(el) {
        // instanceof здесь не годится: у документа кадра свои конструкторы,
        // и его <path> не является SVGElement нашего окна
        if (el && el.namespaceURI === SVG_NS) {
            return el.closest('button, a') || el;
        }
        return el;
    }

    function isTargetable(el) {
        return el && el.nodeType === 1 && !el.closest(OWN_UI);
    }

    // elementFromPoint отдаёт только верхний элемент, поэтому контейнер,
    // целиком закрытый детьми (колонка канбана, форма композера, сам view),
    // иначе недостижим. Колесо мыши поднимает рамку по цепочке предков.
    function lift(el, depth) {
        let cur = el;
        for (let i = 0; i < depth; i++) {
            const parent = cur.parentElement;
            // граница подъёма — body того документа, где элемент живёт:
            // из кадра в нашу страницу колесом не выходим
            if (!parent || parent === cur.ownerDocument.body) break;
            cur = parent;
        }
        return cur;
    }

    function drawFrame(el) {
        const r = el.getBoundingClientRect();
        const off = documentOffset(el); // элемент из кадра — его координаты от окна кадра
        frame.style.top = (r.top + off.y) + 'px';
        frame.style.left = (r.left + off.x) + 'px';
        frame.style.width = r.width + 'px';
        frame.style.height = r.height + 'px';
        frame.hidden = false;
    }

    function placePopover(el, target) {
        const raw = el.getBoundingClientRect();
        const off = documentOffset(el);
        const r = {
            top: raw.top + off.y, bottom: raw.bottom + off.y,
            left: raw.left + off.x, height: raw.height,
        };
        const box = target.getBoundingClientRect();

        // под элементом, если снизу есть место, иначе над ним
        let top = r.bottom + POPOVER_GAP;
        if (top + box.height > window.innerHeight - VIEWPORT_EDGE_MARGIN) {
            top = Math.max(VIEWPORT_EDGE_MARGIN, r.top - box.height - POPOVER_GAP);
        }

        // по левому краю элемента, но не вылезая за экран
        let left = r.left;
        left = Math.min(left, window.innerWidth - box.width - VIEWPORT_EDGE_MARGIN);
        left = Math.max(VIEWPORT_EDGE_MARGIN, left);

        target.style.top = top + 'px';
        target.style.left = left + 'px';
    }

    function openPopover(el) {
        picked = el;
        frame.classList.add('hover-frame--picked');
        drawFrame(el);
        popoverTarget.textContent = describeElement(el);
        field.value = '';
        setCommentMode('Action'); // каждое новое открытие начинается с режима по умолчанию
        popover.hidden = false;
        placePopover(el, popover);
        field.focus();
    }

    function closePopover() {
        popover.hidden = true;
        picked = null;
        hoverBase = null;
        hoverDepth = 0;
        frame.classList.remove('hover-frame--picked');
        frame.hidden = true;
    }

    function syncKarandashItem() {
        karandashButton.setAttribute('aria-pressed', String(karandashMode));
    }

    function enterKarandash() {
        karandashMode = true;
        document.body.classList.add('karandash-mode');
        syncKarandashItem();
        if (rafId === null) track();
    }

    function exitKarandash() {
        karandashMode = false;
        document.body.classList.remove('karandash-mode');
        closePopover();
        syncKarandashItem();
        if (rafId !== null) {
            cancelAnimationFrame(rafId);
            rafId = null;
        }
    }

    // запоминаем позицию курсора и каждый кадр смотрим, что под ней находится.
    // так подхватываются любые элементы, в том числе появившиеся после загрузки
    // или возникшие под неподвижным курсором, а рамка следует за движущимся элементом
    let cursorX = -1;
    let cursorY = -1;
    let rafId = null;
    let hoverBase = null;   // элемент под курсором до подъёма
    let hovered = null;     // элемент, который сейчас в рамке
    let hoverDepth = 0;     // сколько уровней подняли колесом

    document.addEventListener('pointermove', (e) => {
        cursorX = e.clientX;
        cursorY = e.clientY;
    }, { ...ON, capture: true });

    function track() {
        rafId = requestAnimationFrame(track);
        if (!karandashMode) return;

        if (picked) {
            drawFrame(picked);
            placePopover(picked, popover);
            return;
        }

        if (cursorX < 0) return;

        const base = resolve(elementAt(cursorX, cursorY));
        if (!isTargetable(base)) {
            frame.hidden = true;
            hovered = null;
            return;
        }

        // сменился элемент под курсором — подъём начинаем заново
        if (base !== hoverBase) {
            hoverBase = base;
            hoverDepth = 0;
        }

        hovered = lift(base, hoverDepth);
        drawFrame(hovered);
    }

    // колесо вверх — к родителю, вниз — обратно к элементу под курсором;
    // прокрутка страницы в режиме Karandash при этом не нужна
    document.addEventListener('wheel', (e) => {
        if (!karandashMode || picked) return;
        e.preventDefault();
        hoverDepth = Math.max(0, hoverDepth + (e.deltaY < 0 ? 1 : -1));
    }, { ...ON, capture: true, passive: false });

    // перехватываем клик до обычных обработчиков страницы
    let clickSeen = false;
    document.addEventListener('click', (e) => {
        clickSeen = true;
        if (!karandashMode) return;
        // проверяем именно цель клика: по кнопкам окна комментария
        // режим не должен срабатывать, иначе они перестают нажиматься
        if (!isTargetable(resolve(e.target))) return;
        const el = hovered || resolve(e.target);

        e.preventDefault();
        e.stopPropagation();
        openPopover(el);
    }, { ...ON, capture: true });

    // клик по нативному скроллбару браузер не превращает в событие click,
    // поэтому такой элемент нельзя было выбрать наведением на его скролл —
    // ловим это через pointerup и достраиваем выбор, если click не пришёл следом
    document.addEventListener('pointerup', (e) => {
        if (!karandashMode || e.button !== 0) return;
        if (!isTargetable(resolve(e.target))) return;
        const el = hovered || resolve(e.target);
        e.preventDefault();
        e.stopPropagation();
        clickSeen = false;
        setTimeout(() => {
            if (!clickSeen) openPopover(el);
        }, 0);
    }, { ...ON, capture: true });

    // Esc выключает режим и закрывает открытое окно комментария;
    // меню закрывает обработчик выше, поэтому одного нажатия хватает на всё
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape' || !karandashMode) return;
        exitKarandash();
    }, ON);

    // в поле комментария те же правила: Enter — новая строка, Ctrl+Enter — отправка
    field.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            commentSave.click();
        }
    }, ON);

    commentCancel.addEventListener('click', exitKarandash, ON);

    // снимок для миниатюры сессии — настоящий скриншот экрана. Canvas на фронтенде
    // видит только содержимое вкладки, а не экран целиком, поэтому снимает сервер
    // (node-screenshots, уменьшает кадр sharp); фронт лишь просит его и ждёт ответ.
    // Может не получиться — тогда просто вернём null, сессия останется с плейсхолдером
    async function captureThumb() {
        try {
            const res = await fetch('/api/screenshot', { method: 'POST' });
            const data = await res.json();
            return data.ok ? data.thumb : null;
        } catch {
            return null;
        }
    }

    // Сборку запроса делает соседний comment-prompt.js: каждая строка в нём
    // приезжает своим файлом (описание, место в коде, текущий вид), и держать
    // этот список здесь значит растить файл режима (DOCS/decisions/022)

    commentSave.addEventListener('click', async () => {
        const comment = field.value.trim();
        if (!comment || !picked || commentSave.disabled) return;

        // блокируем повторный клик на время двух запросов — иначе второй клик мог бы
        // запустить переход в чат раньше, чем первый снимок успеет отработать
        commentSave.disabled = true;
        const mode = commentMode.dataset.active; // Chat — обсудить место, Action — внести правку

        // окно комментария закрываем сразу, а рамка на элементе остаётся — так в
        // снимок попадает выбранный элемент, но не сам попап
        popover.hidden = true;

        // место в коде и снимок экрана идут вместе: оба запроса к серверу, оба
        // нужны до ухода в чат
        const [place, thumb] = await Promise.all([
            window.KarandashCode.locate(picked),
            captureThumb(),
        ]);
        const prompt = window.KarandashPrompt.build(picked, comment, place, hostFrame(picked.ownerDocument));
        // рамка на элементе остаётся до самого ухода — так в скриншот попадает
        // выбранный элемент, а не сам попап
        commentSave.disabled = false;

        exitKarandash(); // снимает рамку и выходит из режима Karandash
        App.startCommentSession(prompt, thumb, mode);
    }, ON);

    // ---------- кнопка ----------

    karandashButton.addEventListener('click', () => {
        karandashMode ? exitKarandash() : enterKarandash();
    }, ON);

    // горячая перезагрузка этого скрипта: снимаем всё, что он нарисовал, и свои
    // слушатели, иначе свежая копия добавит вторую рамку поверх первой, а на
    // общих узлах — кнопке и document — ещё и вторые обработчики. Кнопку в
    // тулбаре не снимаем: она теперь из шаблона (SYSTEM/topbar.eta), и снятая
    // кнопка уехала бы из меню до перерисовки страницы.
    window.App?.registerHotReload('PROJECTS/Karandash/karandash.js', () => {
        if (karandashMode) exitKarandash();
        listeners.abort();
        frame.remove();
        popover.remove();
    });
})();
