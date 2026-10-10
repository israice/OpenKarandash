// Кнопка "+" в тулбаре табов: выпадающее меню со всеми остальными кнопками
// обеих групп тулбара (иконка + название + toggle показать/скрыть). Скрытые кнопки
// прячутся из тулбара и переживают перезагрузку через localStorage. Выбранные
// иконки — общие для всех окружений, поэтому хранятся на сервере
// (SYSTEM/toolbar-icons-server.js), а не в localStorage конкретного браузера.
(function () {
    const HIDDEN_KEY = 'toolbarHiddenButtons';

    // набор иконок на выбор для замены иконки кнопки тулбара (клик по иконке
    // строки в меню "+"), в стиле остальных иконок проекта: viewBox 24, stroke
    const ICON_CATALOG = {
        star: '<path d="M12 2l3.09 6.26L22 9.27l-5 4.87L18.18 21 12 17.77 5.82 21 7 14.14l-5-4.87 6.91-1.01z"></path>',
        heart: '<path d="M12 21s-7.5-4.5-9.5-9.5C1 7 3.5 3.5 7 3.5c2 0 3.5 1 5 3 1.5-2 3-3 5-3 3.5 0 6 3.5 4.5 8C19.5 16.5 12 21 12 21z"></path>',
        bookmark: '<path d="M6 3h12v18l-6-4-6 4z"></path>',
        flag: '<path d="M5 3v18"></path><path d="M5 4h13l-3 4 3 4H5"></path>',
        bell: '<path d="M6 8a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6"></path><path d="M10 21a2 2 0 0 0 4 0"></path>',
        tag: '<path d="M20.6 12.6 12 21.2 2.8 12l8.6-8.6H20.6z"></path><circle cx="7" cy="7" r="1.4"></circle>',
        folder: '<path d="M3 5h6l2 3h10v11H3z"></path>',
        zap: '<path d="M13 2 4 14h6l-1 8 9-12h-6z"></path>',
        compass: '<circle cx="12" cy="12" r="9"></circle><path d="M15 9l-2 6-6 2 2-6z"></path>',
        layers: '<path d="M12 3 2 8l10 5 10-5z"></path><path d="M2 16l10 5 10-5"></path><path d="M2 12l10 5 10-5"></path>',
        grid: '<rect x="3" y="3" width="8" height="8"></rect><rect x="13" y="3" width="8" height="8"></rect><rect x="3" y="13" width="8" height="8"></rect><rect x="13" y="13" width="8" height="8"></rect>',
        moon: '<path d="M20 14.5A8.5 8.5 0 1 1 9.5 4 7 7 0 0 0 20 14.5z"></path>',
    };

    const addButton = document.getElementById('addButton');
    if (!addButton) return;
    const toolbar = addButton.closest('.toolbar');

    // Каталог иконок нужен и за пределами этого файла: кнопки-заготовки
    // (SYSTEM/new-icon-button.js) рисуются сразу, при создании, и своей копии
    // каталога заводить нельзя — разъедутся при правке. Отдаём наружу пару
    // «нарисуй иконку по ключу»; тот же путь, что и у pickIcon ниже.
    window.ToolbarIcons = {
        apply(btn, iconKey) {
            applyIcon(btn, iconKey);
        },
    };

    function loadHidden() {
        try { return new Set(JSON.parse(localStorage.getItem(HIDDEN_KEY)) || []); }
        catch { return new Set(); }
    }

    function saveHidden(hidden) {
        localStorage.setItem(HIDDEN_KEY, JSON.stringify([...hidden]));
    }

    const hidden = loadHidden();

    // сервер — общий источник истины для всех окружений; локально держим
    // только последний полученный снимок, чтобы применять иконки и названия
    // к кнопкам, которые появляются в DOM позже (см. renderMenu)
    let icons = {};
    let names = {};

    async function loadIcons() {
        try {
            const res = await App.api('/api/toolbar/icons', {});
            return res?.icons || {};
        } catch { return {}; }
    }

    async function loadNames() {
        try {
            const res = await App.api('/api/toolbar/names', {});
            return res?.names || {};
        } catch { return {}; }
    }

    function applyNames() {
        for (const btn of otherButtons()) {
            // у страниц кнопки «Новое» название приходит из pages.title —
            // toolbar_names хранит только переименования встроенных кнопок
            if (btn.dataset.pageId || !names[btn.id]) continue;
            btn.title = names[btn.id];
            btn.setAttribute('aria-label', names[btn.id]);
        }
    }

    function applyIcon(btn, iconKey) {
        const svg = btn.querySelector('svg');
        const markup = ICON_CATALOG[iconKey];
        if (!svg || !markup) return;
        svg.innerHTML = markup;
    }

    function applyIcons() {
        for (const btn of otherButtons()) {
            if (icons[btn.id]) applyIcon(btn, icons[btn.id]);
        }
    }

    // выбранная в пикере иконка сохраняется на сервере — переживает
    // перезагрузку страницы и одинакова во всех окружениях — и сразу
    // отражается и в самой кнопке, и в её строке в этом же меню (renderMenu
    // клонирует svg заново из live DOM кнопки при каждом открытии)
    async function pickIcon(btn, iconKey) {
        icons[btn.id] = iconKey;
        applyIcon(btn, iconKey);
        renderMenu();
        await App.api('/api/toolbar/icons/set', { buttonId: btn.id, icon: iconKey });
    }

    // редактирование названия строки меню: активно не более одной строки за раз
    let editing = null;

    function outsideEditHandler(e) {
        if (!editing || e.target === editing.input) return;
        commitEdit();
    }

    async function commitEdit() {
        if (!editing) return;
        const { input, btn } = editing;
        document.removeEventListener('mousedown', outsideEditHandler, true);
        editing = null;
        const newName = input.value.trim();
        const oldName = btn.getAttribute('aria-label') || btn.title || btn.id;
        if (newName && newName !== oldName) {
            btn.title = newName;
            btn.setAttribute('aria-label', newName);
            // название встроенной кнопки — в toolbar_names, страницы «+» — в pages.title
            if (btn.dataset.pageId) {
                // папка страницы переезжает вместе с заголовком (см. /api/pages/rename),
                // а из неё грузится и README карточки Book, и сам модуль страницы
                const { folder } = await App.api('/api/pages/rename', { id: btn.dataset.pageId, title: newName });
                if (folder) {
                    btn.dataset.folder = folder;
                    btn.dataset.readme = `PROJECTS/${folder}/README.md`;
                }
            }
            else { names[btn.id] = newName; await App.api('/api/toolbar/names/set', { buttonId: btn.id, name: newName }); }
        }
        renderMenu();
    }

    function startEdit(nameSpan, btn) {
        if (editing) { commitEdit(); }
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'toolbar-menu__name-input';
        input.value = btn.getAttribute('aria-label') || btn.title || btn.id;
        nameSpan.replaceWith(input);
        input.focus();
        input.select();
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') commitEdit();
            else if (e.key === 'Escape') { input.value = btn.getAttribute('aria-label') || btn.title || btn.id; commitEdit(); }
        });
        editing = { input, btn };
        document.addEventListener('mousedown', outsideEditHandler, true);
    }

    function otherButtons() {
        // обе группы тулбара: и правая с вкладками, и левая с кнопкой «Новое»
        // и созданными ею страницами (SYSTEM/new-button.js) — иначе кнопки левой
        // группы теряют сохранённые иконки и пропадают из этого меню
        return [...document.querySelectorAll('.toolbar .btn-group__btn')].filter((btn) => btn !== addButton);
    }

    function applyHidden() {
        for (const btn of otherButtons()) btn.hidden = hidden.has(btn.id);
    }
    applyHidden();
    loadIcons().then((loaded) => { icons = loaded; applyIcons(); });
    loadNames().then((loaded) => { names = loaded; applyNames(); });

    addButton.setAttribute('aria-haspopup', 'true');
    addButton.setAttribute('aria-expanded', 'false');
    addButton.setAttribute('aria-controls', 'toolbarMenu');

    const menu = document.createElement('ul');
    menu.className = 'toolbar-menu';
    menu.id = 'toolbarMenu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-labelledby', 'addButton');
    menu.hidden = true;
    toolbar.append(menu);

    // попап выбора иконки: рендерится по клику на iconSpan, крепится к её
    // родительской строке (item — position: relative) и закрывается по
    // выбору варианта, повторному клику на ту же иконку или клику снаружи
    let openPicker = null;

    function closePicker() {
        openPicker?.remove();
        openPicker = null;
    }

    function openIconPicker(item, btn) {
        // wasSameRow — клик по иконке той же строки, где попап уже открыт,
        // сравниваем через dataset.for (не item, попап теперь его сосед по <ul>,
        // а не потомок), иначе повторный клик просто переоткрывал бы тот же попап
        if (openPicker) {
            const wasSameRow = openPicker.dataset.for === btn.id;
            closePicker();
            if (wasSameRow) return;
        }

        // попап рендерится отдельным <li>-соседом строки (а не absolute-позиционированным
        // потомком) — так он всегда остаётся в видимых границах меню и кликабелен,
        // независимо от того, где меню оказалось на экране
        const row = document.createElement('li');
        row.className = 'toolbar-menu__icon-picker';
        row.dataset.for = btn.id;
        row.setAttribute('role', 'menu');
        for (const key of Object.keys(ICON_CATALOG)) {
            const option = document.createElement('button');
            option.type = 'button';
            option.className = 'toolbar-menu__icon-option';
            option.setAttribute('role', 'menuitem');
            option.setAttribute('aria-label', key);
            option.title = key;
            option.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_CATALOG[key]}</svg>`;
            option.addEventListener('click', (e) => {
                e.stopPropagation();
                pickIcon(btn, key);
            });
            row.append(option);
        }
        item.after(row);
        openPicker = row;
    }

    function renderMenu() {
        closePicker();
        // страницы, добавленные кнопкой «+» (SYSTEM/new-button.js), могут появиться
        // в DOM позже начальной загрузки — подхватываем их сохранённые иконку и название тут же
        applyIcons();
        applyNames();
        menu.innerHTML = '';
        for (const btn of otherButtons()) {
            // name — это title страницы (SYSTEM/new-button.js), может быть произвольным
            // текстом от пользователя, поэтому весь узел собираем через DOM-методы,
            // а не innerHTML со строковой подстановкой (иначе получаем XSS)
            const name = btn.getAttribute('aria-label') || btn.title || btn.id;
            const icon = btn.querySelector('svg');
            const removable = btn.dataset.removable === 'true';

            const item = document.createElement('li');
            item.className = 'toolbar-menu__item';
            item.setAttribute('role', 'none');

            const iconSpan = document.createElement('span');
            iconSpan.className = 'toolbar-menu__icon toolbar-menu__icon--pickable';
            iconSpan.setAttribute('role', 'button');
            iconSpan.tabIndex = 0;
            iconSpan.title = 'Change icon';
            iconSpan.setAttribute('aria-label', `${name}: change icon`);
            iconSpan.addEventListener('click', (e) => { e.stopPropagation(); openIconPicker(item, btn); });
            if (icon) iconSpan.append(icon.cloneNode(true));

            const nameSpan = document.createElement('span');
            nameSpan.className = 'toolbar-menu__name';
            nameSpan.textContent = name;
            nameSpan.addEventListener('click', () => startEdit(nameSpan, btn));

            const toggle = document.createElement('button');
            toggle.type = 'button';
            toggle.className = 'toolbar-menu__toggle';
            toggle.dataset.target = btn.id;
            toggle.setAttribute('role', 'menuitemcheckbox');
            toggle.setAttribute('aria-checked', String(!hidden.has(btn.id)));
            toggle.setAttribute('aria-label', `${name}: show/hide`);
            toggle.innerHTML = '<span class="toolbar-menu__toggle-track"><span class="toolbar-menu__toggle-thumb"></span></span>';

            const del = document.createElement('button');
            del.type = 'button';
            del.className = 'toolbar-menu__delete';
            del.dataset.target = btn.id;
            del.disabled = !removable;
            del.setAttribute('aria-label', `${name}: delete page`);
            del.innerHTML = `
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"></path>
                    <path d="M10 11v6M14 11v6"></path>
                </svg>
            `;

            item.append(iconSpan, nameSpan, toggle, del);
            menu.append(item);
        }
    }

    function openMenu() {
        renderMenu();
        menu.hidden = false;
        addButton.setAttribute('aria-expanded', 'true');
        // меню растёт вниз от кнопки — без ограничения при большом числе строк
        // низ уходит за пределы окна; считаем фактически доступное место
        const rect = addButton.getBoundingClientRect();
        menu.style.maxHeight = `${window.innerHeight - rect.bottom - 16}px`;
    }

    function closeMenu() {
        menu.hidden = true;
        addButton.setAttribute('aria-expanded', 'false');
        closePicker();
    }

    addButton.addEventListener('click', () => {
        if (menu.hidden) openMenu();
        else closeMenu();
    });

    document.addEventListener('click', (e) => {
        // composedPath фиксирует путь всплытия на момент клика: обработчики меню
        // (переименование, удаление) успевают пересобрать DOM ещё до этой проверки,
        // из-за чего e.target может быть уже отсоединён от документа — menu.contains
        // тогда ошибочно вернёт false и закроет меню при клике внутри него
        const path = e.composedPath();
        if (menu.hidden || path.includes(addButton) || path.includes(menu)) return;
        // кнопка карандаша переключает свой отдельный режим (PROJECTS/Karandash/karandash.js) —
        // клик по ней не должен закрывать уже открытое меню тулбара, только Esc
        const karandashButton = document.getElementById('karandashButton');
        if (karandashButton && path.includes(karandashButton)) return;
        closeMenu();
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !menu.hidden) {
            closeMenu();
            addButton.focus();
        }
    });

    menu.addEventListener('click', (e) => {
        if (openPicker && !e.target.closest('.toolbar-menu__icon-picker') && !e.target.closest('.toolbar-menu__icon--pickable')) closePicker();

        const del = e.target.closest('.toolbar-menu__delete');
        if (del) {
            if (del.disabled) return;
            const btn = document.getElementById(del.dataset.target);
            if (btn) {
                if (btn.dataset.pageId) App.api('/api/pages/delete', { id: btn.dataset.pageId });
                // кнопка-заготовка: на диске за ней ничего нет, но запись в базе
                // есть, и без её удаления кнопка вернулась бы при перезагрузке
                // страницы — удаление было бы видимым, но не настоящим
                if (btn.dataset.toolbarButtonId) App.api('/api/toolbar/buttons/delete', { id: btn.dataset.toolbarButtonId });
                if (btn.dataset.page) document.getElementById(btn.dataset.page)?.remove();
                btn.remove();
            }
            renderMenu();
            return;
        }

        const toggle = e.target.closest('.toolbar-menu__toggle');
        if (!toggle) return;
        const id = toggle.dataset.target;
        if (hidden.has(id)) hidden.delete(id);
        else hidden.add(id);
        saveHidden(hidden);
        applyHidden();
        toggle.setAttribute('aria-checked', String(!hidden.has(id)));
    });
})();
