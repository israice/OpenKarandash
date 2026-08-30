// Поиск по проекту из терминала: код, заметки vault и прошлые сессии.
// Читает индекс, который собирает server.js — своего разбора здесь нет,
// поэтому команда работает и без запущенного сервера.
//
//   node PROJECTS/Graph/search.js "живая перезагрузка"
//   node PROJECTS/Graph/search.js --kind session "граф"

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

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
    console.error('Использование: node PROJECTS/Graph/search.js [--kind code|note|session] "запрос"');
    process.exit(2);
}

if (!fs.existsSync(INDEX_FILE)) {
    console.error('Индекс не собран. Запустите сервер: node server.js');
    process.exit(1);
}

const db = new DatabaseSync(INDEX_FILE);
const match = ftsQuery(query);
const rows = db.prepare(`
    SELECT kind, ref, title, snippet(docs, 3, '«', '»', '…', 12) AS snippet
    FROM docs WHERE docs MATCH ?${kind ? ' AND kind = ?' : ''}
    ORDER BY bm25(docs, 0, 0, 10.0, 1.0) LIMIT 15
`).all(...(kind ? [match, kind] : [match]));

if (!rows.length) {
    console.log('Ничего не найдено.');
    process.exit(0);
}

for (const row of rows) {
    console.log(`\n[${row.kind}] ${row.title}`);
    console.log(`  ${row.ref}`);
    console.log(`  ${row.snippet.replace(/\s+/g, ' ').trim()}`);
}
