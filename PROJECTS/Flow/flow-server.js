// Серверная половина вкладки Flow: сохранённое состояние доски.
// Клиентская половина — PROJECTS/Flow/flow.js.
//
// Модуль сам заводит свою таблицу и отдаёт таблицу маршрутов: server.js только
// подключает её к общему списку, ничего не зная про устройство flow_state.
//
// Вторая тема папки — память навыков работников — живёт отдельным файлом
// (profiles-server.js, DOCS/decisions/022: один файл — одна тема); здесь только
// подмешивание её маршрутов, чтобы server.js по-прежнему знал одну точку входа.

const { readJson, sendJson } = require('../../SYSTEM/core/http.js');
const profiles = require('./profiles-server.js');

function createRoutes({ db }) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS flow_state (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
    `);

    const listFlowState = db.prepare('SELECT key, value FROM flow_state');
    const setFlowStateRow = db.prepare(`
        INSERT INTO flow_state (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);

    return {
        ...profiles.createRoutes(),

        '/api/flow/state': (req, res) => {
            const state = {};
            for (const row of listFlowState.all()) {
                try {
                    state[row.key] = JSON.parse(row.value);
                } catch { /* битая строка — пропускаем, лучше потерять одно поле, чем всё */ }
            }
            sendJson(res, { ok: true, state });
        },

        '/api/flow/state/set': async (req, res) => {
            const { key, value } = await readJson(req);
            if (typeof key !== 'string' || !key) {
                sendJson(res, { ok: false, error: 'key is required' });
                return;
            }
            setFlowStateRow.run(key, JSON.stringify(value ?? null));
            sendJson(res, { ok: true });
        },
    };
}

module.exports = { createRoutes };
