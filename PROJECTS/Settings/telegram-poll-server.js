// Длинный опрос Telegram: один getUpdates на весь процесс, позиция очереди в
// базе и аккуратная пересменка, когда тот же ключ опрашивает кто-то ещё.
//
// Вынесено отдельно от telegram-server.js (DOCS/decisions/022): это отдельная
// задача с отдельными числами — таймаут опроса, окно пересменки, окно
// перезапуска. Мост отвечает за разговор, опрос — за то, как он вообще живёт.
//
// Опрос всегда ровно один: у Telegram на бота может висеть только один
// getUpdates, поэтому переживать его надо аккуратно. Флага pollRun мало: он
// снова становится «включено» к моменту, когда висящий запрос вернётся, и прошлый
// цикл оживает вторым опросом. Поэтому висящий запрос ещё и гасится — pollAbort.

const POLL_TIMEOUT_S = 50;      // длинный опрос: ответ приходит сразу, как только есть сообщение
const POLL_RETRY_MS = 5000;     // сеть отвалилась — не долбим Telegram в цикле
const CONFLICT_RETRY_MS = 2000; // пересменка: ключ отвоёвывается быстрее обычной ошибки
// poll_answer — голос в опросе-вопросе (telegram-polls-server.js); без явного списка
// Telegram присылал бы и то, что мосту не нужно
const ALLOWED_UPDATES = ['message', 'poll_answer', 'callback_query'];
// Пересменка длится ровно столько, сколько у Telegram живёт опрос прошлого
// процесса: наш сторож гасит сервер на каждой правке *-server.js, а висевший
// getUpdates Telegram отпускает не в момент смерти процесса, а по своему
// таймауту — до POLL_TIMEOUT_S. Прежние 30 секунд были короче этого окна,
// и обычный перезапуск успевал обвинить человека в чужом боте
const CONFLICT_GRACE_MS = (POLL_TIMEOUT_S + 15) * 1000;
const CONFLICT_IDLE_MS = 60000; // дальше не тянем ключ на себя каждые две секунды
// Сколько простоя ещё считается перезапуском, а не «сервер лежал полдня».
// Внутри окна мост продолжает очередь с сохранённой позиции и разбирает всё,
// что человек прислал, пока процесс поднимался; за окном — по-прежнему
// выбрасывает хвост, иначе разом запустится ход на каждое старое сообщение
const RESUME_WINDOW_MS = 15 * 60 * 1000;

const CONFLICT_HINT = 'The same bot token is polled somewhere else — stop that instance or get a new token from @BotFather. Until then messages reach the bridge at random.';

module.exports = function createPolling({ callApi, db, handleUpdate, onError }) {
    // null — «хвост ещё не знаем»: пока он не выяснен, накопившееся за простой не
    // разгребаем. Раньше хвост узнавался отдельным запросом до цикла, и его провал
    // (а первый запрос после перезапуска как раз и упирается в Conflict) молча
    // оставлял offset = 0 — то есть весь бэклог старых сообщений, каждое из
    // которых запускало настоящий ход. Теперь этот запрос — такая же итерация
    // цикла, с общей обработкой ошибок и повтором
    let offset = null;
    let pollRun = 0;
    let pollAbort = null;   // висящий запрос: его гасим, а не ждём его конца

    // Conflict от Telegram означает: этот же ключ опрашивает кто-то ещё. При
    // перезапуске сервера это норма и длится секунды — новый процесс перебивает
    // опрос старого, — поэтому первые CONFLICT_GRACE_MS про драку молчим и быстро
    // возвращаемся за своим опросом. Если она не кончается, дело не в нас: где-то
    // живёт второй бот с тем же ключом, и красная строка должна говорить именно
    // это, а не пересказывать Telegram.
    //
    // Затянувшуюся драку не продолжаем: каждый наш запрос обрывает чужой опрос, а
    // чужой — наш, и сообщения достаются то одному, то другому. Победить нельзя —
    // ключ у Telegram один на бота, — поэтому вместо перетяжки каждые две секунды
    // переходим на редкую проверку раз в минуту: чужой экземпляр перестанем рвать,
    // а если он исчезнет, мост поднимется сам, без захода в настройки
    let conflictSince = null;

    function sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    function resumeOffset() {
        const row = db.readOffset.get();
        if (!row) return null;
        const age = Date.now() - Date.parse(row.at);
        if (!Number.isFinite(age) || age > RESUME_WINDOW_MS) return null;
        return row.value;
    }

    async function pollLoop(myRun) {
        while (pollRun === myRun) {
            try {
                const startedAt = Date.now();
                pollAbort = new AbortController();
                // первый заход только узнаёт хвост очереди (offset: -1, без ожидания)
                if (offset === null) offset = resumeOffset();
                const skipping = offset === null;
                const updates = await callApi(
                    'getUpdates',
                    skipping
                        ? { offset: -1, timeout: 0, allowed_updates: ALLOWED_UPDATES }
                        : { offset, timeout: POLL_TIMEOUT_S, allowed_updates: ALLOWED_UPDATES },
                    skipping ? 15000 : (POLL_TIMEOUT_S + 15) * 1000,
                    pollAbort.signal,
                );
                if (pollRun !== myRun) return; // опрос сменили, пока запрос висел
                conflictSince = null;
                onError(null);
                if (skipping) {
                    offset = updates?.length ? updates[updates.length - 1].update_id + 1 : 0;
                    db.saveOffset.run(offset, new Date().toISOString());
                    continue;
                }
                for (const update of updates || []) {
                    offset = update.update_id + 1;
                    // позицию запоминаем до разбора: ход идёт часами, а перезапуск
                    // может случиться в любую секунду — переразобрать одно и то же
                    // сообщение хуже, чем потерять его
                    db.saveOffset.run(offset, new Date().toISOString());
                    // ход может идти часами — опрос его не ждёт, иначе следующие
                    // сообщения человека молча копились бы до конца работы
                    const handled = update.poll_answer ? handleUpdate.pollAnswer(update.poll_answer) : handleUpdate(update);
                    handled.catch((err) => { onError(err.message); });
                }
                // длинный опрос обязан висеть до POLL_TIMEOUT_S, но между нами и
                // Telegram бывает прокси, который отвечает пустотой сразу же —
                // без этой паузы цикл превращался бы в холостую молотилку
                if (Date.now() - startedAt < 1000) await sleep(1000);
            } catch (err) {
                if (pollRun !== myRun) return; // ключ сменили прямо во время запроса
                if (!/conflict/i.test(err.message)) {
                    conflictSince = null;
                    onError(err.message);
                    await sleep(POLL_RETRY_MS);
                    continue;
                }
                if (conflictSince === null) conflictSince = Date.now();
                const handover = Date.now() - conflictSince < CONFLICT_GRACE_MS;
                onError(handover ? null : CONFLICT_HINT);
                await sleep(handover ? CONFLICT_RETRY_MS : CONFLICT_IDLE_MS);
            }
        }
    }

    function stop() {
        pollRun += 1;           // всё, что крутилось до этого, больше не наше
        pollAbort?.abort();
        pollAbort = null;
    }

    // накопившееся за время простоя не разгребаем: сессии тех сообщений давно
    // закончились, а отвечать на позавчерашнее «ок» новым ходом — сюрприз.
    // Сам пропуск делает первая итерация цикла (offset = null)
    function start() {
        stop();
        offset = null;
        conflictSince = null; // новый опрос — новая пересменка, чужой счётчик ему не судья
        pollLoop(pollRun);
    }

    return { start, stop, sleep };
};