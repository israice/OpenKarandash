// Общая обвязка хода: одна на все CLI.
//
// Коннекторы отличаются ровно двумя вещами: как запустить свой процесс и как
// разобрать его вывод. Всё остальное у хода общее — состояние хода в реестре
// идущих ходов (runs), поток событий живым слушателям, запись хода в базу и
// уборка в finally. Эта общая часть живёт здесь, а различия коннектор передаёт
// функцией drive(ctx).
//
// ctx, который получает drive():
//   begin(cliSessionId)  — открыть ход в базе (startExchange) и объявить сессию
//                          наружу; повторные вызовы игнорируются
//   emit(event)          — событие и отправителю, и подключённым к сессии
//   session              — наш id сессии (null, пока не позвали begin)
//   meta                 — turnMeta хода: usage/cost/stopReason/resultMeta
//   run                  — запись хода в реестре runs: сюда драйвер кладёт child,
//                          а снять ход может кто угодно — уборка здесь или Stop
//   answer / fail(text)  — итоговый текст ответа и текст ошибки хода
//
// create(deps): нужные функции хранилища сессий (SYSTEM/core/sessions-db.js),
// суждение о ходе (turnJudgment), письмо о конце работы
// (PROJECTS/Settings/telegram-server.js), реестр идущих ходов (runs), отложенная
// пересборка карты (map) и канал живой перезагрузки (live). Всё это состояние
// живёт в своих модулях, поэтому приходит аргументом: ядро хода не знает, кто
// пишет в базу и кто отправляет письма.
function create(deps) {
    const {
        startExchange, setMessageMode, setCliSession, finishExchange,
        countToolSteps, listToolSteps, getSessionTitle,
        turnJudgment, notifyTurnFinished, willHandOver, runs, map, live,
    } = deps;

    // сколько отложенный перезапуск сервера ждёт письмо о конце хода (см. finally)
    const MAIL_WAIT_MS = 30000;

    return async function runTurn({ target, prompt, sessionId, model, effort, mode, plan }, send, drive) {
        // startedAt — момент начала именно этого хода: по нему панель Sessions
        // тикает «живую» длительность активной сессии (см. runs.activeStartedAt
        // и /api/fragment/session-list), пока finishExchange не зафиксирует
        // итоговый duration_ms в базе
        const run = { sessionId: sessionId || null, child: null, target, startedAt: Date.now() };
        let mail = null; // письмо о конце хода: перезапуск сервера его дожидается

        // usage/cost/duration копим по ходу стрима и пишем разом в finishExchange:
        // событие с итогами приходит раньше, чем процесс CLI завершится
        const meta = {
            model: model || null, effort: effort || null, mode: mode || null,
            usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
            costUsd: null, durationMs: null, stopReason: null,
            thinkingTokensPeak: null, resultMeta: null, lastRequestTokens: null,
            // исходные итоговые события хода (result у Claude, run.completed у
            // Hermes — у него их бывает несколько: автоповтор внутри хода)
            resultRaws: [],
        };

        const ctx = {
            run, target, meta,
            session: null,
            answer: '',
            errorText: null,
            // позиция последней записанной строки ответа: finishExchange дописывает
            // метаданные хода на неё, а не вставляет ещё одну строку
            assistantPosition: null,
            // Строка «[PLAN] …» в начале ответа — как агент понял поручение. Ловим её
            // из текста по мере прихода и отдаём только начавшему ход (send), не в
            // ленту: в ленте она и так останется частью ответа. Один раз за ход
            planBuffer: '',
            planDone: !plan,
            // flush — текста больше не будет (начался шаг): строка плана могла прийти
            // кусками и без перевода строки в конце
            planFeed(chunk, flush = false) {
                if (ctx.planDone) return;
                ctx.planBuffer += chunk;
                const found = ctx.planBuffer.match(flush ? /\[PLAN\][ \t]*([^\n]+)/ : /\[PLAN\][ \t]*([^\n]+)\n/);
                if (found) send({ type: 'plan', text: found[1].trim().slice(0, 500) });
                // длинный текст без строки плана — агент правило не выполнил, дальше не ждём
                if (found || ctx.planBuffer.length > 1500) ctx.planDone = true;
            },
            emit(event) {
                if (event.type === 'text') ctx.planFeed(`${event.text}\n`);
                // план после первого шага — уже не план, а отчёт: такой не пересылаем
                if (event.type === 'tool') { ctx.planFeed('', true); ctx.planDone = true; }
                // номер получает и отправитель: оборвись его поток — он продолжит
                // через /api/sessions/attach с того же места
                const stamped = ctx.session ? runs.stampEventSeq(ctx.session, event) : event;
                send(stamped);
                if (ctx.session) runs.broadcast(ctx.session, stamped);
            },
            // кусок текста по мере набора: в буфер хода не идёт и номера не получает
            emitLive(event) {
                send(event);
                runs.emitLive(ctx.session, event);
            },
            fail(text) {
                ctx.errorText = text;
                ctx.emit({ type: 'error', error: text });
            },
            // позиция строки с вопросом человека — на неё драйвер дописывает то,
            // что реально ушло модели (input_sent), если это не сам prompt
            userPosition: null,
            // cliSessionId — id, который выдал сам CLI. Наш id сессии от него не зависит
            // (заведён в open() ещё до очереди), этот нужен только для «--resume» того же
            // CLI и потому живёт отдельно, в session_cli
            begin(cliSessionId) {
                if (cliSessionId) setCliSession.run(ctx.session, target.id, cliSessionId);
            },
        };

        // сессию заводим ДО очереди: пока ход ждёт своей очереди, он уже должен быть
        // виден в списке как обычная активная сессия — иначе отправленный запрос
        // выглядит потерянным, пока не закончит предыдущий (событие 'queued' клиент
        // показывает статусом, но без id ему нечего выделять в списке)
        ctx.session = sessionId || `${target.id}-${Date.now().toString(36)}`;
        run.sessionId = ctx.session;
        // Реестр узнаёт о ходе раньше, чем о нём узнала база, и узнаёт раньше
        // любой его записи: падение на старте (завести сессию, открыть поток)
        // оставляло сессию «идущей» без единого способа её остановить. Всё, что
        // дальше, — внутри try, и ход снимается уборкой в finally
        runs.beginTurn(run);

        try {
            // владельца сессии не перебиваем: её мог завести другой CLI, и продолжать
            // её должен уметь он же — target проставляется только при заведении строки
            // (upsertSession: ON CONFLICT обновляет одну updated_at). Кто выполнил
            // конкретный ход, видно в result_meta этого сообщения
            ctx.userPosition = startExchange(ctx.session, prompt, target.id, meta.model, meta.effort);
            setMessageMode.run(mode || null, ctx.session, ctx.userPosition);
            runs.open(ctx.session);
            ctx.emit({ type: 'session', id: ctx.session });
            // без этого push сессия появлялась в списке только у вкладки, которая её
            // завела (там 'sessions-changed' шлёт сам app.js), — у остальных открытых
            // вкладок только через опрос раз в 5с. Тот же канал, что и у live reload
            if (live.clientCount()) {
                live.notifyClients('fragment:session-list');
                live.notifyClients('fragment:home-observation');
            }
            await drive(ctx);
            ctx.emit({ type: 'done', text: ctx.answer });
        } catch (err) {
            ctx.errorText = ctx.errorText || err.message;
            ctx.emit({ type: 'error', error: err.message });
        } finally {
            // Уборка хода. Правило блока одно: снять ход обязан любой итог, поэтому
            // запись в базу и письмо идут под общей защитой, а снятие хода — после
            // них и безусловно. Раньше шаги шли подряд, и падение любого уводило
            // остальные: ход оставался в реестре идущих навсегда, сессия в списке
            // тикала минутами, а перезапуск сервера висел (DOCS/decisions/085)
            try {
                // ход с ошибкой дописывается наравне с успешным: answer при ошибке пуст,
                // поэтому условие смотрит и на errorText (см. DOCS/decisions/012)
                if (ctx.session && (ctx.answer || ctx.errorText)) {
                    // типизированное суждение о ходе (DOCS/decisions/051): ход уже
                    // отдан в ленту событием 'done', поэтому лишние доли секунды здесь
                    // никого не ждут, а результат нужен и ленте, и телеграм-мосту.
                    // Сбой суждения — не сбой хода: judgeTurn отдаёт null, и дальше всё
                    // работает ровно как до него
                    const judgment = await turnJudgment.judgeTurn({
                        request: prompt,
                        answer: ctx.answer,
                        errorText: ctx.errorText,
                        stopReason: meta.stopReason,
                        // факт, который держит код: сделал ли ход хоть один шаг
                        // инструментом. Отчёт «проверено» без единого шага — жёсткое
                        // противоречие, и ловится оно здесь, а не моделью
                        toolSteps: countToolSteps.get(ctx.session, ctx.userPosition).n,
                    }).catch(() => null);
                    // решение о письме принимается до записи хода: оно само часть
                    // суждения и должно лежать в той же строке, а не теряться
                    // причина поломки — до решения о письме: по ней willHandOver ниже знает,
                    // подхватят ли работу, а письмо об ошибке называет её человеку
                    if (ctx.errorText) await turnJudgment.classifyFailure(ctx.errorText).catch(() => null);
                    const notify = turnJudgment.shouldNotify(judgment, { errorText: ctx.errorText });
                    if (judgment) meta.resultMeta = { ...(meta.resultMeta || {}), judgment: { ...judgment, notified: notify } };
                    // durationMs: только askClaude реально разбирает event.duration_ms
                    // от CLI (см. event.type === 'result' в коннекторе) — у остальных
                    // коннекторов meta.durationMs так и остаётся null, ничего не попадает
                    // в duration_ms, и SUM(duration_ms) молча пропускает этот ход: счётчик
                    // в панели честно тикал по настенному времени, а после завершения хода
                    // фиксировать было нечего — отсюда «0s» вместо накопленного значения.
                    // Запасной вариант — настенное время самого хода (run.startedAt поставлен
                    // в начале runTurn) — используем его, только если коннектор не прислал
                    // точную цифру сам
                    finishExchange(ctx.session, ctx.answer || ctx.errorText, {
                        ...meta,
                        durationMs: meta.durationMs ?? (Date.now() - run.startedAt),
                        assistantPosition: ctx.assistantPosition,
                        stopReason: meta.stopReason || (ctx.errorText ? 'error' : null),
                    });
                    // в Telegram уходит законченный ход, а не каждый: человеку нужен
                    // сигнал «задание закончено» и сообщение, ответом на которое он
                    // продолжит сессию, — а не поток промежуточных реплик. Что считать
                    // законченным, решает правило в turn-judgment.js поверх суждения;
                    // ошибка и ход, остановившийся с вопросом к человеку, уходят всегда.
                    // Без await: почта не должна ни задерживать ход, ни ронять его
                    if (notify.send && !(await willHandOver(ctx.session, ctx.errorText))) {
                        mail = notifyTurnFinished({
                            sessionId: ctx.session,
                            title: getSessionTitle.get(ctx.session)?.title || '',
                            text: ctx.answer || '',
                            // сломавшийся ход уходит своим письмом: причина по-человечески
                            // и шаги, которые агент успел сделать до обрыва
                            errorText: ctx.errorText || null,
                            // уверенность jev, что ход ждёт человека: по ней мост решает, считать
                            // ли список в конце ответа вариантами вопроса (опросом)
                            awaitsHuman: judgment?.awaitsHuman ?? null,
                            steps: ctx.errorText ? listToolSteps.all(ctx.session, ctx.userPosition).map((row) => row.text) : null,
                        }).catch(() => {});
                    }
                }
            } catch (err) {
                // ответ ходу уже в ленте, и письмо о нём может уйти или не уйти — а вот
                // снятие хода ниже обязано состояться. Запись в базу, которая не
                // получилась, доберёт следующий ход этой сессии
                console.error(`[turn] the closing record failed for ${ctx.session}: ${err.message}`);
            }
            // Ход закончён: поток сессии закрыт, подписи отпущены, занимать сервер
            // он больше не будет. Идемпотентно, поэтому Stop, снявший ход раньше, ему
            // не помешает. Занятость снята после записи в базу: иначе отложенный
            // перезапуск сервера мог бы оборвать нас между ответом и записью
            runs.finishTurn(run);
            // Ход, правивший серверный файл, заканчивается отложенным перезапуском —
            // и письмо о конце работы гибло вместе с процессом: работа сделана, а в
            // Telegram тишина. Поэтому занятость держим, пока письмо не ушло (с
            // потолком: зависшая почта не должна держать перезапуск вечно). Ход для
            // страниц и очереди уже закончен — ждёт только перезапуск
            if (mail) await Promise.race([mail, new Promise((resolve) => setTimeout(resolve, MAIL_WAIT_MS))]);
            runs.releaseTurn(run);
            // переписка живёт в .sessions.db, а этот файл слежение намеренно не видит:
            // без явного вызова память о только что прошедшей сессии не попала бы
            // ни в vault, ни в поиск до следующей правки любого файла
            map.scheduleMapUpdate();
        }
    };
}

module.exports = { create };