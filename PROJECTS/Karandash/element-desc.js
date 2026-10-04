// Описание выбранного элемента для задачи: подпись, селектор, путь по предкам
// и ориентиры. Живёт отдельно от режима наведения (karandash.js), потому что это
// самостоятельная работа со своим правилом — что именно попадает в строку
// «UI element:», которую потом читает сборщик TOOLS/homework (DOCS/decisions/084).
//
// Путь по предкам и номер среди соседей добавлены потому, что одного селектора
// часто не хватает: класс бывает один на три отображения (DOCS/decisions/039 —
// так сделана плашка модели `model-tag`), и без пути сборщик отбрасывал такой
// якорь как слишком общий, а отчёт выходил пустым.
(function () {
    // человекочитаемое имя раздела — id корневого .view переводим в название,
    // под которым пользователь знает вкладку в тулбаре приложения
    const VIEW_NAMES = {
        flowView: 'Flow',
        kanbanView: 'Kanban',
        sessionsView: 'Sessions',
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

    // название ориентира берём из его же aria-label/title, а если их нет — из
    // ближайшего заголовка внутри (панель настроек и модалка обычно так подписаны)
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

    function viewName(el, hostFrame) {
        // элемент из кадра сам про наши вкладки ничего не знает — раздел
        // определяем по кадру, в котором он лежит
        const anchor = (hostFrame && hostFrame(el.ownerDocument)) || el;
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
// служебные и меняющиеся классы в качестве пути бесполезны: по ним в коде
    // нет ни одной строки, а по постоянным — есть. Поэтому в путь идёт первый
    // класс, который не про состояние, иначе путь был бы из одних is-active
    const STATE_CLASS = /^(is-|has-|js-|[a-z]+--?(open|closed|active|hidden|selected|hover)$)/i;

    // короткий крючок узла для пути: id, а из классов — первый не служебный
    function pathHook(node) {
        if (node.id) return '#' + node.id;
        const tag = node.tagName.toLowerCase();
        if (typeof node.className !== 'string') return tag;
        const cls = node.className.trim().split(/\s+/).find((c) => c && !STATE_CLASS.test(c));
        return cls ? `${tag}.${cls}` : tag;
    }

    // путь вверх на несколько уровней: селектор сам по себе не говорит, где
    // элемент в разметке, а вот предок с собственным классом или id встречается
    // в коде узко — и по нему файлы находятся точно (DOCS/decisions/084)
    function ancestorPath(el, levels = 3) {
        const out = [];
        let cur = el.parentElement;
        while (cur && cur !== cur.ownerDocument.body && out.length < levels) {
            if (cur.classList && cur.classList.contains('view')) break; // дальше вкладка
            out.push(pathHook(cur));
            cur = cur.parentElement;
        }
        return out.reverse().join(' > ');
    }

    // номер среди соседей одного крючка: их на странице бывает много (плашка
    // модели над каждым ответом ленты), и без номера непонятно, о каком именно
    // говорит человек — а выглядят они одинаково
    function nthOf(el) {
        const parent = el.parentElement;
        if (!parent || !parent.children || !parent.children.length) return null;
        const hook = pathHook(el);
        const same = [...parent.children].filter((c) => pathHook(c) === hook);
        return same.length > 1 ? `${same.indexOf(el) + 1} of ${same.length}` : null;
    }

    function describe(el, hostFrame) {
        const id = el.id ? '#' + el.id : '';
        const cls = typeof el.className === 'string' && el.className
            ? '.' + el.className.trim().split(/\s+/).join('.')
            : '';
        const selector = el.tagName.toLowerCase() + id + cls;

        const label = humanLabel(el);
        // элемент из кадра: подписываем, в каком именно, — иначе по одному
        // селектору не понять, что он не из нашей разметки
        const host = hostFrame && hostFrame(el.ownerDocument);
        const inFrame = host ? `embedded ${host.title || 'frame'}` : null;
        const where = [viewName(el, hostFrame), inFrame, ...findLandmarks(el)].filter(Boolean).join(' → ');

        const path = ancestorPath(el);
        const nth = nthOf(el);

        const parts = [];
        if (label) parts.push(`«${label}»`);
        parts.push(selector);
        // путь и номер — то, ради чего место находится сразу: селектор без них
        // указывает на десяток одинаковых элементов (плашка модели над каждым
        // ответом ленты), и сборщик такой якорь отбрасывает как слишком общий
        if (path) parts.push(`in ${path}`);
        if (nth) parts.push(`(${nth})`);
        if (where) parts.push(`— section ${where}`);
        return parts.join(' ');
    }

    window.KarandashDesc = { describe };
})();