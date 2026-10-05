// Схема базы сессий: файл SQLite, таблицы и миграции колонок. Отдельный модуль от
// `sessions-db.js` по той же причине, что и он сам вынесен из server.js
// (DOCS/decisions/022, один файл — одна тема): подготовить хранилище и
// пользоваться заготовленными запросами — разные вопросы, и правка миграции не
// должна выглядеть правкой записи событий.

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

function createSchema({ ROOT, DATA_DIR }) {
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

    -- у каждого CLI своя история запусков: id сессии одного CLI в другом не
    -- существует. Поэтому наш id сессии живёт в sessions, а id внутри конкретного
    -- CLI — здесь, по одному на цель.
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

    -- остатки прежних слоёв (DOCS/decisions/007, 015, 077): в них никто не пишет,
    -- а выглядят как рабочие таблицы. Чистятся один раз при открытии базы
    DROP TABLE IF EXISTS hermes_tasks;
    DROP TABLE IF EXISTS hermes_runs;
    DROP TABLE IF EXISTS replaced_messages;
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
    // режим хода (Chat/Action) — от него зависит набор инструментов и флаги
    // запуска CLI; input_sent — то, что реально ушло модели, если это отличается
    // от text (в Chat перед вопросом приклеивается CHAT_PREAMBLE)
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
    // id подзадачи и попытки внутри неё — поля графа задач (DOCS/decisions/040:
    // «завести» читается как «отразить»). Писать их некому: своего графа у нас
    // нет, поэтому у строк они пустые, но лента их читает
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

// каким CLI ведена сессия: у каждого CLI своё хранилище истории, поэтому
// «--resume» чужого id всегда возвращает ошибку — см. resumeAndHandoff в SYSTEM/core/handoff.js
try {
    db.exec('ALTER TABLE sessions ADD COLUMN target TEXT');
} catch { /* колонка уже есть */ }

return { DB_FILE, db, backupBeforeSchemaChange };
}

module.exports = { createSchema };
