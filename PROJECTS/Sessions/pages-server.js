// Серверная половина страниц, которые заводит кнопка «+» в тулбаре
// (SYSTEM/new-button.js). Каждая страница — настоящая папка в PROJECTS/ с
// README.md (попадает в общий список разделов, book-tab.js), page.js — самим
// содержимым страницы — и page.css с её стилями: раздел живёт в своей папке
// целиком, включая разметку (DOCS/decisions/014, DOCS/decisions/016).
//
// Клиентская половина — PROJECTS/Book/book-tab.js.

const fs = require('fs');
const path = require('path');
const { readJson, sendJson } = require('../../SYSTEM/core/http.js');

// Содержимое новой страницы и её стили. Заготовка нарочно пустая по смыслу
// («Hello World») — дальше её правит пользователь или агент прямо в папке
// страницы, и правка подхватывается без перезагрузки всего интерфейса.
//
// page.css заводим всегда, даже пустым: тогда <link> на него есть с самого
// начала (SYSTEM/new-button.js ставит его по имени папки), и правка стилей
// подменяется на лету, а не перезагружает страницу целиком.
const PAGE_JS = `// Содержимое этой страницы. Файл заводит /api/pages/create, а грузит его
// динамическим import при первом открытии страницы SYSTEM/new-button.js.
// page — её <main>, panel — слот в топбаре под свою панель (пустой не
// показывается), signal — снимается при пересборке страницы: подписывайте им
// слушателей и потоки, чтобы от прошлой сборки ничего не оставалось.
// Пример со всем сразу — PROJECTS/Feed/page.js.
export default function build(page, { panel, signal }) {
    page.style.cssText = 'display:flex;align-items:center;justify-content:center;';
    page.textContent = 'Hello World';
}
`;

const PAGE_CSS = `/* Стили этой страницы. <link> на файл ставит SYSTEM/new-button.js по имени
   папки, поэтому правка подменяется на лету, без перезагрузки интерфейса. */
`;

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
    const renamePage = db.prepare('UPDATE pages SET title = ?, folder = ? WHERE id = ?');

    // имя папки из заголовка: только буквы/цифры/пробелы/дефисы, без выхода за PROJECTS/.
    // current — папка самой страницы при переименовании: она занята ею же, и лишний
    // номер к имени из-за неё приписывать не нужно
    function folderNameFromTitle(title, current) {
        const base = title.replace(/[\\/:*?"<>|]/g, '').trim() || 'Project';
        let folder = base;
        let n = 2;
        while (folder !== current && fs.existsSync(path.join(root, 'PROJECTS', folder))) folder = `${base} ${n++}`;
        return folder;
    }

    return {
        '/api/pages': (req, res) => {
            sendJson(res, { ok: true, pages: listPages.all() });
        },

        '/api/pages/create': async (req, res) => {
            const { title } = await readJson(req);
            if (typeof title !== 'string' || !title) {
                sendJson(res, { ok: false, error: 'title is required' });
                return;
            }
            const folder = folderNameFromTitle(title);
            fs.mkdirSync(path.join(root, 'PROJECTS', folder), { recursive: true });
            fs.writeFileSync(path.join(root, 'PROJECTS', folder, 'README.md'), `# ${title}\n`, 'utf8');
            fs.writeFileSync(path.join(root, 'PROJECTS', folder, 'page.js'), PAGE_JS, 'utf8');
            fs.writeFileSync(path.join(root, 'PROJECTS', folder, 'page.css'), PAGE_CSS, 'utf8');
            const info = insertPage.run(title, folder);
            sendJson(res, { ok: true, id: info.lastInsertRowid, title, folder, readme: `PROJECTS/${folder}/README.md` });
        },

        '/api/pages/rename': async (req, res) => {
            const { id, title } = await readJson(req);
            if (typeof title !== 'string' || !title) {
                sendJson(res, { ok: false, error: 'title is required' });
                return;
            }
            const page = getPage.get(id);
            if (!page) {
                sendJson(res, { ok: false, error: 'Page not found' });
                return;
            }
            // папка — дом страницы целиком (в ней и README.md, и page.js), поэтому
            // её имя держим в синхроне с заголовком: иначе страница «Feed» остаётся
            // жить в папке «Page 6»
            let folder = page.folder;
            const next = folderNameFromTitle(title, folder);
            if (folder && next !== folder) {
                try {
                    fs.renameSync(path.join(root, 'PROJECTS', folder), path.join(root, 'PROJECTS', next));
                    folder = next;
                } catch { /* папку могли удалить вручную — не мешаем переименованию */ }
            }
            // README создаётся с заголовком `# {title}` (см. /api/pages/create) —
            // держим его первую строку в синхроне, иначе открытая карточка покажет старое имя
            const readmePath = path.join(root, 'PROJECTS', folder, 'README.md');
            try {
                const content = fs.readFileSync(readmePath, 'utf8');
                fs.writeFileSync(readmePath, content.replace(/^#.*$/m, `# ${title}`), 'utf8');
            } catch { /* README мог быть удалён вручную — не мешаем переименованию */ }
            renamePage.run(title, folder, id);
            sendJson(res, { ok: true, folder, readme: `PROJECTS/${folder}/README.md` });
        },

        // Иконка кнопки страницы: рисуночек лежит в папке самой страницы файлом
        // page-icon.svg, поэтому раздел отвечает за то, что нарисовано на его
        // кнопке, целиком. Без файла — пустая строка, клиент оставляет номер.
        // Имя папки приходит из тела (её знает клиент, у него есть dataset.folder),
        // поэтому режем в нём разделители: иначе в обход PROJECTS/ ушёл бы любой
        // текст, а чужой файл читать нельзя.
        '/api/pages/icon': async (req, res) => {
            const { folder } = await readJson(req);
            if (typeof folder !== 'string' || !folder) {
                sendJson(res, { ok: false, error: 'folder is required' });
                return;
            }
            const safe = folder.replace(/[\\/:*?"<>|]/g, '').trim();
            if (!safe) {
                sendJson(res, { ok: false, error: 'folder is required' });
                return;
            }
            try {
                const markup = fs.readFileSync(path.join(root, 'PROJECTS', safe, 'page-icon.svg'), 'utf8');
                // Отдаём только фигуры, без внешнего <svg>. Размеры и обводку кнопка
                // уже несёт на своём svg (viewBox 24, stroke currentColor — как у всех
                // иконок тулбара), а вложенный svg без width/height отрисовался бы
                // по своим правилам и разошёлся с соседями. Поэтому файл остаётся
                // самостоятельным (открывается в браузере сам по себе), а в кнопку
                // попадает только содержимое.
                const open = markup.indexOf('<svg');
                const close = markup.lastIndexOf('</svg>');
                const inner = (open === -1 || close <= open)
                    ? markup
                    : markup.slice(markup.indexOf('>', open) + 1, close);
                sendJson(res, { ok: true, icon: inner.trim() });
            } catch {
                sendJson(res, { ok: true, icon: '' }); // иконки нет — это не ошибка
            }
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
