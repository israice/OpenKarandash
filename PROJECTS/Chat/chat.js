// Вход вкладки Chat (кнопка chatButton, экран #chatView — его разметка пока в
// SYSTEM/index.html): режим отправки, композер, обработчики панели Sessions,
// восстановление подключения и последней сессии при загрузке. Части вкладки —
// ./chat-*.js, общее состояние — ./chat-state.js (DOCS/decisions/022).
//
// Подключается как <script type="module"> сразу после SYSTEM/app.js: ядро уже
// опубликовало window.App, здесь в него дописываются функции вкладки, которые
// зовут снаружи (Settings, Karandash, Home, tabs.js) — набор имён window.App
// тот же, что был до разъезда. Ядро импортируется отсюда, а не наоборот:
// обратный импорт дал бы цикл app.js ↔ chat-*.js.
//
// Состояние вкладки импортируется под именем chatState: локальные `state`
// в обработчиках селектов — записи connections, как и было в app.js
import { state as chatState } from './chat-state.js';
import { api, confirmModal, openShotLightbox, restoreServerConnection } from '../../SYSTEM/app.js';
import {
    PROVIDERS, connections, saveProviderState, saveAllProviderStates,
    loadClaudeState, loadProviderState, loadOpenCodeState, renderSessionModelEffort, renderSessionBarControls,
} from '../../SYSTEM/providers.js';
import { initFeed } from './chat-feed.js';
import {
    CHAT_DRAFT_PREFIX, setChatSessionId, saveChatDraft, clearChatDraft, copySessionId,
    renderObsConnection, loadSessions, insertSessionPlaceholder, deselectSession, removeSession,
    initSessionsPanel,
} from './chat-sessions.js';
import { stopClaude, openSession, sendToClaude } from './chat-stream.js';

const claudeProvider = PROVIDERS.find((p) => p.id === 'claude');

// режим отправки: обе опции видны, активная помечена aria-checked —
// узлы заполняет init()
let chatMode = null;
let modeOptions = [];

function setMode(mode) {
    chatMode.dataset.active = mode;

    for (const option of modeOptions) {
        const active = option.dataset.mode === mode;
        option.setAttribute('aria-checked', String(active));
        option.tabIndex = active ? 0 : -1;
    }

    chatState.chatInput.placeholder = mode === 'Action'
        ? 'Describe the action...'
        : 'Write a message...';
}

// комментарий из режима Karandash начинает отдельную сессию с этим вопросом.
// вкладку на Chat не переключаем — пользователь сам перейдёт туда, если захочет.
// mode приходит из переключателя Chat/Action самого попапа Karandash — Chat
// обсуждает место без изменений, Action сразу вносит правку; Loop недоступен
// там же, где и в композере, поэтому сюда никогда не долетает
function startCommentSession(prompt, thumb, mode) {
    chatState.pendingThumb = thumb || null;
    setChatSessionId(null);
    saveAllProviderStates();
    chatState.chatRun += 1;
    chatState.chatList.innerHTML = '';
    const sendMode = mode === 'Chat' ? 'Chat' : 'Action';
    setMode(sendMode);
    sendToClaude(prompt, sendMode);
}

async function adoptAutoConnectedClaude() {
    try {
        const status = await api('/api/agent/status', {});
        if (!status?.claude) return null;
        const provider = PROVIDERS.find((p) => p.id === 'claude');
        const state = {
            installId: status.claude.id,
            label: status.claude.label,
            version: status.claude.version,
            model: provider.defaultModel,
            effort: provider.defaultEffort,
            note: `${status.claude.label} · CLI ${status.claude.version}`,
        };
        connections.set('claude', state);
        saveProviderState('claude');
        renderSessionBarControls(); // панель уже нарисована пустой — показать подключение
        return state;
    } catch {
        return null;
    }
}

async function restoreOnLoad() {
    let savedClaude = loadClaudeState();
    if (savedClaude?.installId) {
        connections.set('claude', savedClaude);
        restoreServerConnection('claude'); // сервер мог быть перезапущен — вернём ему окружение
    } else {
        // выбора ещё не было (свежескачанный проект) — сервер мог подключить
        // claude сам при старте (autoConnectClaude): берём его, чтобы сессии
        // создавались сразу, без похода в Settings
        savedClaude = await adoptAutoConnectedClaude();
    }

    const savedCodex = loadProviderState('codex');
    if (savedCodex?.installId) {
        connections.set('codex', savedCodex);
        restoreServerConnection('codex');
    }

    const savedOpenCode = loadOpenCodeState();
    if (savedOpenCode?.installId) {
        connections.set('opencode', savedOpenCode);
        restoreServerConnection('opencode');
    }

    const savedPi = loadProviderState('pi');
    if (savedPi?.installId) {
        connections.set('pi', savedPi);
        restoreServerConnection('pi');
    }

    renderObsConnection();

    // список сессий готов сразу при загрузке страницы
    const sessions = await loadSessions();

    // последнюю открытую сессию подгружаем всегда, чтобы переход на вкладку Chat
    // (кнопка chatButton) сразу показывал её, а не пустой экран. Если страницу
    // перезагрузили посреди работы той же сессии (например, dev-автообновление) —
    // ещё и переключаемся на вкладку сами, чтобы не терять индикатор в процессе
    const saved = savedClaude?.sessionId ? savedClaude
        : savedCodex?.sessionId ? savedCodex
        : savedOpenCode?.sessionId ? savedOpenCode
        : savedPi;
    const found = saved?.sessionId && sessions.find((s) => s.id === saved.sessionId);
    if (found) {
        await openSession(found.id, found.running);
        if (found.running) MissionTabs.show('chat');
    } else {
        setChatSessionId(null);
        saveAllProviderStates();
    }
}

function init() {
    // ---------- узлы вкладки, общие для её модулей ----------

    chatState.chatSessionBar = document.getElementById('chatSessionBar');
    chatState.chatSessionProviderSelect = document.getElementById('chatSessionProviderSelect');
    chatState.chatSessionModelSelect = document.getElementById('chatSessionModelSelect');
    chatState.chatSessionEffortSelect = document.getElementById('chatSessionEffortSelect');
    chatState.chatGaugeContext = document.getElementById('chatGaugeContext');
    chatState.chatInput = document.getElementById('chatInput');
    chatState.sessionList = document.getElementById('sessionList');
    chatState.sessionsPanel = document.getElementById('sessionsPanel');
    chatState.chatList = document.getElementById('chatList');
    chatState.chatDefaultHtml = chatState.chatList.innerHTML; // карточка «Секретарь» — вид «Чата Пользователя» без выбранной сессии
    chatState.chatEmpty = document.getElementById('chatEmpty');
    chatState.chatMessages = document.getElementById('chatMessages');
    chatState.chatSend = document.querySelector('.chat__send');

    initFeed();
    initSessionsPanel();

    // ---------- шапка сессии: провайдер, модель, effort ----------

    chatState.chatSessionProviderSelect.addEventListener('change', () => {
        const provider = PROVIDERS.find((p) => p.id === chatState.chatSessionProviderSelect.value) || claudeProvider;
        renderSessionModelEffort(provider, connections.get(provider.id) || {});
    });

    chatState.chatSessionModelSelect.addEventListener('change', () => {
        const providerId = chatState.chatSessionProviderSelect.value || 'claude';
        const state = connections.get(providerId);
        if (!state) return;
        state.model = chatState.chatSessionModelSelect.value;
        saveProviderState(providerId);
    });

    chatState.chatSessionEffortSelect.addEventListener('change', () => {
        const providerId = chatState.chatSessionProviderSelect.value || 'claude';
        const state = connections.get(providerId);
        if (!state) return;
        state.effort = chatState.chatSessionEffortSelect.value;
        saveProviderState(providerId);
    });

    // ---------- композер ----------

    // поле ввода растёт под текст, Enter отправляет, Shift+Enter переносит строку
    chatState.chatInput.addEventListener('input', () => {
        chatState.chatInput.style.height = 'auto';
        chatState.chatInput.style.height = chatState.chatInput.scrollHeight + 'px';
        chatState.chatInput.style.overflowY = chatState.chatInput.scrollHeight > 160 ? 'auto' : 'hidden';
        saveChatDraft();
    });

    // Enter переносит строку, отправляет Ctrl+Enter (на Mac — Cmd+Enter)
    chatState.chatInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            document.getElementById('chatComposer').requestSubmit();
        }
    });

    // режим отправки: обе опции видны, активная помечена aria-checked
    chatMode = document.getElementById('chatMode');
    // кнопка Loop задизейблена и не участвует в переключении режимов
    modeOptions = [...chatMode.querySelectorAll('.segmented__option')].filter((o) => !o.disabled);

    chatMode.addEventListener('click', (e) => {
        const option = e.target.closest('.segmented__option');
        if (option) setMode(option.dataset.mode);
    });

    // стрелками переключаемся между опциями, как в обычной группе радиокнопок
    chatMode.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        const current = modeOptions.findIndex((o) => o.dataset.mode === chatMode.dataset.active);
        const next = modeOptions[(current + (e.key === 'ArrowRight' ? 1 : -1) + modeOptions.length) % modeOptions.length];
        setMode(next.dataset.mode);
        next.focus();
    });

    setMode('Action');

    document.getElementById('chatComposer').addEventListener('submit', (e) => {
        e.preventDefault();

        if (chatState.chatSend.classList.contains('chat__send--stop')) {
            stopClaude();
            return;
        }

        const text = chatState.chatInput.value.trim();
        if (!text) return;

        const mode = chatMode.dataset.active;

        clearChatDraft(chatState.chatSessionId);
        chatState.chatInput.value = '';
        chatState.chatInput.style.height = 'auto';
        chatState.chatInput.style.overflowY = 'hidden';
        sendToClaude(text, mode);
    });

    // ---------- панель Sessions ----------

    // клики по строкам сессии вешаем на неизменяемую панель, а не на сам
    // #sessionList — тот периодически подменяется htmx целиком, и слушатель
    // на нём пережил бы только первую отрисовку
    chatState.sessionsPanel.addEventListener('click', (e) => {
        // клик по превью открывает его на весь экран, повторный клик закрывает — превью не должно выбирать сессию
        const thumb = e.target.closest('.session-item__thumb-img');
        if (thumb) {
            openShotLightbox(thumb.src);
            return;
        }

        const copy = e.target.closest('.session-copy');
        if (copy) {
            copySessionId(copy.dataset.copyId).then(() => {
                copy.classList.remove('session-copy--copied');
                void copy.offsetWidth; // рестарт анимации при повторном клике подряд
                copy.classList.add('session-copy--copied');
                setTimeout(() => copy.classList.remove('session-copy--copied'), 1000);
            });
            return; // клик по копированию не должен открывать сессию
        }

        const del = e.target.closest('.session-delete');
        if (del) {
            removeSession(del.dataset.deleteId);
            return; // клик по мусорке не должен открывать сессию
        }

        const btn = e.target.closest('.session-item');
        if (btn && btn.dataset.sessionId) {
            if (btn.getAttribute('aria-current') === 'true') {
                deselectSession();
            } else {
                openSession(btn.dataset.sessionId, btn.classList.contains('session-item--running'));
            }
        }
    });

    // панель наблюдения на вкладке Home: слушаем контейнер, а не сами списки —
    // htmx подменяет <ul> целиком, и обработчик, повешенный на них, пережил бы
    // только первое обновление
    const observationEl = document.querySelector('.observation');
    observationEl?.addEventListener('click', (e) => {
        const btn = e.target.closest('.obs-list__item');
        if (!btn) return;
        MissionTabs.show('chat');
        openSession(btn.dataset.sessionId, btn.dataset.running === '1');
    });

    // новая сессия: чистим ленту, следующий вопрос начнёт свою историю в CLI,
    // а в списке сразу появляется черновик — реальная сессия придёт с сервера позже
    document.getElementById('sessionNew').addEventListener('click', () => {
        setChatSessionId(null);
        saveAllProviderStates();
        chatState.chatRun += 1;
        chatState.chatList.innerHTML = '';
        chatState.chatEmpty.hidden = false;
        insertSessionPlaceholder();
        document.getElementById('chatInput').focus();
    });

    // обнулить базу сессий: чистим список и текущую переписку
    document.getElementById('sessionReset').addEventListener('click', async () => {
        if (!(await confirmModal('Delete all sessions from the database? This cannot be undone.', { title: 'Delete all sessions' }))) return;

        await api('/api/sessions/reset');
        for (const key of Object.keys(localStorage)) {
            if (key.startsWith(CHAT_DRAFT_PREFIX)) localStorage.removeItem(key);
        }
        setChatSessionId(null);
        saveAllProviderStates();
        chatState.chatRun += 1;
        chatState.chatList.innerHTML = '';
        chatState.chatEmpty.hidden = false;
        await loadSessions();
    });

    // ---------- наружу ----------

    // что берут вынесенные файлы из вкладки: tabs.js (chatMessages), Settings
    // (setChatSessionId), Karandash и Home (startCommentSession) — дописываем
    // к ядру, которое app.js уже опубликовал
    Object.assign(window.App, {
        setChatSessionId,
        renderObsConnection,
        chatMessages: chatState.chatMessages,
        deselectSession,
        startCommentSession,
        openSession,
        getChatSessionId: () => chatState.chatSessionId,
    });

    restoreOnLoad();

    // список сессий (боковая панель на всех экранах + панель наблюдения на Home)
    // обновляется сам, пока вкладка открыта
    setInterval(loadSessions, 8000);
}

init();
