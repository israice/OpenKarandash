// Идущие ходы: реестр, поток событий живым слушателям и ответ сторожу на
// перезапуск. Один модуль потому, что все три вещи живут одним и тем же
// состоянием — ходами в реестре: им же меряется, можно ли серверу сейчас умереть
// (DOCS/decisions/020, 085).
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
    // Идущие ходы по их номеру запуска: остановка берёт отсюда child, панель
    // Sessions — заголовок и момент старта, Home — сколько их вообще.
    //
    // Реестр один на все состояния хода, и снимает ход одна функция (finishTurn).
    // Отдельного счётчика «сколько ходов идёт» больше нет: он считал то же самое
    // вторым способом и расходился с реестром — ход, упавший мимо своей уборки,
    // оставался «идущим» навсегда и блокировал перезапуск (DOCS/decisions/085).
    // Держать запись дольше, чем ход идёт, тоже можно: у записи два состояния,
    // finished (работа кончена) и released (занятость снята), и она уходит из
    // реестра только когда выполнены оба
    const turns = new Map(); // runId -> { runId, sessionId, child, target, startedAt, finished, released }
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
    //
    // Ищем только среди не закончивших ходов: у ждущего письма процесса уже нет,
    // и останавливать нечего
    function stop(sessionId) {
        const candidates = liveTurns();
        const target = sessionId
            ? candidates.find((r) => r.sessionId === sessionId)
            : candidates.filter((r) => !r.sessionId).pop();
        if (!target) return false;

        // Процесс ещё жив — обычное дело: гасим дерево, конец хода сделает его
        // собственная уборка. exitCode !== null — процесс уже отработал,
        // а ход числится идущим (упал раньше своей уборки): тогда killTree не
        // делает ничего, и кнопка Stop выглядит как мёртвая, а сессия остаётся
        // «идущей» навсегда, блокируя перезапуск сервера. В этом случае снимаем
        // ход теми же двумя действиями, что и уборка хода, — они идемпотентны,
        // поэтому уборка, которая придёт позже, им ничего не испортит
        if (target.child && target.child.exitCode === null && target.child.signalCode === null) {
            target.child.__stoppedByUser = true;
            // не target.child.kill(): на Windows сигналами потомков не добить — гасим дерево
            killTree(target.child);
            return true;
        }

        // событие обрыва — страница перестаёт ждать поток; обязательно ДО finishTurn,
        // потому что тот закрывает подписки, и после него broadcast уже некому
        // и нечего раздавать
        if (target.sessionId) broadcast(target.sessionId, { type: 'error', error: STOPPED_TEXT });
        finishTurn(target);
        releaseTurn(target);
        return true;
    }

    // Ход только что начат: он виден как идущий и держит занятость. Возвращает
    // ту же запись — ход дальше снимается ею же, отдельного номера у него нет
    function beginTurn(run) {
        run.runId = nextRunId++;
        run.finished = false;
        run.released = false;
        turns.set(run.runId, run);
        return run;
    }

    // Работа хода окончена: ход больше не идёт, поток его сессии закрыт, подписи
    // отпущены. Идемпотентно — звать можно из уборки хода и из stop(), и кто
    // первый пришёл, тот и снял. Падение в уборке хода на этом уже ничего не
    // ломает: ход снят, перезапуск разблокирован
    function finishTurn(run) {
        if (!run || run.finished) return false;
        run.finished = true;
        if (run.sessionId) close(run.sessionId);
        dropFinished(run);
        confirmRestart();
        return true;
    }

    // Занятость снята: перезапуск сервера этот ход больше не ждёт. Отдельно от
    // finishTurn, потому что ход, правивший серверный файл, умирает вместе с
    // процессом — и письмо о конце работы должно уйти до этого, а не после
    function releaseTurn(run) {
        if (!run || run.released) return false;
        run.released = true;
        dropFinished(run);
        confirmRestart();
        return true;
    }

    // Запись держится, пока не выполнены оба условия. Иначе половина уборки
    // потерялась бы вместе с записью и занятость осталась бы висеть навсегда
    function dropFinished(run) {
        if (run.finished && run.released) turns.delete(run.runId);
    }

    // ходы, которые ещё идут (или ждут своего письма) — всё, что можно остановить
    const liveTurns = () => [...turns.values()].filter((r) => !r.finished);

    // сколько ходов держат сервер: перезапуск и пересборка карты откладываются
    // до нуля. Считается по реестру, а не по отдельной переменной, — иначе эти
    // два числа умели разойтись
    const busyCount = () => [...turns.values()].filter((r) => !r.released).length;

    const activeCount = () => liveTurns().length;

    // момент старта текущего хода активной сессии (для живого тикающего счётчика
    // в панели Sessions) — null, если по этой сессии сейчас ничего не выполняется.
    // Один и тот же sessionId вторым активным ходом на практике не бывает (composer
    // блокируется на время хода), первое совпадение достаточно
    function activeStartedAt(sessionId) {
        for (const run of liveTurns()) {
            if (run.sessionId === sessionId) return run.startedAt || null;
        }
        return null;
    }

    // заголовки идущих ходов — для ответа «что там» в Telegram
    function activeTitles(titleOf) {
        return liveTurns()
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
        if (!restartRequested || stopping || busyCount() > 0) return;
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
    // сколько отложенный перезапуск ждёт письмо о конце хода — см. releaseTurn
    return {
        busyCount,
        // ответ сторожу уже ушёл: новый ход запускать нельзя, ход умрёт вместе
        // с процессом, не дописавшись ответ
        isStopping: () => stopping,
        restartError: RESTART_ERROR,
        beginTurn, finishTurn, releaseTurn, stop, activeCount, activeStartedAt, activeTitles,
        open, close, isRunning, liveSeq, attach,
        stampEventSeq, broadcast, emitLive,
    };
}

module.exports = { create, RESTART_ERROR };