// Вкладка Home, серверная половина: панель наблюдения рисуется не браузером,
// а сервером — шаблон home-observation.eta лежит рядом, htmx подменяет им кусок
// страницы (см. «Серверные фрагменты» в AGENTS.md и DOCS/decisions/005).
//
// Карточка Providers сюда не входит — её состояние есть только в браузере.

const { Eta } = require('eta');
const { sendHtml } = require('../../SYSTEM/core/http.js');
const { formatWhen } = require('../../SYSTEM/core/format.js');

// свой экземпляр Eta со своей папкой шаблонов: так фича не зависит от того, где
// держит шаблоны сосед. cache:false — правка .eta подхватывается без перезапуска
const eta = new Eta({ views: __dirname, cache: false });

// sessions() отдаёт сводку по сессиям (заголовок уже почищен, running посчитан),
// activeCount() — сколько ходов идёт прямо сейчас. Обе — из ядра: хранилище
// сессий и реестр запусков живут в server.js
function createRoutes({ sessions, activeCount }) {
    return {
        '/api/fragment/home-observation': (req, res) => {
            const list = sessions();
            const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
            sendHtml(res, eta.render('home-observation', {
                total: list.length,
                active: activeCount(),
                messages: list.reduce((sum, s) => sum + s.messageCount, 0),
                today: list.filter((s) => new Date(s.updatedAt).getTime() >= dayAgo).length,
                lastActive: list[0] ? formatWhen(list[0].updatedAt) : '—',
                running: list.filter((s) => s.running),
                recent: list.slice(0, 6).map((s) => ({
                    ...s,
                    meta: s.running ? 'running…' : `${formatWhen(s.updatedAt)} · ${s.messageCount} msg`,
                })),
            }));
        },
    };
}

module.exports = { createRoutes };
