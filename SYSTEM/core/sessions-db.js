// Слой базы сессий: файл SQLite, схема, заготовленные запросы и функции записи
// сообщений в ленту. Вынесено из server.js (DOCS/decisions/022): всё, что
// трогает базу сессий, живёт здесь, а server.js только вызывает open() один
// раз и берёт нужные имена.
//
// Зависимости приходят аргументами, как у createRoutes(deps) у фич: корень
// проекта, имя папки данных, разбор «какой CLI вёл сессию» (таблица AGENTS
// осталась в server.js) и доступ к задачам Hermes. Тело функции не сдвинуто
// вправо намеренно: так перенесённый текст совпадает с прежним построчно, и
// его видно в `git diff --color-moved` без шума от отступов.

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

function open({ ROOT, DATA_DIR, agentNameByTarget, hermesTasks }) {
// ---------- хранилище сессий (SQLite) ----------

// база лежит в DATA, а эту папку слежение за файлами не обходит,
// поэтому правки базы не вызывают перезагрузку страницы
const DB_FILE = path.join(ROOT, DATA_DIR, '.sessions.db');
const db = new DatabaseSync(DB_FILE);
// WAL: чтение не блокирует запись, поэтому сборка карты и поиск не мешают чату.
// busy_timeout: если папку обслуживает второй экземпляр сервера, ждём его
// транзакцию, а не падаем сразу с «database is locked»
db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');

// копия базы перед необратимой правкой схемы. Нужна потому, что ALTER TABLE в
// SQLite не откатывается, а в этом файле лежит вся история работы: вернуться к
// прежнему состоянию можно только из копии. Копируем по метке — имени колонки,
// которой в старой базе ещё нет: как только она появилась, копия больше не
// делается, поэтому каждый следующий запуск ничего не копирует
function backupBeforeSchemaChange(marker) {
    let columns;
    try {
        columns = db.prepare('PRAGMA table_info(messages)').all().map((c) => c.name);
    } catch {
        return; // таблицы ещё нет — база свежая, копировать нечего
    }
    if (!columns.length || columns.includes(marker)) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dir = path.join(ROOT, DATA_DIR, 'backups');
    try {
        fs.mkdirSync(dir, { recursive: true });
        // -wal и -shm копируются вместе с базой: в режиме WAL часть уже
        // записанного лежит в журнале, и копия одного .db окажется старее самой базы
        for (const suffix of ['', '-wal', '-shm']) {
            const from = `${DB_FILE}${suffix}`;
            if (fs.existsSync(from)) fs.copyFileSync(from, path.join(dir, `sessions-${stamp}.db${suffix}`));
        }
        console.log(`База сессий скопирована перед изменением схемы: ${DATA_DIR}/backups/sessions-${stamp}.db`);
    } catch (e) {
        // не смогли скопировать — говорим и не трогаем схему: потерять историю
        // молча хуже, чем не получить новые поля
        console.error(`Не удалось скопировать базу перед изменением схемы: ${e.message}`);
        throw e;
    }
}

db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );

    -- у каждого CLI своя история запусков: id сессии Claude в OpenCode не существует,
    -- а у Windows-claude и WSL-claude разные папки историй. Поэтому наш id сессии
    -- живёт в sessions, а id внутри конкретного CLI — здесь, по одному на цель.
    -- Так переключение исполнителя продолжает ту же переписку, а не упирается в запрет
    CREATE TABLE IF NOT EXISTS session_cli (
        session_id TEXT NOT NULL,
        target TEXT NOT NULL,
        cli_session_id TEXT NOT NULL,
        PRIMARY KEY (session_id, target)
    );

    CREATE TABLE IF NOT EXISTS messages (
        session_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        role TEXT NOT NULL,
        text TEXT NOT NULL,
        PRIMARY KEY (session_id, position)
    );

    -- строки, которые заменила пересборка хода по истории Hermes
    -- (DOCS/decisions/039 и 040). Журнал обязан только дописываться: разбор
    -- истории даёт правильный порядок, но вместе с ним пропадало то, что мы
    -- видели своими глазами во время хода. Теперь замещённое переезжает сюда
    -- целиком, а не исчезает. replaced_at в ключе потому, что одну и ту же
    -- позицию может заместить не одна пересборка
    CREATE TABLE IF NOT EXISTS replaced_messages (
        session_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        replaced_at TEXT NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY (session_id, position, replaced_at)
    );

    -- остаток удалённого оркестратора Hermes (DOCS/decisions/007, отменено 015):
    -- в них никто не пишет, а выглядят как журнал запусков. Настоящий журнал
    -- вызовов инструментов ведёт сам Hermes — см. SYSTEM/core/hermes-tool-runs.js
    DROP TABLE IF EXISTS hermes_tasks;
    DROP TABLE IF EXISTS hermes_runs;
`);

// колонка добавлена уже после первых версий базы — CREATE TABLE IF NOT EXISTS
// её не добавит в старый файл, поэтому дозаводим миграцией и глушим ошибку,
// если она там уже есть
try {
    db.exec('ALTER TABLE sessions ADD COLUMN thumb TEXT');
} catch { /* колонка уже есть */ }

try {
    db.exec('ALTER TABLE sessions ADD COLUMN context_percent INTEGER');
} catch { /* колонка уже есть */ }

try {
    db.exec('ALTER TABLE sessions ADD COLUMN context_window INTEGER');
} catch { /* колонка уже есть */ }

// метаданные сессии, которые CLI присылает только раз — событием system/init
// в самом начале стрима (рабочая папка, доступные инструменты, режим разрешений,
// подключённые MCP-серверы, слэш-команды) — и лимиты подписки (rate_limit_event,
// те же цифры, что показывает /usage): в базе, а не только у живых слушателей
try {
    db.exec('ALTER TABLE sessions ADD COLUMN session_info TEXT');
} catch { /* колонка уже есть */ }
try {
    db.exec('ALTER TABLE sessions ADD COLUMN rate_limit TEXT');
} catch { /* колонка уже есть */ }

// разбор сессии по шагам (Flow, поиск раздувающих контекст мест): время,
// модель/effort запроса и — только на строке ответа, где CLI реально их
// присылает (событие result — на весь ход, а не на отдельный вызов инструмента) —
// потраченные токены/стоимость/длительность. tool_input/tool_result хранятся
// целиком (лимит — clip ниже), а не обрезанными до 120 символов строки статуса,
// чтобы по ним можно было разобрать, что именно сделал шаг
for (const [col, type] of [
    ['created_at', 'TEXT'],
    ['model', 'TEXT'],
    ['effort', 'TEXT'],
    ['input_tokens', 'INTEGER'],
    ['output_tokens', 'INTEGER'],
    ['cache_read_tokens', 'INTEGER'],
    ['cache_creation_tokens', 'INTEGER'],
    ['cost_usd', 'REAL'],
    ['duration_ms', 'INTEGER'],
    ['tool_input', 'TEXT'],
    ['tool_result', 'TEXT'],
    ['tool_result_images', 'TEXT'],
    ['tool_name', 'TEXT'],
    ['tool_error', 'INTEGER'],
    // tool_use_id — id вызова инструмента (part.id из событий assistant/tool_use),
    // parent_tool_use_id — тот же id, но родительского вызова, если этот шаг выполнен
    // внутри субагента (Task): CLI шлёт вложенные шаги в тот же стрим, и только это
    // поле отличает их от шагов верхнего уровня. stop_reason — почему модель остановилась
    // (end_turn/max_tokens/refusal/…), с события assistant.message.stop_reason
    ['tool_use_id', 'TEXT'],
    ['parent_tool_use_id', 'TEXT'],
    ['stop_reason', 'TEXT'],
    // режим хода (Chat/Action) — от него зависит доступный набор инструментов
    // (CHAT_DENIED_TOOLS) и permission-mode CLI; input_sent — то, что реально
    // ушло модели на stdin, если это отличается от text (в Chat перед вопросом
    // приклеивается CHAT_PREAMBLE, см. askClaude)
    ['mode', 'TEXT'],
    ['input_sent', 'TEXT'],
    // всё, что result присылает сверх duration_ms/total_cost_usd/usage (проверено
    // живым тестовым запросом): тайминги до первого токена, отказы в разрешении,
    // статистика субагентов и т.д. — одним JSON, как session_info/rate_limit
    ['result_meta', 'TEXT'],
    // разное по конкретной строке, что не влезает по смыслу в готовые колонки:
    // у tool_use — part.caller (прямой вызов или из субагента), у thinking —
    // факт/длина part.signature (крипто-подпись блока для API, не текст для
    // чтения) — держим одной универсальной JSON-колонкой, а не заводим по
    // колонке на каждое такое поле
    ['extra_meta', 'TEXT'],
    // ---- Event Schema (DOCS/decisions/040) ----
    // общий формат событий: по нему фильтруют ленту и строят сводки, поэтому
    // каждое из этих полей — своя колонка, а не ключ в extra_meta. Разделение
    // с уже имеющимися полями: role — «как рисовать» (его читают Chat, Feed и
    // Flow), event_type — «что произошло» по протоколу; tool_name — имя
    // инструмента, source — кто прислал строку. Заполняет одно место — stampEvent
    ['source', 'TEXT'],
    ['actor', 'TEXT'],
    ['event_type', 'TEXT'],
    // id подзадачи и попытки внутри неё. Рождает их оркестратор, а не мы
    // (DOCS/decisions/040: «завести» читается как «отразить»): сегодня
    // единственный настоящий источник — дочерние сессии помощников Hermes,
    // у строк вне графа задач поля пустые до этапа 9
    ['task_id', 'TEXT'],
    ['attempt_id', 'TEXT'],
    ['provider', 'TEXT'],
    // исходное событие целиком. Колонка заводится здесь, чтобы схема менялась
    // один раз, а заполняется на следующем шаге (этап 2 плана)
    ['raw', 'TEXT'],
]) {
    // ALTER TABLE в SQLite не отменяется, а база — единственное место, где
    // живёт история работы. Поэтому перед первым добавлением полей Event Schema
    // делаем копию: условие срабатывает ровно один раз, дальше колонка уже есть
    if (col === 'source') backupBeforeSchemaChange('source');
    try {
        db.exec(`ALTER TABLE messages ADD COLUMN ${col} ${type}`);
    } catch { /* колонка уже есть */ }
}

// каким CLI начата сессия: у Windows-claude и WSL-claude свои хранилища истории
// (~/.claude/projects/<путь проекта>, а путь к проекту у них разный), поэтому
// «--resume» чужого id всегда возвращает ошибку — см. askClaude
try {
    db.exec('ALTER TABLE sessions ADD COLUMN target TEXT');
} catch { /* колонка уже есть */ }

const upsertSession = db.prepare(`
    INSERT INTO sessions (id, title, updated_at, target)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at
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
const setMessageTaskIds = db.prepare('UPDATE messages SET task_id = ?, attempt_id = ? WHERE session_id = ? AND position = ?');
const setMessageRaw = db.prepare('UPDATE messages SET raw = ? WHERE session_id = ? AND position = ?');
const getMessageRaw = db.prepare('SELECT raw FROM messages WHERE session_id = ? AND position = ?');

const touchSession = db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?');
const setSessionThumb = db.prepare('UPDATE sessions SET thumb = ? WHERE id = ?');
const setSessionContext = db.prepare('UPDATE sessions SET context_percent = ?, context_window = ? WHERE id = ?');
const setSessionInfo = db.prepare('UPDATE sessions SET session_info = ? WHERE id = ?');
const setSessionRateLimit = db.prepare('UPDATE sessions SET rate_limit = ? WHERE id = ?');
// курсор дотягивания истории Hermes (syncHermesHistory): докуда переписка его
// сессии уже перенесена к нам. У сессий старше этого механизма отметок нет —
// там порогом служит время последней нашей записи
// Строки помощников (hermesChildSession) в курсор сессии не входят: id у
// Hermes сквозные, и помощник, досчитавший позже, сдвинул бы курсор родителя
// дальше его собственных ещё не перенесённых сообщений
const hermesSyncCursor = db.prepare(`
    SELECT MAX(CAST(json_extract(extra_meta, '$.hermesMessageId') AS INTEGER)) AS id
    FROM messages WHERE session_id = ? AND json_extract(extra_meta, '$.hermesChildSession') IS NULL
`);
const hermesChildCursor = db.prepare(`
    SELECT MAX(CAST(json_extract(extra_meta, '$.hermesMessageId') AS INTEGER)) AS id
    FROM messages WHERE session_id = ? AND json_extract(extra_meta, '$.hermesChildSession') = ?
`);
// есть ли у сессии Hermes наша связь — в том числе у удалённой у нас сессии
const hasCliSessionLink = db.prepare('SELECT 1 AS yes FROM session_cli WHERE cli_session_id = ? LIMIT 1');
// пересборка хода Hermes: строки хода, записанные по потоку, уходят целиком
const deleteMessagesFrom = db.prepare('DELETE FROM messages WHERE session_id = ? AND position >= ?');
// то, что пересборка собирается заместить, — забираем целиком до удаления
const selectMessagesFrom = db.prepare('SELECT * FROM messages WHERE session_id = ? AND position >= ? ORDER BY position');
const archiveMessage = db.prepare('INSERT OR REPLACE INTO replaced_messages (session_id, position, replaced_at, payload) VALUES (?, ?, ?, ?)');
const deleteArchiveBySession = db.prepare('DELETE FROM replaced_messages WHERE session_id = ?');
const countArchive = db.prepare('SELECT COUNT(*) AS n FROM replaced_messages WHERE session_id = ?');

// пересборка хода по истории Hermes меняет разобранный слой, но не имеет права
// стирать наблюдение: то, что пришло потоком, мы видели своими глазами, а
// история может оказаться короче (сжатие контекста) или лечь иначе. Поэтому
// замещаемые строки переезжают в архив целиком, включая их сырое событие,
// и только потом удаляются из ленты (DOCS/decisions/040)
function archiveAndDeleteFrom(sessionId, fromPosition) {
    const rows = selectMessagesFrom.all(sessionId, fromPosition);
    if (rows.length) {
        const at = new Date().toISOString();
        for (const row of rows) archiveMessage.run(sessionId, row.position, at, JSON.stringify(row));
    }
    deleteMessagesFrom.run(sessionId, fromPosition);
    return rows.length;
}
const setMessageCreatedAt = db.prepare('UPDATE messages SET created_at = ? WHERE session_id = ? AND position = ?');
const lastMessageTime = db.prepare('SELECT MAX(created_at) AS at FROM messages WHERE session_id = ?');

const getSessionMeta = db.prepare('SELECT context_percent AS contextPercent, context_window AS contextWindow, session_info AS sessionInfo, rate_limit AS rateLimit, target, thumb FROM sessions WHERE id = ?');

const getSessionTitle = db.prepare('SELECT title FROM sessions WHERE id = ?');

// чем сессия шла в прошлый раз: ход, начатый не из браузера (ответ в Telegram),
// берёт модель, effort и режим оттуда — своих настроек у такого хода нет
const getLastTurnParams = db.prepare(`
    SELECT model, effort, mode FROM messages
    WHERE session_id = ? AND role = 'user' ORDER BY position DESC LIMIT 1
`);

const listSessions = db.prepare(`
    SELECT s.id, s.title, s.updated_at AS updatedAt, s.thumb AS thumb,
           s.rowid AS createdOrder,
           (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id AND m.role NOT IN ('tool', 'thinking', 'hook', 'system', 'unknown', 'top_level')) AS messageCount
    FROM sessions s
    ORDER BY s.updated_at DESC
`);

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

// очистка списка: база пустеет. файлы истории Claude CLI не трогаем — они не наши
function resetSessions() {
    // архив замещённых строк — часть истории этих же сессий: очистка списка
    // не должна оставлять от них хвост, который уже не с чем сопоставить
    // и связи с сессиями CLI: по уцелевшей связи удалённая сессия заново
    // втягивалась из истории Hermes — строками без записи в sessions
    db.exec('DELETE FROM messages; DELETE FROM sessions; DELETE FROM replaced_messages; DELETE FROM session_cli;');
}

const deleteMessagesBySession = db.prepare('DELETE FROM messages WHERE session_id = ?');
const deleteSessionById = db.prepare('DELETE FROM sessions WHERE id = ?');
const deleteCliLinksBySession = db.prepare('DELETE FROM session_cli WHERE session_id = ?');

function deleteSession(id) {
    deleteMessagesBySession.run(id);
    deleteArchiveBySession.run(id);
    deleteSessionById.run(id);
    // см. resetSessions: без этого открытие удалённой сессии по id возвращало её строки
    deleteCliLinksBySession.run(id);
}

// ---------- запись сообщений из чата ----------

// вопрос записываем сразу, как CLI сообщил id: сессия появляется в списке
// в начале работы, а не после ответа. Возвращает позицию строки — вызывающий
// код дописывает сюда же mode/input_sent (см. askClaude)
// ---------- Event Schema: кто прислал строку и что это было ----------
// Одно место на все виды записи (DOCS/decisions/040): если заполнять поля
// в каждой функции отдельно, они разойдутся при первой же правке.
//
// source и provider выводятся из цели сессии: id окружения начинается с имени
// коннектора (agentNameByTarget), а сама цель и есть провайдер — wsl/windows
// у прямого CLI. Старые строки остаются пустыми намеренно: пусто значит
// «не знаем», а не «claude», и дозаполнять их задним числом мы не стали.
function originForSession(sessionId) {
    const target = getSessionTarget.get(sessionId)?.target || null;
    return { source: target ? agentNameByTarget(target) : null, provider: target };
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
// Пока графа задач нет, зовётся только оттуда, где источник настоящий
// Номер попытки на строках помощника: task_id у них — дочерняя сессия Hermes,
// а какая это по счёту попытка той же цели, знает журнал его поручений
// (SYSTEM/core/hermes-tasks.js). Пишем `номер:id поручения` — номер для глаз,
// id — чтобы найти запись у Hermes. Источник один, поэтому попытку видят сразу
// Sessions, Feed и Flow: все три читают поле из базы
const setAttemptByTask = db.prepare('UPDATE messages SET attempt_id = ? WHERE session_id = ? AND task_id = ? AND attempt_id IS NOT ?');
const hasUnstampedTask = db.prepare('SELECT 1 FROM messages WHERE session_id = ? AND task_id IS NOT NULL AND attempt_id IS NULL LIMIT 1');
function stampHermesAttempts(sessionId, hermesId) {
    // журнал читается с копии базы Hermes — не трогаем его, пока нечего помечать
    if (!hasUnstampedTask.get(sessionId)) return;
    try {
        for (const d of hermesTasks.readDelegations({ parent: hermesId })) {
            if (!d.childSession) continue;
            const value = `${d.attempt}:${d.delegationId}`;
            setAttemptByTask.run(value, sessionId, d.childSession, value);
        }
    } catch (err) {
        // журнал поручений — чужая база: её отсутствие или смена схемы не должны ронять ход
        console.error(`hermes attempts unavailable for ${sessionId}: ${err.message}`);
    }
}

function stampTask(sessionId, position, taskId, attemptId) {
    if (!taskId && !attemptId) return;
    setMessageTaskIds.run(taskId || null, attemptId || null, sessionId, position);
}

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
function recordStep(sessionId, text, toolName, toolInput, toolUseId, parentToolUseId, caller, raw) {
    const position = countMessages.get(sessionId).n;
    upsertMessage.run(sessionId, position, 'tool', text, new Date().toISOString(), null, null);
    setMessageToolCall.run(toolName || null, toolInput !== undefined ? clip(JSON.stringify(toolInput)) : null, sessionId, position);
    if (toolUseId || parentToolUseId) setMessageToolIds.run(toolUseId || null, parentToolUseId || null, sessionId, position);
    // caller — {"type":"direct"} у обычного вызова, отличает прямой вызов
    // от вызова изнутри субагента; не кладём в toolInput — Flow читает
    // tool_input как есть (sessionFacts в PROJECTS/Flow/flow.js разбирает его
    // как JSON вызова), и обёртка сломала бы вывод
    if (caller) setMessageExtraMeta.run(JSON.stringify({ caller }), sessionId, position);
    stampEvent(sessionId, position, 'tool.call', parentToolUseId ? 'subagent' : 'tool');
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

// рассуждения модели (блоки thinking) — отдельной строкой в той же таблице, рядом с шагами
// Возвращает позицию строки — дотягивание истории (syncHermesHistory) ставит
// на неё отметку о происхождении, как и на остальные добранные строки
function recordThinking(sessionId, text, signature, raw) {
    const position = countMessages.get(sessionId).n;
    upsertMessage.run(sessionId, position, 'thinking', clip(text), new Date().toISOString(), null, null);
    // signature (600-2348 символов) — крипто-подпись блока для API, не читаемый
    // текст; храним факт и длину, не саму строку
    if (signature) setMessageExtraMeta.run(JSON.stringify({ signaturePresent: true, signatureLength: signature.length }), sessionId, position);
    stampEvent(sessionId, position, 'thinking', 'model');
    stampRaw(sessionId, position, raw);
    return position;
}

// текстовый кусок ответа — своя строка на каждое событие 'text' (за один ход
// модель может выдать текст несколько раз подряд, чередуя с вызовами
// инструментов); parentToolUseId — как у recordStep, отличает текст субагента
// (Task) от текста верхнего уровня. Возвращаем позицию — finishExchange
// дописывает на неё usage/stopReason/mode, а не вставляет ещё одну строку
function recordAssistantText(sessionId, text, model, effort, parentToolUseId, raw) {
    const position = countMessages.get(sessionId).n;
    upsertMessage.run(sessionId, position, 'assistant', text, new Date().toISOString(), model || null, effort || null);
    if (parentToolUseId) setMessageToolIds.run(null, parentToolUseId, sessionId, position);
    stampEvent(sessionId, position, 'text', parentToolUseId ? 'subagent' : 'model');
    stampRaw(sessionId, position, raw);
    return position;
}

// событие хода, которое не слова человека и не ответ модели: сервер сам
// переспросил модель, мост поправил её вызов, Hermes сжал контекст, помощнику
// поставлена задача. Роль system — как у неразобранных системных событий CLI;
// name — откуда пометка (tool_name), text — что произошло, словами
function recordNotice(sessionId, name, text, parentToolUseId, raw) {
    const position = countMessages.get(sessionId).n;
    upsertMessage.run(sessionId, position, 'system', clip(text), new Date().toISOString(), null, null);
    setMessageToolCall.run(name || null, clip(JSON.stringify({ notice: name, text })), sessionId, position);
    if (parentToolUseId) setMessageToolIds.run(null, parentToolUseId, sessionId, position);
    // у пометки источник виден по её имени и не совпадает с целью сессии:
    // ход ведёт Hermes, а поправил вызов мост или наш же сервер
    const origin = noticeOrigin(name, sessionId);
    stampEvent(sessionId, position, 'notice', origin.actor, origin);
    stampRaw(sessionId, position, raw);
    return position;
}

// откуда пришла пометка хода. Имена задаются на месте вызова recordNotice
// (claude-bridge, server.retry-nudge, hermes.compaction — DOCS/decisions/039);
// незнакомое имя не выдумываем, а берём источником саму сессию
function noticeOrigin(name, sessionId) {
    const prefix = String(name || '').split('.')[0];
    if (prefix === 'claude-bridge') return { source: 'bridge', provider: null, actor: 'tool' };
    if (prefix === 'server') return { source: 'server', provider: null, actor: 'server' };
    if (prefix === 'hermes') return { ...originForSession(sessionId), source: 'hermes', actor: 'orchestrator' };
    return { ...originForSession(sessionId), actor: null };
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
        // хода — тоже реплика модели по форме, её отличает stop_reason
        stampEvent(sessionId, position, 'text', 'model');
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
    DB_FILE,
    db,
    backupBeforeSchemaChange,
    upsertSession,
    getSessionTarget,
    getCliSession,
    setCliSession,
    upsertMessage,
    setMessageUsage,
    setMessageToolCall,
    setMessageToolResult,
    setMessageToolIds,
    setMessageStopReason,
    setMessageMode,
    setMessageInputSent,
    setMessageResultMeta,
    setMessageExtraMeta,
    setMessageOrigin,
    setMessageTaskIds,
    setMessageRaw,
    getMessageRaw,
    touchSession,
    setSessionThumb,
    setSessionContext,
    setSessionInfo,
    setSessionRateLimit,
    hermesSyncCursor,
    hermesChildCursor,
    hasCliSessionLink,
    deleteMessagesFrom,
    selectMessagesFrom,
    archiveMessage,
    deleteArchiveBySession,
    countArchive,
    archiveAndDeleteFrom,
    setMessageCreatedAt,
    lastMessageTime,
    getSessionMeta,
    getSessionTitle,
    getLastTurnParams,
    listSessions,
    listMessages,
    countNeedsAttention,
    sumSessionUsage,
    countMessages,
    listToolSteps,
    countToolSteps,
    getMessageRole,
    setMessageText,
    DETAIL_CLIP_LEN,
    clip,
    RAW_CLIP_LEN,
    clipRaw,
    toolResultText,
    MAX_TOOL_IMAGE_BYTES,
    MAX_TOOL_IMAGES_PER_RESULT,
    toolResultImages,
    resetSessions,
    deleteMessagesBySession,
    deleteSessionById,
    deleteCliLinksBySession,
    deleteSession,
    originForSession,
    stampEvent,
    stampRaw,
    appendRaw,
    setAttemptByTask,
    hasUnstampedTask,
    stampHermesAttempts,
    stampTask,
    startExchange,
    extractTitle,
    sessionTitle,
    recordStep,
    recordHookStart,
    recordHookResponse,
    recordThinking,
    recordAssistantText,
    recordNotice,
    noticeOrigin,
    recordUnknownPart,
    recordSystemEvent,
    recordTopLevelEvent,
    finishExchange,
};
}

module.exports = { open };
