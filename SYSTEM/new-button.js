// Кнопка «+» (id newButton): по клику создаёт ещё одну кнопку по своему образцу,
// у новой кнопки — своя страница с "Hello World" по центру, и настоящая папка
// в PROJECTS/ с README.md (см. /api/pages/create в server.js) — так новый раздел
// попадает в общий список карточек (PROJECTS/Projects/projects-tab.js) наравне
// со встроенными. Список созданных страниц хранится на сервере (см. /api/pages),
// иначе они пропадали бы при каждой перезагрузке страницы.
(function () {
    const newButton = document.getElementById('newButton');
    const toolbar = newButton.closest('.toolbar');
    const generatedPages = [];

    function hideGeneratedPages() {
        for (const page of generatedPages) page.hidden = true;
    }

    // переключение на обычную вкладку (Graph/Flow/Kanban/Projects/Home) скрывает сгенерированные страницы
    for (const btn of document.querySelectorAll('.toolbar [data-view]')) {
        btn.addEventListener('click', hideGeneratedPages);
    }

    function addPageButton(title, id, readme) {
        const page = document.createElement('main');
        page.id = `generatedPage${id}`;
        page.className = 'view';
        page.hidden = true;
        page.style.cssText = 'display:flex;align-items:center;justify-content:center;';
        page.textContent = 'Hello World';
        document.body.appendChild(page);
        generatedPages.push(page);

        const btn = newButton.cloneNode(true);
        btn.id = `generatedPageButton${id}`;
        btn.title = title;
        btn.setAttribute('aria-label', title);
        btn.dataset.removable = 'true';
        btn.dataset.page = page.id;
        btn.dataset.pageId = id;
        // читает PROJECTS/Projects/projects-tab.js — так карточка попадает в общий список разделов
        btn.dataset.readme = readme;
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
        btn.addEventListener('click', () => {
            hideGeneratedPages();
            for (const view of Object.values(App.VIEWS)) view.hidden = true;
            for (const vb of document.querySelectorAll('.toolbar [data-view]')) vb.setAttribute('aria-pressed', 'false');
            page.hidden = false;
        });
        toolbar.insertBefore(btn, newButton);
    }

    newButton.addEventListener('click', async () => {
        const title = `Страница ${generatedPages.length + 1}`;
        const { id, readme } = await App.api('/api/pages/create', { title });
        addPageButton(title, id, readme);
    });

    (async function restore() {
        const { pages = [] } = await App.api('/api/pages', {});
        for (const page of pages) addPageButton(page.title, page.id, `PROJECTS/${page.folder}/README.md`);
    })();
})();
