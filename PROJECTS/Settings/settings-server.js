// Серверная половина окна Settings: модалка настроек и окно выбора окружения
// CLI живут в PROJECTS/Settings/settings-modal.eta; маршрут /api/fragment/settings-modal
// отдаёт их целиком, а в странице они подставляются через renderPage.

const { Eta } = require('eta');
const { sendHtml } = require('../../SYSTEM/core/http.js');

const eta = new Eta({ views: __dirname, cache: false });

function createRoutes() {
    return {
        '/api/fragment/settings-modal': (req, res) => {
            sendHtml(res, eta.render('settings-modal', {}));
        },
    };
}

module.exports = { createRoutes, renderView: () => eta.render('settings-modal', {}) };
