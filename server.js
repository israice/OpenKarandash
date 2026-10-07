// Точка входа сервера: только сборка.
//
// Всё, что относится к конкретной теме, живёт в своём модуле и подключается
// здесь одним вызовом create(...): .env и платформа (SYSTEM/core/env.js),
// сторож перезапуска (watchdog.js), живая перезагрузка (watch.js), приём
// запросов (http-server.js, api.js), общий слой хода (runs.js, run-turn.js,
// handoff.js), маршруты агентов и сессий и агентский слой (SYSTEM/cli/).
// Серверная половина фичи живёт рядом с фичей и приходит таблицей маршрутов
// (DOCS/decisions/022 — один файл, одна тема; раскладка — DOCS/decisions/017).
//
// Ниже по файлу две половины: сначала родительский процесс (сторож, запросов не
// обслуживает), затем дочерний — собственно сервер. Граница проходит через
// `return`, и всё, что нужно только дочернему (база, коннекторы, маршруты),
// подключается после неё: родительский процесс базу открывать не должен.
const env = require('./SYSTEM/core/env.js');
const watchdog = require('./SYSTEM/core/watchdog.js');
const turnJudgment = require('./SYSTEM/core/turn-judgment.js');
const branchPreview = require('./SYSTEM/core/branch-preview.js');
const cliIndex = require('./SYSTEM/cli/index.js');

const ROOT = __dirname;

// .env читается раньше всего: порт, режим перезагрузки и секреты живут в нём.
// Файла нет — создаём его с портом 3001 (env.js), значения из него не перетирают
// то, что уже задано в окружении
env.loadEnv();

const { detectRuntimePlatform, logExit, setEnvValue } = env;

const PORT = Number(process.env.PORT) || 3001;
const LIVE_RELOAD = process.env.NO_RELOAD !== '1';
const POLL_MS = 400; // как часто сверяем время изменения файлов

// ---------- родительский процесс ----------
//
// Node читает файл один раз при старте, поэтому сервер работает в дочернем
// процессе, а родительский следит за серверными файлами и поднимает дочерний
// заново после правок. Момент смерти выбирает сам сервер: сторож шлёт ему
// prepareRestart и гасит процесс только по ответу readyToRestart
// (DOCS/decisions/020). NO_RELOAD=1 сторож отключает — тогда сервер один.
if (LIVE_RELOAD && !process.env.SERVER_CHILD) {
    watchdog.run({ serverFile: __filename, pollMs: POLL_MS, logExit });
    return; // код ниже выполняется только в дочернем процессе
}

// ---------- дочерний процесс: сервер ----------

watchdog.acquireLock();

// исключение вне обработчика запроса (таймер пересборки карты, колбэк процесса CLI)
// иначе гасит сервер без следа: сторож видит только код выхода, а стек уходит
// в закрытое окно терминала
//
// uncaughtException — состояние процесса неизвестно, падаем. А вот
// unhandledRejection раньше ронял сервер так же: ошибка в фоновой задаче (перебор
// моделей, суждение о ходе, запись в базу) уносила все открытые вкладки с
// «Failed to fetch», хотя виновным был один фоновой вызов. Записываем и живём
// дальше — все пути запросов уже ловят свои ошибки сами (SYSTEM/core/api.js)
process.on('uncaughtException', (error) => {
    logExit(`uncaughtException: ${(error && error.stack) || error}`);
    console.error(error);
    process.exit(1);
});
process.on('unhandledRejection', (reason) => {
    logExit(`unhandledRejection: ${(reason && reason.stack) || reason}`);
    console.error(reason);
});

const graph = require('./PROJECTS/Graph/graph-server.js');

// телеграм-мост Settings: ему нужен и .env (ключ бота), и способ начать ход
// не из браузера — ответ человека в личке продолжает ту же сессию
const telegram = require('./PROJECTS/Settings/telegram-server.js');
// stop и status нужны мосту затем, что не всякое сообщение из Telegram — это
// поручение: «стоп» и «что там» раньше запускали настоящий ход (DOCS/decisions/054)
const telegramLetters = require('./PROJECTS/Settings/telegram-letters-server.js');

// слой базы — SYSTEM/core/sessions-db.js (DOCS/decisions/022): файл SQLite,
// схема, заготовленные запросы и функции записи сообщений. Подключается здесь,
// после границы процессов: базу открывает только тот, кто её реально читает.
// Таблица агентов живёт в SYSTEM/cli/index.js, поэтому «какой CLI вёл сессию»
// передаётся функцией: она объявлена как function и потому уже доступна
const {
    db, upsertSession, getCliSession, setCliSession, upsertMessage, setMessageToolResult,
    setMessageToolIds, setMessageMode, setMessageInputSent, setMessageExtraMeta, touchSession,
    setSessionThumb, getSessionThumb, setSessionContext, setSessionInfo, setSessionRateLimit,
    setMessageCreatedAt, lastMessageTime, getSessionMeta, getSessionTitle, getLastTurnParams,
    listSessions, listMessages, sumSessionUsage, countMessages, listToolSteps,
    countToolSteps, getMessageRole, setMessageText, clip, toolResultText, toolResultImages, resetSessions,
    deleteSession, stampEvent, appendRaw, startExchange, extractTitle, sessionTitle, recordStep,
    recordHookStart, recordHookResponse, recordThinking, recordAssistantText, recordNotice,
    recordUnknownPart, recordSystemEvent, recordTopLevelEvent, finishExchange, originOfTarget,
} = require('./SYSTEM/core/sessions-db.js').open({
    ROOT, DATA_DIR: graph.DATA_DIR, agentNameByTarget: cliIndex.agentNameByTarget,
});

// карта проекта (vault Obsidian) живёт в PROJECTS/Graph; здесь остаётся только её
// запуск — маршруты папка отдаёт сама (graph.createRoutes в featureRoutes ниже)
const { prepareVault, scheduleMapUpdate } = graph.init({
    listSessions,
    listMessages,
    sessionTitle,
    sumSessionUsage,
    onMapReady: () => { if (watch.clientCount()) watch.notifyClients('map'); },
});

// реестр идущих ходов: им же меряется занятость, им же отвечают запросам
// /api/agent/stop и /api/sessions/attach, им же решается, можно ли серверу
// сейчас умереть. Отпустить телеграм перед смертью — дело моста, а не ядра,
// поэтому он приходит аргументом
const runs = require('./SYSTEM/core/runs.js').create({
    releaseTelegram: () => telegram.stop(),
});

// Пересборка карты под тем именем, под каким её знают остальные (run-turn,
// sessions-routes): звать им «график» не нужно, нужен один способ сказать
// «карта стала неправдой». Занятость ходом знает только сервер, поэтому она
// подставляется здесь, а не спрашивается у каждого зовущего
const map = { scheduleMapUpdate: () => scheduleMapUpdate(() => runs.busyCount() > 0) };

// живая перезагрузка: канал до страницы, её скрипт и опрос коммитов, по которому
// события возникают. Карту он не собирает — этим владеет PROJECTS/Graph: по
// коммиту карта стала неправдой, но собирать её не его дело
const watch = require('./SYSTEM/core/watch.js').create({
    root: ROOT,
    pollMs: POLL_MS,
    onCommit: () => map.scheduleMapUpdate(),
});

// слой CLI и телеграм-мост замыкают друг на друга: ход зовёт подхват исполнителя,
// а мост умеет начать ход не из браузера. Обе ссылки разрешаются в момент вызова —
// к тому моменту, когда что-то зовётся, слой уже собран
let cli = null;
let bridge = null;

const handoff = require('./SYSTEM/core/handoff.js').create({
    getCliSession,
    listMessages,
    clip,
    turnJudgment,
    planPreamble: () => bridge.planPreamble(),
});

const runTurn = require('./SYSTEM/core/run-turn.js').create({
    startExchange,
    setMessageMode,
    // без этой функции runTurn нечем записать, что реально ушло модели: ctx.noteInput
    // звал setMessageInputSent.run(...), а её в списке не было, и поле input_sent
    // оставалось пустым во всех ходах, включая живые (DOCS/decisions/092)
    setMessageInputSent,
    setCliSession,
    finishExchange,
    // цель хода — источник его строк: сессию можно продолжить другим CLI, а
    // колонка target в sessions при смене не перебивается, и по ней ход
    // подписывался прежним исполнителем (DOCS/decisions/043)
    originOfTarget,
    countToolSteps,
    listToolSteps,
    getSessionTitle,
    recordThinking,
    // без recordNotice пометки хода («продолжил», «остановлен по лимиту»)
    // жили только в ленте до перезагрузки страницы, и три отображения
    // разходились (DOCS/decisions/039)
    recordNotice,
    setMessageText,
    appendRaw,
    clip,
    turnJudgment,
notifyTurnFinished: (letter) => bridge.notifyTurnFinished(letter),
runs,
    map,
    live: watch,
});

cli = cliIndex.create({
    db,
    dbFns: {
        recordAssistantText, recordStep, setMessageToolResult, appendRaw, clip,
        getSessionTitle, getSessionMeta, getLastTurnParams, listMessages,
    },
    runTurn,
    handoff,
    turnJudgment,
    telegramLetters,
    runs,
});

// хранилище вкладки Flow (PROJECTS/Flow/flow.js) живёт на сервере, а не в
// localStorage браузера — его маршруты подключаются в featureRoutes ниже
bridge = telegram.init({
    setEnvValue,
    ask: cli.askOutsideBrowser,
    startNew: cli.startOutsideBrowser,
    db,
    stop: (sessionId) => runs.stop(sessionId || null),
    // для вопроса опросом (telegram-polls-server.js): спросить можно только живую
    // сессию, а ответ ждёт, пока она освободится
    sessionExists: (id) => Boolean(getSessionTitle.get(id)),
    isRunning: (id) => runs.isRunning(id),
    status: () => ({
        running: runs.activeCount(),
        titles: runs.activeTitles((id) => getSessionTitle.get(id)?.title),
    }),
});

// сводка по сессиям для списков и панелей — её читают Sessions и маршруты
const sessionList = require('./SYSTEM/core/session-list.js').create({
    listSessions,
    sessionTitle,
    runs,
});

// серверные половины фич: каждая заводит свои таблицы сама и отдаёт готовую
// таблицу маршрутов. server.js их только собирает и не знает, что внутри.
// Список ниже — единственное место, где ядро знает про фичи вообще.
// Вкладка Kanban сейчас чистая UI-заготовка без сервера — своих маршрутов не
// заводит, вид меняется по шагам пользователя (DOCS/decisions/032, отменяет 030 и 021)
const featureRoutes = {
    ...graph.createRoutes(),
    ...require('./PROJECTS/Flow/flow-server.js').createRoutes({ db }),
    ...require('./PROJECTS/Sessions/pages-server.js').createRoutes({ db, root: ROOT }),
    // список CLI-агентов с сайта OpenRouter для секции «New projects» на
    // странице Page 3 (PROJECTS/Page 3/page.js) — с копией в DATA, чтобы
    // сайт не дёргать, пока список не отличается от нашего
    ...require('./PROJECTS/Page 3/openrouter-cli-agents-server.js').createRoutes({ root: ROOT }),
    ...require('./PROJECTS/Sessions/sessions-server.js').createRoutes({
        sessions: sessionList.sessionSummaries,
        usage: (id) => sumSessionUsage.get(id),
        activeStartedAt: sessionList.activeStartedAt,
    }),
    ...require('./PROJECTS/Karandash/karandash-server.js').createRoutes({ setEnvValue }),
    ...telegram.createRoutes(),
    ...require('./PROJECTS/Book/book-server.js').createRoutes(),
    ...require('./PROJECTS/Settings/settings-server.js').createRoutes(),
    ...require('./SYSTEM/toolbar-icons-server.js').createRoutes({ db }),
    // верхнее меню страницы: шаблон SYSTEM/topbar.eta подставляется в страницу
    // ещё и при отдаче (SYSTEM/core/version.js), маршрут отдаёт его же
    ...require('./SYSTEM/topbar-server.js').createRoutes(),
    ...branchPreview.createRoutes({ root: ROOT }),
    // два набора ничьих маршрутов: запуск любого CLI и общее хранилище переписок
    // (DOCS/decisions/017). Оформлены так же, как фичи, — таблицей путь → обработчик
    ...require('./SYSTEM/core/agent-routes.js').createRoutes({
        agents: { byName: cli.byName, ask: cli.ask },
        cooldowns: cli.cooldowns,
        turnJudgment,
        runs,
    }),
    // разведка установленных CLI для строки выбора в шапке сессии: одним запросом
    // спрашивает сервер про все имена сразу, чтобы строка могла красить доступные
    // пункты (SYSTEM/cli/scan-server.js, SYSTEM/cli-scan.js)
    ...require('./SYSTEM/cli/scan-server.js').createRoutes({ agents: cli.agents }),
    ...require('./SYSTEM/core/sessions-routes.js').createRoutes({
        db: {
            resetSessions, deleteSession, setSessionThumb, getSessionThumb, getMessageRole, setMessageText,
            getSessionMeta, listMessages, sumSessionUsage,
        },
        list: sessionList,
        map,
        runs,
    }),
};

// ---------- сервер ----------

const api = require('./SYSTEM/core/api.js').createApi(featureRoutes);
const server = require('./SYSTEM/core/http-server.js').createServer({
    root: ROOT,
    liveReload: LIVE_RELOAD,
    reload: watch,
    api,
    branch: branchPreview,
});

// порт ровно один — тот, что записан в .env. соседние не пробуем: вторая копия
// сервера на той же папке дерётся за .sessions.db и .index.db («database is locked»)
// и вслепую перезаписывает vault/
server.on('error', (err) => {
    if (err.code !== 'EADDRINUSE') throw err;
    console.error(`Port ${PORT} is busy — the server is most likely already running: http://localhost:${PORT}`);
    console.error('A different port is set with the PORT= line in .env');
    process.exit(watchdog.EXIT_PORT_BUSY); // отдельный код: по нему сторож понимает, что ждать правок бессмысленно
});

// слушаем только loopback: порт не открывается для сети, а проверки в коде
// (isLocalRequest, Host, Origin — DOCS/decisions/103) остаются вторым рубежом
server.listen(PORT, '127.0.0.1', () => {
    // prepareVault() синхронна и на этом проекте занимает ~20 с: пока она идёт,
    // event loop занят и сокет никому не отвечает. Поэтому «Сервер запущен»
    // печатается после неё — иначе человек идёт на порт, который молчит,
    // и получает таймаут вместо страницы
    console.log('Building the project map — this takes a few seconds...');
    prepareVault();
    console.log(`Server started: http://localhost:${PORT} (runtime: ${detectRuntimePlatform()})`);

    if (LIVE_RELOAD) {
        watch.start();
        console.log('Auto-reload is on — the page reloads once per commit.');
    }
});