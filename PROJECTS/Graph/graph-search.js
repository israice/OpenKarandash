// Вкладка Graph, поиск по проекту: индекс FTS5 по коду, заметкам vault и прошлым
// сессиям и запрос к нему. Состав проекта, разбор файла на секции, имена заметок
// сессий и то, что пришло через init(), берёт из graph-vault.js. Тот же индекс
// без сервера читает PROJECTS/Graph/search.js из терминала.

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const {
    ROOT, DATA_DIR, VAULT, VAULT_DIR, MAP_DIR, SESSION_DIR, TEXT_FILES, state,
    collectNotes, projectFiles, readText, parseUnits, sessionNote,
} = require('./graph-vault.js');
const searchRank = require('../../SYSTEM/core/search-rank.js');
const hooks = require('./graph-hooks.js');

// ---------- поиск по проекту (FTS5) ----------

// индекс — производный кэш, его можно удалить и пересобрать, поэтому он живёт
// отдельно от .sessions.db, где переписка существует в единственном экземпляре.
// лежит в DATA: эту папку не обходит ни карта, ни сторож файлов, и запись
// в базу не вызывает перезагрузку страницы
const INDEX_FILE = path.join(ROOT, DATA_DIR, '.index.db');
const searchDb = new DatabaseSync(INDEX_FILE);
searchDb.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');

// unicode61 нужен для кириллицы, prefix — чтобы работал поиск по началу слова
searchDb.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS docs USING fts5(
        kind UNINDEXED,
        ref  UNINDEXED,
        title,
        body,
        tokenize = 'unicode61 remove_diacritics 2',
        prefix = '2 3'
    );
`);

const insertDoc = searchDb.prepare('INSERT INTO docs(kind, ref, title, body) VALUES (?, ?, ?, ?)');
// удаление строки по её rowid — FTS5 не отдаёт место файла сам, поэтому без
// явного удаления по id старые сегменты остаются лежать навсегда
const deleteDoc = searchDb.prepare('DELETE FROM docs WHERE rowid = ?');

// что уже в индексе: ключ документа (kind|ref) → { rowid, stamp }. Отдельная
// обычная таблица рядом с FTS: по ней видно, что именно нужно переписать, а
// полный перебор docs ради сравнения стоил бы больше самой пересборки
searchDb.exec(`
    CREATE TABLE IF NOT EXISTS index_state (
        kind  TEXT NOT NULL,
        ref   TEXT NOT NULL,
        rowid INTEGER NOT NULL,
        stamp TEXT NOT NULL,
        PRIMARY KEY (kind, ref)
    );
`);
const readState = searchDb.prepare('SELECT kind, ref, rowid, stamp FROM index_state');
const writeState = searchDb.prepare(`
    INSERT INTO index_state(kind, ref, rowid, stamp) VALUES (?, ?, ?, ?)
    ON CONFLICT(kind, ref) DO UPDATE SET rowid = excluded.rowid, stamp = excluded.stamp
`);
const dropState = searchDb.prepare('DELETE FROM index_state WHERE kind = ? AND ref = ?');

// сырой ввод в MATCH роняет запрос («fts5: syntax error near "."»), поэтому каждое
// слово оборачиваем в кавычки, а последнему разрешаем префиксный поиск
function ftsQuery(raw) {
    const terms = String(raw || '')
        .split(/\s+/)
        .filter(Boolean)
        .map((term) => `"${term.replace(/"/g, '""')}"`);
    if (!terms.length) return '';
    terms[terms.length - 1] += '*';
    return terms.join(' ');
}

// Сборка индекса инкрементальная: сначала собираем то, что должно быть в
// индексе (ref + отпечаток источника), и сравниваем с index_state. Переписывается
// только то, что действительно изменилось или появилось, а исчезшее удаляется по
// сохранённому rowid.
//
// Почему так, а не «DELETE FROM docs и вставить всё заново»: FTS5 удалённые
// страницы не возвращает файлу, поэтому каждая полная пересборка безвозвратно
// добавляла к базе свои мегабайты. За полгода ежедневных пересборок .index.db
// дорос до 837 МБ при 6 МБ живого содержимого, а он остаётся таким даже после
// того, как старые сессии из индекса убрали. Плюс чтение всей переписки всех
// сессий на каждый чих держало event loop занятым.

// схема индекса хуков (класс/id → файл:строка) — своей таблицей рядом с FTS.
// ответ на «где этот элемент в коде» отдаёт она, а не текстовый поиск: имени
// класса в разметке десятки упоминаний, а место, где его создают, одно
hooks.initSchema(searchDb);

// отпечаток файла по размеру и времени правки — этого хватает, чтобы отличить
// «файл не трогали» от «файл изменился», и стоит одного stat вместо чтения
function fileStamp(file) {
    try {
        const stat = fs.statSync(file);
        return `${stat.size}:${Math.round(stat.mtimeMs)}`;
    } catch {
        return ''; // файла нет — в индексе ему не место
    }
}

// карту «что должно быть в индексе» собираем целиком в памяти: живого текста
// здесь единицы мегабайт, зато сравнение со старым индексом делается одним
// проходом без обращения к базе на каждый файл
function collectWanted(wanted) {
    const put = (kind, ref, title, body, stamp) => {
        if (body) wanted.set(`${kind}|${ref}`, { kind, ref, title, body, stamp });
    };

    // код: крупные файлы режем по секциям, чтобы попадание указывало на узел графа.
    // файл, которого не касались, не читаем и не разбираем вовсе
    for (const file of projectFiles()) {
        if (!TEXT_FILES.test(file)) continue;
        const stamp = fileStamp(path.join(ROOT, file));
        if (!stamp) continue;
        const text = readText(file);
        if (!text) continue;

        const units = parseUnits(file, text).filter((unit) => unit.kind === 'section');
        if (units.length) {
            for (const unit of units) put('code', unit.note, `${file} › ${unit.title}`, unit.body, stamp);
        } else {
            put('code', `${MAP_DIR}/${file}`, file, text, stamp);
        }
    }

    // заметки vault: и сгенерированные, и написанные руками. заметка сначала
    // ищется в папке данных, потом — в корне vault (её могли положить руками)
    for (const note of collectNotes(VAULT, VAULT)) {
        const generated = path.join(VAULT_DIR, note);
        const source = fs.existsSync(generated) ? generated : path.join(VAULT, note);
        const stamp = fileStamp(source);
        if (!stamp) continue;
        const text = safeRead(source);
        put('note', note.replace(/\.md$/, ''), note, text, stamp);
    }

    // сессии: только человеческая часть переписки. вывод инструментов — это
    // 1500 строк вида «Read index.html», в поиске от них один шум. переписку
    // читаем лишь у тех сессий, у которых сдвинулись дата, счётчик реплик
    // или заголовок — у остальных отпечаток совпал и текст не нужен, поэтому
    // в wanted кладём только отпечаток, а тело добирается ниже по session
    for (const session of state.deps.listSessions.all()) {
        const ref = `${SESSION_DIR}/${sessionNote(session)}`;
        const stamp = `${session.updatedAt || ''}|${session.messageCount || 0}|${session.title || ''}`;
        wanted.set(`session|${ref}`, { kind: 'session', ref, title: state.deps.sessionTitle(session), stamp, session });
    }
    return wanted;
}

// тело сессии добираем отдельно и только для тех, чей отпечаток разошёлся:
// держать в wanted всю переписку всех сессий ради сравнения не нужно
function sessionBody(session) {
    if (!session) return '';
    const messages = state.deps.listMessages.all(session.id).filter((m) => m.role === 'user' || m.role === 'assistant');
    return messages.map((m) => m.text).join('\n\n');
}

function rebuildSearchIndex() {
    try {
        // BEGIN тоже внутри try: занятая база (второй процесс, checkpoint) роняла
        // его исключением мимо этого catch, а пересборка идёт из таймера — некому
        // было ловить, и сервер выключался целиком
        searchDb.exec('BEGIN');

        const wanted = new Map();
        collectWanted(wanted);
        // индекс хуков обновляем в той же транзакции и тем же проходом: обе
        // таблицы описывают одни и те же файлы, и отдельный обход прошёлся бы по
        // проекту второй раз ради того же самого результата. Сбой здесь не
        // должен уносить с собой поисковый индекс — ради ответа «где элемент» он
        // не жертвует тем, что уже собрано
        try {
            hooks.syncHooks(searchDb);
        } catch (error) {
            console.error(`Failed to build the hook index: ${error.message}`);
        }
        const known = new Map(readState.all().map((row) => [`${row.kind}|${row.ref}`, row]));
        // первая сборка на таблице, которой ещё нет: в индексе лежат строки
        // прежней полной пересборки, о них index_state не знает, и они остались бы
        // навсегда вторыми копиями каждого попадания. Один раз чистим целиком
        if (!known.size) searchDb.exec('DELETE FROM docs');
        const kept = new Set();

        for (const [key, want] of wanted) {
            const previous = known.get(key);
            if (previous && previous.stamp === want.stamp) {
                kept.add(key); // не трогаем: файл и сессия с прошлой сборки те же самые
                continue;
            }
            const body = want.body ?? sessionBody(want.session);
            if (!body) { // файл опустел или у сессии не осталось реплик — выкидываем старое
                if (previous) deleteDoc.run(previous.rowid);
                dropState.run(want.kind, want.ref);
                continue;
            }
            if (previous) deleteDoc.run(previous.rowid);
            const { lastInsertRowid } = insertDoc.run(want.kind, want.ref, want.title, body);
            writeState.run(want.kind, want.ref, Number(lastInsertRowid), want.stamp);
            kept.add(key);
        }

        // файл или сессия исчезли — их строки ещё в индексе, убираем по rowid
        for (const [key, row] of known) {
            if (kept.has(key)) continue;
            deleteDoc.run(row.rowid);
            dropState.run(row.kind, row.ref);
        }

        searchDb.exec('COMMIT');
        trimIndexWals();
    } catch (error) {
        // откат без открытой транзакции — сам по себе исключение («no transaction
        // is active»), и оно улетело бы выше catch
        try { searchDb.exec('ROLLBACK'); } catch { /* транзакции не было */ }
        console.error(`Failed to build the search index: ${error.message}`);
    }
}

// WAL индекса копится, пока база открыта постоянным соединением, а автосброс у
// него не срабатывает. Обрезаем его после каждой пересборки, если он больше
// порога: файл в полусотне мегабайт сам по себе тормозит и поиск из терминала,
// и копирование папки DATA
const WAL_TRIM_BYTES = 8 * 1024 * 1024;

function trimIndexWals() {
    try {
        if (fileSize(`${INDEX_FILE}-wal`) <= WAL_TRIM_BYTES) return;
        searchDb.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    } catch {
        /* файл WAL мог исчезнуть — тогда и обрезать нечего */
    }
}

// Жим файла индекса. FTS5 не возвращает место удалённых строк, поэтому база
// с годами пересборок держит сотни мегабайнут мёртвых страниц, и это уже не
// зависит от живого содержимого. VACUUM переписывает файл целиком, поэтому
// зовём его не на каждой пересборке, а один раз при старте сервера и только
// когда больше половины страниц свободно
const COMPACT_MIN_BYTES = 64 * 1024 * 1024;

function compactSearchIndex() {
    try {
        if (fileSize(INDEX_FILE) < COMPACT_MIN_BYTES) return;
        // по одному PRAGMA на запрос: несколько через запятую node:sqlite
        // не разбирает («near ",": syntax error») — и жим молча не проходил
        const { page_count: pages } = searchDb.prepare('PRAGMA page_count').get();
        const { freelist_count: free } = searchDb.prepare('PRAGMA freelist_count').get();
        if (!pages || free * 2 < pages) return; // живого содержимого больше половины — не жмём
        searchDb.exec('VACUUM');
        console.log(`Compacted the search index to ${(fileSize(INDEX_FILE) / 1024 / 1024).toFixed(1)} MB`);
    } catch (error) {
        console.error(`Failed to compact the search index: ${error.message}`);
    }
}

function fileSize(file) {
    try {
        return fs.statSync(file).size;
    } catch {
        return 0;
    }
}

function safeRead(file) {
    try {
        return fs.readFileSync(file, 'utf8');
    } catch {
        return '';
    }
}

function searchProject(query, limit = 20, kind = '') {
    const match = ftsQuery(query);
    if (!match) return { ok: true, hits: [] };
    try {
        // веса по колонкам: совпадение в заголовке важнее, чем в теле;
        // kind — тот же фильтр, что у search.js (code|note|session)
        const hits = searchDb.prepare(`
            SELECT kind, ref, title, snippet(docs, 3, '«', '»', '…', 12) AS snippet,
                   snippet(docs, 3, '', '', '…', 48) AS excerpt
            FROM docs WHERE docs MATCH ?${kind ? ' AND kind = ?' : ''} ORDER BY bm25(docs, 0, 0, 10.0, 1.0) LIMIT ?
        `).all(...(kind ? [match, String(kind)] : [match]), Math.min(Number(limit) || 20, 100));
        return { ok: true, hits };
    } catch (error) {
        return { ok: false, error: `Search failed: ${error.message}` };
    }
}

// Тот же поиск, но с осмысленной расстановкой найденного: BM25 находит
// кандидатов по словам, а порядок им задаёт суждение о том, отвечает ли кусок
// на запрос (SYSTEM/core/search-rank.js, DOCS/decisions/053). Механизм выключен
// или сервис не ответил — порядок остаётся прежним, поиск работает как раньше.
// Отдельной функцией, а не внутри searchProject: тот синхронный, им пользуются
// и там, где ждать сеть нельзя
async function searchProjectRanked(query, limit, kind) {
    const found = searchProject(query, limit, kind);
    if (!found.ok || !found.hits.length) return found;
    const ranked = await searchRank.rankHits(query, found.hits, (hit) => hit.excerpt);
    // excerpt — длинный кусок только для взвешивания: наружу отдаём тот же
    // короткий snippet, что и раньше, иначе ответ вырастет в разы
    return { ok: true, hits: ranked.map(({ excerpt, ...hit }) => hit) };
}

module.exports = {
    rebuildSearchIndex, compactSearchIndex, searchProject, searchProjectRanked,
    // место элемента в коде по его именам: ответ на вопрос «где это править» без
    // rg. Соединение то же, что у поиска, — второй файл базы открывать нельзя
    findHooks: (names, limit) => hooks.findHooks(searchDb, names, limit),
};
