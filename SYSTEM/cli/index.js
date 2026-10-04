// Агентский слой: кого зовём, кого временно не зовём и что делаем, когда
// исполнитель оборвался.
//
// Один контракт на все CLI (DOCS/decisions/017): коннектор отличается от соседнего
// только тем, как он запускает свой процесс и как разбирает вывод. Снаружи все они
// отвечают одинаково, поэтому маршруты /api/agent/* не знают, какой CLI за ними
// стоит, а новый коннектор добавляется строкой в таблице CONNECTORS, а не копией
// роутов.
//
// Агент по умолчанию — тот, чьим коннектором идёт ход, когда сессия ничего не
// говорит о своём CLI: пустой target или target удалённого коннектора
// (DOCS/decisions/075, 078 — в проекте остался только OpenCode)
const opencode = require('./opencode.js');
const cooldown = require('./cooldown.js');
const fallback = require('./fallback.js');
const outsideBrowser = require('./outside-browser.js');

const DEFAULT_AGENT = 'opencode';

// коннекторы и их порядок. Здесь же читается выключатель подхвата: он касается и
// памяти о недоступных, и самой цепочки смены исполнителя — читать его в двух
// модулях значило бы завести две правды об одном флаге
const FALLBACK_OFF = process.env.AGENT_FALLBACK === '0';

const CONNECTORS = {
    opencode: (deps) => opencode.create(deps),
};

// Какой CLI вёл сессию, видно по её target: id окружений коннектора начинаются
// с его имени. Старые сессии удалённых коннекторов (claude/pi/codex) отдают
// DEFAULT_AGENT — их target никто не узнает, а история читается целиком.
// Чистая функция строки: ею пользуется и слой базы (sessions-db.js), который
// подключается раньше коннекторов
function agentNameByTarget(targetId) {
    if (!targetId) return DEFAULT_AGENT;
    const name = String(targetId).split('-')[0];
    return CONNECTORS[name] ? name : DEFAULT_AGENT;
}

// create({ db, dbFns, runTurn, handoff, turnJudgment, telegramLetters, runs }):
//   db         — handle базы сессий (кулдаун кладёт записи в общую с ним базу)
//   dbFns      — функции записи сообщений, которые нужны коннектору
//   runTurn    — общая обвязка хода (SYSTEM/core/run-turn.js)
//   handoff    — продолжение сессии и пересказ истории (SYSTEM/core/handoff.js)
//   turnJudgment — суждения jev о ходе и о поломке (SYSTEM/core/turn-judgment.js)
//   telegramLetters — слова для человека о поломке (telegram-letters-server.js)
//   runs       — реестр идущих ходов: «сервер уже уходит» знаем только он
//
// turnJudgment берём под тем именем, каким его передаёт server.js. С прошлым
// именем judgment в разборе аргументов он был undefined во всём этом слое:
// первым делом падал ход на turnJudgment.classifyFailure (SYSTEM/cli/fallback.js),
// и вместе с ним уезжало всё остальное суждение. Ровно та же ошибка была и в
// agent-routes.js — см. комментарий там.
//
// Сборка слоя целиком, а не только таблица коннекторов, потому что части связаны
// одной логикой: подхват исполнителя ходит и по подключениям, и по кулдаунам, а
// ход не из браузера — по тому же подхвату. Разложить это по файлам можно было бы,
// но тогда каждая часть брала бы половину соседней через require.
function create({ db, dbFns, runTurn, handoff, turnJudgment, telegramLetters, runs }) {
    const agents = {};
    for (const [name, connect] of Object.entries(CONNECTORS)) {
        agents[name] = connect({ runTurn, resumeAndHandoff: handoff.resumeAndHandoff, db: dbFns });
    }

    function byName(name) {
        const agent = agents[name];
        if (!agent) throw new Error(`Unknown agent: ${name}`);
        return agent;
    }

    // Поломка ложится в базу, и следующий выбор исполнителя знает «кто сегодня
    // недоступен и до какого времени», не повторяя ошибку. Память выключается тем же
    // AGENT_FALLBACK=0, что и весь подхват: ноль значит «работаем как попросили,
    // без самодеятельности пульта»
    const cooldowns = cooldown.create({ db, enabled: () => !FALLBACK_OFF, reasonText: telegramLetters.reasonText });

    const chain = fallback.create({
        agents,
        cooldowns,
        turnJudgment,
        fallbackOff: FALLBACK_OFF,
    });

    // ход, начатый не из браузера: ответ человека в Telegram продолжает ту же
    // сессию или заводит новую
    const outside = outsideBrowser.create({
        agents,
        agentByName: byName,
        agentNameByTarget,
        cooldowns,
        askWithFallback: chain.askWithFallback,
        turnJudgment,
        db: dbFns,
        runs,
    });

    return {
        agents,
        cooldowns,
        byName,
        agentNameByTarget,
        askWithFallback: chain.askWithFallback,
        willHandOver: chain.willHandOver,
        // ответ человека в личке / новая работа оттуда же
        askOutsideBrowser: outside.ask,
        startOutsideBrowser: outside.startNew,
    };
}

module.exports = { create, agentNameByTarget, DEFAULT_AGENT };