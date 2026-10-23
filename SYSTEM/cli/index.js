// Агентский слой: кого зовём, кем это помнится и что делаем, когда
// исполнитель оборвался.
//
// Один контракт на все CLI (DOCS/decisions/017): коннектор отличается от соседнего
// только тем, как он запускает свой процесс и как разбирает вывод. Снаружи все они
// отвечают одинаково, поэтому маршруты /api/agent/* не знают, какой CLI за ними
// стоит, а новый коннектор добавляется строкой в таблице CONNECTORS, а не копией
// роутов.
//
// Коннектор тут один на всех — any.js, — и он работает с любым словом, каким
// назовут CLI (SYSTEM/cli-agents.js: список приходит с сайта и меняется).
// Таблица CONNECTORS поэтому не перечисляет CLI, а хранит уже созданные
// коннекторы: по имени, которое человек выбрал в строке выбора сессии.
// Один коннектор на слово — тоже граница: состояние подключения и кулдаун
// принадлежат именно этому CLI, и общий коннектор на всех смешал бы их между
// собой. Слово, для которого коннектора ещё нет, создаётся на лету и попадает
// в таблицу, поэтому подключить и позвать можно любое имя из списка.
//
// Агент по умолчанию — тот, чей коннектор ведёт ход, когда сессия ничего не
// говорит о своём CLI: пустой target или target удалённого коннектора
// (DOCS/decisions/075, 078, 094 — в проекте остался только pi)
const any = require('./any.js');
const cooldown = require('./cooldown.js');
const outsideBrowser = require('./outside-browser.js');

const DEFAULT_AGENT = 'pi';

// Слаг CLI → его имя, наполняется созданием коннектора. Живёт на уровне модуля
// ради одного потребителя: слой базы (sessions-db.js) открывается раньше
// коннекторов и зовёт agentNameByTarget при записи каждой строки, поэтому
// функция должна быть доступна и до create()
const namesBySlug = new Map();

// Какой CLI вёл сессию, видно по её target: id цели коннектора начинается с
// его слиги (SYSTEM/cli/any.js). Сессии удалённых коннекторов (opencode-windows)
// отдают DEFAULT_AGENT — их target никто не узнает, а история читается целиком.
// Чистая функция строки: ею пользуется и слой базы, который подключается раньше
// коннекторов
function agentNameByTarget(targetId) {
    if (!targetId) return DEFAULT_AGENT;
    return namesBySlug.get(String(targetId).split('-')[0]) || DEFAULT_AGENT;
}

function targetIdForAgent(name) {
    return `${any.slugOf(name)}-local`;
}

// create({ db, dbFns, runTurn, handoff, turnJudgment, telegramLetters, runs }):
//   db         — handle базы сессий (кулдаун кладёт записи в общую с ним базу)
//   dbFns      — функции записи сообщений, которые нужны коннектору
//   runTurn    — общая обвязка хода (SYSTEM/core/run-turn.js)
//   handoff    — продолжение сессии и пересказ истории (SYSTEM/core/handoff.js)
//   turnJudgment — необязательные локальные метаданные хода (SYSTEM/core/turn-judgment.js)
//   telegramLetters — слова для человека о поломке (telegram-letters-server.js)
//   runs       — реестр идущих ходов: «сервер уже уходит» знаем только он
//
// turnJudgment берём под тем именем, каким его передаёт server.js: с прошлым
// именем judgment в разборе аргументов он был undefined во всём этом слое,
// и суждение уезжало вместе с ходом.
//
// Сборка слоя целиком, а не только таблица коннекторов, потому что части связаны
// одной логикой: ход начинается здесь и идёт в коннектор по имени, а память о
// поломке — рядом с ним. Разложить это по файлам можно было бы, но тогда каждая
// часть брала бы половину соседней через require.
function create({ db, dbFns, runTurn, handoff, turnJudgment, telegramLetters, runs, desktopSessions }) {
    const deps = { runTurn, resumeAndHandoff: handoff.resumeAndHandoff, db: dbFns, desktopSessions };
    const agents = {};

    function byName(name) {
        const key = String(name || '').trim();
        if (!agents[key]) {
            agents[key] = any.create(deps, key);
            namesBySlug.set(agents[key].slug, key);
        }
        return agents[key];
    }

    // Память о недоступных исполнителях (DOCS/decisions/071). Записывается поломкой
    // и больше ничего не решает: кого звать — решает человек в строке выбора
    const cooldowns = cooldown.create({ db, reasonText: telegramLetters.reasonText });

    // Ход ведёт тот, кого назвали в строке выбора над сессией, и ровно один раз
    // (DOCS/decisions/097). Подхвата нет: раньше сломанного исполнителя сменял
    // первый подключённый, и тот получал модель мёртвого — «kilo/stealth/
    // space-bunny-alpha» уходило в pi, который такого пути не знает, и ход падал
    // с «Model not found». Слово из уровня CLI уходит в CLI буквально тем же
    // словом: сломалось — человек видит настоящую ошибку и решает сам.
    //
    // started — завелся ли ход вообще (отказ до старта в базу не попадает, и без
    // этого признака отказ не отличить от ответа); failure — ошибка того, кого
    // звали. Разбором причины занимается run-turn сам, здесь она нужна только
    // для памяти о недоступных
    async function ask(name, params, onEvent) {
        let failure = null;
        let started = false;
        await byName(name).ask(params, (event) => {
            if (event.type === 'session') started = true;
            if (event.type === 'error') failure = event.error;
            onEvent(event);
        });
        if (failure) {
            const known = turnJudgment && typeof turnJudgment.knownFailure === 'function'
                ? turnJudgment.knownFailure(failure)
                : null;
            cooldowns.record(name, null, known?.reason);
            return { failure, started };
        }
        return { failure: null, started: true };
    }

    // ход, начатый не из браузера: ответ человека в Telegram продолжает ту же
    // сессию или заводит новую
    const outside = outsideBrowser.create({
        agents,
        agentByName: byName,
        agentNameByTarget,
        ask,
        turnJudgment,
        db: dbFns,
        runs,
    });

    return {
        agents,
        cooldowns,
        byName,
        agentNameByTarget,
        ask,
        // ответ человека в личке / новая работа оттуда же
        askOutsideBrowser: outside.ask,
        startOutsideBrowser: outside.startNew,
    };
}

// Наружу отдаётся и разбор цели сессии: его зовёт слой базы (server.js), и он
// открывается раньше, чем коннекторы созданы
module.exports = { create, agentNameByTarget, targetIdForAgent, DEFAULT_AGENT };
