const MENU_ID = 'model-search-menu';
const SEARCH_LABEL = 'Поиск моделей';

let activeSelect = null;
let menu = null;
let input = null;
let optionList = null;
let visibleOptions = [];
let activeIndex = -1;
let selectObserver = null;
let documentObserver = null;

function ensureMenu() {
    if (menu) return;
    menu = document.createElement('div');
    menu.id = MENU_ID;
    menu.className = 'model-search-menu';
    menu.setAttribute('role', 'dialog');
    menu.setAttribute('aria-label', 'Выбор модели');
    menu.hidden = true;

    input = document.createElement('input');
    input.className = 'model-search-menu__input';
    input.type = 'search';
    input.placeholder = SEARCH_LABEL;
    input.setAttribute('aria-label', SEARCH_LABEL);
    input.setAttribute('aria-controls', `${MENU_ID}-options`);
    input.setAttribute('aria-autocomplete', 'list');

    optionList = document.createElement('div');
    optionList.id = `${MENU_ID}-options`;
    optionList.className = 'model-search-menu__options';
    optionList.setAttribute('role', 'listbox');
    optionList.setAttribute('aria-label', 'Модели');
    menu.append(input, optionList);
    document.body.append(menu);

    input.addEventListener('input', renderOptions);
    input.addEventListener('keydown', handleInputKeydown);
    optionList.addEventListener('keydown', handleOptionKeydown);
}

function renderOptions() {
    const query = input.value.trim().toLocaleLowerCase();
    visibleOptions = [...activeSelect.options].filter((option) => (
        `${option.textContent} ${option.value}`.toLocaleLowerCase().includes(query)
    ));
    optionList.replaceChildren();

    if (!visibleOptions.length) {
        const empty = document.createElement('div');
        empty.className = 'model-search-menu__empty';
        empty.textContent = 'Нет совпадений';
        optionList.append(empty);
        activeIndex = -1;
        return;
    }

    activeIndex = visibleOptions.findIndex((option) => option.value === activeSelect.value);
    visibleOptions.forEach((option, index) => {
        const item = document.createElement('div');
        item.className = 'model-search-menu__option';
        item.textContent = option.textContent;
        item.setAttribute('role', 'option');
        item.setAttribute('aria-selected', String(option.value === activeSelect.value));
        item.setAttribute('aria-disabled', String(option.disabled));
        item.tabIndex = -1;
        if (option.dataset.free) item.dataset.free = option.dataset.free;
        item.addEventListener('pointerdown', (event) => event.preventDefault());
        item.addEventListener('pointermove', () => {
            activeIndex = index;
            updateActiveOption();
        });
        item.addEventListener('click', () => chooseOption(option));
        optionList.append(item);
    });
}

function updateActiveOption() {
    [...optionList.children].forEach((item, index) => {
        item.classList.toggle('model-search-menu__option--active', index === activeIndex);
    });
}

function positionMenu() {
    const rect = activeSelect.getBoundingClientRect();
    const width = Math.min(Math.max(rect.width, 280), 420, window.innerWidth - 16);
    menu.style.width = `${width}px`;
    menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
    const height = menu.getBoundingClientRect().height;
    const below = rect.bottom + height <= window.innerHeight - 8;
    menu.style.top = `${below ? rect.bottom + 4 : Math.max(8, rect.top - height - 4)}px`;
}

function closeMenu(restoreFocus = true) {
    if (!activeSelect) return;
    const select = activeSelect;
    activeSelect = null;
    menu.hidden = true;
    select.setAttribute('aria-expanded', 'false');
    selectObserver?.disconnect();
    documentObserver?.disconnect();
    document.removeEventListener('pointerdown', handleDocumentPointerDown, true);
    document.removeEventListener('scroll', handleDocumentScroll, true);
    window.removeEventListener('resize', positionMenu);
    if (restoreFocus && select.isConnected) select.focus();
}

function openMenu(select, query = '') {
    if (select.disabled || activeSelect === select) return;
    if (activeSelect) closeMenu(false);
    ensureMenu();
    activeSelect = select;
    input.value = query;
    renderOptions();
    menu.hidden = false;
    select.setAttribute('aria-expanded', 'true');
    positionMenu();
    document.addEventListener('pointerdown', handleDocumentPointerDown, true);
    document.addEventListener('scroll', handleDocumentScroll, true);
    window.addEventListener('resize', positionMenu);
    selectObserver = new MutationObserver(() => {
        if (select.disabled) closeMenu(false);
        else renderOptions();
    });
    selectObserver.observe(select, { attributes: true, childList: true, subtree: true, characterData: true });
    documentObserver = new MutationObserver(() => {
        if (!select.isConnected) closeMenu(false);
    });
    documentObserver.observe(document.body, { childList: true, subtree: true });
    input.focus();
}

function chooseOption(option) {
    if (option.disabled || !activeSelect) return;
    const select = activeSelect;
    const changed = select.value !== option.value;
    select.value = option.value;
    closeMenu();
    if (changed) select.dispatchEvent(new Event('change', { bubbles: true }));
}

function moveActiveOption(direction) {
    const enabled = visibleOptions
        .map((option, index) => ({ option, index }))
        .filter(({ option }) => !option.disabled);
    if (!enabled.length) return;
    const current = enabled.findIndex(({ index }) => index === activeIndex);
    const next = current < 0
        ? (direction > 0 ? 0 : enabled.length - 1)
        : (current + direction + enabled.length) % enabled.length;
    activeIndex = enabled[next].index;
    updateActiveOption();
    optionList.children[activeIndex].focus();
}

function handleDocumentPointerDown(event) {
    if (menu.contains(event.target) || activeSelect.contains(event.target)) return;
    closeMenu(false);
}

function handleDocumentScroll(event) {
    if (!menu.contains(event.target)) closeMenu(false);
}

function handleSelectPointerDown(event) {
    event.preventDefault();
    const select = event.currentTarget;
    if (activeSelect === select) closeMenu();
    else openMenu(select);
}

function handleSelectKeydown(event) {
    const select = event.currentTarget;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openMenu(select);
    } else if (Array.from(event.key).length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        openMenu(select, event.key);
    }
}

function handleInputKeydown(event) {
    if (event.key === 'Escape') {
        event.preventDefault();
        closeMenu();
    } else if (event.key === 'ArrowDown') {
        event.preventDefault();
        moveActiveOption(1);
    } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        moveActiveOption(-1);
    } else if (event.key === 'Tab') {
        closeMenu(false);
    }
}

function handleOptionKeydown(event) {
    if (event.key === 'Escape') {
        event.preventDefault();
        closeMenu();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        moveActiveOption(event.key === 'ArrowDown' ? 1 : -1);
    } else if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault();
        let enabledIndex = -1;
        if (event.key === 'Home') {
            enabledIndex = visibleOptions.findIndex((option) => !option.disabled);
        } else {
            for (let index = visibleOptions.length - 1; index >= 0; index -= 1) {
                if (!visibleOptions[index].disabled) {
                    enabledIndex = index;
                    break;
                }
            }
        }
        if (enabledIndex >= 0) {
            activeIndex = enabledIndex;
            updateActiveOption();
            optionList.children[activeIndex].focus();
        }
    } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        const option = visibleOptions[activeIndex];
        if (option) chooseOption(option);
    } else if (event.key === 'Tab') {
        closeMenu(false);
    }
}

export function attachModelSearch(select) {
    ensureMenu();
    select.setAttribute('aria-haspopup', 'dialog');
    select.setAttribute('aria-expanded', 'false');
    select.setAttribute('aria-controls', MENU_ID);
    select.addEventListener('pointerdown', handleSelectPointerDown);
    select.addEventListener('keydown', handleSelectKeydown);
}
