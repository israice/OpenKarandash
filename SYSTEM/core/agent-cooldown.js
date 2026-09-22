// Кулдаун недоступных исполнителей: запись «модель/агент не берём до времени»,
// выведенная из суждения о причине поломки (DOCS/decisions/071, уточняет 066).
// Раньше знание о поломке жило только в памяти текущей цепочки (handoverWatch
// в server.js) и пропадало с концом хода — следующая работа снова упиралась в
// ту же исчерпанную дневным лимитом модель. Теперь поломка кладётся в базу на
// срок по причине, и выбор исполнителя (nextExecutor) пропускает тех, кто в
// кулдауне: сначала свободные бесплатные, а к платным не лезет, пока известно,
// что «деньгам» тоже плохо. Таблица своя, схему сессий не трогает.
//
// Запись по паре (agent, model): model = '' — агент недоступен целиком (ключ,
// не подключён), иначе — одна конкретная модель агента. Протухшие записи
// подметаются лениво: при каждом чтении/записи строки с истёкшим until уходят.
// Пустой строкой, а не NULL, нарочно: в PRIMARY KEY SQLite NULL не равен NULL,
// и upsert по (agent, model) не находил бы повторную запись об агенте.

const COOLDOWN_MS = {
    // модель сняли или она не существует: отсидим до следующего пополнения каталога
    no_model: 12 * 60 * 60 * 1000,
    // ключ/логин: чинится руками, час — человек успеет
    auth: 60 * 60 * 1000,
    // агент не подключён: подключение тоже руками, час
    not_connected: 60 * 60 * 1000,
    // сеть моргнула — короткий срок, чтобы не ругаться долго из-за одной ошибки
    network: 5 * 60 * 1000,
    // сбой поставщика: обычно возвращается быстро
    provider: 30 * 60 * 1000,
    // каприз агента/модели: как у сбоя поставщика
    agent_fault: 30 * 60 * 1000,
};
// дневной лимит не про паузу, а про сброс счёта — отсиживаем до начала новых
// суток по UTC (конец дня — единственный правдоподобный общий момент сброса)
const LIMIT_RESET = 'end-of-utc-day';
// причины, по которым работу не передаём (task — виновато поручение, gone —
// сессии/серверу), и неведомые причины в кулдаун не пишем вовсе: без причины
// помнить нечего, и прежнее поведение «попробуем снова» остаётся

function untilMs(reason, nowMs) {
    if (reason === 'limit') {
        const day = new Date(nowMs);
        day.setUTCHours(24, 0, 0, 0);
        return day.getTime();
    }
    const ms = COOLDOWN_MS[reason];
    return ms ? nowMs + ms : 0;
}

// db — общий с сессиями handle (SYSTEM/core/sessions-db.js): те же WAL и
// busy_timeout уже выставлены. Зависимости аргументами, как у createRoutes.
// enabled — выключатель AGENT_FALLBACK (server.js): при нём память ни читается,
// ни пишется, поведение возвращается к прежнему «работаю как попросили»
function create({ db, now = () => new Date(), enabled = () => true }) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS agent_cooldown (
            agent TEXT NOT NULL,
            model TEXT NOT NULL DEFAULT '',
            reason TEXT NOT NULL,
            until TEXT NOT NULL,
            created_at TEXT NOT NULL,
            PRIMARY KEY (agent, model)
        );
    `);

    const upsert = db.prepare(`
        INSERT INTO agent_cooldown (agent, model, reason, until, created_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(agent, model) DO UPDATE SET
            reason = excluded.reason, until = excluded.until, created_at = excluded.created_at
    `);
    const select = db.prepare('SELECT reason, until FROM agent_cooldown WHERE agent = ? AND model = ?');
    const listAll = db.prepare('SELECT agent, model, reason, until FROM agent_cooldown WHERE until > ?');
    const deleteExpired = db.prepare('DELETE FROM agent_cooldown WHERE until <= ?');

    function prune() {
        deleteExpired.run(now().toISOString());
    }

    // положить поломку в память. model = null/'' — агент целиком; reason вне
    // списка сроков молча не кладётся, прежде чем что-то помнить о будущем
    function record(agent, model, reason) {
        if (!enabled()) return;
        const until = untilMs(reason, now().getTime());
        if (!until) return;
        prune();
        const target = model || '';
        upsert.run(agent, target, reason, new Date(until).toISOString(), now().toISOString());
    }

    // { reason, until } активного кулдауна пары или null. Агент целиком
    // перекрывает свои модели: запись об агенте достаётся и для любого его
    // запроса, а запись о модели — только для этой модели
    function cooled(agent, model) {
        if (!enabled()) return null;
        prune();
        const row = select.get(agent, '');
        if (row && row.until > now().toISOString()) return { reason: row.reason, until: row.until };
        const target = model || '';
        const modelRow = target ? select.get(agent, target) : null;
        if (modelRow && modelRow.until > now().toISOString()) return { reason: modelRow.reason, until: modelRow.until };
        return null;
    }

    // все активные записи — диагностика и API пульта (выключатель не трогает:
    // посмотреть, что лежит, полезно и при выключенной работе)
    function list() {
        prune();
        return listAll.all(now().toISOString()).map((r) => ({ agent: r.agent, model: r.model || null, reason: r.reason, until: r.until }));
    }

    function clear() {
        db.exec('DELETE FROM agent_cooldown');
        return list();
    }

    return { record, cooled, list, clear, COOLDOWN_MS, LIMIT_RESET };
}

module.exports = { create };