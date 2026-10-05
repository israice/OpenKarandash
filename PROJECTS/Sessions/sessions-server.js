// Вкладка Sessions, серверная половина: список сессий её боковой панели рисует
// сервер — шаблон session-list.eta лежит рядом, htmx подменяет им #sessionList
// целиком по hx-swap-oob (см. «Серверные фрагменты» в AGENTS.md).
//
// Кто из сессий выбран (aria-current), серверу не известно — это чинит браузер
// сразу после подмены (sessions-panel.js). Само хранилище сессий — в SYSTEM/core/sessions-db.js,
// его читают и Flow, и страницы кнопки «+», поэтому оно ядро, а не
// половина этой вкладки.
//
// Страницы кнопки «+» живут рядом, в pages-server.js.

const { Eta } = require('eta');
const { sendHtml } = require('../../SYSTEM/core/http.js');
const { formatTokens, formatDuration } = require('../../SYSTEM/core/format.js');

// свой экземпляр Eta со своей папкой шаблонов: так фича не зависит от того, где
// держит шаблоны сосед. cache:false — правка .eta подхватывается без перезапуска
const eta = new Eta({ views: __dirname, cache: false });

// sessions() отдаёт сводку по сессиям из ядра: заголовок уже почищен, running
// посчитан. usage(id) — сводка sumSessionUsage из SYSTEM/core/sessions-db.js: суммарные токены и
// суммарная длительность (duration_ms) по всем ходам сессии сразу, без
// пересчёта по сообщениям
function createRoutes({ sessions, usage, activeStartedAt }) {
    return {
        '/api/fragment/session-view': (req, res) => {
            sendHtml(res, eta.render('session-view', {}));
        },

        '/api/fragment/session-list': (req, res) => {
            const list = sessions().map((session) => {
                const u = usage(session.id) || {};
                const totalTokens = (u.inputTokens || 0) + (u.outputTokens || 0)
                    + (u.cacheReadTokens || 0) + (u.cacheCreationTokens || 0);
                const tokensText = formatTokens(totalTokens);

                // активная сессия: длительность не статичный текст «running…»,
                // а тикающий счётчик — baseMs (сумма duration_ms уже завершённых
                // ходов) плюс время с начала текущего хода. Здесь только
                // начальное значение для первого показа и для браузера без JS;
                // секунды между подменами фрагмента (раз в 5с) досчитывает клиент
                // — см. data-started/data-base-ms в session-list.eta и
                // tickLiveDurations в sessions-panel.js
                const startedAt = session.running ? activeStartedAt(session.id) : null;
                const baseMs = u.durationMs || 0;
                const liveMs = startedAt ? baseMs + (Date.now() - startedAt) : baseMs;

                return {
                    id: session.id,
                    title: session.title,
                    // адресом, а не строкой data-URL: фрагмент опрашивается
                    // каждые 5с, и 40 КБ base64 на сессию ездили заново каждый
                    // раз (DOCS/decisions/091) — теперь это /api/image/session-thumb
                    thumb: session.hasThumb ? `/api/image/session-thumb?id=${encodeURIComponent(session.id)}` : null,
                    running: session.running,
                    live: Boolean(startedAt),
                    tokensText,
                    startedAt,
                    baseMs,
                    meta: `${tokensText} · ${formatDuration(liveMs)}`,
                };
            });

            sendHtml(res, eta.render('session-list', { sessions: list }));
        },
    };
}

module.exports = { createRoutes, renderView: () => eta.render('session-view', {}) };