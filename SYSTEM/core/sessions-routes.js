// /api/sessions* — общее хранилище переписок: его читают и Chat, и Flow, и Home,
// и страницы кнопки «+», поэтому маршруты живут в ядре, а не в одной папке
// (DOCS/decisions/017). Обращения к самой базе — SYSTEM/core/sessions-db.js.
const { readJson, sendJson } = require('./http.js');

// createRoutes({ db, list, map, runs }): db — нужные функции хранилища, list —
// сводка сессий для списков (core/session-list.js), map — отложенная пересборка
// карты проекта: список сессий попадает в vault, и без неё заметки останутся
// старыми.
function createRoutes({ db, list, map, runs }) {
    const {
        resetSessions, deleteSession, setSessionThumb, getMessageRole, setMessageText,
        getSessionMeta, listMessages, sumSessionUsage,
    } = db;
    const { sessionSummaries } = list;

    return {
        '/api/sessions': async (req, res) => {
            sendJson(res, { ok: true, sessions: sessionSummaries(), active: runs.activeCount() });
        },

        '/api/sessions/reset': async (req, res) => {
            resetSessions();
            map.scheduleMapUpdate(); // список опустел — уберём и заметки о сессиях
            sendJson(res, { ok: true });
        },

        // удаление одной сессии из списка. работающую не трогаем: её запрос
        // ещё допишет в базу ответ, и строка воскреснет наполовину пустой
        '/api/sessions/delete': async (req, res) => {
            const { id } = await readJson(req);
            if (!id) {
                sendJson(res, { ok: false, error: 'No session specified' });
                return;
            }
            if (runs.isRunning(id)) {
                sendJson(res, { ok: false, error: 'The session is still running' });
                return;
            }
            deleteSession(id);
            map.scheduleMapUpdate(); // заметка удалённой сессии тоже должна уйти
            sendJson(res, { ok: true });
        },

        // страница могла перезагрузиться посреди хода — она возвращается и
        // спрашивает поток заново. Ответ не закроется до конца работы
        '/api/sessions/attach': async (req, res) => {
            const { id, after, deltas } = await readJson(req);
            if (!runs.attach({ req, res, id, after, deltas })) {
                sendJson(res, { ok: true, running: false });
            }
        },

        // превью элемента, к которому был оставлен комментарий из режима Karandash —
        // приходит уже готовой data URL (скриншот системы либо клиентский снимок)
        '/api/sessions/thumb': async (req, res) => {
            const { id, thumb } = await readJson(req);
            const MAX_THUMB_BYTES = 300 * 1024;
            // строгий формат data-URL: только base64, без пробелов, кавычек и скобок —
            // это то, что реально отдаёт canvas.toDataURL, и ничего сверх этого
            const THUMB_RE = /^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/]+=*$/;
            if (!id || typeof thumb !== 'string' || thumb.length > MAX_THUMB_BYTES || !THUMB_RE.test(thumb)) {
                sendJson(res, { ok: false, error: 'Invalid preview' });
                return;
            }
            setSessionThumb.run(thumb, id);
            sendJson(res, { ok: true });
        },

        // правка своей реплики прямо на графе Flow (§10 chat.md). Менять разрешено
        // только строку роли user: остальное — запись того, что модель и инструменты
        // действительно сделали, и подделывать её значило бы врать самой трассой.
        // Почему маршрут здесь, а не в flow-server.js — DOCS/decisions/018
        '/api/sessions/message/set': async (req, res) => {
            const { id, position, text } = await readJson(req);
            if (!id || !Number.isInteger(position) || typeof text !== 'string') {
                sendJson(res, { ok: false, error: 'id, position and text are required' });
                return;
            }
            const row = getMessageRole.get(id, position);
            if (!row) {
                sendJson(res, { ok: false, error: 'Message not found' });
                return;
            }
            if (row.role !== 'user') {
                sendJson(res, { ok: false, error: `Only your own message can be edited, not "${row.role}"` });
                return;
            }
            setMessageText.run(text, id, position);
            sendJson(res, { ok: true });
        },

        '/api/sessions/messages': async (req, res) => {
            const { id } = await readJson(req);
            const meta = getSessionMeta.get(id) || {};
            let sessionInfo = null;
            let rateLimit = null;
            try { sessionInfo = meta.sessionInfo ? JSON.parse(meta.sessionInfo) : null; } catch { /* битая запись — пропускаем */ }
            try { rateLimit = meta.rateLimit ? JSON.parse(meta.rateLimit) : null; } catch { /* битая запись — пропускаем */ }
            sendJson(res, {
                ok: true,
                messages: listMessages.all(id),
                contextPercent: meta.contextPercent ?? null,
                contextWindow: meta.contextWindow ?? null,
                sessionInfo,
                rateLimit,
                usage: sumSessionUsage.get(id),
                target: meta.target ?? null,
                thumb: meta.thumb ?? null,
                // ход идёт прямо сейчас: номер последнего события, уже отражённого
                // в этих строках, — с него клиент просит продолжение у attach
                liveSeq: runs.liveSeq(id),
            });
        },
    };
}

module.exports = { createRoutes };