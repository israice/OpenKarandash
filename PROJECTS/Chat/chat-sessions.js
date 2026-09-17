// Панель Sessions вкладки Chat: текущая сессия и её черновик в композере,
// список сессий (разметку строит сервер — PROJECTS/Chat/chat-sessions.eta,
// htmx подменяет #sessionList целиком), снятие выбора и удаление сессии,
// индикатор «сессия ещё выполняется» и busy-состояние композера, строка
// провайдера на панели наблюдения Home. Открытие сессии (openSession) лежит
// в chat-stream.js: оно досматривает живой поток, а поток зависит от этого
// файла — иначе модули импортировали бы друг друга по кругу.
// Вынесено из SYSTEM/app.js (DOCS/decisions/022)
import { state } from './chat-state.js';
import { api, confirmModal } from '../../SYSTEM/app.js';
import { connections, saveAllProviderStates, updateContextGauge, renderSessionBarControls } from '../../SYSTEM/providers.js';
import { addPendingStatus } from './chat-feed.js';

// узлы, нужные только этому файлу — заполняет initSessionsPanel()
let runningCountEl = null;
let obsConnectionText = null;

export function setChatSessionId(id) {
    state.chatSessionId = id;
    renderSessionBarControls();
    syncComposerBusy();
    syncSessionSelection(); // список сессий рисует сервер, aria-current — единственное, что знает только браузер
    loadChatDraft(id);
    state.chatInput.focus();
}

// недописанный текст в композере переживает обновление страницы — свой черновик
// на каждую сессию (id === null — общий слот для «сессия не выбрана»/«новая сессия»)
export const CHAT_DRAFT_PREFIX = 'chatDraft:';

function chatDraftKey(id) {
    return CHAT_DRAFT_PREFIX + (id || '__none__');
}

export function saveChatDraft() {
    const key = chatDraftKey(state.chatSessionId);
    const text = state.chatInput.value;
    if (text) localStorage.setItem(key, text);
    else localStorage.removeItem(key);
}

function loadChatDraft(id) {
    state.chatInput.value = localStorage.getItem(chatDraftKey(id)) || '';
    state.chatInput.style.height = 'auto';
    state.chatInput.style.height = state.chatInput.scrollHeight + 'px';
    state.chatInput.style.overflowY = state.chatInput.scrollHeight > 160 ? 'auto' : 'hidden';
}

export function clearChatDraft(id) {
    localStorage.removeItem(chatDraftKey(id));
}

// aria-current — единственное в списке сессий, что знает только браузер
// (сервер рендерит разметку без понятия о том, какая сессия сейчас открыта)
function syncSessionSelection() {
    for (const btn of state.sessionList.querySelectorAll('.session-item')) {
        btn.setAttribute('aria-current', String(btn.dataset.sessionId === state.chatSessionId));
    }
}

// navigator.clipboard недоступен вне secure context (например, при
// заходе на сервер по LAN-адресу без https) — тогда пробуем старый
// execCommand('copy') через временный textarea
export function copySessionId(id) {
    if (navigator.clipboard && window.isSecureContext) {
        return navigator.clipboard.writeText(id).catch(() => copySessionIdFallback(id));
    }
    return copySessionIdFallback(id);
}

function copySessionIdFallback(id) {
    const textarea = document.createElement('textarea');
    textarea.value = id;
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

// ---------- панель наблюдения на вкладке Home ----------

// счётчики и списки панели рисует сервер (шаблон
// PROJECTS/Home/home-observation.eta, роут /api/fragment/home-observation),
// htmx подменяет их по hx-swap-oob. Здесь остаётся только строка
// провайдера — она известна одному браузеру
export function renderObsConnection() {
    const state = connections.get('claude');
    if (state?.note) {
        obsConnectionText.textContent = `${state.note} · model ${state.model}`;
        obsConnectionText.classList.remove('obs-connection__text--off');
    } else {
        obsConnectionText.textContent = 'Not connected · connect a provider in settings';
        obsConnectionText.classList.add('obs-connection__text--off');
    }
}

export async function loadSessions() {
    try {
        const { sessions = [] } = await api('/api/sessions');
        // сам список рисует сервер: этот же 'sessions-changed' слушают и
        // home-observation, и chat-sessions — оба фрагмента подтянутся сразу,
        // не дожидаясь очередного опроса по таймеру
        document.body.dispatchEvent(new CustomEvent('sessions-changed'));
        return sessions;
    } catch {
        return [];
    }
}

// черновик новой сессии: показывается в списке сразу, до первого сообщения,
// и исчезает сам, когда список перерисуется с реальными данными с сервера
export function insertSessionPlaceholder() {
    state.sessionList.querySelector('.session-item--placeholder')?.closest('li').remove();
    state.sessionList.querySelector('.session-empty')?.remove();

    for (const btn of state.sessionList.querySelectorAll('.session-item')) {
        btn.setAttribute('aria-current', 'false');
    }

    const item = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'session-item session-item--placeholder';
    btn.setAttribute('aria-current', 'true');
    btn.innerHTML = `
        <span class="session-item__thumb" aria-hidden="true"></span>
        <span class="session-item__body">
            <span class="session-item__title">New</span>
            <span class="session-item__meta">draft</span>
        </span>
    `;
    item.append(btn);
    state.sessionList.prepend(item);
    applyRunningIndicator();
}

// повторный клик по выбранной (синей) сессии снимает выбор — назад к чату default
export function deselectSession() {
    MissionFiles?.closeFilePanel(); // могла быть открыта панель редактирования файла
    setChatSessionId(null);
    saveAllProviderStates();
    state.chatRun += 1;
    state.chatList.innerHTML = state.chatDefaultHtml;
    state.chatEmpty.hidden = false;
    updateContextGauge(null);
}

// удаление сессии из базы. если удалили открытую — лента чистится,
// иначе следующий вопрос ушёл бы в --resume несуществующей сессии
export async function removeSession(id) {
    if (!id) return;
    if (!(await confirmModal('Delete this session from the database? This cannot be undone.', { title: 'Delete session' }))) return;

    const { ok, error } = await api('/api/sessions/delete', { id });
    if (!ok) {
        alert(error || 'Failed to delete the session');
        await loadSessions();
        return;
    }

    clearChatDraft(id);

    if (id === state.chatSessionId) {
        setChatSessionId(null);
        saveAllProviderStates();
        state.chatRun += 1;
        state.chatList.innerHTML = '';
        state.chatEmpty.hidden = false;
    }

    await loadSessions();
}

// индикатор «сессия ещё выполняется» в списке слева
export const PENDING_SESSION_ID = '__pending__'; // запрос уже идёт, но id придёт позже

export function applyRunningIndicator() {
    for (const btn of state.sessionList.querySelectorAll('.session-item')) {
        const id = btn.dataset.sessionId || (btn.classList.contains('session-item--placeholder') ? PENDING_SESSION_ID : null);
        const active = btn.dataset.running === '1' || (id !== null && id === state.runningSessionId);
        btn.classList.toggle('session-item--running', active);
    }
    const runningCount = state.sessionList.querySelectorAll('.session-item--running').length;
    runningCountEl.textContent = runningCount;
    document.getElementById('chatButton')?.classList.toggle('icon-button--running', runningCount > 0);
    const chatButtonBadge = document.getElementById('chatButtonBadge');
    if (chatButtonBadge) chatButtonBadge.textContent = runningCount;
    syncPendingWithIndicator();
}

// три точки в ленте живут только вместе с оранжевым кругом этой же сессии
// в списке слева — круг и есть единственный источник истины для точек:
// горит круг у открытой сессии — точки есть (если их ещё нет — создаются
// прямо здесь, не дожидаясь подключения к потоку), погас — прячутся.
// Прятать, а не удалять: строку ожидания убирает сам поток
// (sendToClaude/attachSession), здесь только её наличие и видимость
function syncPendingWithIndicator() {
    const viewedId = state.chatSessionId || PENDING_SESSION_ID;
    let circleShown = false;
    for (const btn of state.sessionList.querySelectorAll('.session-item--running')) {
        const id = btn.dataset.sessionId || (btn.classList.contains('session-item--placeholder') ? PENDING_SESSION_ID : null);
        if (id === viewedId) { circleShown = true; break; }
    }
    if (circleShown && !state.chatList.querySelector('.chat__message--pending')) addPendingStatus();
    for (const el of state.chatList.querySelectorAll('.chat__message--pending')) el.hidden = !circleShown;
}

export function setRunningSessionId(id) {
    state.runningSessionId = id;
    applyRunningIndicator();
    syncComposerBusy();
    // сигнал остальным страницам (слушает PROJECTS/Flow/flow-session-sync.js):
    // по этой сессии начался ход — можно подключиться к её живому потоку
    document.body.dispatchEvent(new CustomEvent('session-running-changed', { detail: { id } }));
}

// Stop-кнопка нужна только той сессии, что сейчас реально выполняется —
// при переключении на другую сессию busy-состояние пересчитывается заново
export function syncComposerBusy() {
    const viewingId = state.chatSessionId || PENDING_SESSION_ID;
    setComposerBusy(state.runningSessionId !== null && state.runningSessionId === viewingId);
}

export function setComposerBusy(busy) {
    state.chatSend.classList.toggle('chat__send--stop', busy);
    state.chatSend.textContent = busy ? 'Stop' : 'Send';
}

// длительность активной сессии в панели — не статичный текст «running…»,
// а тикающий счётчик: сервер (chat-server.js) отдаёт data-started (когда
// начался текущий ход) и data-base-ms (сколько уже накопили завершённые
// ходы той же сессии) при каждой подмене фрагмента, а секунды между
// подменами (фрагмент опрашивается раз в 5с) досчитывает браузер — иначе
// цифра менялась бы раз в 5 секунд, а не «живо». Копия форматирования из
// SYSTEM/core/format.js: тот модуль CommonJS и не годится браузеру напрямую
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

// запрашивает актуальные узлы прямо из document, а не через state.sessionList:
// htmx подменяет #sessionList целиком (раз в 5с или по sessions-changed), и
// держать константную ссылку между тиками нельзя (см. комментарий у sessionList
// в chat-state.js) — переспрашивать проще, чем переподхватывать по oobAfterSwap
function tickLiveDurations() {
    for (const el of document.querySelectorAll('.session-item__meta--live')) {
        const startedAt = Number(el.dataset.started);
        if (!startedAt) continue;
        const baseMs = Number(el.dataset.baseMs) || 0;
        el.textContent = `${el.dataset.tokens} · ${formatLiveDuration(baseMs + (Date.now() - startedAt))}`;
    }
}

// узлы панели и подхват подмен htmx — зовёт init() в chat.js, когда общие
// узлы вкладки (state.sessionList, state.sessionsPanel) уже найдены
export function initSessionsPanel() {
    runningCountEl = document.getElementById('runningCount');
    obsConnectionText = document.getElementById('obsConnectionText');
    setInterval(tickLiveDurations, 1000);

    // htmx подменяет #sessionList целиком (hx-swap-oob) — старый узел живой
    // ссылке, которую держат остальные функции файла, больше не принадлежит,
    // поэтому переподхватываем актуальный и досчитываем то, что знает только браузер.
    // Новый узел всегда приходит со scrollTop = 0, поэтому при активных
    // сессиях (они обновляются чаще, см. hx-trigger) список каждую подмену
    // дёргало наверх прямо во время прокрутки. htmx убирает старый узел из DOM
    // ДО события oobAfterSwap, а scrollTop у отсоединённого узла уже читается
    // как 0 — поэтому позицию нужно снять раньше, на oobBeforeSwap, пока узел
    // ещё живой, и применить её позже, когда придёт новый
    // пока палец/курсор жмёт на строку (мусорка, копирование id), подмену
    // нужно отложить: htmx создаёт НОВЫЕ узлы кнопок, а клик засчитывается
    // браузером только если mousedown и mouseup случились на одном и том же
    // узле — если подмена попадёт между ними, клик молча пропадёт, а кнопка
    // (видимая только через :hover/opacity) как будто "закроется" сама
    let sessionsPointerDown = false;
    state.sessionsPanel.addEventListener('pointerdown', () => { sessionsPointerDown = true; });
    window.addEventListener('pointerup', () => { sessionsPointerDown = false; });
    window.addEventListener('pointercancel', () => { sessionsPointerDown = false; });

    let sessionListScrollBeforeSwap = 0;
    document.body.addEventListener('htmx:oobBeforeSwap', (e) => {
        if (e.target.id !== 'sessionList') return;
        if (sessionsPointerDown) { e.detail.shouldSwap = false; return; }
        sessionListScrollBeforeSwap = e.target.scrollTop;
    });
    document.body.addEventListener('htmx:oobAfterSwap', (e) => {
        if (e.target.id !== 'sessionList') return;
        state.sessionList = e.target;
        state.sessionList.scrollTop = sessionListScrollBeforeSwap;
        syncSessionSelection();
        applyRunningIndicator();
    });
}
