// Серверная половина страниц, которые заводит кнопка «+» в тулбаре
// (SYSTEM/new-button.js). Каждая страница — настоящая папка в PROJECTS/ с
// README.md, чтобы попасть в общий список разделов (book-tab.js) наравне
// со встроенными.
//
// Клиентская половина — PROJECTS/Book/book-tab.js.

const fs = require('fs');
const path = require('path');
const { readJson, sendJson } = require('../../SYSTEM/core/http.js');

function createRoutes({ db, root }) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS pages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL
        );
    `);
    try {
        db.exec("ALTER TABLE pages ADD COLUMN folder TEXT NOT NULL DEFAULT ''");
    } catch { /* колонка уже есть */ }

    const listPages = db.prepare('SELECT id, title, folder FROM pages ORDER BY id');
    const getPage = db.prepare('SELECT folder FROM pages WHERE id = ?');
    const insertPage = db.prepare('INSERT INTO pages (title, folder) VALUES (?, ?)');
    const deletePage = db.prepare('DELETE FROM pages WHERE id = ?');
    const renamePage = db.prepare('UPDATE pages SET title = ? WHERE id = ?');

    // имя папки из заголовка: только буквы/цифры/пробелы/дефисы, без выхода за PROJECTS/
    function folderNameFromTitle(title) {
        const base = title.replace(/[\\/:*?"<>|]/g, '').trim() || 'Проект';
        let folder = base;
        let n = 2;
        while (fs.existsSync(path.join(root, 'PROJECTS', folder))) folder = `${base} ${n++}`;
        return folder;
    }

    return {
        '/api/pages': (req, res) => {
            sendJson(res, { ok: true, pages: listPages.all() });
        },

        '/api/pages/create': async (req, res) => {
            const { title } = await readJson(req);
            if (typeof title !== 'string' || !title) {
                sendJson(res, { ok: false, error: 'Нужен title' });
                return;
            }
            const folder = folderNameFromTitle(title);
            fs.mkdirSync(path.join(root, 'PROJECTS', folder), { recursive: true });
            fs.writeFileSync(path.join(root, 'PROJECTS', folder, 'README.md'), `# ${title}\n`, 'utf8');
            const info = insertPage.run(title, folder);
            sendJson(res, { ok: true, id: info.lastInsertRowid, title, folder, readme: `PROJECTS/${folder}/README.md` });
        },

        '/api/pages/rename': async (req, res) => {
            const { id, title } = await readJson(req);
            if (typeof title !== 'string' || !title) {
                sendJson(res, { ok: false, error: 'Нужен title' });
                return;
            }
            const page = getPage.get(id);
            if (!page) {
                sendJson(res, { ok: false, error: 'Страница не найдена' });
                return;
            }
            // README создаётся с заголовком `# {title}` (см. /api/pages/create) —
            // держим его первую строку в синхроне, иначе открытая карточка покажет старое имя
            const readmePath = path.join(root, 'PROJECTS', page.folder, 'README.md');
            try {
                const content = fs.readFileSync(readmePath, 'utf8');
                fs.writeFileSync(readmePath, content.replace(/^#.*$/m, `# ${title}`), 'utf8');
            } catch { /* README мог быть удалён вручную — не мешаем переименованию */ }
            renamePage.run(title, id);
            sendJson(res, { ok: true });
        },

        '/api/pages/delete': async (req, res) => {
            const { id } = await readJson(req);
            // страница создаётся вместе с настоящей папкой (см. /api/pages/create) —
            // удаляем вместе с ней, иначе на диске остаётся мусор
            const page = getPage.get(id);
            if (page?.folder) fs.rmSync(path.join(root, 'PROJECTS', page.folder), { recursive: true, force: true });
            deletePage.run(id);
            sendJson(res, { ok: true });
        },
    };
}

module.exports = { createRoutes };
