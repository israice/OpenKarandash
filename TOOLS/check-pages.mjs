// Проверка реестра страниц против диска. Страница живёт в папке PROJECTS/<folder>,
// а список страниц лежит в таблице pages базы DATA/.sessions.db — и эти две
// вещи никак не связаны на уровне файлов. Переименование папки руками (git mv,
// «переименую папку и всё») оставляет реестр со старым именем, страница перестаёт
// открываться, а причина неочевидна: ошибка прилетает из import() страницы.
//
//   node TOOLS/check-pages.mjs
//
// Правильный путь переименования — POST /api/pages/rename, он меняет и папку, и
// реестр, и первую строку README разом. Этот скрипт только проверяет.
//
// Нужен Node 22+ (node:sqlite) и запущенный сервер не обязателен: база читается
// напрямую.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dbPath = path.join(root, 'DATA', '.sessions.db');

if (!fs.existsSync(dbPath)) {
    console.error(`нет базы ${path.relative(root, dbPath)} — запусти сервер и создай страницу`);
    process.exit(2);
}

const db = new DatabaseSync(dbPath, { readOnly: true });
const pages = db.prepare('SELECT id, title, folder FROM pages ORDER BY id').all();
db.close();

const problems = [];
for (const p of pages) {
    if (!p.folder) { problems.push(`id=${p.id} «${p.title}»: папка не задана — переименование мимо /api/pages/rename`); continue; }
    if (!fs.existsSync(path.join(root, 'PROJECTS', p.folder))) {
        problems.push(`id=${p.id} «${p.title}»: папки PROJECTS/${p.folder} нет — страница не откроется (import() упадёт)`);
    }
}

// Папка есть, а в реестре её нет — обратная рассинхронизация: страница лежит
// на диске, но кнопки в тулбаре у неё не будет.
const known = new Set(pages.map((p) => p.folder));
for (const dir of fs.readdirSync(path.join(root, 'PROJECTS'), { withFileTypes: true })) {
    if (!dir.isDirectory() || dir.name === 'Sessions' || known.has(dir.name)) continue;
    if (fs.existsSync(path.join(root, 'PROJECTS', dir.name, 'page.js'))) {
        problems.push(`PROJECTS/${dir.name}: папка со страницей есть, а в реестре её нет — добавь через /api/pages/create или переименуй через /api/pages/rename`);
    }
}

if (!problems.length) {
    console.log(`страницы в порядке: ${pages.length}`);
    process.exit(0);
}
for (const p of problems) console.error(`pages: ${p}`);
process.exit(1);