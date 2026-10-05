// Запись событий хода в ленту: строки ответа, шаги инструментов, хуки, рассуждения, пометки сервера и всё, что не разобрано. Схему и миграции делает sessions-db-schema.js, SQL-заготовки лежат в sessions-db-queries.js, а сюда они приходят аргументом: правила Event Schema (source/actor/event_type/raw, DOCS/decisions/040) читаются только в этом файле.

function createRecords({ queries, agentNameByTarget }) {
const {
    upsertSession, upsertMessage, setMessageUsage, setMessageToolCall, setMessageToolResult, setMessageToolIds,
    setMessageStopReason, setMessageMode, setMessageResultMeta, setMessageExtraMeta, setMessageOrigin,
    setMessageRaw, getMessageRaw, getSessionTarget, countMessages, touchSession,
} = queries;
// потолок на tool_input/tool_result/thinking: без лимита один Bash с гигантским
// выводом раздул бы .sessions.db, но значение выбрано так, чтобы обычные ответы
// инструментов не резались вовсе
const DETAIL_CLIP_LEN = 50000;
function clip(text) {
    if (typeof text !== 'string') return text;
    return text.length > DETAIL_CLIP_LEN ? text.slice(0, DETAIL_CLIP_LEN) + '…' : text;
}

// у сырого события своя граница, и она выше: смысл raw в том, чтобы к событию
// можно было вернуться, когда наш разбор окажется неполным, а обрезка по общей
// границе как раз и лишила бы нас этой возможности. Совсем без границы нельзя:
// один ответ с большим файлом иначе кладёт в базу десятки мегабайт. Обрезанное
// помечаем явно, чтобы позже не принять усечённое событие за целое
const RAW_CLIP_LEN = 400000;
function clipRaw(value) {
    let text;
    try {
        text = typeof value === 'string' ? value : JSON.stringify(value);
    } catch {
        return null; // циклическая ссылка в событии — лучше без raw, чем упавший ход
    }
    if (typeof text !== 'string') return null;
    if (text.length <= RAW_CLIP_LEN) return text;
    return JSON.stringify({ rawTruncated: true, originalLength: text.length, head: text.slice(0, RAW_CLIP_LEN) });
}

// tool_result приходит как строка либо как массив блоков (text/image/…) —
// картинки и прочее нетекстовое просто помечаем именем типа
function toolResultText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content.map((part) => (part.type === 'text' ? part.text : `[${part.type}]`)).join('\n');
    }
    return '';
}

// картинки из tool_result (скриншоты Playwright/Chrome DevTools и т.п.): в тексте
// шага от них остаётся метка «[image]», а сами байты лежат здесь —
// как data-URL, тем же способом, что и sessions.thumb (см. THUMB_RE
// ниже), с тем же лимитом на картинку — иначе один шаг с несколькими большими
// скриншотами раздул бы .sessions.db
const MAX_TOOL_IMAGE_BYTES = 300 * 1024;
const MAX_TOOL_IMAGES_PER_RESULT = 6;
function toolResultImages(content) {
    if (!Array.isArray(content)) return null;
    const images = [];
    for (const part of content) {
        if (images.length >= MAX_TOOL_IMAGES_PER_RESULT) break;
        if (part.type !== 'image' || !part.source || part.source.type !== 'base64') continue;
        const { media_type: mediaType, data } = part.source;
        if (!mediaType || typeof data !== 'string' || data.length > MAX_TOOL_IMAGE_BYTES) continue;
        images.push(`data:${mediaType};base64,${data}`);
    }
    return images.length ? JSON.stringify(images) : null;
}

// ---------- запись сообщений из чата ----------

// вопрос записываем сразу, как CLI сообщил id: сессия появляется в списке
// в начале работы, а не после ответа. Возвращает позицию строки — вызывающий
// код дописывает сюда же mode/input_sent
// ---------- Event Schema: кто прислал строку и что это было ----------
// Одно место на все виды записи (DOCS/decisions/040): если заполнять поля
// в каждой функции отдельно, они разойдутся при первой же правке.
//
// source и provider выводятся из цели: id окружения начинается с имени
// коннектора (agentNameByTarget), а сама цель и есть провайдер. Старые строки
// остаются пустыми намеренно: пусто значит «не знаем», а не догадка, и
// дозаполнять их задним числом мы не стали.
function originOfTarget(targetId) {
    const target = targetId || null;
    return { source: target ? agentNameByTarget(target) : null, provider: target };
}

// Запасной источник для мест, которые ход не ведут и цели не знают: сама
// сессия. Своими строками ход источник не берёт — он передаёт свой (origin
// ниже), потому что сессию можно продолжить любым CLI, а колонка target в
// sessions при смене CLI не перебивается: отсюда отвечал прежний исполнитель на
// ход, который вёл новый (в ленте, в Feed и в Flow ответ подписывался чужим
// именем — DOCS/decisions/043)
function originForSession(sessionId) {
    return originOfTarget(getSessionTarget.get(sessionId)?.target);
}

// eventType — что произошло по протоколу, рядом с role, а не вместо неё:
// role говорит интерфейсу, как рисовать строку, и её читают Chat, Feed и Flow.
// Неизвестный вид события пишется как есть и не отбрасывается (DOCS/decisions/012).
function stampEvent(sessionId, position, eventType, actor, origin) {
    const { source, provider } = origin || originForSession(sessionId);
    setMessageOrigin.run(source || null, actor || null, eventType || null, provider || null, sessionId, position);
}

// исходное событие рядом с разобранным (DOCS/decisions/040, этап 2 плана).
// Нужно затем, что разбор всегда отстаёт от источника: новый вид события у
// новой модели попадёт в готовые колонки не целиком, и без raw утраченное уже
// не вернуть. Пишется у строк всех ролей, а не только у неразобранных
function stampRaw(sessionId, position, raw) {
    if (raw === undefined || raw === null || position === null || position === undefined) return;
    const text = clipRaw(raw);
    if (text) setMessageRaw.run(text, sessionId, position);
}

// второе исходное событие той же строки: шаг инструмента собирается из вызова
// и результата, хук — из запуска и ответа, итоговая реплика — из текста и
// итога хода. Затирать первое нельзя, поэтому строка получает оба:
// { rawEvents: [первое, второе, …] }. Ключ нарочно не похож на поля источников,
// чтобы склейку нельзя было спутать с самим событием
function appendRaw(sessionId, position, raw) {
    if (raw === undefined || raw === null || position === null || position === undefined) return;
    const prev = getMessageRaw.get(sessionId, position)?.raw;
    if (!prev) return stampRaw(sessionId, position, raw);
    let parsed;
    try {
        parsed = JSON.parse(prev);
    } catch {
        parsed = prev; // raw был строкой, а не JSON — кладём как есть
    }
    const events = Array.isArray(parsed?.rawEvents) ? parsed.rawEvents : [parsed];
    stampRaw(sessionId, position, { rawEvents: [...events, raw] });
}

// id подзадачи и попытки приходят от оркестратора — своих не выдумываем.
function startExchange(sessionId, question, target, model, effort) {
    upsertSession.run(sessionId, extractTitle(question, 300), new Date().toISOString(), target || null);
    const position = countMessages.get(sessionId).n;
    upsertMessage.run(sessionId, position, 'user', question, new Date().toISOString(), model || null, effort || null);
    // вопрос задал человек — источник не зависит от того, каким CLI пойдёт ход
    stampEvent(sessionId, position, 'text', 'human', { source: 'user', provider: target || null });
    return position;
}

// тема сессии: режим комментариев кладёт в вопрос «Элемент интерфейса… Комментарий: …»,
// и настоящее намерение — именно текст комментария
function extractTitle(raw, maxLen) {
    const text = String(raw || '').trim();
    const comment = text.match(/(?:Comment|Комментарий):\s*([\s\S]+)/);
    const line = (comment ? comment[1] : text).split(/\r?\n/)[0].trim();
    return line.slice(0, maxLen) || 'No subject';
}

function sessionTitle(session) {
    // 80 символов подходили под старую фиксированную панель 210px — при
    // ресайзе (sidebar-resize.js) в две строки реально влезает больше, а
    // сервер обрезал текст ещё до браузера, так что расширение панели ничего
    // не добавляло. -webkit-line-clamp сам подрежет визуально и добавит «…»,
    // поэтому здесь достаточно щедрого запаса, а не точного расчёта под ширину
    return extractTitle(session.title, 240);
}

// шаги работы (вызовы инструментов) хранятся вместе с перепиской,
// иначе при открытии сессии от них не остаётся следа. text — по-прежнему
// «Bash grep -n ...» для строки статуса чата (короткая, режется в toolLabel());
// toolName/toolInput — те же данные структурно и без обрезки в 120 символов,
// ими пользуется Flow, чтобы показать на ноде название инструмента и реальную
// команду, а не общее слово «Шаг». Возвращаем позицию, чтобы вызывающий код
// мог позже дописать сюда же tool_result (он приходит отдельным событием)
function recordStep(sessionId, text, toolName, toolInput, toolUseId, parentToolUseId, caller, raw, origin) {
    const position = countMessages.get(sessionId).n;
    upsertMessage.run(sessionId, position, 'tool', text, new Date().toISOString(), null, null);
    setMessageToolCall.run(toolName || null, toolInput !== undefined ? clip(JSON.stringify(toolInput)) : null, sessionId, position);
    if (toolUseId || parentToolUseId) setMessageToolIds.run(toolUseId || null, parentToolUseId || null, sessionId, position);
    // caller — {"type":"direct"} у обычного вызова, отличает прямой вызов
    // от вызова изнутри субагента; не кладём в toolInput — Flow читает
    // tool_input как есть (sessionFacts в PROJECTS/Flow/flow-session-node.js разбирает его
    // как JSON вызова), и обёртка сломала бы вывод
    if (caller) setMessageExtraMeta.run(JSON.stringify({ caller }), sessionId, position);
    stampEvent(sessionId, position, 'tool.call', parentToolUseId ? 'subagent' : 'tool', origin);
    stampRaw(sessionId, position, raw);
    return position;
}

// вывод хука (SessionStart/PreToolUse/PostToolUse/…) — своя строка роли 'hook',
// использует те же tool_name/tool_input/tool_result, что и обычные шаги
// (см. комментарий у hookPositions выше). hook_started создаёт строку,
// hook_response тем же hook_id дописывает результат — recordHookResponse
function recordHookStart(sessionId, event) {
    const position = countMessages.get(sessionId).n;
    const label = [event.hook_name, event.hook_event].filter(Boolean).join(' · ') || 'hook';
    upsertMessage.run(sessionId, position, 'hook', label, new Date().toISOString(), null, null);
    setMessageToolCall.run(
        event.hook_name || null,
        clip(JSON.stringify({ hookId: event.hook_id || null, hookEvent: event.hook_event || null })),
        sessionId, position,
    );
    // хук — не модель и не инструмент модели: его запустила сама среда CLI
    stampEvent(sessionId, position, 'hook.run', 'tool');
    stampRaw(sessionId, position, event);
    return position;
}

function recordHookResponse(sessionId, position, event) {
    const text = clip([
        event.stdout || null,
        event.output && event.output !== event.stdout ? event.output : null,
        event.stderr ? `[stderr]\n${event.stderr}` : null,
    ].filter(Boolean).join('\n\n'));
    setMessageToolResult.run(text || null, event.exit_code ? 1 : 0, null, sessionId, position);
    appendRaw(sessionId, position, event);
}

// рассуждения модели (блоки thinking) — отдельной строкой в той же таблице, рядом со шагами
// Возвращает позицию строки — на неё ссылается лента
function recordThinking(sessionId, text, signature, raw, origin) {
    const position = countMessages.get(sessionId).n;
    upsertMessage.run(sessionId, position, 'thinking', clip(text), new Date().toISOString(), null, null);
    // signature (600-2348 символов) — крипто-подпись блока для API, не читаемый
    // текст; храним факт и длину, не саму строку
    if (signature) setMessageExtraMeta.run(JSON.stringify({ signaturePresent: true, signatureLength: signature.length }), sessionId, position);
    stampEvent(sessionId, position, 'thinking', 'model', origin);
    stampRaw(sessionId, position, raw);
    return position;
}

// текстовый кусок ответа — своя строка на каждое событие 'text' (за один ход
// модель может выдать текст несколько раз подряд, чередуя с вызовами
// инструментов); parentToolUseId — как у recordStep, отличает текст субагента
// (Task) от текста верхнего уровня. Возвращаем позицию — finishExchange
// дописывает на неё usage/stopReason/mode, а не вставляет ещё одну строку
function recordAssistantText(sessionId, text, model, effort, parentToolUseId, raw, origin) {
    const position = countMessages.get(sessionId).n;
    upsertMessage.run(sessionId, position, 'assistant', text, new Date().toISOString(), model || null, effort || null);
    if (parentToolUseId) setMessageToolIds.run(null, parentToolUseId, sessionId, position);
    stampEvent(sessionId, position, 'text', parentToolUseId ? 'subagent' : 'model', origin);
    stampRaw(sessionId, position, raw);
    return position;
}

// событие хода, которое не слова человека и не ответ модели: сервер сам
// переспросил модель, помощнику поставлена задача. Роль system — как у
// неразобранных системных событий CLI; name — откуда пометка (tool_name),
// text — что произошло, словами
function recordNotice(sessionId, name, text, parentToolUseId, raw, origin) {
    const position = countMessages.get(sessionId).n;
    upsertMessage.run(sessionId, position, 'system', clip(text), new Date().toISOString(), null, null);
    setMessageToolCall.run(name || null, clip(JSON.stringify({ notice: name, text })), sessionId, position);
    if (parentToolUseId) setMessageToolIds.run(null, parentToolUseId, sessionId, position);
    // у пометки источник виден по её имени и не совпадает с целью хода:
    // ход ведёт агент, а действие за него — наш сервер
    const from = noticeOrigin(name, sessionId, origin);
    stampEvent(sessionId, position, 'notice', from.actor, from);
    stampRaw(sessionId, position, raw);
    return position;
}

// откуда пришла пометка хода. Имена задаются на месте вызова recordNotice;
// незнакомое имя не выдумываем, а берём источником тот же, что у хода
function noticeOrigin(name, sessionId, origin) {
    const prefix = String(name || '').split('.')[0];
    if (prefix === 'server') return { source: 'server', provider: null, actor: 'server' };
    return { ...(origin || originForSession(sessionId)), actor: null };
}

// перехватчик для частей ответа с типом, который сервер явно не разбирает:
// WebSearch/WebFetch идут обычным tool_use, но CLI может прислать и что-то ещё
// (см. DOCS/decisions/012)
function recordUnknownPart(sessionId, part, parentToolUseId) {
    const position = countMessages.get(sessionId).n;
    upsertMessage.run(sessionId, position, 'unknown', part.type || 'unknown', new Date().toISOString(), null, null);
    setMessageToolCall.run(part.type || null, clip(JSON.stringify(part)), sessionId, position);
    if (parentToolUseId) setMessageToolIds.run(null, parentToolUseId, sessionId, position);
    // вид события пишется как есть: завтрашний тип у новой модели должен
    // попасть в ленту без правки сервера (DOCS/decisions/012)
    stampEvent(sessionId, position, part.type || 'unknown', parentToolUseId ? 'subagent' : null);
    stampRaw(sessionId, position, part);
    return position;
}

// перехватчик для system-подтипов, которые сервер явно не разбирает (init/
// hook_started/hook_response/thinking_tokens — см. HANDLED_SYSTEM_SUBTYPES);
// такие подтипы реально приходят, например permission_denied
function recordSystemEvent(sessionId, event) {
    const position = countMessages.get(sessionId).n;
    upsertMessage.run(sessionId, position, 'system', event.subtype || 'system', new Date().toISOString(), null, null);
    setMessageToolCall.run(event.subtype || null, clip(JSON.stringify(event)), sessionId, position);
    stampEvent(sessionId, position, event.subtype || 'system', null);
    stampRaw(sessionId, position, event);
    return position;
}

// последний уровень перехвата: верхнеуровневый event.type, для которого нет
// ни одной ветки в onLine (см. HANDLED_TOP_LEVEL_TYPES и DOCS/decisions/012)
function recordTopLevelEvent(sessionId, event) {
    const position = countMessages.get(sessionId).n;
    upsertMessage.run(sessionId, position, 'top_level', event.type || 'unknown', new Date().toISOString(), null, null);
    setMessageToolCall.run(event.type || null, clip(JSON.stringify(event)), sessionId, position);
    stampEvent(sessionId, position, event.type || 'unknown', null);
    stampRaw(sessionId, position, event);
    return position;
}

// usage/cost/duration — только на весь ход (см. setMessageUsage) — приходят
// с CLI в событии result до того, как известна позиция строки ответа, поэтому
// finishExchange принимает их вместе с текстом и сам решает, что записать.
// assistantPosition — если текст уже записан построчно (recordAssistantText),
// новую строку вставлять не нужно, только дописать метаданные хода на неё же
function finishExchange(sessionId, answer, meta = {}) {
    touchSession.run(new Date().toISOString(), sessionId);
    let position = meta.assistantPosition;
    if (position == null) {
        position = countMessages.get(sessionId).n;
        upsertMessage.run(sessionId, position, 'assistant', answer, new Date().toISOString(), meta.model || null, meta.effort || null);
        // строка рождается здесь, мимо recordAssistantText, — без этого она
        // осталась бы единственной без источника и вида события. Текст ошибки
        // хода — тоже реплика модели по форме, её отличает stop_reason.
        // Источник — цель хода (meta.origin): строка ответа принадлежит тому
        // CLI, который её дал, а не тому, что завёл сессию
        stampEvent(sessionId, position, 'text', 'model', meta.origin);
    }
    for (const raw of meta.resultRaws || []) appendRaw(sessionId, position, raw);
    const u = meta.usage || {};
    const hasUsage = u.inputTokens || u.outputTokens || u.cacheReadTokens || u.cacheCreationTokens;
    if (hasUsage || meta.costUsd != null || meta.durationMs != null) {
        setMessageUsage.run(
            u.inputTokens || 0, u.outputTokens || 0, u.cacheReadTokens || 0, u.cacheCreationTokens || 0,
            meta.costUsd ?? null, meta.durationMs ?? null,
            sessionId, position,
        );
    }
    if (meta.stopReason) setMessageStopReason.run(meta.stopReason, sessionId, position);
    if (meta.mode) setMessageMode.run(meta.mode, sessionId, position);
    if (meta.resultMeta) setMessageResultMeta.run(JSON.stringify(meta.resultMeta), sessionId, position);
    return position;
}

return {
    DETAIL_CLIP_LEN, clip, RAW_CLIP_LEN, clipRaw, toolResultText,
    MAX_TOOL_IMAGE_BYTES, MAX_TOOL_IMAGES_PER_RESULT, toolResultImages,
    originOfTarget, originForSession, stampEvent, stampRaw, appendRaw, startExchange,
    extractTitle, sessionTitle, recordStep, recordHookStart, recordHookResponse,
    recordThinking, recordAssistantText, recordNotice, noticeOrigin,
    recordUnknownPart, recordSystemEvent, recordTopLevelEvent, finishExchange,
};
}

module.exports = { createRecords };
