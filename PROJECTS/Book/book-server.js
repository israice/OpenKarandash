// Серверная половина вкладки Book: отдаёт разметку маршрутом
// /api/fragment/book-view и рендерит её в страницу (renderPage в
// SYSTEM/core/version.js, заглушка {{BOOK_VIEW}}). Состояния нет.

const { Eta } = require('eta');
const { sendHtml } = require('../../SYSTEM/core/http.js');

const eta = new Eta({ views: __dirname, cache: false });

function createRoutes() {
    return {
        '/api/fragment/book-view': (req, res) => {
            sendHtml(res, eta.render('book-view', {}));
        },
    };
}

module.exports = { createRoutes, renderView: () => eta.render('book-view', {}) };
