// Ядро Mission Control (DOCS/decisions/022): помощник api() для POST-запросов,
// модальные окна и их закрытие, лайтбокс превью, App.VIEWS, восстановление
// окружения CLI на сервере, escapeHtml. Публикует window.App — из него
// остальные файлы (tabs.js, Flow, Kanban, Karandash, Settings, страницы кнопки
// «+») берут общее ядро. Подключён как <script type="module">: модульные
// скрипты без async выполняются в порядке документа вместе с defer, поэтому
// цепочка book-tab.js / telegram.js → app.js → PROJECTS/Sessions/sessions.js →
// остальные сохраняется.
//
// Провайдеры (состояние подключения, лимиты, шапка сессии) — SYSTEM/providers.js,
// в window.App они попадают отсюда. Вкладка Sessions — PROJECTS/Sessions/sessions.js: она
// грузится своим тегом сразу после этого файла, импортирует ядро отсюда
// (обратный импорт дал бы цикл) и сама дописывает в window.App свои функции
// (setSessionId, openSession, startCommentSession, …) — набор имён
// window.App тот же, что был до разъезда.
//
// Само окно настроек и вся его разметка — в PROJECTS/Settings/settings.js, он
// грузится первым (см. порядок <script> в index.html), поэтому в init() можно
// сразу находить #settingsModal/#pickerModal в DOM.
import {
    PROVIDERS, providerById, registerProvider, connections, saveProviderState, saveActiveProvider, loadActiveProvider,
    activateExclusive, DEFAULT_AGENT,
} from './providers.js';
// Горячая перезагрузка скриптов — отдельный модуль: правило переисполнения,
// перерисовки и поставщиков к ядру отношения не имеет, а app.js подходит к
// четырёмстам строкам (DOCS/decisions/022)
import * as HotReload from './hot-reload.js';
// Каскад выбора модели — из model-cascade.js: строка в шапке сессии берёт оттуда
// выбор и пишет его одним способом, а модель при отправке хода читается оттуда же
import {
    modelOf, levelsOf,
} from './model-cascade.js';
// Строка выбора в шапке сессии и чтения выбора при отправке хода — отсюда
import {
    renderSessionBarControls, getActiveProviderId, getActiveModel, getActiveEffort,
} from './session-model-bar.js';

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
    // крестик закрытия убран из всех окон (data-close-modal остался только
    // на фоне-подложке) — фокус ставим на сам диалог, чтобы Escape и клик
    // по подложке по-прежнему закрывали окно с клавиатуры
    const dialog = el.querySelector('.modal__dialog');
    if (dialog) {
        dialog.setAttribute('tabindex', '-1');
        dialog.focus();
    }
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

// лайтбокс лежит в index.html вне вкладок — им пользуются
// screenshotScreenPreview (Karandash) и миниатюры сессий. Узлы заполняет init()
let shotLightbox = null;
let shotLightboxImg = null;

// единственное место в проекте, которое открывает превью скриншота на весь экран —
// им пользуются screenshotScreenPreview и миниатюры сессий
export function openShotLightbox(src, alt = '') {
    shotLightboxImg.src = src;
    shotLightboxImg.alt = alt;
    shotLightbox.hidden = false;
}

function closeShotLightbox() {
    shotLightbox.hidden = true;
    shotLightboxImg.src = '';
}

const BOARD_COLUMNS = ['New', 'In Progress', 'In Review', 'Validator', 'Done'];

// сервер держит выбранное окружение в памяти и теряет его при перезапуске,
// поэтому страница умеет восстановить подключение по сохранённому id —
// функция общая на всех провайдеров.
// Ответ connect для pi везёт свежий список моделей — кладём его в
// PROVIDERS сразу, иначе после reload select «Model for …» остаётся пустым
// (provider.models сброшен в [], см. providers.js) и строка модели не рисуется
const reconnecting = {};

export function restoreServerConnection(providerId) {
    const state = connections.get(providerId);
    if (!state) return Promise.resolve(false);
    if (!reconnecting[providerId]) {
        reconnecting[providerId] = api('/api/agent/connect', { agent: providerId, id: state.installId })
            .then((r) => {
                if (!r?.ok) return false;
                // id, который сервер принял на самом деле, записанный обратно:
                // сохранённый стареет (цель переехала, сервер вернулся на другой
                // id), и каждое восстановление после рестарта спотыкалось бы о
                // него снова. Пустое id от клиента не пишем — тогда следующее
                // восстановление снова подберёт единственную цель
                if (r.id && state.installId !== r.id) {
                    state.installId = r.id;
                    saveProviderState(providerId);
                }
                if (Array.isArray(r.models) && r.models.length) {
                    // Каталог моделей едет в провайдера, и больше connect тут
                    // ничего не меняет: раньше он попутно решал, какая модель
                    // «должна» быть (не из выбранной — из своего дефолта или
                    // первой в каталоге), и затирал ею выбор человека из строки
                    // над сессией. Модель выбирают там, и подключение её не
                    // трогает — только наполняет списки строки выбора
                    const provider = providerById(providerId);
                    if (provider) provider.models = r.models;
                }
                return true;
            })
            .catch(() => false)
            .finally(() => { reconnecting[providerId] = null; });
    }
    return reconnecting[providerId];
}

// Подключение выбранного CLI перед ходом. Слово из строки выбора в шапке может
// быть неподключённым — список CLI приходит с сайта и меняется, — и раньше такой
// выбор молча уводил ход на провайдера по умолчанию. Здесь то же слово
// подключается: сперва пробуем восстановить прошлое подключение, иначе ищем CLI
// на машине и подключаем единственную найденную цель. Список моделей оттуда же
// едет в каскад выбора, поэтому уровни Gateway/Provider/Model после первого
// хода показывают реальные имена, а не прочерки
export async function ensureConnected(providerId) {
    if (connections.has(providerId)) {
        const restored = await restoreServerConnection(providerId);
        if (restored || connections.has(providerId)) return connections.get(providerId);
    }
    const provider = providerById(providerId);
    const { installs = [] } = await api('/api/agent/detect', { agent: providerId }).catch(() => ({}));
    const target = installs[0];
    if (!target) return null;
    const result = await api('/api/agent/connect', { agent: providerId, id: target.id });
    if (!result?.ok) return null;
    // Подключение наполняет каталог моделей и не выбирает модель: выбор
    // человека живёт в строке над сессией, и он единственный. Раньше здесь
    // стоял свой перебор (его модель → дефолт проекта → первая в каталоге), и
    // подключение, случись оно между выбором и ходом, тихо подменяло модель на
    // другую — ровно тот случай, когда настройки «перестают работать»
    const chosen = modelOf(providerId);
    provider.models = Array.isArray(result.models) ? result.models : [];
    connections.set(providerId, {
        installId: result.id,
        label: result.label,
        version: result.version,
        model: chosen || null,
        note: `${result.label} · CLI ${result.version}`,
    });
    saveProviderState(providerId);
    saveActiveProvider(providerId);
    renderSessionBarControls();
    return connections.get(providerId);
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
        const img = e.target.closest('#screenshotScreenPreview');
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
        flow: document.getElementById('flowView'),
        kanban: document.getElementById('kanbanView'),
        book: document.getElementById('bookView'),
        chat: document.getElementById('chatView'),
        telegram: document.getElementById('telegramView'),
    };

    // Ширину нативного скроллбара мерять не нужно: лента скроллится сама
    // (scrollbar-width: none), а композер и шапка центрируются по своей
    // ширине. Раньше здесь мерилась ширина скроллбара и вычиталась из
    // композера — на Windows, где скроллбар накладывается, это уводило
    // композер на 15px влево от ленты (--sbw).

    // ---------- горячая перезагрузка скриптов ----------
    // Правка клиентского скрипта приходит событием `script:<путь>`. Раздел, который
    // умеет перерисовать себя на месте, регистрирует крючок под свой файл: крючок
    // снимает то, что скрипт нарисовал в прошлый раз, а свежая копия выполняется
    // обычным порядком и рисует себя заново сама. Крючка нет — раздел за собой не
    // умеет убираться, и клиент откатывается к полной перезагрузке страницы: это
    // честнее, чем оставить два экземпляра раздела один поверх другого.
    //
    // Само правило живёт в SYSTEM/hot-reload.js: там же перерисовка уже нарисованных
    // узлов и поставщики, которые рисует чужой скрипт (DOCS/decisions/090).
    const hot = HotReload.create(window);

    // что берут вынесенные файлы: вкладки (tabs.js), Flow, Kanban, Karandash, Settings.
    // Остальные имена (setSessionId, renderObsConnection, chatMessages,
    // deselectSession, startCommentSession, openSession, getSessionId)
    // дописывает PROJECTS/Sessions/sessions.js — он грузится следующим тегом
    window.App = {
        BOARD_COLUMNS,
        VIEWS,
        PROVIDERS,
        providerById,
        registerProvider,
        DEFAULT_AGENT,
        api,
        connections,
        saveProviderState,
        saveActiveProvider,
        loadActiveProvider,
        activateExclusive,
        renderSessionBarControls,
        ensureConnected,
        getActiveProviderId,
        getActiveModel,
        getActiveEffort,
        // выбор человека из шапки сессии целиком: подключение держит его при
        // Connect, чтобы не вернуть свой выбор поверх выбора в шапке
        modelOf,
        // выбранные уровни Gateway/Provider/Model: подпись модели над ответом
        // дописывает шлюз, которого нет в пути CLI-шной формы (DOCS/decisions/076)
        levelsOf,
        openModal,
        confirmModal,
        closeModal,
        escapeHtml,
        // Регистрация крючка не зависит от порядка загрузки: до готовности ядра крючок
        // ждёт в очереди на окне, после — попадает в карту (см. SYSTEM/hot-reload.js)
        registerHotReload: hot.registerHotReload,
        registerHotRedraw: hot.registerHotRedraw,
        declareDependent: hot.declareDependent,
        canReloadScript: hot.canReloadScript,
        reloadScript: hot.reloadScript,
    };
}

init();
