// История Hermes → наша лента сессии.
//
// Свою переписку Hermes ведёт сам, и в ней больше, чем проходит через его поток
// событий: тексты модели между вызовами, размышления, пометки сжатия контекста,
// работа помощников (delegate_task — у каждого своя дочерняя сессия), ходы,
// пришедшие мимо нас (его дашборд, API, расписание). Поток сессии отдаёт только
// старт и конец инструментов верхнего уровня, поэтому всё остальное лента
// получает отсюда — двумя путями, но одним разбором (DOCS/decisions/039):
//
// - rebuild — сразу после нашего хода: строки хода, записанные вживую по
//   потоку, заменяются тем, что Hermes записал на самом деле, в его порядке;
// - sync — перед показом сессии: добираем всё, чего у нас ещё нет (ходы мимо
//   нас, помощники, досчитавшие после конца хода).
//
// Курсор — id сообщения Hermes: он монотонный и сквозной для всех его сессий,
// на каждой перенесённой строке остаётся в extra_meta, оттуда и читается. У
// помощника курсор свой (строки с hermesChildSession). У сессии, которую вели
// до появления отметок, порогом служит время последней нашей записи, иначе
// первый же проход задвоил бы всю переписку.
//
// Модуль ничего не знает ни про HTTP-сервер, ни про схему базы: и то и другое
// приходит снаружи (server.js), поэтому разбор проверяется без запуска сервера.

const PAGE = 200;
const TIMEOUT_MS = 15_000;

// пометка, которой мост claude-bridge подписывает то, что сделал с ответом
// модели сам (переспросил, поднял таймаут, выбросил вызов): она едет в поле
// размышлений, потому что другого канала от моста до ленты через Hermes нет
const BRIDGE_NOTE = /^\[claude-bridge\]\s*(.+)$/;

// текст сообщения: строкой или списком частей (у Hermes встречается и то и то)
function contentText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content.map((part) => (typeof part === 'string' ? part : part?.text || '')).filter(Boolean).join('\n');
    }
    return content == null ? '' : JSON.stringify(content);
}

// вызовы из строки assistant: id вызова → имя и аргументы. Результат приходит
// отдельным сообщением роли tool и ссылается на этот же id
function callsById(message) {
    const calls = new Map();
    let raw = message.tool_calls;
    if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { raw = null; } }
    for (const call of Array.isArray(raw) ? raw : []) {
        const fn = call.function || call;
        let args = fn.arguments ?? call.arguments;
        if (typeof args === 'string') { try { args = JSON.parse(args); } catch { /* оставляем строкой */ } }
        const id = String(call.id || call.call_id || fn.name || '');
        calls.set(id, { name: fn.name || call.name || 'tool', args });
    }
    return calls;
}

// текст, который на самом деле — запрос инструмента по текстовому протоколу
// моста ({"tool_calls": [...]}). Перед объектом модель повторяет то, что стояло
// в конце запроса: подпись «Assistant:» и напоминание о протоколе. Разбирать
// такой ответ и выполнять вызов — дело моста (claude-bridge/tool_protocol.py);
// здесь только распознаём, чтобы сырой объект не ушёл человеку под видом ответа
const RAW_TOOL_CALL_ECHO = /^(?:\s*(?:Assistant|Model)\s*:|\s*\[\s*Protocol reminder\b[^\n]*\])+/i;
function isRawToolCall(text) {
    const body = String(text || '').replace(RAW_TOOL_CALL_ECHO, '').trimStart();
    // обёртка с ключом tool_calls — и голый список вызовов без неё: модель
    // пишет и так, и так (сессия hermes-docker-mtqy9nps встала именно на списке)
    return /^\{\s*"tool_calls"\s*:/.test(body) || /^\[\s*\{\s*"name"\s*:/.test(body);
}

// размышление модели и пометки моста в нём — порознь
function splitReasoning(text) {
    const notes = [];
    const thought = [];
    for (const line of String(text || '').split(/\r?\n/)) {
        const note = line.trim().match(BRIDGE_NOTE);
        if (note) notes.push(note[1]);
        else thought.push(line);
    }
    return { thought: thought.join('\n').trim(), notes };
}

// ошибкой считаем то, что сам инструмент так пометил в своём JSON-ответе
function isToolFailure(content) {
    try {
        const parsed = JSON.parse(content);
        return parsed?.success === false || Boolean(parsed?.error);
    } catch {
        return false;
    }
}

const COMPACTION_TEXT = 'Hermes сжал контекст: ранние ходы сессии заменены пересказом, '
    + 'дальше модель работает с пересказом, а не с полной историей';

// Что именно дописать в ленту: чистое преобразование истории Hermes в список
// строк. Ничего не пишет и в сеть не ходит.
//
// messages — история Hermes по возрастанию id; cursor — id последнего уже
// перенесённого сообщения (null, если отметок нет); sinceMs — время последней
// нашей записи, запасной порог для такой сессии. nudgeText — поправка, которую
// наш сервер сам шлёт модели (автоповтор): это не слова человека, а событие хода.
function planEntries(messages, { cursor = null, sinceMs = NaN, nudgeText = null } = {}) {
    const isNew = (m) => (cursor !== null
        ? Number(m.id) > Number(cursor)
        : !Number.isFinite(sinceMs) || Number(m.timestamp) * 1000 > sinceMs);

    const plan = [];
    let calls = new Map();
    let callAt = null;
    let compactionShown = false;
    for (const m of messages || []) {
        if (m.role === 'assistant') {
            const own = callsById(m);
            if (own.size) { calls = own; callAt = Number(m.timestamp) || null; }
        }
        if (!isNew(m)) continue;

        const text = contentText(m.content);
        const at = Number(m.timestamp) ? new Date(Number(m.timestamp) * 1000).toISOString() : new Date().toISOString();
        const hermesMessageId = Number(m.id) || null;
        const notice = (name, noticeText) => plan.push({ kind: 'notice', name, text: noticeText, at, hermesMessageId });

        // сжатие контекста: Hermes отдаёт пересказ пустой скрытой строкой
        // (display_kind hidden) — иногда парой user+assistant, пометка одна
        if (m.display_kind === 'hidden') {
            if (!compactionShown) notice('hermes.compaction', COMPACTION_TEXT);
            compactionShown = true;
            continue;
        }
        compactionShown = false;

        if (m.role === 'user') {
            if (m.display_kind === 'async_delegation_complete') notice('hermes.async-delegation', text);
            else if (nudgeText && text.trim() === nudgeText.trim()) notice('server.retry-nudge', `Сервер попросил модель переоформить вызов инструмента: ${text}`);
            else plan.push({ kind: 'user', text, at, hermesMessageId });
        } else if (m.role === 'assistant') {
            // размышление модели: у Hermes оно лежит своим полем рядом с ответом;
            // в нём же едут пометки моста — их показываем отдельными строками
            const reasoning = m.reasoning_content || m.reasoning || '';
            const { thought, notes } = splitReasoning(typeof reasoning === 'string' ? reasoning : '');
            for (const note of notes) notice('claude-bridge', note);
            if (thought) plan.push({ kind: 'thinking', text: thought, at, hermesMessageId });
            // строка ассистента без текста — это только заявка на инструменты;
            // сам шаг покажет строка его результата, дубля не заводим
            if (!text.trim()) continue;
            if (isRawToolCall(text)) {
                notice('hermes.raw-tool-call', `Модель написала вызов инструмента текстом, и он не был выполнен:\n${text}`);
            } else {
                plan.push({ kind: 'assistant', text, at, hermesMessageId });
            }
        } else if (m.role === 'tool') {
            const toolCallId = String(m.tool_call_id || '');
            const call = calls.get(toolCallId) || {};
            plan.push({
                kind: 'tool',
                name: m.tool_name || call.name || 'tool',
                args: call.args ?? null,
                result: text,
                failed: isToolFailure(text),
                toolCallId: toolCallId || null,
                callAt,
                at,
                hermesMessageId,
            });
        }
    }
    return plan;
}

// К какому вызову delegate_task относится дочерняя сессия помощника: к
// последнему такому вызову, заявленному не позже её старта. Id вызова
// (tool_call_id) и становится parent_tool_use_id строк помощника — так же
// вложены шаги субагентов у Claude.
// Вызова может уже не быть в выдаче: Hermes убирает из истории то, что
// поглотило сжатие контекста, — тогда null, и строки помощника остаются
// подписанными своей сессией (hermesChildSession), без привязки к шагу.
function parentCallFor(child, delegateSteps) {
    const started = Number(child.started_at) || 0;
    let match = null;
    for (const step of delegateSteps) {
        if (step.toolCallId && (Number(step.callAt) || 0) <= started) match = step;
    }
    return match?.toolCallId || null;
}

// вся история сессии Hermes, постранично
async function fetchMessages(request, base, hermesId) {
    const all = [];
    for (let offset = 0; ; offset += PAGE) {
        const url = `${base}/api/sessions/${encodeURIComponent(hermesId)}/messages`
            + `?order=oldest&limit=${PAGE}&offset=${offset}`;
        const page = await request(url, { method: 'GET', timeoutMs: TIMEOUT_MS });
        const rows = Array.isArray(page?.data) ? page.data : [];
        all.push(...rows);
        if (rows.length < PAGE) return all;
    }
}

// дочерние сессии помощников этой сессии (source=subagent, parent_session_id)
async function fetchChildSessions(request, base, hermesId) {
    const url = `${base}/api/sessions?source=subagent&include_children=true&limit=200`;
    const page = await request(url, { method: 'GET', timeoutMs: TIMEOUT_MS });
    const rows = Array.isArray(page?.data) ? page.data : [];
    return rows
        .filter((s) => s.parent_session_id === hermesId)
        .sort((a, b) => (Number(a.started_at) || 0) - (Number(b.started_at) || 0));
}

// сессии Hermes верхнего уровня — для переноса начатых не из интерфейса
async function fetchTopSessions(request, base) {
    const all = [];
    for (let offset = 0; offset < 2000; offset += PAGE) {
        const page = await request(`${base}/api/sessions?limit=${PAGE}&offset=${offset}`, { method: 'GET', timeoutMs: TIMEOUT_MS });
        const rows = Array.isArray(page?.data) ? page.data : [];
        all.push(...rows);
        if (!page?.has_more || !rows.length) break;
    }
    return all.filter((s) => s.source !== 'subagent' && !s.parent_session_id);
}

// deps: request — запрос к Hermes (hermesRequest), store — доступ к нашей базе,
// log — куда жаловаться. store:
//   cursor(sessionId) / childCursor(sessionId, childId) — id последнего перенесённого
//   lastMessageTime(sessionId) — запасной порог
//   append(sessionId, entry, { parentToolUseId, childSession, model }) → позиция
//   truncate(sessionId, fromPosition) — убрать строки хода, записанные по потоку
//   touch(sessionId)
function createHermesHistory({ request, store, log = () => {} }) {
    // строки помощников: для каждой дочерней сессии — всё новое после её курсора
    async function syncChildren(sessionId, hermesId, base, parentMessages, { model } = {}) {
        let children;
        try {
            children = await fetchChildSessions(request, base, hermesId);
        } catch (err) {
            log(`hermes subagent sessions unavailable for ${sessionId}: ${err.message}`);
            return [];
        }
        if (!children.length) return [];
        const delegateSteps = planEntries(parentMessages).filter((e) => e.kind === 'tool' && e.name === 'delegate_task');
        const added = [];
        for (const child of children) {
            let messages;
            try {
                messages = await fetchMessages(request, base, child.id);
            } catch (err) {
                log(`hermes subagent history failed for ${child.id}: ${err.message}`);
                continue;
            }
            const cursor = store.childCursor(sessionId, child.id);
            const parentToolUseId = parentCallFor(child, delegateSteps);
            // первое сообщение помощника — поставленная ему задача, а не слова человека
            const plan = planEntries(messages, { cursor }).map((entry) => (entry.kind === 'user'
                ? { ...entry, kind: 'notice', name: 'hermes.subagent-task', text: `Задача помощнику: ${entry.text}` }
                : entry));
            for (const entry of plan) {
                entry.position = store.append(sessionId, entry, { parentToolUseId, childSession: child.id, model });
                entry.parentToolUseId = parentToolUseId;
                added.push(entry);
            }
        }
        return added;
    }

    // Добрать всё, чего у нас нет. Недоступный Hermes не считается ошибкой:
    // открытие сессии в чате не должно зависеть от того, поднят ли контейнер.
    async function sync(sessionId, hermesId, base) {
        if (!sessionId || !hermesId) return 0;
        let messages;
        try {
            messages = await fetchMessages(request, base, hermesId);
        } catch (err) {
            log(`hermes history sync failed for ${sessionId}: ${err.message}`);
            return 0;
        }
        const plan = planEntries(messages, {
            cursor: store.cursor(sessionId),
            sinceMs: store.lastMessageTime(sessionId),
        });
        for (const entry of plan) store.append(sessionId, entry, {});
        const children = await syncChildren(sessionId, hermesId, base, messages);
        const total = plan.length + children.length;
        if (total) store.touch(sessionId);
        return total;
    }

    // Пересобрать строки только что закончившегося хода по истории Hermes.
    // sentText — то, что ушло модели первым сообщением хода: с него ход у Hermes
    // и начинается. Не нашли его (Hermes недоступен, история другая) — null, и
    // строки, записанные по потоку, остаются как есть.
    //
    // liveThoughts — размышления, записанные по потоку: { text, toolsBefore, at }.
    // liveToolCount — сколько шагов мы уже записали по потоку. Если сжатие
    // контекста случилось посреди хода, часть его шагов из выдачи Hermes уже
    // пропала: заменять ими записанное нельзя — тогда строки хода остаются, а
    // дописываются только пометки (partial), которых в потоке не было.
    async function rebuild(sessionId, hermesId, base, { fromPosition, sentText, nudgeText, model, liveToolCount = 0, liveThoughts = [] }) {
        let messages;
        try {
            messages = await fetchMessages(request, base, hermesId);
        } catch (err) {
            log(`hermes turn rebuild failed for ${sessionId}: ${err.message}`);
            return null;
        }
        let start = -1;
        for (let i = messages.length - 1; i >= 0; i--) {
            const m = messages[i];
            if (m.role === 'user' && contentText(m.content).trim() === String(sentText || '').trim()) { start = i; break; }
        }
        if (start < 0) return null;

        // вызовы, заявленные до начала хода, не нужны: ход начинается с вопроса
        const plan = planEntries(messages.slice(start + 1), { nudgeText });
        const partial = plan.filter((e) => e.kind === 'tool').length < liveToolCount;
        // размышление, показанное вживую, Hermes в историю кладёт не всегда
        // (reasoning_content у сообщения пуст) — тогда пересборка стирала его
        // вместе со строками потока. Возвращаем на место: перед тем вызовом,
        // перед которым оно прозвучало
        if (!partial && liveThoughts.length && !plan.some((e) => e.kind === 'thinking')) {
            for (const thought of [...liveThoughts].reverse()) {
                let seen = 0;
                let at = plan.findIndex((e) => e.kind === 'tool' && seen++ === thought.toolsBefore);
                if (at < 0) at = plan.findIndex((e, i) => e.kind === 'assistant' && !plan.slice(i + 1).some((x) => x.kind === 'tool'));
                if (at < 0) at = plan.length;
                plan.splice(at, 0, { kind: 'thinking', text: thought.text, at: thought.at, live: true });
            }
        }
        // автоповтор сервер уже записал сам, когда отправлял его, — второй раз не нужен
        const kept = partial ? plan.filter((e) => e.kind === 'notice' && e.name !== 'server.retry-nudge') : plan;
        if (!partial) store.truncate(sessionId, fromPosition);
        for (const entry of kept) entry.position = store.append(sessionId, entry, { model });
        const children = await syncChildren(sessionId, hermesId, base, messages, { model });
        return { entries: kept, children, partial };
    }

    // Шаги помощников, которые уже есть у Hermes, — только чтобы показать их
    // вживую, пока ход идёт (его поток про помощников молчит). В базу не пишет:
    // строки хода целиком запишет rebuild.
    async function peekChildren(hermesId, base) {
        const children = await fetchChildSessions(request, base, hermesId);
        const out = [];
        for (const child of children) {
            const messages = await fetchMessages(request, base, child.id);
            for (const entry of planEntries(messages)) out.push({ ...entry, childSession: child.id });
        }
        return out;
    }

    return { sync, rebuild, peekChildren };
}

module.exports = {
    createHermesHistory, planEntries, contentText, callsById, isRawToolCall,
    splitReasoning, parentCallFor, fetchTopSessions,
};
