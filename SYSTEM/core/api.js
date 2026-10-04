// Разбор /api/*: метод, поиск маршрута и превращение неожиданного падения в ответ.
//
// Ни одной таблицы маршрутов здесь: все три её набора (фичи, агенты, сессии)
// одинаково устроены — «полный путь → обработчик (req, res)», поэтому api.js их
// только складывает (см. server.js) и больше ничего о маршрутах не знает.
const { sendJson, sendHtml, escapeHtml } = require('./http.js');

// createApi(routes) — обработчик запроса для http-server.js
function createApi(routes) {
    return async function handleApi(req, res, urlPath) {
        // фрагменты только читают состояние, и htmx тянет их обычным hx-get —
        // остальному API по-прежнему нужен POST
        const readOnly = urlPath.startsWith('/api/fragment/');
        if (req.method !== 'POST' && !(readOnly && req.method === 'GET')) {
            sendJson(res, { ok: false, error: readOnly ? 'Expected GET or POST' : 'Expected POST' }, 405);
            return;
        }

        const route = routes[urlPath];
        if (!route) {
            sendJson(res, { ok: false, error: 'Unknown endpoint' }, 404);
            return;
        }

        try {
            await route(req, res);
        } catch (err) {
            // сюда попадают только неожиданные падения: там, где ошибка предусмотрена,
            // обработчик сам отвечает 200 с { ok: false }. Поэтому здесь код 500 и
            // запись в консоль — иначе баг в сервере выглядит как успешный ответ
            // и находится потом по симптомам в интерфейсе
            console.error(`[api] ${urlPath}: ${err.stack || err.message}`);

            // Заголовки потока уже ушли (ход идёт, NDJSON открыт): обычный JSON
            // поверх него не отправить — такой ответ обрывал соединение, вкладка
            // показывала «Failed to fetch», а процесс падал по
            // ERR_HTTP_HEADERS_SENT. Дописываем ошибку последней строкой потока —
            // её клиент читает как любое другое событие хода
            if (res.headersSent) {
                if (!res.writableEnded) {
                    if (String(res.getHeader('Content-Type') || '').includes('ndjson')) {
                        res.write(`${JSON.stringify({ type: 'error', error: err.message })}\n`);
                    }
                    res.end();
                }
                return;
            }

            // htmx на 200 попробовал бы разложить тело по oob-целям, ничего не нашёл
            // и тихо оставил панель замороженной
            if (readOnly) {
                sendHtml(res, `<!-- fragment error: ${escapeHtml(err.message)} -->`, 500);
                return;
            }
            // тело прежнее: App.api() читает JSON независимо от кода ответа
            sendJson(res, { ok: false, error: err.message }, 500);
        }
    };
}

module.exports = { createApi };