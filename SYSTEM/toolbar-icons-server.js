// Серверное хранение иконок и названий, выбранных пользователем для кнопок
// тулбара «Действия» через меню "+" (SYSTEM/toolbar-menu.js). Раньше выбор
// жил в localStorage и терялся при обновлении страницы в другом окружении —
// здесь общие для всех клиентов таблицы в той же БД, что у pages/flow_state.
// Названия здесь — только для встроенных кнопок: у страниц кнопки «Новое»
// название живёт в pages.title (PROJECTS/Chat/pages-server.js).

const { readJson, sendJson } = require('./core/http.js');

function createRoutes({ db }) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS toolbar_icons (
            button_id TEXT PRIMARY KEY,
            icon TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS toolbar_names (
            button_id TEXT PRIMARY KEY,
            name TEXT NOT NULL
        );
    `);

    const listIcons = db.prepare('SELECT button_id, icon FROM toolbar_icons');
    const setIcon = db.prepare(`
        INSERT INTO toolbar_icons (button_id, icon) VALUES (?, ?)
        ON CONFLICT(button_id) DO UPDATE SET icon = excluded.icon
    `);
    const listNames = db.prepare('SELECT button_id, name FROM toolbar_names');
    const setName = db.prepare(`
        INSERT INTO toolbar_names (button_id, name) VALUES (?, ?)
        ON CONFLICT(button_id) DO UPDATE SET name = excluded.name
    `);

    return {
        '/api/toolbar/icons': (req, res) => {
            const icons = {};
            for (const row of listIcons.all()) icons[row.button_id] = row.icon;
            sendJson(res, { ok: true, icons });
        },

        '/api/toolbar/icons/set': async (req, res) => {
            const { buttonId, icon } = await readJson(req);
            if (typeof buttonId !== 'string' || !buttonId || typeof icon !== 'string' || !icon) {
                sendJson(res, { ok: false, error: 'buttonId and icon are required' });
                return;
            }
            setIcon.run(buttonId, icon);
            sendJson(res, { ok: true });
        },

        '/api/toolbar/names': (req, res) => {
            const names = {};
            for (const row of listNames.all()) names[row.button_id] = row.name;
            sendJson(res, { ok: true, names });
        },

        '/api/toolbar/names/set': async (req, res) => {
            const { buttonId, name } = await readJson(req);
            if (typeof buttonId !== 'string' || !buttonId || typeof name !== 'string' || !name) {
                sendJson(res, { ok: false, error: 'buttonId and name are required' });
                return;
            }
            setName.run(buttonId, name);
            sendJson(res, { ok: true });
        },
    };
}

module.exports = { createRoutes };
