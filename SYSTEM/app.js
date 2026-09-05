// Ядро Mission Control (DOCS/decisions/022): помощник api() для POST-запросов,
// модальные окна и их закрытие, лайтбокс превью, App.VIEWS, восстановление
// окружения CLI на сервере, escapeHtml. Публикует window.App — из него
// остальные файлы (tabs.js, Flow, Kanban, Karandash, Settings, страницы кнопки
// «+») берут общее ядро. Подключён как <script type="module">: модульные
// скрипты без async выполняются в порядке документа вместе с defer, поэтому
// цепочка book-tab.js → app.js → PROJECTS/Chat/chat.js → остальные сохраняется.
//
// Провайдеры (состояние подключения, лимиты, шапка сессии) — SYSTEM/providers.js,
// в window.App они попадают отсюда. Вкладка Chat — PROJECTS/Chat/chat.js: она
// грузится своим тегом сразу после этого файла, импортирует ядро отсюда
// (обратный импорт дал бы цикл) и сама дописывает в window.App свои функции
// (setChatSessionId, openSession, startCommentSession, …) — набор имён
// window.App тот же, что был до разъезда.
//
// Само окно настроек и вся его разметка — в PROJECTS/Settings/settings.js, он
// грузится первым (см. порядок <script> в index.html), поэтому в init() можно
// сразу находить #settingsModal/#pickerModal в DOM.
import {
    PROVIDERS, connections, saveClaudeState, saveProviderState, renderSessionBarControls, renderUsageInline,
} from './providers.js';

// общий помощник для POST-запросов к серверу — им пользуются и остальные
// файлы через window.App.api, каждый второй экран так или иначе ходит на сервер
export async function api(path, body) {
    const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
    });
    return res.json();
}

// оба окна физически создаёт PROJECTS/Settings/settings.js (грузится раньше
// app.js, см. порядок <script> в index.html) — здесь только общая логика
// закрытия модалок, одна для всех окон проекта. Узлы заполняет init()
let modal = null;
let pickerModal = null;

export function openModal(el) {
    el.hidden = false;
    el.querySelector('.modal__close').focus();
}


export function closeModal(el) {
    el.hidden = true;
    if (el === modal) {
        document.getElementById('settingsButton').focus();
    }
}

// модальное окно подтверждения взамен нативного confirm() — та же
// разметка .modal/.modal__dialog, что у остальных окон, поэтому стиль
// не расходится; строится на лету и убирается за собой, чтобы им можно
// было пользоваться из любого файла (flow.js, sessions и т.п.) без
// добавления своего <div> в index.html под каждый вызов
export function confirmModal(message, opts = {}) {
    return new Promise((resolve) => {
        const el = document.createElement('div');
        el.className = 'modal modal--top';
        el.innerHTML = `
            <div class="modal__backdrop"></div>
            <div class="modal__dialog modal__dialog--confirm" role="alertdialog" aria-modal="true" aria-labelledby="confirmModalTitle">
                <div class="modal__header">
                    <h2 class="modal__title" id="confirmModalTitle"></h2>
                </div>
                <p class="modal__hint"></p>
                <div class="modal__confirm-actions">
                    <button type="button" class="modal__btn" data-confirm="cancel"></button>
                    <button type="button" class="modal__btn modal__btn--danger" data-confirm="ok"></button>
                </div>
            </div>
        `;
        el.querySelector('.modal__title').textContent = opts.title || 'Confirm action';
        el.querySelector('.modal__hint').textContent = message;
        el.querySelector('[data-confirm="cancel"]').textContent = opts.cancelText || 'Cancel';
        el.querySelector('[data-confirm="ok"]').textContent = opts.confirmText || 'Delete';
        document.body.append(el);

        function cleanup(result) {
            el.remove();
            document.removeEventListener('keydown', onKey);
            resolve(result);
        }
        el.addEventListener('click', (e) => {
            if (e.target.closest('.modal__backdrop') || e.target.closest('[data-confirm="cancel"]')) cleanup(false);
            else if (e.target.closest('[data-confirm="ok"]')) cleanup(true);
        });
        function onKey(e) {
            if (e.key !== 'Escape') return;
            cleanup(false);
        }
        document.addEventListener('keydown', onKey);
        el.querySelector('[data-confirm="ok"]').focus();
    });
}

// лайтбокс лежит в index.html вне #chatView — им пользуются и task-card__shot,
// и screenshotScreenPreview (Karandash), и миниатюры сессий. Узлы заполняет init()
let shotLightbox = null;
let shotLightboxImg = null;

// единственное место в проекте, которое открывает превью скриншота на весь экран —
// им пользуются и task-card__shot, и screenshotScreenPreview, и миниатюры сессий
export function openShotLightbox(src, alt = '') {
    shotLightboxImg.src = src;
    shotLightboxImg.alt = alt;
    shotLightbox.hidden = false;
}

function closeShotLightbox() {
    shotLightbox.hidden = true;
    shotLightboxImg.src = '';
}

const BOARD_COLUMNS = ['New', 'In Progress', 'Checking', 'Validator', 'Done'];

// сервер держит выбранное окружение в памяти и теряет его при перезапуске,
// поэтому страница умеет восстановить подключение по сохранённому id —
// общая функция на оба провайдера, только с разным API-префиксом
const reconnecting = {};

export function restoreServerConnection(providerId = 'claude') {
    const state = connections.get(providerId);
    if (!state) return Promise.resolve(false);
    if (!reconnecting[providerId]) {
        reconnecting[providerId] = api('/api/agent/connect', { agent: providerId, id: state.installId })
            .then((r) => r.ok)
            .catch(() => false)
            .finally(() => { reconnecting[providerId] = null; });
    }
    return reconnecting[providerId];
}

export function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function init() {
    modal = document.getElementById('settingsModal');
    pickerModal = document.getElementById('pickerModal');

    shotLightbox = document.getElementById('shotLightbox');
    shotLightboxImg = document.getElementById('shotLightboxImg');

    document.addEventListener('click', (e) => {
        const img = e.target.closest('.task-card__shot img, #screenshotScreenPreview');
        if (!img || img.hidden) return;
        openShotLightbox(img.src, img.alt);
    });

    shotLightbox.addEventListener('click', closeShotLightbox);

    const versionModal = document.getElementById('versionModal');
    document.getElementById('appVersionButton').addEventListener('click', () => openModal(versionModal));

    // окно файла живёт в file-editor.js, но закрывается общим кодом — берём его по id
    const fileModal = document.getElementById('fileModal');

    for (const el of [modal, pickerModal, versionModal, fileModal]) {
        el.addEventListener('click', (e) => {
            if (e.target.closest('[data-close-modal]')) closeModal(el);
        });
    }

    // Esc закрывает верхнее из открытых окон
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        if (!shotLightbox.hidden) { closeShotLightbox(); }
        else if (!fileModal.hidden) closeModal(fileModal);
        else if (!pickerModal.hidden) closeModal(pickerModal);
        else if (!versionModal.hidden) closeModal(versionModal);
        else if (!modal.hidden) closeModal(modal);
    });

    // ---------- переключение вида Session ----------

    const VIEWS = {
        home: document.getElementById('defaultView'),
        flow: document.getElementById('flowView'),
        kanban: document.getElementById('kanbanView'),
        book: document.getElementById('bookView'),
        chat: document.getElementById('chatView'),
    };

    // ширина нативного скроллбара нужна, чтобы composer/session-bar совпадали по ширине
    // с .chat__messages, где место под скроллбар зарезервировано через scrollbar-gutter
    const sbProbe = document.createElement('div');
    sbProbe.style.cssText = 'position:absolute;top:-9999px;width:100px;height:100px;overflow:scroll;';
    document.body.appendChild(sbProbe);
    document.documentElement.style.setProperty('--sbw', (sbProbe.offsetWidth - sbProbe.clientWidth) + 'px');
    sbProbe.remove();

    // что берут вынесенные файлы: вкладки (tabs.js), Flow, Kanban, Karandash, Settings.
    // Остальные имена (setChatSessionId, renderObsConnection, chatMessages,
    // deselectSession, startCommentSession, openSession, getChatSessionId)
    // дописывает PROJECTS/Chat/chat.js — он грузится следующим тегом
    window.App = {
        BOARD_COLUMNS,
        VIEWS,
        PROVIDERS,
        api,
        connections,
        saveClaudeState,
        saveProviderState,
        renderSessionBarControls,
        renderUsageInline,
        openModal,
        confirmModal,
        closeModal,
    };
}

init();
