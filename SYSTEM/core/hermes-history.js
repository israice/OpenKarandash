// Дотягивание истории Hermes в нашу ленту.
//
// Свою переписку Hermes ведёт сам, и ход в его сессию может прийти не от нас:
// из его дашборда, по его собственному API, из задания по расписанию. Такой ход
// в нашей ленте не появлялся вовсе — сервер пишет только то, что прошло через
// него, — и пользователь видел обрывок работы вместо целого разговора. Поэтому
// перед показом сессии мы добираем у Hermes всё, чего у нас нет.
//
// Курсор — id сообщения Hermes: он монотонный и на каждой добранной строке
// остаётся в extra_meta, оттуда и читается в следующий раз. У сессии, которую
// вели до появления этого дотягивания, отметок нет: там порогом служит время
// последней нашей записи, иначе первый же проход задвоил бы всю переписку.
//
// Модуль ничего не знает ни про HTTP, ни про схему базы: и то и другое приходит
// снаружи (server.js), поэтому разбор истории проверяется без запуска сервера.

const PAGE = 200;
const TIMEOUT_MS = 15_000;

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

// Что именно дописать в ленту: чистое преобразование истории Hermes в список
// действий. Ничего не пишет и в сеть не ходит — его и проверяет тест.
//
// messages — история Hermes по возрастанию id; cursor — id последнего уже
// перенесённого сообщения (null, если отметок нет); sinceMs — время последней
// нашей записи, запасной порог для такой сессии.
function planEntries(messages, { cursor = null, sinceMs = NaN } = {}) {
    const isNew = (m) => (cursor !== null
        ? Number(m.id) > Number(cursor)
        : !Number.isFinite(sinceMs) || Number(m.timestamp) * 1000 > sinceMs);

    const plan = [];
    let calls = new Map();
    for (const m of messages || []) {
        if (m.role === 'assistant') {
            const own = callsById(m);
            if (own.size) calls = own;
        }
        if (!isNew(m)) continue;

        const text = contentText(m.content);
        const at = Number(m.timestamp) ? new Date(Number(m.timestamp) * 1000).toISOString() : new Date().toISOString();
        const hermesMessageId = Number(m.id) || null;

        if (m.role === 'user') {
            plan.push({ kind: 'user', text, at, hermesMessageId });
        } else if (m.role === 'assistant') {
            // размышление модели: у Hermes оно лежит своим полем рядом с ответом
            const reasoning = m.reasoning_content || m.reasoning || '';
            if (typeof reasoning === 'string' && reasoning.trim()) {
                plan.push({ kind: 'thinking', text: reasoning, at, hermesMessageId });
            }
            // строка ассистента без текста — это только заявка на инструменты;
            // сам шаг покажет строка его результата, дубля не заводим
            if (text.trim()) plan.push({ kind: 'assistant', text, at, hermesMessageId, model: m.model || null });
        } else if (m.role === 'tool') {
            const call = calls.get(String(m.tool_call_id || '')) || {};
            plan.push({
                kind: 'tool',
                name: m.tool_name || call.name || 'tool',
                args: call.args ?? null,
                result: text,
                at,
                hermesMessageId,
            });
        }
    }
    return plan;
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

// deps: request — запрос к Hermes (hermesRequest), store — доступ к нашей базе
// (cursor/lastMessageTime/append/touch), log — куда жаловаться.
// Возвращает sync(sessionId, hermesId, base) → сколько строк добрано.
// Недоступный Hermes не считается ошибкой: открытие сессии в чате не должно
// зависеть от того, поднят ли сейчас контейнер.
function createHermesHistory({ request, store, log = () => {} }) {
    return async function sync(sessionId, hermesId, base) {
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
        for (const entry of plan) store.append(sessionId, entry);
        if (plan.length) store.touch(sessionId);
        return plan.length;
    };
}

module.exports = { createHermesHistory, planEntries, contentText, callsById };
