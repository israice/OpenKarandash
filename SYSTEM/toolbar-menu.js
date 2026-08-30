// Кнопка "+" в тулбаре табов: выпадающее меню со всеми остальными кнопками
// этого тулбара (иконка + название + toggle показать/скрыть). Скрытые кнопки
// прячутся из тулбара и переживают перезагрузку через localStorage.
(function () {
    const HIDDEN_KEY = 'toolbarHiddenButtons';

    const addButton = document.getElementById('addButton');
    if (!addButton) return;
    const toolbar = addButton.closest('.toolbar');

    function loadHidden() {
        try { return new Set(JSON.parse(localStorage.getItem(HIDDEN_KEY)) || []); }
        catch { return new Set(); }
    }

    function saveHidden(hidden) {
        localStorage.setItem(HIDDEN_KEY, JSON.stringify([...hidden]));
    }

    const hidden = loadHidden();

    function otherButtons() {
        return [...toolbar.querySelectorAll('.btn-group__btn')].filter((btn) => btn !== addButton);
    }

    function applyHidden() {
        for (const btn of otherButtons()) btn.hidden = hidden.has(btn.id);
    }
    applyHidden();

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

    function renderMenu() {
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
            iconSpan.className = 'toolbar-menu__icon';
            if (icon) iconSpan.append(icon.cloneNode(true));

            const nameSpan = document.createElement('span');
            nameSpan.className = 'toolbar-menu__name';
            nameSpan.textContent = name;

            const toggle = document.createElement('button');
            toggle.type = 'button';
            toggle.className = 'toolbar-menu__toggle';
            toggle.dataset.target = btn.id;
            toggle.setAttribute('role', 'menuitemcheckbox');
            toggle.setAttribute('aria-checked', String(!hidden.has(btn.id)));
            toggle.setAttribute('aria-label', `${name}: показать/скрыть`);
            toggle.innerHTML = '<span class="toolbar-menu__toggle-track"><span class="toolbar-menu__toggle-thumb"></span></span>';

            const del = document.createElement('button');
            del.type = 'button';
            del.className = 'toolbar-menu__delete';
            del.dataset.target = btn.id;
            del.disabled = !removable;
            del.setAttribute('aria-label', `${name}: удалить страницу`);
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
    }

    function closeMenu() {
        menu.hidden = true;
        addButton.setAttribute('aria-expanded', 'false');
    }

    addButton.addEventListener('click', () => {
        if (menu.hidden) openMenu();
        else closeMenu();
    });

    document.addEventListener('click', (e) => {
        if (!menu.hidden && !addButton.contains(e.target) && !menu.contains(e.target)) closeMenu();
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !menu.hidden) {
            closeMenu();
            addButton.focus();
        }
    });

    menu.addEventListener('click', (e) => {
        const del = e.target.closest('.toolbar-menu__delete');
        if (del) {
            if (del.disabled) return;
            const btn = document.getElementById(del.dataset.target);
            if (btn) {
                if (btn.dataset.pageId) App.api('/api/pages/delete', { id: btn.dataset.pageId });
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
