// Стриминг вкладки Chat: ответ /api/agent/ask приходит потоком NDJSON — здесь
// его чтение, отрисовка событий в ленту, отправка вопроса, остановка, а также
// открытие сессии (openSession): оно досматривает живой поток уже идущей
// работы, поэтому лежит тут, а не в chat-sessions.js, от которого этот файл
// зависит. Вынесено из SYSTEM/app.js (DOCS/decisions/022)
import { state } from './chat-state.js';
import { api, restoreServerConnection } from '../../SYSTEM/app.js';
import {
    PROVIDERS, connections, saveProviderState, saveAllProviderStates, getActiveProviderId,
    updateClaudeUsage, updateContextGauge, contextWindowForModel,
} from '../../SYSTEM/providers.js';
import { isChatNearBottom, scrollChatToBottom, addStep, addThinkingStep, addMessage, addPendingStatus } from './chat-feed.js';
import { PENDING_SESSION_ID, setChatSessionId, setRunningSessionId, setComposerBusy, loadSessions } from './chat-sessions.js';

// останавливает CLI-процесс на сервере; поток сам закроется событием error/done.
// очередь и запущенные процессы общие на все CLI, поэтому маршрут один
// и провайдера указывать не нужно
export function stopClaude() {
    api('/api/agent/stop', { sessionId: state.chatSessionId });
}

// ответ приходит потоком NDJSON: по событию в строке
async function readNdjson(res, onEvent) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let tail = '';

    for (;;) {
        const { value, done } = await reader.read();
        if (done) break;

        tail += decoder.decode(value, { stream: true });
        const lines = tail.split('\n');
        tail = lines.pop();

        for (const line of lines) {
            if (line.trim()) onEvent(JSON.parse(line));
        }
    }
}

// маршрут один на всех: какой CLI звать, сервер берёт из поля agent
// в теле. Формат событий тоже общий (session|tool|text|context|error|done),
// поэтому readNdjson/makeRenderer ниже не различают провайдеров
async function streamAsk(body, onEvent) {
    const res = await fetch('/api/agent/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    await readNdjson(res, onEvent);
}

// отрисовка событий потока — одна и та же для своего запроса
// и для подключения к работе, которая уже идёт
function makeRenderer(status) {
    let answered = false;

    return (event) => {
        if (event.type === 'tool') {
            // каждое действие остаётся своей строкой в ленте, а не заменяет предыдущую
            addStep(`${event.name} ${event.detail}`.trim(), status);
        } else if (event.type === 'thinking') {
            // текст рассуждения, а не просто отметка, что оно было
            addThinkingStep(event.text, status);
        } else if (event.type === 'text') {
            answered = true;
            const stick = isChatNearBottom();
            addMessage(event.text, 'assistant');
            state.chatList.append(status); // строка ожидания остаётся последней
            if (stick) scrollChatToBottom();
        } else if (event.type === 'error') {
            addMessage(event.error, 'error');
        } else if (event.type === 'done') {
            if (!answered && event.text) addMessage(event.text, 'assistant');
            loadSessions(); // в списке обновилось число сообщений
        }
    };
}

// сессия всё ещё выполняется (страницу перезагрузили посреди работы) —
// досматриваем её ленту вживую
export async function attachSession(id, run) {
    const res = await fetch('/api/sessions/attach', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
    });

    // поток идёт с типом application/x-ndjson; обычный JSON означает,
    // что работа уже закончилась и подключаться не к чему
    if (!res.headers.get('content-type')?.includes('ndjson')) {
        setRunningSessionId(null);
        loadSessions();
        return;
    }

    const status = addPendingStatus();
    setComposerBusy(true);
    const render = makeRenderer(status);

    // как и в sendToClaude: пока довоспроизводим чужой поток, автообновление подождёт,
    // иначе очередной dev-reload оборвёт чтение раньше, чем страница успеет его показать
    window.__holdReload?.(true);

    try {
        await readNdjson(res, (event) => {
            if (event.type === 'rate_limit') { updateClaudeUsage(event.info); return; }
            if (event.type === 'context') { updateContextGauge(event.percent, event.window); return; }
            if (run === state.chatRun) render(event);
        });
    } finally {
        window.__holdReload?.(false);
        status.remove();
        setRunningSessionId(null);
        if (run === state.chatRun) setComposerBusy(false);
    }
}

// переключение на другую сессию: показываем её переписку и продолжаем её же
export async function openSession(id, running = false) {
    MissionFiles?.closeFilePanel(); // могла быть открыта панель редактирования файла
    state.sessionList.querySelector('.session-item--placeholder')?.closest('li').remove();
    setChatSessionId(id);
    saveAllProviderStates();

    state.chatRun += 1;
    state.chatList.innerHTML = '';
    state.chatEmpty.hidden = true;

    const { messages = [], contextPercent = null, contextWindow = null } = await api('/api/sessions/messages', { id });
    for (const message of messages) {
        if (message.role === 'tool') addStep(message.text);
        else addMessage(message.text, message.role === 'user' ? 'user' : 'assistant');
    }

    if (messages.length === 0) state.chatEmpty.hidden = false;
    updateContextGauge(contextPercent, contextWindow);

    // работа ещё идёт (страницу перезагрузили посреди неё) — досматриваем вживую
    if (running) {
        setRunningSessionId(id);
        attachSession(id, state.chatRun);
    }
}

export async function sendToClaude(text, mode = 'Action') {
    const run = ++state.chatRun;
    // провайдер берём из строки шапки сессии — туда же уходит запрос
    const providerId = getActiveProviderId();
    const provider = PROVIDERS.find((p) => p.id === providerId);
    const claude = connections.get(providerId);
    if (!claude) {
        addMessage(`${provider ? provider.name : 'Provider'} is not connected. Open Settings and click "Connect".`, 'error');
        return;
    }

    addMessage(text, 'user');

    const status = addPendingStatus();
    setComposerBusy(true);
    setRunningSessionId(state.chatSessionId || PENDING_SESSION_ID);

    let notConnected = false;
    const render = makeRenderer(status);

    // Claude из чата правит файлы проекта — автообновление подождёт,
    // иначе перезагрузка оборвёт чтение потока и ответ пропадёт
    window.__holdReload?.(true);

    const handle = (event) => {
        // ленту уже очистили под другую сессию — этот запрос дорабатывает
        // на сервере, но в чат больше не пишет
        if (run !== state.chatRun) return;

        if (event.type === 'session') {
            status.innerHTML = '<span class="chat__typing"><span></span><span></span><span></span></span>';

            // id известен сразу — сессия появляется в списке до ответа
            if (event.id !== state.chatSessionId) {
                setChatSessionId(event.id);
                saveProviderState(providerId);
                setRunningSessionId(event.id);
                // окно модели известно сразу — не ждём первого 'context' от CLI,
                // чтобы датчик не висел на «—» весь первый ход новой сессии
                updateContextGauge(0, contextWindowForModel(claude.model));
                if (state.pendingThumb) {
                    const thumb = state.pendingThumb;
                    state.pendingThumb = null;
                    api('/api/sessions/thumb', { id: event.id, thumb }).then(loadSessions);
                } else {
                    loadSessions();
                }
            }
            return;
        }

        // формулировка ошибки идёт от сервера ("Claude не подключён" /
        // "OpenCode не подключён" и т.п.) — ловим по общему признаку,
        // а не по конкретному имени провайдера
        if (event.type === 'error' && typeof event.error === 'string' && event.error.includes('is not connected')) {
            notConnected = true; // повторим после восстановления окружения
            return;
        }

        if (event.type === 'rate_limit') {
            updateClaudeUsage(event.info);
            return;
        }

        if (event.type === 'context') {
            updateContextGauge(event.percent, event.window);
            return;
        }

        render(event);
    };

    const ask = () => streamAsk({
        agent: providerId,
        prompt: text,
        model: claude.model,
        effort: claude.effort,
        sessionId: state.chatSessionId,
        mode,
    }, handle);

    try {
        await ask();

        // сервер перезапустился и забыл окружение — восстановим и повторим
        if (notConnected) {
            notConnected = false;
            const restored = await restoreServerConnection(providerId);
            if (restored) await ask();
            if (!restored || notConnected) {
                addMessage(`${provider ? provider.name : 'Provider'} is not connected. Open Settings and connect again.`, 'error');
            }
        }
    } catch (err) {
        addMessage(`Failed to get a response: ${err.message}`, 'error');
    } finally {
        window.__holdReload?.(false);
        setRunningSessionId(null);
        status.remove();
        if (run === state.chatRun) {
            setComposerBusy(false);
            state.chatInput.focus();
        }
    }
}
