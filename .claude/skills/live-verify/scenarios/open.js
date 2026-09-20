// Открыть вкладку, все вкладки или страницу кнопки «+» и сказать, что там: открылась ли,
// сколько в ней видимого, какие ошибки случились, пока она была открыта. Снимок (--shot)
// делается после сценария, то есть с той вкладки, что открыта последней.
//
// Параметры:
//   view=<имя>|all   вкладка из App.VIEWS (имена берутся со страницы) либо все подряд
//   page=<папка>     страница кнопки «+» по имени её папки в PROJECTS/ (например Feed)
//   count=<селектор> дополнительно посчитать элементы по CSS-селектору (видимые и все)
//   wait=<мс>        сколько ждать после открытия (по умолчанию 1500 для вкладки, 2500 для «+»)
// Без view и page — то же, что view=all.
//
// Полный обход с ошибками самой загрузки страницы делает `npm run ui`: он слушает браузер
// снаружи. Этот сценарий видит только то, что случилось в странице после его старта, — он
// нужен, когда надо открыть одно место, посчитать в нём что-то своё и снять снимок.
async function scenario(P) {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const errors = [];
    const onError = (e) => errors.push(String(e.message || e.reason?.message || e.reason || e.type).slice(0, 300));
    const consoleError = console.error;
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onError);
    console.error = (...args) => { errors.push(`console.error: ${args.map(String).join(' ')}`.slice(0, 300)); consoleError(...args); };

    const measure = (el) => {
        if (!el) return { found: false };
        const shown = [...el.querySelectorAll('*')].filter((n) => n.offsetParent !== null).length;
        const row = { found: true, hidden: el.hidden, elements: shown, text: el.innerText.trim().length };
        if (P.count) {
            const hits = [...document.querySelectorAll(P.count)];
            row.count = { all: hits.length, visible: hits.filter((n) => n.offsetParent !== null).length };
        }
        return row;
    };

    const report = [];
    try {
        if (P.page) {
            // кнопки страниц «+» в тулбаре помечены data-page (id её <main>) и data-folder (папка)
            const buttons = [...document.querySelectorAll('.toolbar [data-page]')];
            const btn = buttons.find((b) => [b.dataset.folder, b.title, b.dataset.page].includes(P.page));
            if (!btn) return { ok: false, error: `Страницы «${P.page}» в тулбаре нет`, known: buttons.map((b) => b.dataset.folder || b.title) };
            btn.click();
            await wait(Number(P.wait) || 2500); // модуль страницы грузится при первом открытии
            report.push({ page: btn.dataset.folder || btn.title, ...measure(document.getElementById(btn.dataset.page)), errors: [...errors] });
        } else {
            const names = Object.keys(App.VIEWS);
            const wanted = !P.view || P.view === 'all' ? names : [P.view];
            for (const name of wanted) {
                if (!names.includes(name)) { report.push({ view: name, found: false, known: names, errors: [] }); continue; }
                errors.length = 0;
                MissionTabs.show(name);
                await wait(Number(P.wait) || 1500);
                report.push({ view: name, ...measure(App.VIEWS[name]), errors: [...errors] });
            }
        }
    } finally {
        window.removeEventListener('error', onError);
        window.removeEventListener('unhandledrejection', onError);
        console.error = consoleError;
    }
    // заготовка «Hello World» — текст прямо в <main>, без элементов: пустой считаем только то,
    // где нет ни элементов, ни текста (то же правило, что в SYSTEM/ui-walk.mjs)
    const bad = report.filter((r) => !r.found || r.hidden || (!r.elements && !r.text) || r.errors.length);
    return { ok: bad.length === 0, report };
}
