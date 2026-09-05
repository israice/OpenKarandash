// Кнопка Karandash: полностью самодостаточный файл. Создаёт свою разметку (кнопку в
// тулбаре, рамку наведения и попап комментария) и реализует режим комментариев
// к элементам интерфейса. Наведение рисует рамку, колесо поднимает выбор к
// родителю, клик открывает поле — комментарий уходит отдельной сессией.
(function () {
    // ---------- разметка ----------

    const toolbar = document.createElement('div');
    toolbar.className = 'toolbar';
    toolbar.setAttribute('role', 'toolbar');
    toolbar.setAttribute('aria-label', 'Karandash');
    toolbar.innerHTML = `
        <button type="button" class="icon-button" id="karandashButton" aria-pressed="false" aria-label="Karandash" title="Karandash">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M12 20h9"></path>
                <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"></path>
            </svg>
        </button>
    `;
    const settings = document.getElementById('settings');
    settings.parentElement.insertBefore(toolbar, settings);

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
        <div class="comment-popover__actions">
            <button type="button" class="comment-popover__button" id="commentCancel">Cancel</button>
            <button type="button" class="comment-popover__button comment-popover__button--primary" id="commentSave">Save</button>
        </div>
    `;
    document.body.appendChild(popover);

    const karandashButton = toolbar.querySelector('#karandashButton');
    const popoverTarget = popover.querySelector('#commentTarget');
    const field = popover.querySelector('#commentField');
    const commentCancel = popover.querySelector('#commentCancel');
    const commentSave = popover.querySelector('#commentSave');

    // ---------- режим комментариев ----------

    // исключаем только собственный слой режима — рамку и окно комментария.
    // всё остальное на странице комментируется, включая меню настроек
    const OWN_UI = '.hover-frame, .comment-popover';

    // отступы окна комментария от элемента и от края экрана
    const POPOVER_GAP = 10;
    const VIEWPORT_EDGE_MARGIN = 8;

    let karandashMode = false;
    let picked = null;

    // человекочитаемое имя раздела — id корневого .view переводим в название,
    // под которым пользователь знает вкладку в тулбаре приложения
    const VIEW_NAMES = {
        defaultView: 'Home',
        flowView: 'Flow',
        kanbanView: 'Kanban',
        chatView: 'Sessions',
    };

    // ориентиры на пути к элементу — тулбары, боковые панели, модалки:
    // по ним понятно, в каком блоке интерфейса элемент физически находится
    const LANDMARKS = [
        { selector: '[role="dialog"], .modal, .comment-popover', kind: 'modal dialog' },
        { selector: '[role="toolbar"], .toolbar', kind: 'toolbar' },
        { selector: '[role="tablist"]', kind: 'tab list' },
        { selector: 'nav, .side-nav, aside', kind: 'side panel' },
        { selector: 'header', kind: 'header' },
        { selector: 'footer', kind: 'footer' },
    ];

    function landmarkKind(el) {
        const found = LANDMARKS.find((l) => el.matches(l.selector));
        return found ? found.kind : null;
    }

    // название ориентира берём из его же aria-label/title, а если их нет —
    // из ближайшего заголовка внутри (панели настроек и модалки обычно так подписаны)
    function landmarkLabel(el) {
        const aria = (el.getAttribute('aria-label') || el.getAttribute('title') || '').trim();
        if (aria) return aria;
        const heading = el.querySelector(':scope > h1, :scope > h2, :scope > h3, :scope > [class$="__title"]');
        const text = heading && heading.textContent.trim();
        return text || null;
    }

    function findLandmarks(el) {
        const landmarks = [];
        let cur = el.parentElement;
        while (cur && cur !== cur.ownerDocument.body && landmarks.length < 2) {
            const kind = landmarkKind(cur);
            if (kind) {
                const label = landmarkLabel(cur);
                landmarks.push(label ? `${kind} «${label}»` : kind);
            }
            cur = cur.parentElement;
        }
        return landmarks;
    }

    function viewName(el) {
        // элемент из кадра сам про наши вкладки ничего не знает — раздел
        // определяем по кадру, в котором он лежит
        const anchor = hostFrame(el.ownerDocument) || el;
        const view = anchor.closest('.view');
        return view ? (VIEW_NAMES[view.id] || view.id) : null;
    }

    // подпись элемента для человека: то, как его видит пользователь, а не только селектор
    function humanLabel(el) {
        for (const attr of ['aria-label', 'title', 'placeholder', 'alt', 'name']) {
            const v = el.getAttribute && el.getAttribute(attr);
            if (v && v.trim()) return v.trim();
        }
        return null;
    }

    function describe(el) {
        const id = el.id ? '#' + el.id : '';
        const cls = typeof el.className === 'string' && el.className
            ? '.' + el.className.trim().split(/\s+/).join('.')
            : '';
        const selector = el.tagName.toLowerCase() + id + cls;

        const label = humanLabel(el);
        // элемент из кадра: подписываем, в каком именно, — иначе по одному
        // селектору не понять, что он не из нашей разметки
        const host = hostFrame(el.ownerDocument);
        const inFrame = host ? `embedded ${host.title || 'frame'}` : null;
        const where = [viewName(el), inFrame, ...findLandmarks(el)].filter(Boolean).join(' → ');

        const parts = [];
        if (label) parts.push(`«${label}»`);
        parts.push(selector);
        if (where) parts.push(`— section ${where}`);
        return parts.join(' ');
    }

    // ---------- спуск в свои кадры ----------
    //
    // Вкладка Kanban показывает beads-web отдельным <iframe>. Пока он был чужого
    // origin, внутрь заглянуть было нечем, и рамка накрывала доску целиком. Теперь
    // доска отдаётся с нашего порта (PROJECTS/Kanban/kanban-server.js), её документ
    // читается, и указывать можно на её же кнопки и карточки.
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
        popoverTarget.textContent = describe(el);
        field.value = '';
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
    }, true);

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
    }, { capture: true, passive: false });

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
    }, true);

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
    }, true);

    // Esc выключает режим и закрывает открытое окно комментария;
    // меню закрывает обработчик выше, поэтому одного нажатия хватает на всё
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape' || !karandashMode) return;
        exitKarandash();
    });

    // в поле комментария те же правила: Enter — новая строка, Ctrl+Enter — отправка
    field.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            commentSave.click();
        }
    });

    commentCancel.addEventListener('click', exitKarandash);

    // снимок для миниатюры сессии — настоящий скриншот экрана. Canvas на фронтенде
    // видит только содержимое вкладки, а не экран целиком, поэтому снимает сервер
    // (PowerShell + System.Drawing); фронт лишь просит его и ждёт ответ.
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

    // из комментария собираем вопрос: что за элемент и что о нём написал пользователь
    function buildCommentPrompt(el, comment) {
        // у контейнеров в textContent лежит всё их содержимое — такой «текст элемента»
        // только зашумляет вопрос, поэтому берём его лишь у коротких элементов
        const text = (el.textContent || '').trim().replace(/\s+/g, ' ');
        const lines = [`UI element: ${describe(el)}`];
        if (text && text.length <= 120) lines.push(`Element text: ${text}`);
        lines.push(`Comment: ${comment}`);
        return lines.join('\n');
    }

    commentSave.addEventListener('click', async () => {
        const comment = field.value.trim();
        if (!comment || !picked || commentSave.disabled) return;

        // блокируем повторный клик на время захвата — иначе второй клик мог бы
        // запустить переход в чат раньше, чем первый снимок успеет отработать
        commentSave.disabled = true;
        const prompt = buildCommentPrompt(picked, comment);

        // окно комментария закрывается сразу, а рамка на элементе остаётся —
        // так в скриншот попадает выбранный элемент, но не сам попап
        popover.hidden = true;
        const thumb = await captureThumb();
        commentSave.disabled = false;

        exitKarandash(); // снимает рамку и выходит из режима Karandash
        App.startCommentSession(prompt, thumb);
    });

    // ---------- кнопка ----------

    karandashButton.addEventListener('click', () => {
        karandashMode ? exitKarandash() : enterKarandash();
    });
})();
