// Идущие ходы: реестр, поток событий живым слушателям и ответ сторожу на
// перезапуск. Один модуль потому, что все три вещи живут одним и тем же
// состоянием — числом идущих ходов: им же меряется, можно ли серверу сейчас
// умереть (DOCS/decisions/020).
//
// Сессии работают параллельно: новый ход стартует сразу, не дожидаясь уже идущих,
// и файлы под ним не блокируются. Одновременную правку одного файла двумя
// агентами сервер не разруливает и ходы друг от друга не удерживает.
const { killTree } = require('../cli/spawn.js');

// sendJson/NDJSON — обычный отказ вместо оборванного соединения: страница
// покажет его как ошибку хода, а человек повторит через пару секунд
const RESTART_ERROR = 'The server is restarting after a code change — send it again in a few seconds';

// Ход, у которого процесса уже нет, а запись осталась: останавливать нечего,
// поэтому говорим human-language тем же текстом, что и при остановке живого
const STOPPED_TEXT = 'Stopped by the user';

// create({ releaseTelegram }): отпустить телеграм перед смертью процесса.
// Аргументом, а не require внутрь: ядро не должно знать про фичи — единственное
// место, которое знает о них, это server.js
function create({ releaseTelegram }) {
    // сколько ходов идёт прямо сейчас: по этому числу откладывается и перезапуск
    // сервера, и пересборка карты
    let running = 0;

    // идущие ходы по их номеру запуска: остановка берёт отсюда child, панель
    // Sessions — заголовок и момент старта, Home — сколько их вообще
    const activeRuns = new Map(); // runId -> { sessionId, child, done, target, startedAt }
    let nextRunId = 1;

    // запущенные сейчас запросы: id сессии -> { listeners, events, seq }.
    // страницу могли перезагрузить, и она подключается к уже идущей работе.
    // events — события этого хода с порядковым номером seq: подключившийся называет
    // номер последнего события, которое видел (after), и получает всё, что было
    // после него, — иначе события между обрывом связи и переподключением в живую
    // ленту не попадали вовсе. Буфер живёт ровно ход и ограничен RUN_BUFFER_MAX:
    // вытесненное из него клиент доберёт из базы (seq первого события в буфере
    // больше after + 1 — знак, что пора перечитать /api/sessions/messages)
    const runs = new Map();
    const RUN_BUFFER_MAX = 5000;

    // sessionId известен не всегда (CLI ещё не прислал id для только что стартовавшего
    // запуска) — тогда останавливаем самый свежий безымянный: неоднозначность возможна,
    // только если два новых запуска стартовали в одну и ту же секунду
    function stop(sessionId) {
        const candidates = [...activeRuns.values()];
        const target = sessionId
            ? candidates.find((r) => r.sessionId === sessionId)
            : candidates.filter((r) => !r.sessionId).pop();
        if (!target) return false;

        // Процесс ещё жив — обычное дело: гасим дерево, конец хода сделает его
        // собственная уборка. exitCode !== null — процесс уже отработал,
        // а запись в реестре осталась (ход упал раньше своей уборки): тогда
        // killTree не делает ничего, и кнопка Stop выглядит как мёртвая, а сессия
        // остаётся «идущей» навсегда, блокируя перезапуск сервера. В этом случае
        // снимаем запись сами — иначе остановить такую сессию нечем
        if (target.child && target.child.exitCode === null && target.child.signalCode === null) {
            target.child.__stoppedByUser = true;
            // не target.child.kill(): на Windows сигналами потомков не добить — гасим дерево
            killTree(target.child);
            return true;
        }

        // процесс мёртв, а ход числится идущим: отпускаем всё, что он держит
        for (const [runId, run] of activeRuns) {
            if (run === target) activeRuns.delete(runId);
        }
        if (target.sessionId) {
            // событие обрыва — страница перестаёт ждать поток; обязательно ДО close,
            // потому что close удаляет подписки, и после него broadcast уже некому
            // и нечего раздавать
            broadcast(target.sessionId, { type: 'error', error: STOPPED_TEXT });
            close(target.sessionId);
        }
        if (running > 0) running -= 1; // снятие занятости: иначе перезапуск ждёт вечно
        confirmRestart();
        return true;
    }

    function beginRun(run) {
        const runId = nextRunId++;
        activeRuns.set(runId, run);
        return runId;
    }

    function endRun(runId) {
        activeRuns.delete(runId);
    }

    const activeCount = () => activeRuns.size;
    const busyCount = () => running;

    // момент старта текущего хода активной сессии (для живого тикающего счётчика
    // в панели Sessions) — null, если по этой сессии сейчас ничего не выполняется.
    // Один и тот же sessionId вторым активным ходом на практике не бывает (composer
    // блокируется на время хода), первое совпадение достаточно
    function activeStartedAt(sessionId) {
        for (const run of activeRuns.values()) {
            if (run.sessionId === sessionId) return run.startedAt || null;
        }
        return null;
    }

    // заголовки идущих ходов — для ответа «что там» в Telegram
    function activeTitles(titleOf) {
        return [...activeRuns.values()]
            .map((run) => run.sessionId && titleOf(run.sessionId))
            .filter(Boolean);
    }

    // нумерует событие хода и кладёт его в буфер; возвращает то, что уходит наружу
    function stampEventSeq(sessionId, event) {
        const live = runs.get(sessionId);
        if (!live) return event;
        const stamped = { ...event, seq: ++live.seq };
        live.events.push(stamped);
        if (live.events.length > RUN_BUFFER_MAX) live.events.shift();
        return stamped;
    }

    function broadcast(sessionId, event) {
        const live = runs.get(sessionId);
        if (!live) return;

        const line = JSON.stringify(event) + '\n';
        for (const res of live.listeners) res.write(line);
    }

    // кусок текста по мере набора: в буфер хода не идёт и номера не получает —
    // это черновик, который целиком заменит обычное событие text/thinking;
    // иначе куски вытеснили бы из буфера настоящие события
    function emitLive(sessionId, event) {
        const live = sessionId && runs.get(sessionId);
        if (!live) return;
        const line = JSON.stringify(event) + '\n';
        for (const res of live.listeners) if (res.__deltas) res.write(line);
    }

    const isRunning = (sessionId) => runs.has(sessionId);
    const liveSeq = (sessionId) => runs.get(sessionId)?.seq ?? null;

    function open(sessionId) {
        runs.set(sessionId, { listeners: new Set(), events: [], seq: 0 });
    }

    // работа окончена — отпускаем подключившиеся страницы
    function close(sessionId) {
        for (const listener of runs.get(sessionId)?.listeners || []) listener.end();
        runs.delete(sessionId);
    }

    // подписка страницы на идущий ход: догоняем пропущенное по after и дальше
    function attach({ req, res, id, after, deltas }) {
        const live = runs.get(id);
        if (!live) return false;

        res.writeHead(200, {
            'Content-Type': 'application/x-ndjson; charset=utf-8',
            'Cache-Control': 'no-store',
        });
        // after — номер последнего события, которое клиент уже видел (или
        // liveSeq из /api/sessions/messages, если он только что прочитал
        // базу). Без него — как раньше: только то, что случится дальше.
        // Запись и подписка идут в одном такте, между ними событие не влезет
        if (Number.isFinite(after)) {
            for (const event of live.events) {
                if (event.seq > after) res.write(JSON.stringify(event) + '\n');
            }
        }
        // куски текста по мере набора нужны только ленте Sessions: Feed и Flow
        // перечитывают базу на каждый пришедший байт, а в базе кусков нет
        if (deltas) res.__deltas = true;
        live.listeners.add(res);
        // res, а не req: у запроса с телом close приходит сразу после чтения тела
        // (Node 16+), и слушатель отписывался до первого события — досмотр хода
        // после переподключения не получал ничего (тело запроса тут всегда есть)
        res.on('close', () => live.listeners.delete(res));
        return true; // ответ закроется, когда закончится работа
    }

    // ---------- перезапуск после правки: решение за сервером ----------
    // Сторож правку только объявляет, а гасить процесс просит нас: он не видит,
    // идёт ли ход и не начинается ли новый прямо сейчас. Отвечаем «можно» ровно
    // в тот момент, когда последний ход дописан в базу, и с этого же мгновения
    // новых ходов не берём — щели между «ходов нет» и смертью процесса не остаётся
    let restartRequested = false;
    let stopping = false; // ответ сторожу уже отправлен: процесса вот-вот не станет

    async function confirmRestart() {
        if (!restartRequested || stopping || running > 0) return;
        stopping = true;
        // опрос телеграма отпускаем до смерти процесса и ждём, пока он отпустится:
        // Telegram держит getUpdates своим таймаутом, а не смертью клиента, и снять
        // его может только наш же прощальный запрос. Не дождавшись, мы бы убили его
        // вместе с процессом, и следующий запуск встретил бы Conflict вместо
        // сообщений (require кэширован — это тот же модуль, что и у server.js).
        // Ожидание ограничено внутри самого stop(): недоступный Telegram перезапуск
        // не держит. Зовут нас без await, поэтому своей ошибкой отсюда наружу
        // выходить нельзя — необработанный отказ гасит сервер целиком
        try {
            await releaseTelegram();
        } catch (err) {
            console.error('Telegram release on restart:', err.message);
        }
        process.send({ readyToRestart: true }, () => {}); // колбэк: закрытый канал не должен ронять сервер
    }

    if (process.send) {
        process.on('message', (message) => {
            if (!message || !message.prepareRestart) return;
            restartRequested = true;
            confirmRestart();
        });
    }

    // счётчик идущих ходов: по нему откладывается и пересборка карты, и перезапуск.
    // сколько отложенный перезапуск ждёт письмо о конце хода — см. run-turn.js
    function busy(delta) {
        running += delta;
        if (running === 0) confirmRestart();
    }

    return {
        busy, busyCount,
        // ответ сторожу уже ушёл: новый ход запускать нельзя, ход умрёт вместе
        // с процессом, не дописавшись ответ
        isStopping: () => stopping,
        restartError: RESTART_ERROR,
        beginRun, endRun, stop, activeCount, activeStartedAt, activeTitles,
        open, close, isRunning, liveSeq, attach,
        stampEventSeq, broadcast, emitLive,
    };
}

module.exports = { create, RESTART_ERROR };