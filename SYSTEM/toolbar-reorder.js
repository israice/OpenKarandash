// Перетаскивание кнопок внутри любой .btn-group (тулбар вкладок, zoom-панель Flow и т.д.):
// долгое нажатие (>2с) включает режим "тряски", в котором любую кнопку можно перетащить
// на новое место. Выход — Esc, порядок кнопок сохраняется в localStorage и переживает перезагрузку.
(function () {
    const ORDER_KEY = 'toolbarOrder';
    const LONG_PRESS_MS = 2000;
    const MOVE_CANCEL_PX = 8;

    function groupKey(group, index) {
        return group.id || group.getAttribute('aria-label') || `btn-group-${index}`;
    }

    function loadOrder() {
        try { return JSON.parse(localStorage.getItem(ORDER_KEY)) || {}; }
        catch { return {}; }
    }

    function saveOrder(all) {
        localStorage.setItem(ORDER_KEY, JSON.stringify(all));
    }

    // применяем сохранённый порядок при загрузке страницы
    (function restoreOrder() {
        const all = loadOrder();
        document.querySelectorAll('.btn-group').forEach((group, index) => {
            const order = all[groupKey(group, index)];
            if (!order) return;
            const byId = new Map([...group.children].map(btn => [btn.id, btn]));
            for (const id of order) {
                const btn = byId.get(id);
                if (btn) group.appendChild(btn);
            }
        });
    })();

    let pressTimer = null;
    let pressStart = null;
    let activeGroup = null;
    let dragButton = null;
    let justDragged = false;

    function clearPress() {
        clearTimeout(pressTimer);
        pressTimer = null;
        pressStart = null;
    }

    function enterReorderMode(group) {
        activeGroup = group;
        group.classList.add('btn-group--reorder');
    }

    function exitReorderMode() {
        if (!activeGroup) return;
        const groups = [...document.querySelectorAll('.btn-group')];
        const all = loadOrder();
        all[groupKey(activeGroup, groups.indexOf(activeGroup))] =
            [...activeGroup.children].map(btn => btn.id).filter(Boolean);
        saveOrder(all);
        activeGroup.classList.remove('btn-group--reorder');
        activeGroup = null;
    }

    function startDrag(button) {
        dragButton = button;
        justDragged = true;
        button.classList.add('btn-group__btn--dragging');
    }

    function stopDrag() {
        if (!dragButton) return;
        dragButton.classList.remove('btn-group__btn--dragging');
        dragButton = null;
    }

    // переставляем перетаскиваемую кнопку относительно соседей по позиции курсора
    function updateDrag(clientX) {
        if (!dragButton || !activeGroup) return;
        for (const sib of activeGroup.children) {
            if (sib === dragButton) continue;
            const rect = sib.getBoundingClientRect();
            if (clientX < rect.left + rect.width / 2) {
                if (sib.previousElementSibling !== dragButton) activeGroup.insertBefore(dragButton, sib);
                return;
            }
        }
        if (activeGroup.lastElementChild !== dragButton) activeGroup.appendChild(dragButton);
    }

    document.addEventListener('pointerdown', (e) => {
        const button = e.target.closest('.btn-group .btn-group__btn');
        if (!button) return;
        const group = button.closest('.btn-group');

        if (activeGroup === group) {
            e.preventDefault();
            startDrag(button);
            return;
        }
        if (activeGroup) return;

        pressStart = { x: e.clientX, y: e.clientY };
        pressTimer = setTimeout(() => {
            pressTimer = null;
            enterReorderMode(group);
            startDrag(button);
        }, LONG_PRESS_MS);
    });

    document.addEventListener('pointermove', (e) => {
        if (pressTimer && pressStart) {
            if (Math.hypot(e.clientX - pressStart.x, e.clientY - pressStart.y) > MOVE_CANCEL_PX) clearPress();
            return;
        }
        if (dragButton) {
            e.preventDefault();
            updateDrag(e.clientX);
        }
    });

    document.addEventListener('pointerup', () => {
        clearPress();
        stopDrag();
    });

    // долгое нажатие/перетаскивание не должно ещё и переключать вкладку/действие кликом
    document.addEventListener('click', (e) => {
        if (!justDragged) return;
        justDragged = false;
        if (e.target.closest('.btn-group__btn')) {
            e.preventDefault();
            e.stopPropagation();
        }
    }, true);

    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape' || !activeGroup) return;
        stopDrag();
        exitReorderMode();
    });
})();
