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

// индекс собираем целиком: весь проект — сотни килобайт, полная пересборка
// занимает единицы миллисекунд, инкрементальность тут не окупается
function rebuildSearchIndex() {
    try {
        // BEGIN тоже внутри try: занятая база (второй процесс, checkpoint) роняла
        // его исключением мимо этого catch, а пересборка идёт из таймера — некому
        // было ловить, и сервер выключался целиком
        searchDb.exec('BEGIN');
        searchDb.exec('DELETE FROM docs');

        // код: крупные файлы режем по секциям, чтобы попадание указывало на узел графа
        for (const file of projectFiles()) {
            if (!TEXT_FILES.test(file)) continue;
            const text = readText(file);
            if (!text) continue;

            const units = parseUnits(file, text).filter((unit) => unit.kind === 'section');
            if (units.length) {
                for (const unit of units) insertDoc.run('code', unit.note, `${file} › ${unit.title}`, unit.body);
            } else {
                insertDoc.run('code', `${MAP_DIR}/${file}`, file, text);
            }
        }

        // заметки vault: и сгенерированные, и написанные руками
        for (const note of collectNotes(VAULT, VAULT)) {
            const text = readText(path.join(VAULT_DIR, note)) || safeRead(path.join(VAULT, note));
            if (text) insertDoc.run('note', note.replace(/\.md$/, ''), note, text);
        }

        // сессии: только человеческая часть переписки. вывод инструментов — это
        // 1500 строк вида «Read index.html», в поиске от них один шум
        for (const session of state.deps.listSessions.all()) {
            const messages = state.deps.listMessages.all(session.id).filter((m) => m.role === 'user' || m.role === 'assistant');
            if (!messages.length) continue;
            insertDoc.run(
                'session',
                `${SESSION_DIR}/${sessionNote(session)}`,
                state.deps.sessionTitle(session),
                messages.map((m) => m.text).join('\n\n'),
            );
        }

        searchDb.exec('COMMIT');
    } catch (error) {
        // откат без открытой транзакции — сам по себе исключение («no transaction
        // is active»), и оно улетело бы выше catch
        try { searchDb.exec('ROLLBACK'); } catch { /* транзакции не было */ }
        console.error(`Failed to build the search index: ${error.message}`);
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

module.exports = { rebuildSearchIndex, searchProject, searchProjectRanked };
