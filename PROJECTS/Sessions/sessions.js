// Вход вкладки Sessions: находит узлы разметки (её построил sessions-view.js
// раньше нас), вешает обработчики и восстанавливает последнее состояние при
// загрузке. Логика разложена по файлам: лента — sessions-feed.js, список
// сессий — sessions-panel.js, поток хода — sessions-stream.js, полнота строки
// — sessions-details.js, общее состояние — sessions-state.js.
//
// Подключается как <script type="module"> сразу после SYSTEM/app.js: ядро уже
// опубликовало window.App, здесь в него дописываются функции вкладки, которые
// зовут снаружи (Settings, Karandash, tabs.js) — набор имён window.App
// тот же, что был до переписки. Ядро импортируется отсюда, а не наобороду:
// обратный импорт дал бы цикл app.js ↔ sessions-*.js.
import { state } from './sessions-state.js';
import { api, confirmModal, openShotLightbox, restoreServerConnection } from '../../SYSTEM/app.js';
import {
    connections, saveAllProviderStates, saveActiveProvider,
    loadActiveProvider, DEFAULT_AGENT, loadOpenCodeState,
} from '../../SYSTEM/providers.js';
import {
    DRAFT_PREFIX, setSessionId, saveDraft, clearDraft, copyId,
    loadSessions, startNewSession, remove, initPanel,
} from './sessions-panel.js';
import { openSession, sendTurn } from './sessions-stream.js';
import { stopTurn } from './sessions-ndjson.js';
// Заслон первой сборки страницы (SYSTEM/boot.js): страница не показывается, пока
// вкладка не доставит список сессий и ленту
import { bootTask } from '../../SYSTEM/boot.js';

// режим отправки: обе опции видны, активная помечена aria-checked
function setMode(mode) {
    state.mode.dataset.active = mode;

    for (const option of state.modeOptions) {
        const active = option.dataset.mode === mode;
        option.setAttribute('aria-checked', String(active));
        option.tabIndex = active ? 0 : -1;
    }

    state.input.placeholder = mode === 'Chat'
        ? 'Write a message...'
        : 'Describe the action...';
}

// Комментарий из режима Karandash начинает отдельную сессию с этим вопросом.
// Вкладку на Sessions не переключаем — человек сам
// перейдёт туда, если захочет. mode приходит из переключателя Chat/Action
// самого попапа Karandash: Chat обсуждает место без изменений, Action сразу
// вносит правку; Loop недоступен там же, где и в композере, поэтому сюда
// никогда не долетает
function startCommentSession(prompt, thumb, mode) {
    state.pendingThumb = thumb || null;
    state.closeModalsOnSession = true;
    setSessionId(null);
    saveAllProviderStates();
    state.run += 1;
    state.list.innerHTML = '';

    const sendMode = mode === 'Chat' ? 'Chat' : 'Action';
    setMode(sendMode);
    sendTurn(prompt, sendMode);
}

// ---------- узлы вкладки ----------

function bindNodes() {
    state.sessionsPanel = document.getElementById('sessionsPanel');
    state.sessionList = document.getElementById('sessionList');
    state.messages = document.getElementById('chatMessages');
    state.list = document.getElementById('chatList');
    state.fileEditor = document.getElementById('chatFileEditor');
    state.composer = document.getElementById('chatComposer');
    state.input = document.getElementById('chatInput');
    state.send = document.querySelector('.chat-send');
    state.mode = document.getElementById('chatMode');
    state.sessionBar = document.getElementById('chatSessionBar');
    state.gaugeContext = document.getElementById('chatGaugeContext');

    // кнопка Loop задизейблена и не участвует в переключении режимов
    state.modeOptions = [...state.mode.querySelectorAll('.mode-switch__option')].filter((o) => !o.disabled);
}

// ---------- композер ----------

function bindComposer() {
    // поле ввода растёт под текст, Ctrl+Enter отправляет, Shift+Enter переносит
    state.input.addEventListener('input', () => {
        state.input.style.height = 'auto';
        state.input.style.height = state.input.scrollHeight + 'px';
        state.input.style.overflowY = state.input.scrollHeight > 160 ? 'auto' : 'hidden';
        saveDraft();
    });

    // Enter переносит строку, отправляет Ctrl+Enter (на Mac — Cmd+Enter)
    state.input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            state.composer.requestSubmit();
        }
    });

    state.mode.addEventListener('click', (e) => {
        const option = e.target.closest('.mode-switch__option');
        if (option) setMode(option.dataset.mode);
    });

    // стрелками переключаемся между опциями, как в обычной группе радиокнопок
    state.mode.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        const current = state.modeOptions.findIndex((o) => o.dataset.mode === state.mode.dataset.active);
        const shift = e.key === 'ArrowRight' ? 1 : -1;
        const next = state.modeOptions[(current + shift + state.modeOptions.length) % state.modeOptions.length];
        setMode(next.dataset.mode);
        next.focus();
    });

    setMode('Action');

    state.composer.addEventListener('submit', (e) => {
        e.preventDefault();

        if (state.send.classList.contains('chat-send--stop')) {
            stopTurn();
            return;
        }

        const text = state.input.value.trim();
        if (!text) return;

        clearDraft(state.sessionId);
        state.input.value = '';
        state.input.style.height = 'auto';
        state.input.style.overflowY = 'hidden';
        sendTurn(text, state.mode.dataset.active);
    });
}

// ---------- панель Sessions ----------

function bindPanel() {
    // Клики по строкам сессии вешаем на неизменяемую панель, а не на сам
    // #sessionList — тот периодически подменяется htmx целиком, и слушатель
    // на нём пережил бы только первую отрисовку
    state.sessionsPanel.addEventListener('click', (e) => {
        // клик по превью открывает его на весь экран, повторный клик закрывает —
        // превью не должно выбирать сессию
        const thumb = e.target.closest('.session-item__thumb-img');
        if (thumb) {
            openShotLightbox(thumb.src);
            return;
        }

        const copy = e.target.closest('.session-copy');
        if (copy) {
            copyId(copy.dataset.copyId).then(() => {
                copy.classList.remove('session-copy--copied');
                void copy.offsetWidth; // рестарт анимации при повторном клике подряд
                copy.classList.add('session-copy--copied');
                setTimeout(() => copy.classList.remove('session-copy--copied'), 1000);
            });
            return; // клик по копированию не должен открывать сессию
        }

        const del = e.target.closest('.session-delete');
        if (del) {
            remove(del.dataset.deleteId);
            return; // клик по мусорке не должен открывать сессию
        }

        const btn = e.target.closest('.session-item');
        if (!btn?.dataset.sessionId) return;

        if (btn.getAttribute('aria-current') === 'true') startNewSession();
        else openSession(btn.dataset.sessionId, btn.classList.contains('session-item--running'));
    });

    // новая сессия: чистим ленту, следующий вопрос начнёт свою историю в CLI,
    // а в списке сразу появляется черновик — реальная сессия придёт с сервера
    // позже
    document.getElementById('sessionNew').addEventListener('click', startNewSession);

    // обнулить базу сессий: чистим список и текущую переписку
    document.getElementById('sessionReset').addEventListener('click', async () => {
        if (!await confirmModal('Delete all sessions from the database? This cannot be undone.', { title: 'Delete all sessions' })) return;

        await api('/api/sessions/reset');
        for (const key of Object.keys(localStorage)) {
            if (key.startsWith(DRAFT_PREFIX)) localStorage.removeItem(key);
        }
        await loadSessions();
        // список пуст, а лента должна чем-то принадлежать — открываем новую
        // сессию после перерисовки списка, иначе её тут же смоет подмена htmx
        startNewSession();
    });
}

// ---------- восстановление при загрузке ----------

async function restoreOnLoad() {
    // Активный провайдер решает всё (043): только его состояние поднимаем,
    // остальные даже не читаем — иначе первый по списку вставал над чатом
    // вместо последнего выбранного
    const activeId = loadActiveProvider();
    const saved = { opencode: loadOpenCodeState() };

    if (activeId && saved[activeId]?.installId) {
        connections.set(activeId, saved[activeId]);
        await restoreServerConnection(activeId); // сервер мог быть перезапущен — вернём ему окружение
    } else if (!activeId) {
        // выбора ещё не было (свежескачанный проект) или он потерян: поднимаем
        // сохранённое подключение, активным станет подключённый провайдер —
        // дальше эксклюзивный режим уже не даст раздвоения
        if (saved.opencode?.installId) {
            connections.set('opencode', saved.opencode);
            restoreServerConnection('opencode');
            saveActiveProvider(DEFAULT_AGENT);
        }
    } else {
        // active есть, но его installId потерян (чистка localStorage вручную,
        // смена окружения) — чужого не подхватываем, остаёмся без подключения:
        // молчаливое воскрешение тут и было багом
        saveActiveProvider(null);
    }

    // список сессий готов сразу при загрузке страницы
    const sessions = await loadSessions();

    // Последнюю открытую сессию подгружаем всегда, чтобы переход на вкладку
    // Sessions (кнопка chatButton) сразу показывал её, а не пустой экран. Если
    // страницу перезагрузили посреди работы той же сессии (например,
    // dev-автообновление) — ещё и переключаемся на вкладку сами, чтобы не
    // терять индикатор в процессе. Сессию берём у активного провайдера, а не
    // «первую по списку» — иначе после работы с одним агентом открывалась чужая
    const currentActive = loadActiveProvider();
    const providerState = (currentActive && saved[currentActive]) ? saved[currentActive] : null;
    // сервер отдаёт сессии по убыванию updated_at, поэтому первая в списке —
    // самая свежая
    const found = providerState?.sessionId ? sessions.find((s) => s.id === providerState.sessionId) : sessions[0];

    if (found) {
        await openSession(found.id, found.running);
        if (found.running) MissionTabs.show('chat');
        return;
    }

    // сохранённой сессии нет (ещё ни одной, её удалили, сменился провайдер) —
    // пустой ленты с подсказкой «выбери сессию» у нас не бывает: сразу
    // открываем чистый лист новой сессии, как если бы New был уже нажат
    startNewSession();
}

// ---------- старт ----------

function init() {
    bindNodes();
    initPanel();
    bindComposer();
    bindPanel();

    // что берут вынесенные файлы из вкладки: tabs.js (chatMessages), Settings
    // (setSessionId), Karandash (startCommentSession) — дописываем к
    // ядру, которое app.js уже опубликовал
    Object.assign(window.App, {
        setSessionId,
        chatMessages: state.messages,
        deselectSession: startNewSession,
        startCommentSession,
        openSession,
        getSessionId: () => state.sessionId,
    });

    // список сессий (боковая панель на всех экранах) обновляется сам,
    // пока вкладка открыта
    setInterval(loadSessions, 8000);

    // первая сборка вкладки — условие, снимемое заслоном (SYSTEM/boot.js):
    // страница открывается целиком, а не достраивается на глазах
    bootTask('sessions', restoreOnLoad());
}

init();