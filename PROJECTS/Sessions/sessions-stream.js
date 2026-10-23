// Ход: события потока → строки ленты. Здесь решается, что делать с событием;
// само чтение потока и досматривание обрывов — в sessions-ndjson.js, показ
// истории из базы — в sessions-history.js.
//
// Открытие сессии (openSession) лежит здесь, а не в sessions-panel.js: оно
// досматривает живой поток уже идущей работы, а поток зависит от этого файла —
// иначе модули импортировали бы друг друга по кругу.
import { state, PENDING_SESSION_ID } from './sessions-state.js';
import {
    isNearBottom, scrollToBottom, addStep, addThinking, addMessage, thinkingText,
    addPending, markPendingActivity, removePending, addInterrupted,
} from './sessions-feed.js';
import { renderStored, isTurnUnfinished } from './sessions-history.js';
import { streamAsk, followRun } from './sessions-ndjson.js';
import { api, closeModal, restoreServerConnection, ensureConnected } from '../../SYSTEM/app.js';
import {
    providerById, connections, saveProviderState, saveAllProviderStates,
    updateContextGauge, contextWindowForModel,
} from '../../SYSTEM/providers.js';
import { getActiveProviderId, getActiveModel, getActiveEffort } from '../../SYSTEM/session-model-bar.js';
import { setSessionId, setRunningSessionId, setComposerBusy, loadSessions } from './sessions-panel.js';

// ---------- события в ленту ----------

// Чем продолжается ход, который не дошёл до ответа. Словами человека и по
// правилам проекта: работа не выкинута, её надо доделать, проверить и сдать
// отчётом — поэтому «продолжить» здесь означает «доделай», а не «ответь ещё
// раз». Тот же текст идёт и в кнопку плашки, и в кнопку под лимитом.
const CONTINUE_TEXT = 'Продолжай работу с того места, где она остановилась. Доделай задание до конца, проверь результат так, как велит AGENTS.override.md, и только потом дай итоговый ответ.';

// Режим последнего хода сессии: продолжение должно идти в том же, а не
// всегда в Action (в Chat у CLI ограничен набор инструментов, и работа,
// оборвавшаяся в Chat, продолжилась бы с полным набором — то есть не так,
// как её начинали)
function modeOfLastTurn(messages) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        if (messages[i].role === 'user' && messages[i].mode) return messages[i].mode;
    }
    return 'Action';
}

// Отрисовка событий потока — одна и та же для своего запроса и для
// подключения к работе, которая уже идёт. model — та модель, которой пойдёт
// ход, cli — тот же выбор из шапки сессии, первым уровнем пути: ею
// подписываются ответы, пока стримятся (после хода лента перечитывается из
// базы, и подпись у каждой строки своя — из её полей model и source)
function makeRenderer(status, model, cli) {
    let answered = false;

    // черновик: текст или размышление, которое модель ещё набирает. Сервер
    // шлёт его кусками (событие delta), а следом — целое сообщение обычным
    // событием; поэтому любое другое событие черновик снимает, и на его месте
    // встаёт настоящая строка. В базе черновика нет — Feed и Flow его не видят
    let draft = null; // { kind, text, node }
    const dropDraft = () => {
        draft?.node.remove();
        draft = null;
    };

    return (event) => {
        if (event.type === 'delta') {
            if (draft && draft.kind !== event.kind) dropDraft();
            const stick = isNearBottom();
            if (!draft) {
                const node = event.kind === 'thinking'
                    ? addThinking('', status)
                    : addMessage('', 'assistant', null, status);
                node.classList.add('chat-message--draft');
                // мысли, уже собранные в блок, — начало набора: первый кусок
                // потока дополняет блок, а не заменяет его (thinkingText)
                draft = { kind: event.kind, text: event.kind === 'thinking' ? thinkingText() : '', node };
            }
            draft.text += event.text;
            // мысли идут кусками только у CLI, которые шлют поток: набор идёт
            // в тот же блок, что и целый текст, а ответ — в свой узел
            if (event.kind === 'thinking') addThinking(draft.text, status);
            else draft.node.textContent = draft.text;
            markPendingActivity(status);
            if (stick) scrollToBottom();
            return;
        }

        dropDraft();

        if (event.type === 'tool') {
            // каждое действие остаётся своей строкой в ленте, а не заменяет
            // предыдущую
            addStep(`${event.name} ${event.detail}`.trim(), status);
            markPendingActivity(status); // пауза до следующего шага считается заново
        } else if (event.type === 'notice') {
            // событие хода, а не ответ: сервер переспросил модель, помощнику
            // поставлена задача — строкой шага, как вызовы
            addStep(`${event.name} ${event.text}`, status);
            markPendingActivity(status);
        } else if (event.type === 'thinking') {
            // текст рассуждения, а не просто отметка, что оно было
            addThinking(event.text, status);
            markPendingActivity(status);
        } else if (event.type === 'text') {
            answered = true;
            markPendingActivity(status);
            addMessage(event.text, 'assistant', model, status, cli);
        } else if (event.type === 'error') {
            addMessage(event.error, 'error');
        } else if (event.type === 'done') {
            if (!answered && event.text) addMessage(event.text, 'assistant', model, null, cli);
            loadSessions(); // в списке обновилось число сообщений
        }
    };
}

// ---------- открытие сессии ----------

// Переключение на другую сессию: показываем её переписку и продолжаем её же
export async function openSession(id, running = false) {
    MissionFiles?.closeFilePanel(); // могла быть открыта панель редактирования файла
    setSessionId(id); // отсюда же уходит черновик новой сессии, если он был
    saveAllProviderStates();

    state.run += 1;
    state.list.innerHTML = '';

    const { messages = [], contextPercent = null, contextWindow = null, liveSeq = null } = await api('/api/sessions/messages', { id });
    for (const message of messages) renderStored(message);

    updateContextGauge(contextPercent, contextWindow);

    // работа ещё идёт (страницу перезагрузили посреди неё) — досматриваем вживую
    if (running) {
        setRunningSessionId(id);
        // liveSeq — событие, до которого эти строки уже дочитаны: поток
        // продолжится ровно с него, и то, что случилось между чтением базы и
        // подключением, не пропадёт
        attachSession(id, state.run, liveSeq);
        return;
    }

    // ход, который не дошёл до ответа: последней осталась строка шага или сам
    // вопрос. Ждать нечего — работа уже не идёт, поэтому предлагаем продолжить
    if (isTurnUnfinished(messages)) {
        addInterrupted(() => sendTurn(CONTINUE_TEXT, modeOfLastTurn(messages)));
    }
}

export async function attachSession(id, run, after = null) {
    let status = null;
    let render = null;

    const attached = await followRun(id, after, (event) => {
        if (event.type === 'context') { updateContextGauge(event.percent, event.window); return; }
        if (run === state.run) render(event);
    }, () => {
        status = addPending();
        setComposerBusy(true);
        // модель для подписи ответов — та, что выбрана в шапке сессии: своих
        // настроек у чужого идущего хода нет (как и у хода из телеграма)
        render = makeRenderer(status, getActiveModel(), getActiveProviderId());
        // как и в sendTurn: пока довоспроизводим чужой поток, автообновление
        // подождёт, иначе очередной dev-reload оборвёт чтение раньше, чем
        // страница успеет его показать
        window.__holdReload?.(true);
    }).catch(() => status !== null);

    if (!attached) {
        setRunningSessionId(null);
        loadSessions();
        return;
    }

    window.__holdReload?.(false);
    removePending(status);
    setRunningSessionId(null);
    if (run === state.run) {
        setComposerBusy(false);
        await reloadFromStore(id, run);
    }
}

// После хода лента перечитывается из базы: во время хода она собиралась из
// событий потока, а сервер дописывает в базу то, чего в потоке не было (шаги,
// размышления, пометки). Иначе Sessions показывал бы не то, что Feed и Flow
async function reloadFromStore(id, run) {
    if (!id || id === PENDING_SESSION_ID) return;

    let messages;
    try {
        ({ messages = [] } = await api('/api/sessions/messages', { id }));
    } catch { return; }

    if (run !== state.run || state.sessionId !== id) return;

    const stick = isNearBottom();
    const scroll = state.messages.scrollTop;
    state.list.innerHTML = '';
    for (const message of messages) renderStored(message);

    // Ход, который не дошёл до ответа (оборвался, или у него кончился дневной
    // лимит модели), получает кнопку продолжения сразу — под последней строкой,
    // а не при следующем открытии сессии: раньше плашка появлялась только в
    // openSession, и после хода её не было видно вовсе, пока человек не закроет
    // и не откроет сессию заново. Смена источника модели делается в строке над
    // сессией, кнопка зовёт новый ход — то есть ровно то, что нужно после
    // лимита (PROJECTS/Sessions/README.md)
    if (isTurnUnfinished(messages)) {
        addInterrupted(() => sendTurn(CONTINUE_TEXT, modeOfLastTurn(messages)));
    }

    // человек читал выше — оставляем его на месте, а не выдёргиваем вниз
    if (stick) scrollToBottom();
    else state.messages.scrollTop = scroll;
}

// ---------- отправка хода ----------

export async function sendTurn(text, mode = 'Action') {
    const run = ++state.run;

    // Провайдер, модель и глубина размышления — из строки выбора в шапке
    // сессии, и больше ниоткуда (SYSTEM/session-model-bar.js). Это единственный
    // источник: раньше модель бралась из состояния подключения
    // (providerState.model), и после перезагрузки страницы или смены CLI в
    // шапке ход уходил не туда, куда показывал выбор — то есть работали
    // «другие модели» (решение владельца 2026-10-03).
    //
    // Читаем строку до подключения: подключение дозапрашивает каталог моделей и
    // перерисовывает строку, а перерисовка не имеет права изменить то, что
    // человек уже выбрал к этому моменту
    const providerId = getActiveProviderId();
    const provider = providerById(providerId);
    // Ход идёт ровно тем, что выбрано в строке над сессией. Если строка не
    // нарисована или в ней не выбрано — хода нет: подставлять вместо выбора
    // что-то другое (дефолт проекта, состояние подключения, первую модель
    // каталога) нельзя, потому что тогда человек читает одну настройку, а
    // работает другая. Лучше сказать прямо и ждать выбора
    const model = getActiveModel();
    const effort = getActiveEffort();
    if (!providerId || !model) {
        addMessage('Choose a CLI and a model in the row above the chat.', 'error');
        return;
    }
    addMessage(text, 'user');

    const status = addPending();
    setComposerBusy(true);
    setRunningSessionId(state.sessionId || PENDING_SESSION_ID);

    // CLI detection/connect can take several seconds. Show the submitted message
    // and pending state first so setup latency never looks like a lost send.
    let providerState;
    let setupError;
    try {
        providerState = await ensureConnected(providerId);
    } catch (error) {
        setupError = `${provider ? provider.name : providerId} setup failed: ${error.message}`;
    }
    if (setupError || !providerState) {
        if (run === state.run) {
            addMessage(setupError || `${provider ? provider.name : providerId} is not available. Check that the CLI is installed, or set its path in the environment variable.`, 'error');
            setRunningSessionId(null);
            removePending(status);
            setComposerBusy(false);
            state.input.focus();
        }
        return;
    }
    if (run !== state.run) {
        removePending(status);
        return;
    }

    // ход дошёл до сервера целиком? только тогда ленту сверяем с базой — ошибка
    // соединения живёт лишь в ленте, и перечитывание стёрло бы её
    let reachedServer = false;
    // сервер забыл окружение и просит переподключиться — тогда повторяем ход
    let notConnected = false;
    // подпись ответов — моделью, которой реально уйдёт этот ход (та же model,
    // что уходит в теле запроса), а не той, что случайно выбрана в шапке позже
    const render = makeRenderer(status, model, providerId);

    // агент из чата правит файлы проекта — автообновление подождёт, иначе
    // перезагрузка оборвёт чтение потока и ответ пропадёт
    window.__holdReload?.(true);

    // для продолжения после обрыва связи: id идущего хода, номер последнего
    // увиденного события и признак, что ход дошёл до своего 'done'
    let liveId = null;
    let lastSeq = null;
    let finished = false;

    const handle = (event) => {
        if (typeof event.seq === 'number') lastSeq = event.seq;
        if (event.type === 'session') liveId = event.id;
        if (event.type === 'done') finished = true;

        // ленту уже очистили под другую сессию — этот запрос дорабатывает
        // на сервере, но в чат больше не пишет
        if (run !== state.run) return;

        if (event.type === 'session') {
            status.innerHTML = '<span class="chat-typing"><span></span><span></span><span></span></span>';

            // id известен сразу — сессия появляется в списке до ответа
            if (event.id !== state.sessionId) {
                setSessionId(event.id);
                saveProviderState(providerId);
                setRunningSessionId(event.id);

                // новая сессия из Karandash появилась — открытые окна
                // (настройки, версии, файл) больше не нужны; окно подтверждения
                // (modal--top) живёт своим циклом и не трогается
                if (state.closeModalsOnSession) {
                    state.closeModalsOnSession = false;
                    for (const m of document.querySelectorAll('.modal:not([hidden]):not(.modal--top)')) closeModal(m);
                }

                // окно модели известно сразу — не ждём первого 'context' от CLI,
                // чтобы датчик не висел на «—» весь первый ход новой сессии
                updateContextGauge(0, contextWindowForModel(model));

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

        // формулировка ошибки идёт от сервера ("pi is not connected" и
        // т.п.) — ловим по общему признаку, а не по конкретному имени провайдера
        if (event.type === 'error' && typeof event.error === 'string' && event.error.includes('is not connected')) {
            notConnected = true; // повторим после восстановления окружения
            return;
        }

        if (event.type === 'context') {
            updateContextGauge(event.percent, event.window);
            return;
        }

        render(event);
    };

    const askOnce = () => streamAsk({
        agent: providerId,
        prompt: text,
        model,
        effort,
        sessionId: state.sessionId,
        mode,
    }, handle);

    // Поток ответа мог оборваться, а ход на сервере продолжается: досматриваем
    // его через attach с места обрыва, а не объявляем ошибку
    // (DOCS/decisions/046)
    const ask = async () => {
        liveId = null; lastSeq = null; finished = false;
        try {
            await askOnce();
        } catch (err) {
            if (!liveId) throw err; // до сервера не дошло — продолжать нечего
        }
        if (liveId && !finished) await followRun(liveId, lastSeq, handle);
    };

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
        reachedServer = !notConnected;
    } catch (err) {
        addMessage(`Failed to get a response: ${err.message}`, 'error');
    } finally {
        window.__holdReload?.(false);
        setRunningSessionId(null);
        removePending(status);
        if (run === state.run) {
            setComposerBusy(false);
            state.input.focus();
            if (reachedServer) await reloadFromStore(state.sessionId, run);
        }
    }
}