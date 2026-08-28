// Перетаскивание кнопок внутри .toolbar: долгое нажатие (>2с) включает режим
// "тряски", в котором любую кнопку можно перетащить на новое место. Выход — Esc,
// порядок кнопок сохраняется в localStorage и переживает перезагрузку.
(function () {
    const ORDER_KEY = 'toolbarOrder';
    const LONG_PRESS_MS = 2000;
    const MOVE_CANCEL_PX = 8;

    function toolbarKey(toolbar, index) {
        return toolbar.getAttribute('aria-label') || `toolbar-${index}`;
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
        document.querySelectorAll('.toolbar').forEach((toolbar, index) => {
            const order = all[toolbarKey(toolbar, index)];
            if (!order) return;
            const byId = new Map([...toolbar.children].map(btn => [btn.id, btn]));
            for (const id of order) {
                const btn = byId.get(id);
                if (btn) toolbar.appendChild(btn);
            }
        });
    })();

    let pressTimer = null;
    let pressStart = null;
    let activeToolbar = null;
    let dragButton = null;
    let justDragged = false;

    function clearPress() {
        clearTimeout(pressTimer);
        pressTimer = null;
        pressStart = null;
    }

    function enterReorderMode(toolbar) {
        activeToolbar = toolbar;
        toolbar.classList.add('toolbar--reorder');
    }

    function exitReorderMode() {
        if (!activeToolbar) return;
        const toolbars = [...document.querySelectorAll('.toolbar')];
        const all = loadOrder();
        all[toolbarKey(activeToolbar, toolbars.indexOf(activeToolbar))] =
            [...activeToolbar.children].map(btn => btn.id).filter(Boolean);
        saveOrder(all);
        activeToolbar.classList.remove('toolbar--reorder');
        activeToolbar = null;
    }

    function startDrag(button) {
        dragButton = button;
        justDragged = true;
        button.classList.add('icon-button--dragging');
    }

    function stopDrag() {
        if (!dragButton) return;
        dragButton.classList.remove('icon-button--dragging');
        dragButton = null;
    }

    // переставляем перетаскиваемую кнопку относительно соседей по позиции курсора
    function updateDrag(clientX) {
        if (!dragButton || !activeToolbar) return;
        for (const sib of activeToolbar.children) {
            if (sib === dragButton) continue;
            const rect = sib.getBoundingClientRect();
            if (clientX < rect.left + rect.width / 2) {
                if (sib.previousElementSibling !== dragButton) activeToolbar.insertBefore(dragButton, sib);
                return;
            }
        }
        if (activeToolbar.lastElementChild !== dragButton) activeToolbar.appendChild(dragButton);
    }

    document.addEventListener('pointerdown', (e) => {
        const button = e.target.closest('.toolbar .icon-button');
        if (!button) return;
        const toolbar = button.closest('.toolbar');

        if (activeToolbar === toolbar) {
            e.preventDefault();
            startDrag(button);
            return;
        }
        if (activeToolbar) return;

        pressStart = { x: e.clientX, y: e.clientY };
        pressTimer = setTimeout(() => {
            pressTimer = null;
            enterReorderMode(toolbar);
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

    // долгое нажатие/перетаскивание не должно ещё и переключать вкладку кликом
    document.addEventListener('click', (e) => {
        if (!justDragged) return;
        justDragged = false;
        if (e.target.closest('.icon-button')) {
            e.preventDefault();
            e.stopPropagation();
        }
    }, true);

    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape' || !activeToolbar) return;
        stopDrag();
        exitReorderMode();
    });
})();
