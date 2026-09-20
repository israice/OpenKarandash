// Поиск по проекту из терминала: код, заметки vault и прошлые сессии.
// Читает индекс, который собирает server.js — своего разбора здесь нет,
// поэтому команда работает и без запущенного сервера.
//
// Если саму базу открыть нельзя, спрашивает запущенный сервер (/api/search).
// Так бывает в контейнере Hermes: DATA/.index.db живёт в режиме WAL, а через
// смонтированную с Windows папку SQLite отвечает «disk I/O error» — агент
// тогда копировал базу и писал дампы руками, тратя на это десятки шагов.
// Адрес сервера — OPENKARANDASH_URL, иначе localhost и host.docker.internal.
//
//   node PROJECTS/Graph/search.js "живая перезагрузка"
//   node PROJECTS/Graph/search.js --kind session "граф"

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const searchRank = require('../../SYSTEM/core/search-rank.js');

const INDEX_FILE = path.join(__dirname, '..', '..', 'DATA', '.index.db'); // всё, что сервер собрал сам, — в DATA

// то же экранирование, что и на сервере: сырой ввод в MATCH роняет запрос
function ftsQuery(raw) {
    const terms = String(raw || '')
        .split(/\s+/)
        .filter(Boolean)
        .map((term) => `"${term.replace(/"/g, '""')}"`);
    if (!terms.length) return '';
    terms[terms.length - 1] += '*';
    return terms.join(' ');
}

const args = process.argv.slice(2);
let kind = '';
if (args[0] === '--kind') kind = args.splice(0, 2)[1];
const query = args.join(' ');

if (!query) {
    console.error('Usage: node PROJECTS/Graph/search.js [--kind code|note|session] "query"');
    process.exit(2);
}

if (!fs.existsSync(INDEX_FILE)) {
    console.error('Index not built. Start the server: node server.js');
    process.exit(1);
}

function searchLocal() {
    const db = new DatabaseSync(INDEX_FILE, { readOnly: true });
    const match = ftsQuery(query);
    return db.prepare(`
        SELECT kind, ref, title, snippet(docs, 3, '«', '»', '…', 12) AS snippet,
               snippet(docs, 3, '', '', '…', 48) AS excerpt
        FROM docs WHERE docs MATCH ?${kind ? ' AND kind = ?' : ''}
        ORDER BY bm25(docs, 0, 0, 10.0, 1.0) LIMIT 15
    `).all(...(kind ? [match, kind] : [match]));
}

async function searchServer() {
    const port = process.env.PORT || 3001;
    const bases = [process.env.OPENKARANDASH_URL, `http://127.0.0.1:${port}`, `http://host.docker.internal:${port}`].filter(Boolean);
    let lastError;
    for (const base of bases) {
        try {
            const res = await fetch(`${base}/api/search`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ q: query, limit: 15, kind }),
                signal: AbortSignal.timeout(5000),
            });
            const data = await res.json();
            if (!data.ok) throw new Error(data.error || `HTTP ${res.status}`);
            return data.hits;
        } catch (error) {
            lastError = error;
        }
    }
    throw lastError;
}

async function main() {
    let rows;
    try {
        rows = searchLocal();
    } catch (localError) {
        try {
            rows = await searchServer();
        } catch (serverError) {
            console.error(`Index unreadable (${localError.message}) and server unreachable (${serverError.message}).`);
            process.exit(1);
        }
    }

    if (!rows.length) {
        console.log('Nothing found.');
        return;
    }

    // порядок задаёт не только совпадение слов: по каждому кандидату задаётся
    // вопрос, отвечает ли он на запрос (DOCS/decisions/053). Сервер делает то
    // же самое в /api/search, поэтому оба пути отвечают одинаково. Механизм
    // выключен или недоступен — порядок остаётся тем, что дал BM25
    rows = await searchRank.rankHits(query, rows, (row) => row.excerpt);

    for (const row of rows) {
        // «·» у кандидата, который по смыслу к запросу не относится: выбрасывать
        // его нельзя (суждение бывает неправо), но и молчать о нём нечестно
        const mark = row.relevance === undefined ? '' : (row.relevant ? '' : ' ·');
        console.log(`\n[${row.kind}]${mark} ${row.title}`);
        console.log(`  ${row.ref}`);
        console.log(`  ${row.snippet.replace(/\s+/g, ' ').trim()}`);
    }
}

main();
