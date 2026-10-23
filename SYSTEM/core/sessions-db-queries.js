// Заготовленные запросы к базе сессий: чтение сессий и сообщений, правка полей строки, удаление. Схему (файл, таблицы, миграции) готовит sessions-db-schema.js, функции записи событий лежат в sessions-db-records.js — здесь только SQL и удаление, без истории про то, кто и зачем пишет.

function createQueries(db) {
const upsertSession = db.prepare(`
    INSERT INTO sessions (id, title, updated_at, target)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
        updated_at = excluded.updated_at,
        title = CASE WHEN sessions.title = 'New session' THEN excluded.title ELSE sessions.title END,
        target = COALESCE(sessions.target, excluded.target)
`);

const getSessionTarget = db.prepare('SELECT target FROM sessions WHERE id = ?');

// id этой сессии внутри конкретного CLI — им и только им можно продолжать
const getCliSession = db.prepare('SELECT cli_session_id AS id FROM session_cli WHERE session_id = ? AND target = ?');
const setCliSession = db.prepare(`
    INSERT INTO session_cli (session_id, target, cli_session_id) VALUES (?, ?, ?)
    ON CONFLICT(session_id, target) DO UPDATE SET cli_session_id = excluded.cli_session_id
`);

const upsertMessage = db.prepare(`
    INSERT INTO messages (session_id, position, role, text, created_at, model, effort)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id, position) DO NOTHING
`);

// usage/cost/duration CLI присылает только раз на весь ход (событие result),
// а не на отдельный вызов инструмента — поэтому это отдельный UPDATE поверх
// уже вставленной строки ответа, а не поле в upsertMessage
const setMessageUsage = db.prepare(`
    UPDATE messages
    SET input_tokens = ?, output_tokens = ?, cache_read_tokens = ?, cache_creation_tokens = ?, cost_usd = ?, duration_ms = ?
    WHERE session_id = ? AND position = ?
`);
// имя инструмента — отдельной колонкой, а не только первым словом text: клиенту
// (Flow) нужно название узла как структурные данные, а не парсинг строки статуса
const setMessageToolCall = db.prepare('UPDATE messages SET tool_name = ?, tool_input = ? WHERE session_id = ? AND position = ?');
const setMessageToolResult = db.prepare('UPDATE messages SET tool_result = ?, tool_error = ?, tool_result_images = ? WHERE session_id = ? AND position = ?');
const setMessageToolIds = db.prepare('UPDATE messages SET tool_use_id = ?, parent_tool_use_id = ? WHERE session_id = ? AND position = ?');
const setMessageStopReason = db.prepare('UPDATE messages SET stop_reason = ? WHERE session_id = ? AND position = ?');
const setMessageMode = db.prepare('UPDATE messages SET mode = ? WHERE session_id = ? AND position = ?');
const setMessageInputSent = db.prepare('UPDATE messages SET input_sent = ? WHERE session_id = ? AND position = ?');
const setMessageResultMeta = db.prepare('UPDATE messages SET result_meta = ? WHERE session_id = ? AND position = ?');
const setMessageExtraMeta = db.prepare('UPDATE messages SET extra_meta = ? WHERE session_id = ? AND position = ?');
const setMessageOrigin = db.prepare('UPDATE messages SET source = ?, actor = ?, event_type = ?, provider = ? WHERE session_id = ? AND position = ?');
const setMessageRaw = db.prepare('UPDATE messages SET raw = ? WHERE session_id = ? AND position = ?');
const getMessageRaw = db.prepare('SELECT raw FROM messages WHERE session_id = ? AND position = ?');

const touchSession = db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?');
const setSessionThumb = db.prepare('UPDATE sessions SET thumb = ? WHERE id = ?');
const setSessionContext = db.prepare('UPDATE sessions SET context_percent = ?, context_window = ? WHERE id = ?');
const setSessionInfo = db.prepare('UPDATE sessions SET session_info = ? WHERE id = ?');
const setSessionRateLimit = db.prepare('UPDATE sessions SET rate_limit = ? WHERE id = ?');
const setDesktop = db.prepare(`
    UPDATE sessions SET desktop_session_id = ?, desktop_status = ?, desktop_url = ?,
        repository = ?, branch = ?, base_branch = ?, last_commit = ?, sync_status = ?, desktop_error = ?
    WHERE id = ?
`);
const getDesktop = db.prepare(`
    SELECT desktop_session_id AS desktopSessionId, desktop_status AS desktopStatus,
        desktop_url AS desktopUrl, repository, branch, base_branch AS baseBranch,
        last_commit AS lastCommit, sync_status AS syncStatus, desktop_error AS desktopError
    FROM sessions WHERE id = ?
`);
const getStandbyDesktop = db.prepare(`
    SELECT desktop_session_id AS id, desktop_url AS url
    FROM desktop_standby WHERE slot = 1
`);
const setStandbyDesktop = db.prepare(`
    INSERT INTO desktop_standby (slot, desktop_session_id, desktop_url)
    VALUES (1, ?, ?)
    ON CONFLICT(slot) DO UPDATE SET
        desktop_session_id = excluded.desktop_session_id,
        desktop_url = excluded.desktop_url
`);
const claimStandbyDesktop = db.prepare('DELETE FROM desktop_standby WHERE slot = 1 AND desktop_session_id = ?');
const clearStandbyDesktop = db.prepare('DELETE FROM desktop_standby WHERE slot = 1');
const setMessageCreatedAt = db.prepare('UPDATE messages SET created_at = ? WHERE session_id = ? AND position = ?');
const lastMessageTime = db.prepare('SELECT MAX(created_at) AS at FROM messages WHERE session_id = ?');

// Превью здесь нужно только как «есть или нет»: байты отдаёт
// /api/image/session-thumb, а строки data-URL в ответе /api/sessions/messages
// ездили заново при каждом перечитывании ленты (DOCS/decisions/091)
const getSessionMeta = db.prepare('SELECT context_percent AS contextPercent, context_window AS contextWindow, session_info AS sessionInfo, rate_limit AS rateLimit, target, thumb IS NOT NULL AS hasThumb, desktop_session_id AS desktopSessionId, desktop_status AS desktopStatus, desktop_url AS desktopUrl, repository, branch, base_branch AS baseBranch, last_commit AS lastCommit, sync_status AS syncStatus, desktop_error AS desktopError FROM sessions WHERE id = ?');

const getSessionTitle = db.prepare('SELECT title FROM sessions WHERE id = ?');

// чем сессия шла в прошлый раз: ход, начатый не из браузера (ответ в Telegram),
// берёт модель, effort и режим оттуда — своих настроек у такого хода нет
const getLastTurnParams = db.prepare(`
    SELECT model, effort, mode FROM messages
    WHERE session_id = ? AND role = 'user' ORDER BY position DESC LIMIT 1
`);

// Превью в списке нужно только как «есть или нет»: сами байты отдаёт
// /api/image/session-thumb отдельным адресом, и браузер берёт их из кэша.
// В сводке thumb ездил строкой data-URL на каждую сессию, а список опрашивается
// каждые 5 секунд — за минуту простоя вкладка Sessions принимала почти 10 МБ
// одних превью (DOCS/decisions/091)
const listSessions = db.prepare(`
    SELECT s.id, s.title, s.updated_at AS updatedAt, s.thumb IS NOT NULL AS hasThumb,
           s.desktop_status AS desktopStatus, s.desktop_url AS desktopUrl,
           s.rowid AS createdOrder,
           (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id AND m.role NOT IN ('tool', 'thinking', 'hook', 'system', 'unknown', 'top_level')) AS messageCount
    FROM sessions s
    ORDER BY s.updated_at DESC
`);

const getSessionThumb = db.prepare('SELECT thumb FROM sessions WHERE id = ?');

const listMessages = db.prepare(`
    SELECT position, role, text, created_at AS createdAt, model, effort,
           input_tokens AS inputTokens, output_tokens AS outputTokens,
           cache_read_tokens AS cacheReadTokens, cache_creation_tokens AS cacheCreationTokens,
           cost_usd AS costUsd, duration_ms AS durationMs,
           tool_name AS toolName, tool_input AS toolInput, tool_result AS toolResult, tool_error AS toolError,
           tool_result_images AS toolResultImages,
           tool_use_id AS toolUseId, parent_tool_use_id AS parentToolUseId, stop_reason AS stopReason,
           mode, input_sent AS inputSent, result_meta AS resultMeta, extra_meta AS extraMeta,
           source, actor, event_type AS eventType, task_id AS taskId, attempt_id AS attemptId, provider, raw
    FROM messages WHERE session_id = ? ORDER BY position
`);

// Сессии, где последний ход просит человека вмешаться: суждение о ходе уже
// посчитано и лежит в result_meta (DOCS/decisions/051), но до v0.0.52 никуда
// не вело — его видно было только в самой ленте. Шкала нужна ровно затем,
// чтобы на главной было видно, чем заняться (DOCS/decisions/055).
//
// Считаем по последней строке модели в каждой сессии: более ранние ходы этой
// же сессии человек либо уже разобрал, либо они и привели к последнему.
//
// Условий два, и прямой вопрос к человеку здесь главнее шкалы. Замер на живом
// ходе: ход, остановившийся с уточняющим вопросом, дал awaitsHuman 0.96, а по
// шкале важности всего 1.14 при уверенности ноль — то есть шкала на таком ходе
// сама себе не верит, и один порог по ней пропускал бы ровно те сессии, ради
// которых счётчик и заведён
const countNeedsAttention = db.prepare(`
    SELECT COUNT(*) AS n FROM (
        SELECT m.session_id,
               json_extract(m.result_meta, '$.judgment.needsAttention') AS attention,
               json_extract(m.result_meta, '$.judgment.awaitsHuman') AS waits,
               ROW_NUMBER() OVER (PARTITION BY m.session_id ORDER BY m.position DESC) AS rn
        FROM messages m
        WHERE m.role = 'assistant' AND m.result_meta IS NOT NULL
    ) WHERE rn = 1 AND (waits >= ? OR attention >= ?)
`);

// сводка по сессии целиком — сколько токенов/денег/времени она стоила разом,
// без пересчёта по сообщениям на клиенте (Flow, панель сессий)
const sumSessionUsage = db.prepare(`
    SELECT COALESCE(SUM(input_tokens), 0) AS inputTokens,
           COALESCE(SUM(output_tokens), 0) AS outputTokens,
           COALESCE(SUM(cache_read_tokens), 0) AS cacheReadTokens,
           COALESCE(SUM(cache_creation_tokens), 0) AS cacheCreationTokens,
           COALESCE(SUM(cost_usd), 0) AS costUsd,
           COALESCE(SUM(duration_ms), 0) AS durationMs
    FROM messages WHERE session_id = ?
`);

const countMessages = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE session_id = ?');

// шаги инструментов этого хода: всё, что записано после строки с вопросом
// человека. Нужен для сверки отчёта с делом (DOCS/decisions/056)
const listToolSteps = db.prepare("SELECT text FROM messages WHERE session_id = ? AND position > ? AND role = 'tool' ORDER BY position");
const countToolSteps = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE session_id = ? AND position > ? AND role = 'tool'");

// правка собственной реплики на графе Flow (см. DOCS/decisions/018): роль проверяем
// отдельным запросом, потому что менять разрешено только строку пользователя
const getMessageRole = db.prepare('SELECT role FROM messages WHERE session_id = ? AND position = ?');
const setMessageText = db.prepare('UPDATE messages SET text = ? WHERE session_id = ? AND position = ?');

// очистка списка: база пустеет. файлы истории CLI на хосте не трогаем — они не наши,
// и по уцелевшим связям сессия завелась бы заново, уже без нас
function resetSessions() {
    db.exec('DELETE FROM messages; DELETE FROM sessions; DELETE FROM session_cli;');
}

const deleteMessagesBySession = db.prepare('DELETE FROM messages WHERE session_id = ?');
const deleteSessionById = db.prepare('DELETE FROM sessions WHERE id = ?');
const deleteCliLinksBySession = db.prepare('DELETE FROM session_cli WHERE session_id = ?');

function deleteSession(id) {
    deleteMessagesBySession.run(id);
    deleteSessionById.run(id);
    // см. resetSessions: без этого открытие удалённой сессии по id возвращало её строки
    deleteCliLinksBySession.run(id);
}

return {
    upsertSession, getSessionTarget, getCliSession, setCliSession,
    upsertMessage, setMessageUsage, setMessageToolCall, setMessageToolResult, setMessageToolIds,
    setMessageStopReason, setMessageMode, setMessageInputSent, setMessageResultMeta, setMessageExtraMeta,
    setMessageOrigin, setMessageRaw, getMessageRaw,
    touchSession, setSessionThumb, setSessionContext, setSessionInfo, setSessionRateLimit,
    setDesktop, getDesktop, getStandbyDesktop, setStandbyDesktop, claimStandbyDesktop, clearStandbyDesktop,
    setMessageCreatedAt, lastMessageTime, getSessionMeta, getSessionTitle, getLastTurnParams,
    listSessions, getSessionThumb, listMessages, countNeedsAttention, sumSessionUsage, countMessages,
    listToolSteps, countToolSteps, getMessageRole, setMessageText,
    resetSessions, deleteMessagesBySession, deleteSessionById, deleteCliLinksBySession, deleteSession,
};
}

module.exports = { createQueries };
