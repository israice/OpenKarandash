// Серверная половина кнопок-заготовок в группе «Actions» тулбара.
//
// Отличие от страниц (PROJECTS/Sessions/pages-server.js) принципиальное: там
// «+» заводит папку в PROJECTS/ с настоящим содержимым, здесь — только кнопку
// в тулбаре, без папки и без файлов. Кнопка-заготовка несёт иконку и название
// и ничего больше: обработчика под неё нет, и заводить его предстоит позже
// (заглушка должна быть видимой, но не делать вид, что уже работает).
//
// Клиентская половина — SYSTEM/new-icon-button.js. Разметка группы —
// SYSTEM/topbar.eta, там же кнопка «+» этой группы (id newIconButton).
//
// Иконка и название хранятся здесь же, а не в toolbar_icons/toolbar_names
// (SYSTEM/toolbar-icons-server.js): те — переименование и перерисовка кнопок,
// которые есть в разметке шаблона, а здесь набор сам пользовательский и
// меняется по клику «+».

const { readJson, sendJson } = require('./core/http.js');

function createRoutes({ db }) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS toolbar_buttons (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            icon TEXT NOT NULL
        );
    `);

    const list = db.prepare('SELECT id, name, icon FROM toolbar_buttons ORDER BY id');
    const insert = db.prepare('INSERT INTO toolbar_buttons (name, icon) VALUES (?, ?)');
    const remove = db.prepare('DELETE FROM toolbar_buttons WHERE id = ?');
    const get = db.prepare('SELECT id FROM toolbar_buttons WHERE id = ?');

    // Иконка приходит как ключ каталога (star, heart, …), а не как разметка SVG:
    // сам каталог живёт в SYSTEM/toolbar-menu.js, и принимать от клиента готовый
    // <svg> значило бы писать в базу то, что потом рисуется в DOM (см. строку про
    // XSS в renderMenu). Разрешённые ключи не проверяем: неизвестный ключ клиент
    // всё равно не нарисует (applyIcon выходит по !markup), а проверка на сервере
    // держала бы список иконок в двух местах.
    function clean(value, fallback) {
        return typeof value === 'string' && value.trim() ? value.trim().slice(0, 64) : fallback;
    }

    return {
        '/api/toolbar/buttons': (req, res) => {
            sendJson(res, { ok: true, buttons: list.all() });
        },

        '/api/toolbar/buttons/create': async (req, res) => {
            const body = await readJson(req);
            const name = clean(body.name, 'Button');
            const icon = clean(body.icon, 'star');
            const info = insert.run(name, icon);
            sendJson(res, { ok: true, id: Number(info.lastInsertRowid), name, icon });
        },

        '/api/toolbar/buttons/delete': async (req, res) => {
            const { id } = await readJson(req);
            // номера кнопки нет — удалять нечего; это не ошибка запроса, но и
            // молчание здесь скрыло бы рассинхрон между сервером и меню
            if (!get.get(id)) {
                sendJson(res, { ok: false, error: 'Button not found' });
                return;
            }
            remove.run(id);
            sendJson(res, { ok: true });
        },
    };
}

module.exports = { createRoutes };