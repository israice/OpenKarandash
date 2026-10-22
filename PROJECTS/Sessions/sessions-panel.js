// Панель Sessions: список сессий слева от ленты. Разметку списка строит
// сервер (session-list.eta, роут /api/fragment/session-list) — htmx подменяет
// #sessionList целиком по hx-swap-oob. Здесь всё, что сервер не знает:
// кто выбран (aria-current), что выполняется прямо сейчас, чем закончилась
// строка, и черновик в композере.
//
// Открытие сессии (openSession) лежит не здесь, а в sessions-stream.js:
// оно досматривает живой поток, а поток зависит от этого файла — иначе
// модули импортировали бы друг друга по кругу.
import { state, PENDING_SESSION_ID } from './sessions-state.js';
import { api, confirmModal } from '../../SYSTEM/app.js';
import {
    saveAllProviderStates, updateContextGauge,
} from '../../SYSTEM/providers.js';
import { renderSessionBarControls } from '../../SYSTEM/session-model-bar.js';
import { addPending } from './sessions-feed.js';

// ---------- текущая сессия и черновик ----------

export function setSessionId(id) {
    state.sessionId = id;
    renderSessionBarControls();
    syncComposerBusy();
    // список сессий рисует сервер, поэтому aria-current — единственное, что
    // знает только браузер
    syncSelection();
    syncDraftRow();
    loadDraft(id);
    state.input.focus();
}

// недописанный текст в композере переживает обновление страницы: свой черновик
// на каждую сессию (id === null — общий слот для «сессия не выбрана»/«новая»)
export const DRAFT_PREFIX = 'chatDraft:';

function draftKey(id) {
    return DRAFT_PREFIX + (id || '__none__');
}

export function saveDraft() {
    const key = draftKey(state.sessionId);
    const text = state.input.value;
    if (text) localStorage.setItem(key, text);
    else localStorage.removeItem(key);
}

function loadDraft(id) {
    state.input.value = localStorage.getItem(draftKey(id)) || '';
    fitInput();
}

// поле ввода растёт под текст, но не выше 160px — дальше оно скроллится
function fitInput() {
    state.input.style.height = 'auto';
    state.input.style.height = state.input.scrollHeight + 'px';
    state.input.style.overflowY = state.input.scrollHeight > 160 ? 'auto' : 'hidden';
}

export function clearDraft(id) {
    localStorage.removeItem(draftKey(id));
}

// aria-current — единственное в списке сессий, что знает только браузер:
// сервер рендерит разметку без понятия о том, какая сессия сейчас открыта
function syncSelection() {
    for (const btn of state.sessionList.querySelectorAll('.session-item')) {
        btn.setAttribute('aria-current', String(btn.dataset.sessionId === state.sessionId));
    }
}

// ---------- список сессий ----------

export async function loadSessions() {
    try {
        const { sessions = [] } = await api('/api/sessions');
        // сам список рисует сервер: этот же 'sessions-changed' слушает и
        // session-list — фрагмент подтянется сразу, не дожидаясь очередного
        // опроса по таймеру
        document.body.dispatchEvent(new CustomEvent('sessions-changed'));
        return sessions;
    } catch {
        return [];
    }
}

// Черновик новой сессии: строка списка на время между кликом New и первым
// сообщением. Ставится начисто, поэтому звать можно сколько угодно — старая
// строка убирается, а пустой базе вместо «No sessions yet» встаёт черновик
function insertDraftRow() {
    state.sessionList.querySelector('.session-item--placeholder')?.closest('li').remove();
    state.sessionList.querySelector('.session-empty')?.remove();

    const item = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'session-item session-item--placeholder';
    btn.setAttribute('aria-current', 'true');
    btn.innerHTML = `
        <span class="session-item__body">
            <span class="session-item__title">New</span>
            <span class="session-item__meta">draft</span>
        </span>
    `;
    item.append(btn);
    state.sessionList.prepend(item);
    applyRunningIndicator();
}

// Плейсхолдер новой сессии живёт в списке до первого сообщения, а список
// рисует сервер и подменяет целиком каждые пять секунд (и сразу по
// sessions-changed): без досборки строки после подмены черновик исчезал через
// пару секунд после клика New — лента пуста, выбрать нечего, и кнопка выглядела
// сломанной. Правило одно: пока сессия не названа, черновик обязан быть в
// списке. Зовется и из setSessionId, и после каждой подмены htmx
function syncDraftRow() {
    const draft = state.sessionList.querySelector('.session-item--placeholder');
    if (state.sessionId !== null) {
        draft?.closest('li').remove();
    } else if (!draft) {
        syncSelection();
        insertDraftRow();
    }
}

// Чистый лист для новой сессии: снимаем выбор, чистим ленту и сразу
// показываем в списке черновик — реальная сессия появится из первого же
// сообщения. Общий вход и для кнопки New, и для повторного клика по
// выбранной строке, и для пустой базы: состояния «сессия не выбрана» у
// вкладки не бывает вовсе, лента всегда принадлежит какой-то сессии или
// черновику
export function startNewSession() {
    MissionFiles?.closeFilePanel(); // могла быть открыта панель редактирования файла
    setSessionId(null); // отсюда же в списке встаёт черновик (syncDraftRow)
    saveAllProviderStates();
    state.run += 1;
    state.list.innerHTML = '';
    updateContextGauge(null);
    state.input.focus();
}

// Удаление сессии из базы. Если удалили открытую — лента чистится, иначе
// следующий вопрос ушёл бы в --resume несуществующей сессии
export async function remove(id) {
    if (!id) return;
    if (!await confirmModal('Delete this session from the database? This cannot be undone.', { title: 'Delete session' })) return;

    const { ok, error } = await api('/api/sessions/delete', { id });
    if (!ok) {
        alert(error || 'Failed to delete the session');
        await loadSessions();
        return;
    }

    clearDraft(id);

    if (id === state.sessionId) startNewSession();

    await loadSessions();
}

// Копирование указателя на сессию. Копируется не голый id: id вне интерфейса
// ничего не значит, и получатель начинает искать, где такие сессии лежат.
// Поэтому копируется адрес, который открывается одной командой, — сам заголовок
// рядом, потому что по нему человек узнаёт свою сессию в списке (DOCS/decisions/099).
export function copySessionRef(id, title) {
    return copyText([
        `Сессия OpenKarandash: ${id}`,
        title ? `— «${String(title).trim().slice(0, 80)}»` : null,
        `Прочитать целиком: node TOOLS/sessions/read.mjs ${id}`,
    ].filter(Boolean).join('\n'));
}

export function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
        return navigator.clipboard.writeText(text).catch(() => copyIdFallback(text));
    }
    return copyIdFallback(text);
}

function copyIdFallback(text) {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    try {
        document.execCommand('copy');
    } finally {
        textarea.remove();
    }
    return Promise.resolve();
}

// ---------- индикатор выполнения ----------

export function applyRunningIndicator() {
    for (const btn of state.sessionList.querySelectorAll('.session-item')) {
        const id = btn.dataset.sessionId || (btn.classList.contains('session-item--placeholder') ? PENDING_SESSION_ID : null);
        const active = btn.dataset.running === '1' || (id !== null && id === state.runningSessionId);
        btn.classList.toggle('session-item--running', active);
    }

    const runningCount = state.sessionList.querySelectorAll('.session-item--running').length;

    // счётчик и круг на кнопке вкладки: видны, даже когда панель свёрнута
    document.getElementById('chatButton')?.classList.toggle('icon-button--running', runningCount > 0);
    const badge = document.getElementById('chatButtonBadge');
    if (badge) badge.textContent = runningCount;

    syncPendingWithIndicator();
    // круг в списке — источник истины о том, что сессия идёт, и кнопка Stop
    // смотрит на тот же признак: ход может начаться не отсюда (соседняя
    // вкладка, Telegram, Flow), и без круга о нём не знает никто
    syncComposerBusy();
}

// Три точки в ленте живут только вместе с оранжевым кругом этой же сессии в
// списке: круг и есть единственный источник истины. Горит круг у открытой
// сессии — точки есть (если их ещё нет, создаются прямо здесь, не дожидаясь
// подключения к потоку), погас — прячутся. Прятать, а не удалять: строку
// ожидания убирает сам поток, здесь только её наличие и видимость
function syncPendingWithIndicator() {
    const viewedId = state.sessionId || PENDING_SESSION_ID;
    let circleShown = false;
    for (const btn of state.sessionList.querySelectorAll('.session-item--running')) {
        const id = btn.dataset.sessionId || (btn.classList.contains('session-item--placeholder') ? PENDING_SESSION_ID : null);
        if (id === viewedId) { circleShown = true; break; }
    }
    if (circleShown && !state.list.querySelector('.chat-message--pending')) addPending();
    for (const el of state.list.querySelectorAll('.chat-message--pending')) el.hidden = !circleShown;
}

export function setRunningSessionId(id) {
    state.runningSessionId = id;
    // круг в списке и busy-состояние кнопки Stop пересчитываются вместе:
    // и то и другое смотрит на один и тот же признак «сессия идёт»
    applyRunningIndicator();
    // сигнал остальным страницам (слушает PROJECTS/Flow/flow-session-sync.js):
    // по этой сессии начался ход — можно подключиться к её живому потоку
    document.body.dispatchEvent(new CustomEvent('session-running-changed', { detail: { id } }));
}

// Stop-кнопка нужна только той сессии, что сейчас реально выполняется —
// при переключении на другую сессию busy-состояние пересчитывается заново.
// Истина о том, что сессия идёт, у круга в списке: ход может начаться не
// отсюда (соседняя вкладка, Telegram, Flow), и без круга о нём не знал
// никто — кнопка Stop тогда не появлялась вовсе. Свой ход вкладка знает и
// сама, поэтому и он в счёт: он начинается мгновенно, а круг обновится
// списком через несколько секунд.
export function syncComposerBusy() {
    const viewingId = state.sessionId || PENDING_SESSION_ID;
    const own = state.runningSessionId !== null && state.runningSessionId === viewingId;
    setComposerBusy(own || rowIsRunning(viewingId));
}

// круг в списке у сессии: помечена ли она как идущая
function rowIsRunning(id) {
    for (const btn of state.sessionList.querySelectorAll('.session-item')) {
        const btnId = btn.dataset.sessionId || (btn.classList.contains('session-item--placeholder') ? PENDING_SESSION_ID : null);
        if (btnId === id) return btn.classList.contains('session-item--running');
    }
    return false;
}

export function setComposerBusy(busy) {
    state.send.classList.toggle('chat-send--stop', busy);
    state.send.textContent = busy ? 'Stop' : 'Send';
}

// ---------- живой счётчик длительности ----------

// Длительность активной сессии — не статичный текст «running…», а тикающий
// счётчик: сервер отдаёт data-started (когда начался текущий ход) и
// data-base-ms (сколько уже накопили завершённые ходы той же сессии) при
// каждой подмене фрагмента, а секунды между подменами (фрагмент опрашивается
// раз в 5с) досчитывает браузер — иначе цифра менялась бы раз в 5 секунд, а
// не «живо». Копия форматирования из SYSTEM/core/format.js: тот модуль
// CommonJS и не годится браузеру напрямую
function formatLiveDuration(ms) {
    const totalSeconds = Math.round((Number(ms) || 0) / 1000);
    if (totalSeconds < 60) return `${totalSeconds}s`;

    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes < 60) return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;

    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return mins ? `${hours}h ${mins}m` : `${hours}h`;
}

// Запрашивает узлы прямо из document, а не через state.sessionList: htmx
// подменяет #sessionList целиком (раз в 5с или по sessions-changed), и
// держать константную ссылку между тиками нельзя
function tickLiveDurations() {
    for (const el of document.querySelectorAll('.session-item__meta--live')) {
        const startedAt = Number(el.dataset.started);
        if (!startedAt) continue;
        const baseMs = Number(el.dataset.baseMs) || 0;
        el.textContent = `${el.dataset.tokens} · ${formatLiveDuration(baseMs + (Date.now() - startedAt))}`;
    }
}

// ---------- подхват подмен htmx ----------

// Зовёт sessions.js, когда общие узлы вкладки (state.sessionList,
// state.sessionsPanel) уже найдены
export function initPanel() {
    setInterval(tickLiveDurations, 1000);

    // Пока палец/курсор жмёт на строку (мусорка, копирование id), подмену
    // нужно отложить: htmx создаёт НОВЫЕ узлы кнопок, а клик засчитывается
    // браузером только если mousedown и mouseup случились на одном и том же
    // узле — если подмена попадёт между ними, клик молча пропадёт, а кнопка
    // (видимая только через :hover/opacity) как будто «закроется» сама
    let pointerDown = false;
    state.sessionsPanel.addEventListener('pointerdown', () => { pointerDown = true; });
    window.addEventListener('pointerup', () => { pointerDown = false; });
    window.addEventListener('pointercancel', () => { pointerDown = false; });

    // htmx подменяет #sessionList целиком (hx-swap-oob) — старый узел больше не
    // принадлежит ссылке, которую держат остальные функции файла, поэтому
    // переподхватываем актуальный и досчитываем то, что знает только браузер.
    // Новый узел всегда приходит со scrollTop = 0, поэтому при активных
    // сессиях (они обновляются чаще) список каждую подмену дёргало наверх прямо
    // во время прокрутки. htmx убирает старый узел из DOM ДО события
    // oobAfterSwap, а scrollTop у отсоединённого узла уже читается как 0 —
    // поэтому позицию снимаем раньше, на oobBeforeSwap, пока узел ещё живой, и
    // применяем позже, когда придёт новый
    let scrollBeforeSwap = 0;
    document.body.addEventListener('htmx:oobBeforeSwap', (e) => {
        if (e.target.id !== 'sessionList') return;
        if (pointerDown) { e.detail.shouldSwap = false; return; }
        scrollBeforeSwap = e.target.scrollTop;
    });
    document.body.addEventListener('htmx:oobAfterSwap', (e) => {
        if (e.target.id !== 'sessionList') return;
        state.sessionList = e.target;
        state.sessionList.scrollTop = scrollBeforeSwap;
        syncSelection();
        syncDraftRow();
        applyRunningIndicator();
    });
}