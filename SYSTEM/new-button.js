// Кнопка «+» (id newButton): по клику создаёт ещё одну кнопку по своему образцу
// и настоящую папку в PROJECTS/ (см. /api/pages/create) — с README.md, чтобы
// раздел попал в общий список карточек (PROJECTS/Book/book-tab.js) наравне
// со встроенными, и с page.js + page.css — самим содержимым страницы. Список
// созданных страниц хранится на сервере (см. /api/pages), иначе они пропадали бы
// при каждой перезагрузке страницы.
//
// Этот файл про кнопки и переключение, а не про то, что на страницах нарисовано:
// содержимое каждой страницы лежит в её собственной папке и грузится модулем
// при первом открытии (DOCS/decisions/016). Поэтому здесь нет ни «Hello World»,
// ни знания про ленту сессий — обе страницы для этого файла одинаковы.
//
// Договор со страницей:
//
//     export default function build(page, { panel, signal }) { … }
//
//   page   — её <main>, всё нарисованное живёт внутри;
//   panel  — пустой слот в топбаре, если странице нужна панель рядом с табами;
//   signal — снимается при пересборке страницы: с ним подписывают слушателей
//            (addEventListener(…, { signal })) и потоки (fetch(…, { signal })).
//
// Всё, что страница делает, обязано попадать в эти три вещи: тогда снять её
// целиком — это очистить два узла и дёрнуть abort, что и делает unmount ниже.
// На этом же держится горячая перезагрузка одной страницы: правка её page.js
// не трогает остальную страницу (SYSTEM/core/reload.js → событие `page:<папка>`).
(function () {
    const newButton = document.getElementById('newButton');
    const toolbar = newButton.closest('.toolbar');
    const topbar = newButton.closest('.topbar');
    const generatedPages = [];
    // id страницы → функция её открытия: по ним восстанавливаем последнюю открытую
    const openers = new Map();
    // папка страницы → её пересборка: этим ключом приходит событие живой перезагрузки
    const rebuilders = new Map();

    function hideGeneratedPages() {
        for (const page of generatedPages) {
            page.hidden = true;
            page.__panel.hidden = true;
        }
        // подсветка выбранного — та же, что у соседней панели: .icon-button[aria-pressed="true"]
        for (const btn of toolbar.querySelectorAll('[data-page]')) btn.setAttribute('aria-pressed', 'false');
    }

    // переключение на обычную вкладку (Flow/Kanban/Projects/Home) скрывает
    // сгенерированные страницы: SYSTEM/tabs.js зовёт hideAll внутри showView,
    // поэтому покрыты и программные переключения (MissionTabs.show из app.js)
    //
    // rebuildPage зовёт живая перезагрузка (см. connect() в server.js) на правку
    // PROJECTS/<папка>/page.js. false — такой страницы здесь нет (её успели
    // переименовать или список ещё не пришёл), и звавший перезагружает всё целиком
    window.MissionPages = {
        hideAll: hideGeneratedPages,
        rebuildPage(folder) {
            const rebuild = rebuilders.get(folder);
            if (!rebuild) return false;
            rebuild();
            return true;
        },
    };

    function addPageButton(title, id, folder) {
        const page = document.createElement('main');
        page.id = `generatedPage${id}`;
        page.className = 'view';
        page.hidden = true;
        document.body.appendChild(page);
        generatedPages.push(page);

        // слот под панель страницы: узел заводит и показывает этот файл, а рисует
        // в нём — сама страница (PROJECTS/Feed/page.js)
        const panel = document.createElement('div');
        panel.className = 'page-panel';
        panel.hidden = true;
        topbar.prepend(panel);
        page.__panel = panel;

        // стили страницы подключаем сразу, не дожидаясь открытия: тогда правка
        // page.css подменяется на лету (css:… в server.js), а не перезагружает
        // страницу целиком из-за того, что <link> ещё нет в документе
        const css = document.createElement('link');
        css.rel = 'stylesheet';
        css.href = `PROJECTS/${folder}/page.css`;
        document.head.appendChild(css);

        const btn = newButton.cloneNode(true);
        btn.id = `generatedPageButton${id}`;
        btn.title = title;
        btn.setAttribute('aria-label', title);
        btn.setAttribute('aria-pressed', 'false');
        btn.dataset.removable = 'true';
        btn.dataset.page = page.id;
        btn.dataset.pageId = id;
        // читает PROJECTS/Book/book-tab.js — так карточка попадает в общий список разделов
        btn.dataset.readme = `PROJECTS/${folder}/README.md`;
        // папку переименование меняет вместе с заголовком (см. /api/pages/rename),
        // поэтому SYSTEM/toolbar-menu.js обновляет её здесь после переименования
        btn.dataset.folder = folder;
        // иконка «+» уже занята кнопкой newButton — у сгенерированных страниц своя, номер страницы
        const svg = btn.querySelector('svg');
        svg.replaceChildren();
        const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        text.setAttribute('x', '12');
        text.setAttribute('y', '16');
        text.setAttribute('text-anchor', 'middle');
        text.setAttribute('font-size', '12');
        text.setAttribute('font-weight', '700');
        text.setAttribute('stroke', 'none');
        text.setAttribute('fill', 'currentColor');
        text.textContent = String(id);
        svg.appendChild(text);

        let mounted = null; // AbortController собранной страницы; null — не собрана
        let version = 0;    // ?v= в адресе модуля: без него браузер отдаёт старый из кэша

        async function mount() {
            const controller = new AbortController();
            mounted = controller;
            const url = `/PROJECTS/${encodeURIComponent(folder)}/page.js${version ? `?v=${version}` : ''}`;
            try {
                const mod = await import(url);
                mod.default(page, { panel, signal: controller.signal });
            } catch (err) {
                // страницу правят прямо в её папке — ошибку показываем на ней самой,
                // а не только в консоли, иначе страница просто останется пустой
                page.textContent = `PROJECTS/${folder}/page.js: ${err.message}`;
            }
            // страницу могли успеть закрыть, пока грузился модуль, — тогда её панели
            // в топбаре взяться неоткуда, там уже чужая
            showPanel();
        }

        // пустой слот не показываем вовсе: у .topbar есть gap, и пустышка съела бы
        // 12px рядом с табами
        function showPanel() {
            panel.hidden = page.hidden || !panel.childElementCount;
        }

        function unmount() {
            mounted?.abort();
            mounted = null;
            // страница жила ровно в двух узлах и в подписках по signal — после этого
            // от неё не остаётся ничего, и следующая сборка начинает с чистого места
            page.replaceChildren();
            page.removeAttribute('style');
            page.className = 'view';
            panel.replaceChildren();
            panel.className = 'page-panel';
            panel.hidden = true;
        }

        async function openPage() {
            hideGeneratedPages();
            for (const view of Object.values(App.VIEWS)) view.hidden = true;
            for (const vb of document.querySelectorAll('.toolbar [data-view]')) vb.setAttribute('aria-pressed', 'false');
            page.hidden = false;
            btn.setAttribute('aria-pressed', 'true');
            // запоминаем страницу тем же ключом, что и вкладки (SYSTEM/tabs.js),
            // чтобы после перезагрузки открылась она, а не последняя вкладка
            MissionTabs.saveLastView(`page:${id}`);
            // содержимое рисует модуль из папки самой страницы. Грузим при первом
            // показе, а не при создании кнопки: иначе каждая страница ходила бы
            // за своими данными ещё до того, как её открыли
            if (!mounted) await mount();
            else showPanel();
        }

        rebuilders.set(folder, () => {
            if (!mounted) return; // ещё не открывали — свежий модуль возьмёт при открытии
            unmount();
            version += 1;
            // закрытую страницу не собираем заново: откроют — соберётся сама,
            // уже из нового файла, и до тех пор не ходит за данными впустую
            if (!page.hidden) mount();
        });

        btn.addEventListener('click', openPage);
        toolbar.insertBefore(btn, newButton);
        openers.set(String(id), openPage);
    }

    newButton.addEventListener('click', async () => {
        const title = `Page ${generatedPages.length + 1}`;
        const { id, folder } = await App.api('/api/pages/create', { title });
        addPageButton(title, id, folder);
    });

    (async function restore() {
        const { pages = [] } = await App.api('/api/pages', {});
        for (const page of pages) addPageButton(page.title, page.id, page.folder);
        // последним был открыт не таб, а одна из этих страниц — возвращаем на неё.
        // Вкладку в этом случае tabs.js специально не показывал: он не знает список страниц
        const last = MissionTabs.readLastView() || '';
        if (!last.startsWith('page:')) return;
        const open = openers.get(last.slice('page:'.length));
        // страницу могли удалить с прошлого захода — тогда обычная вкладка по умолчанию
        if (open) open();
        else MissionTabs.show('chat');
    })();
})();
