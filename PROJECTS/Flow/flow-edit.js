// Правка текста в карточке на живом полотне: редактирование вопросов и
// заголовка/подзаголовка/тела ноды, перетаскивание вопросов и кнопок вертикального
// меню долгим нажатием.
//
// Здесь только обработчики. Данные, которые они читают и пишут, живут в
// flow-node-state.js (тексты, вопросы, порядок кнопок).
(function () {
    window.FlowEdit = function (ctx) {
        const { surface } = ctx;

        // --- вопросы под телом ноды ---

        surface.addEventListener('input', (e) => {
            const field = e.target.closest('.flow-node__question');
            if (!field) return;
            ctx.saveQuestionsFor(field.closest('.flow-node'));
        });
        surface.addEventListener('click', (e) => {
            const addBtn = e.target.closest('.flow-node__questions-add');
            if (!addBtn) return;
            const group = addBtn.closest('.flow-node__questions');
            const field = ctx.addQuestionField(group);
            const textEl = field.querySelector('.flow-node__question-text');
            textEl.contentEditable = 'true';
            textEl.focus();
            ctx.saveQuestionsFor(group.closest('.flow-node'));
        });
        surface.addEventListener('click', (e) => {
            const field = e.target.closest('.flow-node__question');
            if (!field) return;
            const textEl = field.querySelector('.flow-node__question-text');
            if (textEl.isContentEditable) return;
            const rect = ctx.questionTextRect(field);
            if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) return;
            textEl.contentEditable = 'true';
            textEl.focus();
        });
        surface.addEventListener('focusout', (e) => {
            const field = e.target.closest('.flow-node__question');
            if (!field) return;
            field.querySelector('.flow-node__question-text').contentEditable = 'false';
        });

        // перетаскивание вопросов за ручку слева — тот же приём, что и у кнопок
        // тулбара (см. toolbar-reorder.js): долгое нажатие (>2с) включает "тряску",
        // в которой вопрос можно перетащить на новое место; выход — Esc
        const Q_LONG_PRESS_MS = 2000;
        const Q_MOVE_CANCEL_PX = 8;
        const Q_HANDLE_WIDTH = 26;
        let qPressTimer = null;
        let qPressStart = null;
        let qActiveGroup = null;
        let qDragField = null;

        function isQuestionHandle(e, field) {
            const rect = field.getBoundingClientRect();
            return e.clientX - rect.left < Q_HANDLE_WIDTH;
        }
        function clearQPress() {
            clearTimeout(qPressTimer);
            qPressTimer = null;
            qPressStart = null;
        }
        function enterQuestionReorder(group) {
            qActiveGroup = group;
            group.classList.add('flow-node__questions--reorder');
        }
        function exitQuestionReorder() {
            if (!qActiveGroup) return;
            ctx.saveQuestionsFor(qActiveGroup.closest('.flow-node'));
            qActiveGroup.classList.remove('flow-node__questions--reorder');
            qActiveGroup = null;
        }
        function startQuestionDrag(field) {
            qDragField = field;
            field.classList.add('flow-node__question--dragging');
        }
        function stopQuestionDrag() {
            if (!qDragField) return;
            qDragField.classList.remove('flow-node__question--dragging');
            qDragField = null;
        }
        function updateQuestionDrag(clientY) {
            if (!qDragField || !qActiveGroup) return;
            for (const sib of qActiveGroup.querySelectorAll('.flow-node__question')) {
                if (sib === qDragField) continue;
                const rect = sib.getBoundingClientRect();
                if (clientY < rect.top + rect.height / 2) {
                    if (sib.previousElementSibling !== qDragField) qActiveGroup.insertBefore(qDragField, sib);
                    return;
                }
            }
            const addBtn = qActiveGroup.querySelector('.flow-node__questions-add');
            if (addBtn.previousElementSibling !== qDragField) qActiveGroup.insertBefore(qDragField, addBtn);
        }

        surface.addEventListener('pointerdown', (e) => {
            const field = e.target.closest('.flow-node__question');
            if (!field || !isQuestionHandle(e, field)) return;
            const group = field.closest('.flow-node__questions');

            if (qActiveGroup === group) {
                e.preventDefault();
                startQuestionDrag(field);
                return;
            }
            if (qActiveGroup) return;

            qPressStart = { x: e.clientX, y: e.clientY };
            qPressTimer = setTimeout(() => {
                qPressTimer = null;
                enterQuestionReorder(group);
                startQuestionDrag(field);
            }, Q_LONG_PRESS_MS);
        });
        surface.addEventListener('pointermove', (e) => {
            if (qPressTimer && qPressStart) {
                if (Math.hypot(e.clientX - qPressStart.x, e.clientY - qPressStart.y) > Q_MOVE_CANCEL_PX) clearQPress();
                return;
            }
            if (qDragField) {
                e.preventDefault();
                updateQuestionDrag(e.clientY);
            }
        });
        surface.addEventListener('pointerup', () => {
            clearQPress();
            stopQuestionDrag();
        });
        window.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape' || !qActiveGroup) return;
            stopQuestionDrag();
            exitQuestionReorder();
        });

        // --- заголовок, подзаголовок и тело ноды ---

        // клик по заголовку, строке под ним или телу ноды превращает поле в
        // резиновое (растущее вместе с текстом) редактируемое; клик мимо — сохраняет
        surface.addEventListener('click', (e) => {
            const field = e.target.closest(ctx.EDITABLE_SELECTOR);
            if (!field || field.isContentEditable || field.id) return;
            field.contentEditable = 'true';
            field.focus();
            // без этого курсор при входе в редактирование всегда прыгает
            // в начало текста, а не встаёт туда, где кликнул пользователь
            const range = document.caretRangeFromPoint
                ? document.caretRangeFromPoint(e.clientX, e.clientY)
                : document.caretPositionFromPoint
                    ? (() => {
                        const pos = document.caretPositionFromPoint(e.clientX, e.clientY);
                        const r = document.createRange();
                        r.setStart(pos.offsetNode, pos.offset);
                        return r;
                    })()
                    : null;
            if (range) {
                const sel = window.getSelection();
                sel.removeAllRanges();
                sel.addRange(range);
            }
        });
        surface.addEventListener('focusout', (e) => {
            const field = e.target.closest(ctx.EDITABLE_SELECTOR);
            if (!field || field.id) return;
            field.contentEditable = 'false';
            const n = field.closest('.flow-node');
            // правка текста ноды сессии живёт до ближайшей перестройки графа
            // и в состояние не пишется — она всё равно будет перезаписана
            // сообщением (правка самой сессии — этап 3 в TASKS.md)
            if (n.dataset.session) return;
            const all = ctx.loadTexts();
            const name = field.classList.contains('flow-node__title') ? 'title'
                : field.classList.contains('flow-node__subtitle') ? 'subtitle' : 'body';
            all[`${n.id}:${name}`] = field.textContent;
            ctx.flowSet(ctx.TEXT_KEY, all);
        });

        // --- порядок кнопок вертикального меню ---

        // тот же приём, что у вопросов выше и у кнопок тулбара
        // (SYSTEM/toolbar-reorder.js): долгое нажатие (>2с) включает «тряску», в
        // которой кнопку можно перетащить на новое место, выход — Esc. Порядок
        // общий на все ноды с таким меню и живёт во flow_state, поэтому переживает
        // перезагрузку
        const MENU_ORDER_KEY = 'flowQaMenuOrder';
        const M_LONG_PRESS_MS = 2000;
        const M_MOVE_CANCEL_PX = 8;
        let mPressTimer = null;
        let mPressStart = null;
        let mActiveMenu = null;
        let mDragItem = null;
        let mJustDragged = false;

        // ключ кнопки — её надпись: id у пунктов меню нет, а надпись в шаблоне
        // уникальна и переживает смену иконки
        function menuItemKey(btn) {
            return btn.querySelector('.flow-node__menu-label').textContent.trim();
        }
        function applyMenuOrder(n) {
            const order = ctx.flowGet(MENU_ORDER_KEY, null);
            const menu = n && n.querySelector('.flow-node__menu');
            if (!order || !menu) return;
            const byKey = new Map([...menu.children].map((b) => [menuItemKey(b), b]));
            // кнопки сохранённого порядка переставляем в хвост по очереди;
            // добавленную в шаблон новую кнопку порядок не знает — она просто
            // окажется выше сохранённых, а не потеряется
            for (const key of order) {
                const btn = byKey.get(key);
                if (btn) menu.appendChild(btn);
            }
        }
        function saveMenuOrder(menu) {
            ctx.flowSet(MENU_ORDER_KEY, [...menu.children].map(menuItemKey));
            // порядок общий на все карточки — остальные открытые ноды
            // выстраиваем тут же, а не после перезагрузки страницы
            for (const n of surface.querySelectorAll('.flow-node')) {
                if (!n.contains(menu)) applyMenuOrder(n);
            }
        }
        function clearMPress() {
            clearTimeout(mPressTimer);
            mPressTimer = null;
            mPressStart = null;
        }
        function enterMenuReorder(menu) {
            mActiveMenu = menu;
            menu.classList.add('flow-node__menu--reorder');
        }
        function exitMenuReorder() {
            if (!mActiveMenu) return;
            saveMenuOrder(mActiveMenu);
            mActiveMenu.classList.remove('flow-node__menu--reorder');
            mActiveMenu = null;
        }
        function startMenuDrag(item) {
            mDragItem = item;
            mJustDragged = true;
            item.classList.add('flow-node__menu-item--dragging');
        }
        function stopMenuDrag() {
            if (!mDragItem) return;
            mDragItem.classList.remove('flow-node__menu-item--dragging');
            mDragItem = null;
        }
        // меню вертикальное — соседей сравниваем по середине их высоты
        function updateMenuDrag(clientY) {
            if (!mDragItem || !mActiveMenu) return;
            for (const sib of mActiveMenu.children) {
                if (sib === mDragItem) continue;
                const rect = sib.getBoundingClientRect();
                if (clientY < rect.top + rect.height / 2) {
                    if (sib.previousElementSibling !== mDragItem) mActiveMenu.insertBefore(mDragItem, sib);
                    return;
                }
            }
            if (mActiveMenu.lastElementChild !== mDragItem) mActiveMenu.appendChild(mDragItem);
        }

        surface.addEventListener('pointerdown', (e) => {
            const item = e.target.closest('.flow-node__menu-item');
            if (!item) return;
            const menu = item.closest('.flow-node__menu');

            if (mActiveMenu === menu) {
                e.preventDefault();
                startMenuDrag(item);
                return;
            }
            if (mActiveMenu) return;

            mPressStart = { x: e.clientX, y: e.clientY };
            mPressTimer = setTimeout(() => {
                mPressTimer = null;
                enterMenuReorder(menu);
                startMenuDrag(item);
            }, M_LONG_PRESS_MS);
        });
        surface.addEventListener('pointermove', (e) => {
            if (mPressTimer && mPressStart) {
                if (Math.hypot(e.clientX - mPressStart.x, e.clientY - mPressStart.y) > M_MOVE_CANCEL_PX) clearMPress();
                return;
            }
            if (mDragItem) {
                e.preventDefault();
                updateMenuDrag(e.clientY);
            }
        });
        surface.addEventListener('pointerup', () => {
            clearMPress();
            stopMenuDrag();
        });
        // долгое нажатие и перетаскивание не должны ещё и открывать панель
        // кнопки: гасим клик, которым браузер завершает такой жест
        surface.addEventListener('click', (e) => {
            if (!mJustDragged) return;
            mJustDragged = false;
            if (e.target.closest('.flow-node__menu-item')) {
                e.preventDefault();
                e.stopPropagation();
            }
        }, true);
        window.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape' || !mActiveMenu) return;
            stopMenuDrag();
            exitMenuReorder();
        });

        ctx.applyMenuOrder = applyMenuOrder;
    };
})();
