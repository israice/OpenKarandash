// Вкладка Home, серверная половина: панель наблюдения рисуется не браузером,
// а сервером — шаблон home-observation.eta лежит рядом, htmx подменяет им кусок
// страницы (см. «Серверные фрагменты» в AGENTS.md и DOCS/decisions/005).
//
// Карточка Providers сюда не входит — её состояние есть только в браузере.

const { Eta } = require('eta');
const { sendHtml } = require('../../SYSTEM/core/http.js');
const { formatWhen } = require('../../SYSTEM/core/format.js');
const typesafe = require('../../SYSTEM/core/typesafe.js');

// свой экземпляр Eta со своей папкой шаблонов: так фича не зависит от того, где
// держит шаблоны сосед. cache:false — правка .eta подхватывается без перезапуска
const eta = new Eta({ views: __dirname, cache: false });

// sessions() отдаёт сводку по сессиям (заголовок уже почищен, running посчитан),
// activeCount() — сколько ходов идёт прямо сейчас. Обе — из ядра: хранилище
// сессий и реестр запусков живут в server.js
function createRoutes({ sessions, activeCount, needsAttention }) {
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
                // суждения о ходах: сбой там ничего не ломает и потому ничем
                // себя не выдаёт — показываем его здесь, в панели наблюдения,
                // иначе о нём узнают по симптомам через неделю (DOCS/decisions/051)
                judgment: judgmentLine(typesafe.status()),
                // сколько сессий просят вмешаться: суждение о ходе считалось и
                // раньше, но видно было только в самой ленте (DOCS/decisions/055)
                attention: needsAttention ? needsAttention() : 0,
                running: list.filter((s) => s.running),
                recent: list.slice(0, 6).map((s) => ({
                    ...s,
                    meta: s.running ? 'running…' : `${formatWhen(s.updatedAt)} · ${s.messageCount} msg`,
                })),
            }));
        },
    };
}

// строка панели: состояние словами плюс пометка вида, по которой шаблон красит.
// Счётчик неудач показываем всегда, когда он ненулевой, — даже если последний
// запрос прошёл: редкие сбои так же важны, как постоянные
function judgmentLine(s) {
    if (s.health === 'off') return { text: 'off — no key', kind: 'off' };
    if (s.health === 'idle') return { text: 'waiting for the first turn', kind: 'idle' };
    if (s.health === 'error') return { text: `failing — ${s.lastError}`, kind: 'error' };
    // расход показываем здесь же, а не отдельной строкой: он интересен ровно
    // в ту секунду, когда смотришь, жив ли механизм. Счёт с последнего запуска
    // сервера — постоянного хранения он не стоит, цена копеечная
    const spent = s.inputTokens ? ` · ${formatTokens(s.inputTokens)} tok` : '';
    return { text: (s.failed ? `${s.ok} ok · ${s.failed} failed` : `${s.ok} ok`) + spent, kind: 'ok' };
}

// «12.3k» вместо «12345»: в строке панели важен порядок, а не точное число
function formatTokens(n) {
    return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

module.exports = { createRoutes };
