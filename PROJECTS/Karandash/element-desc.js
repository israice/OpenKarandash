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
    // под которым пользователь знает вкладку в тулбаре приложения.
    //
    // Ключи — настоящие id видов из SYSTEM/index.html, а не те, что были в
    // таблице раньше: там стоял sessionsView, которого в разметке нет вовсе
    // (вкладка называется chatView), и имя не подставлялось — в описание уезжал
    // сырой id, по которому ни человек, ни агент вкладку не узнаёт. Правку
    // заметили по жалобе «карандаш указал непонятно где», поэтому сверяться
    // надо с index.html, а не с памятью о прежней таблице
    const VIEW_NAMES = {
        chatView: 'Sessions',
        flowView: 'Flow',
        kanbanView: 'Kanban',
        telegramView: 'Telegram',
        bookView: 'Book',
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

    // имена, по которым сервер ищет место элемента в коде: id и классы без
    // служебных. Служебные отбрасываем по той же причине, что и в пути: по
    // `is-active` в коде нет ни одной строки, искать по нему бессмысленно.
    // id идёт первым — он в проекте уникален, а классов у элемента бывает
    // несколько, и узкий ответ по id лучше широкого по классу
    function hooksOf(el) {
        const out = [];
        if (el.id) out.push(el.id);
        if (typeof el.className === 'string') {
            for (const c of el.className.trim().split(/\s+/)) {
                if (c && !STATE_CLASS.test(c) && !out.includes(c)) out.push(c);
            }
        }
        return out.slice(0, 6);
    }

    // подпись рядом с элементом, когда своя у него нет: у выпадающего списка в
    // строке выбора модели подпись «CLI:» лежит отдельным span слева, и без неё
    // в описании остаётся только aria-label — а он у каскада есть не всегда.
    // Берём предка, у которого текст короткий и нет своих элементов: длинный
    // текст контейнера к задаче об одном контроле отношения не имеет
    const NEAR_LABEL_LIMIT = 24;

    function nearLabel(el) {
        const prev = el.previousElementSibling;
        if (!prev || prev.children.length) return null;
        const text = (prev.textContent || '').trim().replace(/\s+/g, ' ');
        return text && text.length <= NEAR_LABEL_LIMIT ? text : null;
    }

    // сколько пунктов селекта показываем в описании: список нужен, чтобы понять,
    // про что речь (пятьдесят имён агентов — это один вопрос, две строки — другой),
    // а целиком он в описание не влезает и задачу только раздувает
    const OPTION_PREVIEW = 5;

    // Что за контрол и что в нём сейчас. Без этого «добавь пункт в этот список»
    // уводит агента читать файл целиком: из селектора не видно, что это список
    // из скольких пунктов, что выбрано и как называются остальные. Значения
    // берутся из DOM в момент клика, поэтому они настоящие, а не восстановленные
    // по коду
    function controlOf(el) {
        const tag = el.tagName.toLowerCase();
        if (tag === 'select') {
            const options = [...el.options];
            const chosen = el.selectedOptions[0];
            const preview = options.slice(0, OPTION_PREVIEW)
                .map((o) => (o.textContent || '').trim()).filter(Boolean);
            return {
                control: `select, ${options.length} ${plural(options.length, 'пункт', 'пункта', 'пунктов')}`,
                selected: chosen ? (chosen.textContent || '').trim() || chosen.value : '',
                disabled: Boolean(el.disabled),
                preview,
            };
        }
        if (tag === 'input' || tag === 'textarea') {
            const type = (el.getAttribute('type') || tag).toLowerCase();
            // значение поля пишем только у безобидного типа: у password оно само
            // по себе утечка, и в описание задачи оно попадать не должно
            const safe = type !== 'password';
            return {
                control: `${tag}[type=${type}]`,
                selected: safe ? String(el.value || '').slice(0, 40) : '(скрытое значение)',
                disabled: Boolean(el.disabled),
                preview: [],
            };
        }
        return { control: tag, selected: '', disabled: Boolean(el.disabled), preview: [] };
    }

    // число с правильным окончанием: «1 пункт», «2 пункта», «50 пунктов» —
    // в описании это читается как отчёт, а не как телеметрия
    function plural(n, one, few, many) {
        const mod100 = n % 100;
        if (mod100 >= 11 && mod100 <= 14) return many;
        const mod10 = n % 10;
        if (mod10 === 1) return one;
        if (mod10 >= 2 && mod10 <= 4) return few;
        return many;
    }

    function describe(el, hostFrame) {
        const id = el.id ? '#' + el.id : '';
        const cls = typeof el.className === 'string' && el.className
            ? '.' + el.className.trim().split(/\s+/).join('.')
            : '';
        const selector = el.tagName.toLowerCase() + id + cls;

        const label = humanLabel(el) || nearLabel(el);
        // элемент из кадра: подписываем, в каком именно, — иначе по одному
        // селектору не понять, что он не из нашей разметки
        const host = hostFrame && hostFrame(el.ownerDocument);
        const inFrame = host ? `embedded ${host.title || 'frame'}` : null;
        const where = [viewName(el, hostFrame), inFrame, ...findLandmarks(el)].filter(Boolean).join(' → ');

        const path = ancestorPath(el);
        const nth = nthOf(el);
        const control = controlOf(el);

        const parts = [];
        if (label) parts.push(`«${label}»`);
        parts.push(selector);
        // что за контрол и что в нём выбрано — иначе агент читает файл, чтобы
        // узнать две вещи, которые написаны прямо в элементе
        const state = [`выбрано «${control.selected}»`];
        if (control.preview.length) state.push(`первые: ${control.preview.join(', ')}`);
        if (control.disabled) state.push('неактивен');
        parts.push(`[${control.control}, ${state.join(', ')}]`);
        // путь и номер — то, ради чего место находится сразу: селектор без них
        // указывает на десяток одинаковых элементов (плашка модели над каждым
        // ответом ленты), и сборщик такой якорь отбрасывает как слишком общий
        if (path) parts.push(`in ${path}`);
        if (nth) parts.push(`(${nth})`);
        if (where) parts.push(`— section ${where}`);
        return parts.join(' ');
    }

    window.KarandashDesc = { describe, hooksOf, controlOf };
})();