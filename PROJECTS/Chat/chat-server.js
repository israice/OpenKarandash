// Вкладка Chat, серверная половина: список сессий её боковой панели рисует
// сервер — шаблон chat-sessions.eta лежит рядом, htmx подменяет им #sessionList
// целиком по hx-swap-oob (см. «Серверные фрагменты» в AGENTS.md).
//
// Кто из сессий выбран (aria-current), серверу не известно — это чинит app.js
// сразу после подмены. Само хранилище сессий — в server.js: его читают и Flow,
// и Home, и страницы кнопки «+», поэтому оно ядро, а не половина этой вкладки.
//
// Страницы кнопки «+» живут рядом, в pages-server.js.

const { Eta } = require('eta');
const { sendHtml } = require('../../SYSTEM/core/http.js');
const { formatWhen } = require('../../SYSTEM/core/format.js');

// свой экземпляр Eta со своей папкой шаблонов: так фича не зависит от того, где
// держит шаблоны сосед. cache:false — правка .eta подхватывается без перезапуска
const eta = new Eta({ views: __dirname, cache: false });

// sessions() отдаёт сводку по сессиям из ядра: заголовок уже почищен, running посчитан
function createRoutes({ sessions }) {
    return {
        '/api/fragment/chat-sessions': (req, res) => {
            const list = sessions().map((session) => ({
                id: session.id,
                title: session.title,
                thumb: session.thumb,
                running: session.running,
                meta: session.running
                    ? 'running…'
                    : `${formatWhen(session.updatedAt)} · ${session.messageCount} msg`,
            }));
            sendHtml(res, eta.render('chat-sessions', { sessions: list }));
        },
    };
}

module.exports = { createRoutes };
