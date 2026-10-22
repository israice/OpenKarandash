// Приём: то, что человек написал боту, попадает в сессию — или в ту же, из
// которой он отвечает, или в новую.
//
// Вынесено отдельно от telegram-server.js (DOCS/decisions/022): это противоположная
// сторона разговора и самая длинная часть моста. Здесь живут разбор сообщения,
// решение «поручение это или ответ», запуск хода и ожидание свободной сессии.
//
// Опросы (telegram-polls-server.js) и ядро хода приходят зависимостями: модуль не
// знает ни про Telegram, ни про сессии — он только решает, что с сообщением
// делать. Опросы создаются позже моста, поэтому ставятся через setPolls.

module.exports = function createInbox({ callApi, send, db, getUsers, keyboard, letters, turnJudgment, sleep, deps }) {
    // ход из Telegram идёт долго, а опрос его не ждёт — значит, на одну сессию
    // может прилететь второе сообщение поверх незаконченного первого. Такие
    // не запускаем: в сессии должен идти один ход за раз
    const busySessions = new Set();

    let polls = null;
    function setPolls(module) { polls = module; }

    // Ответ, который мост даёт сам, не поднимая агента. Формулировки короткие:
    // это личка, а не отчёт, и читают их с телефона
    function answerWithoutTurn(intent, sessionId) {
        if (intent === 'stop') {
            const stopped = deps.stop ? deps.stop(sessionId) : false;
            return stopped ? '⏹ Остановил.' : '⏹ Останавливать нечего — эта работа уже закончена.';
        }
        if (intent === 'status') {
            const { running = 0, titles = [] } = (deps.status ? deps.status() : {});
            if (!running) return '💤 Сейчас ничего не выполняется.';
            return `⚙️ Выполняется: ${running}\n${titles.map((t) => `· ${String(t).slice(0, 80)}`).join('\n')}`;
        }
        return '👌';
    }

    // Последняя работа лички, которая ещё есть в пульте: адресат служебных слов
    // без reply («стоп», «что там») и образец для новой (likeSessionId). Удалённые
    // забываем молча: иначе служебное слово упиралось в «работа удалена», хотя
    // человек писал не в неё, а просто в личку
    function liveLastSession(chatId) {
        for (;;) {
            const sessionId = db.lastSessionOfChat.get(chatId)?.sessionId;
            if (!sessionId || deps.sessionExists(sessionId)) return sessionId || null;
            db.forgetSession.run(sessionId);
        }
    }

    // Режим хода по виду поручения: на вопрос бот уже ответил «ничего не меняя» —
    // и ход идёт обсуждением, где править и запускать нельзя. Только при высокой
    // уверенности: принять поручение за вопрос значит не выполнить его. Всё
    // остальное — Action явно, иначе режим унаследовался бы от прошлого вопроса
    // (DOCS/decisions/067)
    const ASK_MODE_CONFIDENCE = 0.85;
    function modeFor(understood) {
        return understood?.kind === 'explain' && (understood.kindConfidence ?? 0) >= ASK_MODE_CONFIDENCE ? 'Chat' : 'Action';
    }

    // Первое письмо на поручение — сразу, до исполнителя: как jev понял, какого рода
    // это дело (turn-judgment.js, вопрос kind). Исполнитель может быть слабой
    // моделью и строки [PLAN] не дать вовсе, а человеку с телефона нужен знак, что
    // его поняли верно, в первую же секунду (DOCS/decisions/064). Неуверенный или
    // недоступный jev — общее «принял»: гадать вслух хуже, чем промолчать о виде
    async function acknowledge(chatId, understood, sessionId) {
        const line = understood?.kindWords
            ? `🧭 Понял поручение как: ${understood.kindWords}. Приступаю.`
            : '🧭 Принял поручение, приступаю.';
        await send(chatId, line)
            .then((sent) => { if (sessionId) db.remember(chatId, sent.message_id, sessionId); })
            .catch(() => {});
    }

    // Поручение без reply заводит новую сессию в пульте (DOCS/decisions/132)
    async function startNewSession(chatId, text, messageId, mode) {
        const like = liveLastSession(chatId) || null;
        let created = null;
        try {
            await deps.startNew({
                text,
                mode,
                likeSessionId: like,
                note: (line) => { send(chatId, line).then((sent) => { if (created) db.remember(chatId, sent.message_id, created); }).catch(() => {}); },
                // id приходит в начале хода: сразу снимаем «новую работу» и
                // привязываем личку к сессии — следующее сообщение пойдёт уже в неё,
                // а не заведёт ещё одну
                onSession: (sessionId) => {
                    if (created) return;
                    created = sessionId;
                    busySessions.add(sessionId);
                    db.saveChatState.run(chatId, 'action', 0, new Date().toISOString());
                    // привязка сразу, по сообщению самого человека: письмо ниже
                    // может задержаться, а следующее сообщение уже в пути
                    db.remember(chatId, messageId, sessionId);
                    send(chatId, '🆕 Новая работа начата. Ответ придёт сюда.')
                        .then((sent) => db.remember(chatId, sent.message_id, sessionId))
                        .catch(() => {});
                },
            });
        } catch (err) {
            // работа не завелась — «новая работа» остаётся включённой: человек
            // повторит поручение, и оно не уйдёт в старую сессию
            await send(chatId, `⚠️ Новую работу начать не удалось: ${letters.humanReason(err.message)}.\n\nПовторите поручение, когда причина устранена.\n\nТекст ошибки: ${String(err.message).slice(0, 300)}`).catch(() => {});
        } finally {
            if (created) busySessions.delete(created);
        }
    }

    // нажатие встроенной кнопки: те же действия, что у обычной, плюс перерисовка
    // пометки на самом письме, под которым нажали
    async function handleCallback(query) {
        const chatId = String(query.message?.chat?.id ?? query.from?.id ?? '');
        if (!getUsers().includes(chatId)) return;
        const button = keyboard.BUTTONS.find((b) => `btn:${b.label}` === query.data);
        if (!button) {
            await callApi('answerCallbackQuery', { callback_query_id: query.id }).catch(() => {});
            return;
        }
        const reply = keyboard.pressButton(chatId, button);
        await callApi('answerCallbackQuery', { callback_query_id: query.id, text: reply.split('\n')[0].slice(0, 200) }).catch(() => {});
        if (query.message?.message_id) {
            await callApi('editMessageReplyMarkup', {
                chat_id: chatId,
                message_id: query.message.message_id,
                reply_markup: keyboard.inlineKeyboardFor(chatId),
            }).catch(() => {}); // «не изменилась» — не ошибка
        }
        await send(chatId, reply).catch(() => {});
    }

    async function handleUpdate(update) {
        if (update.callback_query) { await handleCallback(update.callback_query); return; }
        const message = update.message;
        // человек дописал свой вариант в опрос — это ответ на вопрос, а не текст
        if (message?.poll_option_added) {
            await polls.handleOptionAdded(message);
            return;
        }
        if (!message || !message.text) return;

        const chatId = String(message.chat?.id ?? '');
        // чужим не отвечаем вовсе: бот виден всему миру, а по этому мосту можно
        // запускать агента в проекте — пускаем только перечисленные в .env id
        if (!getUsers().includes(chatId)) return;

        // нажатие кнопки приходит её текстом: без перехвата слово «ASK» ушло бы
        // агенту настоящим поручением
        const button = keyboard.pressedButton(message.text);
        if (button) {
            // так приходит нажатие старой обычной клавиатуры или набранное руками слово;
            // ответ несёт встроенные кнопки как любое письмо бота
            await send(chatId, keyboard.pressButton(chatId, button)).catch(() => {});
            return;
        }

        const replyTo = message.reply_to_message?.message_id;
        // текст ответом на сообщение с открытым опросом — свой вариант ответа
        if (await polls.handleReply(chatId, replyTo, message.text)) return;
        const repliedSession = replyTo && db.sessionByReply.get(chatId, Number(replyTo))?.sessionId;
        // разбор «стоп / что там / спасибо» идёт до выбора адресата: нужен обоим
        // путям ниже. Неуверенный ответ — поручение, как мост вёл себя всегда
        // (DOCS/decisions/054): принять поручение за «спасибо» значит не выполнить
        const understood = await turnJudgment.classifyInbox(message.text).catch(() => ({ intent: 'task' }));
        const { intent } = understood;
        // reply — ровно в ту сессию, письма которой он адресован, даже после END:
        // человек сам назвал адресата. Поручение без reply — новая работа
        // (DOCS/decisions/132), но только когда работа этой лички не идёт: письмо
        // вдогонку идущему ходу отвечает в неё же (DOCS/decisions/062), иначе
        // погоня за ходом репликами заводила бы копию работы на каждую реплику.
        // Служебные слова («стоп», «что там», «спасибо») ходов не поднимают и работ
        // не заводят — их адресат, идущая работа, виден по последнему письму чата
        const runSession = repliedSession || liveLastSession(chatId);
        const isRunningWork = runSession && (busySessions.has(runSession) || deps.isRunning(runSession));
        const sessionId = runSession && (repliedSession || intent !== 'task' || isRunningWork) ? runSession : null;
        if (intent !== 'task') {
            await send(chatId, answerWithoutTurn(intent, sessionId)).catch(() => {});
            return;
        }
        // отвечать некуда — значит, это поручение на новую работу
        if (!sessionId) {
            await acknowledge(chatId, understood, null);
            await startNewSession(chatId, message.text, message.message_id, modeFor(understood));
            return;
        }
        // занятая работа поручение не примет — «приступаю» было бы неправдой
        if (!busySessions.has(sessionId) && !deps.isRunning(sessionId)) await acknowledge(chatId, understood, sessionId);

        await runInSession(chatId, sessionId, message.text, { mode: modeFor(understood) });
    }

    // Сколько ответ на опрос ждёт, пока сессия освободится. Вопрос задают изнутри
    // идущего хода, и человек успевает ответить раньше, чем ход закончится, —
    // терять такой ответ нельзя, а второй ход поверх первого запускать тоже
    const IDLE_WAIT_MS = 10 * 60 * 1000;
    const IDLE_CHECK_MS = 2000;

    // Слова человека уходят в сессию настоящим ходом. Общий путь и для обычного
    // сообщения, и для ответа на опрос (telegram-polls-server.js)
    async function runInSession(chatId, sessionId, text, { waitIdle = false, mode } = {}) {
        if (waitIdle) {
            const deadline = Date.now() + IDLE_WAIT_MS;
            while ((busySessions.has(sessionId) || deps.isRunning(sessionId)) && Date.now() < deadline) await sleep(IDLE_CHECK_MS);
        }
        // busySessions знает только ходы, начатые отсюда; ход той же сессии из
        // браузера виден через deps.isRunning — второй поверх него не запускаем
        if (busySessions.has(sessionId) || deps.isRunning(sessionId)) {
            // ответ на опрос, не дождавшийся свободной сессии, называем дословно:
            // опрос уже закрыт, и без этого выбор человека пропал бы молча
            const note = waitIdle
                ? `⏳ Работа всё ещё выполняется, и ваш ответ «${text.slice(0, 300)}» агенту не передан. Ответьте на это письмо, когда она закончится, — ответ уйдёт в неё же.`
                : '⏳ Эта работа ещё выполняется — дождитесь её ответа. Остановить её можно словом «стоп».';
            await send(chatId, note).then((sent) => db.remember(chatId, sent.message_id, sessionId)).catch(() => {});
            return;
        }

        busySessions.add(sessionId);
        try {
            // ответ придёт сюда же сам: закончившийся ход снова позовёт notifyTurnFinished
            // note — что сервер хочет сказать человеку по дороге (заменил агента)
            // промежуточные письма привязываем к сессии: ответ reply на строку
            // плана («нет, я имел в виду другое») должен уйти в эту же работу
            await deps.ask({
                sessionId,
                text,
                mode,
                note: (line) => { send(chatId, line).then((sent) => db.remember(chatId, sent.message_id, sessionId)).catch(() => {}); },
            });
        } catch (err) {
            // сессию могли удалить из пульта уже после того, как человек прочитал
            // её ответ, — «Session not found» в личке выглядит поломкой моста,
            // хотя мост исправен. Говорим, что случилось на самом деле
            // слова человека до агента не дошли — говорим какие и почему, и
            // привязываем это письмо к сессии: ответ на него уйдёт туда же
            let reply = letters.undeliveredLetter(text, err.message);
            if (/session not found/i.test(err.message)) {
                // и забываем её: иначе служебные слова и ответы на письма этой
                // сессии снова и снова упирались бы в несуществующую работу
                db.forgetSession.run(sessionId);
                reply = '🗑 Эта работа удалена из пульта — отвечать в неё больше некуда. Новое поручение без ответа-реплая начнёт новую работу.';
            }
            await send(chatId, reply)
                .then((sent) => { if (!/session not found/i.test(err.message)) db.remember(chatId, sent.message_id, sessionId); })
                .catch(() => {});
        } finally {
            busySessions.delete(sessionId);
        }
    }

    return { handleUpdate, runInSession, setPolls };
};