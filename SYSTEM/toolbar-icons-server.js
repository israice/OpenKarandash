// Серверное хранение иконок, выбранных пользователем для кнопок тулбара
// «Действия» через попап в меню "+" (SYSTEM/toolbar-menu.js). Раньше выбор
// жил в localStorage и терялся при обновлении страницы в другом окружении —
// здесь общая для всех клиентов таблица в той же БД, что у pages/flow_state.

const { readJson, sendJson } = require('./core/http.js');

function createRoutes({ db }) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS toolbar_icons (
            button_id TEXT PRIMARY KEY,
            icon TEXT NOT NULL
        );
    `);

    const listIcons = db.prepare('SELECT button_id, icon FROM toolbar_icons');
    const setIcon = db.prepare(`
        INSERT INTO toolbar_icons (button_id, icon) VALUES (?, ?)
        ON CONFLICT(button_id) DO UPDATE SET icon = excluded.icon
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
                sendJson(res, { ok: false, error: 'Нужны buttonId и icon' });
                return;
            }
            setIcon.run(buttonId, icon);
            sendJson(res, { ok: true });
        },
    };
}

module.exports = { createRoutes };
