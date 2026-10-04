// /api/agent/* — запуск любого CLI.
//
// Один набор маршрутов на все коннекторы (DOCS/decisions/017): имя CLI приходит
// полем agent в теле, а не в пути, поэтому добавление второго коннектора не
// добавляет ни одного маршрута. Различия коннекторов собраны в таблице CONNECTORS
// (SYSTEM/cli/index.js).
const { readJson, sendJson } = require('./http.js');
const skillHints = require('./skill-hints.js');
const homeworkHint = require('./homework-hint.js');

// createRoutes({ agents, cooldowns, turnJudgment, runs })
//
// turnJudgment берём и под таким именем, каким его передаёт server.js: с прошлым
// именем judgment в разборе аргументов он был undefined, и каждый ход падал на
// turnJudgment.pickDecisionHints — TypeError улетал из уже начатого потока в
// api.js, тот отвечал JSON поверх отправленных заголовков, процесс падал по
// ERR_HTTP_HEADERS_SENT, и вкладка получала «Failed to fetch» вместо хода
function createRoutes({ agents, cooldowns, turnJudgment, runs }) {
    const { byName, askWithFallback } = agents;
    // подсказки — украшение хода, а не его условие: без суждения или без ключа
    // TypeSafe ход идёт как раньше
    const pickHints = (prompt) => (turnJudgment && turnJudgment.pickDecisionHints
        ? turnJudgment.pickDecisionHints(prompt).catch(() => null)
        : Promise.resolve(null));

    return {
        '/api/agent/detect': async (req, res) => {
            const { agent } = await readJson(req);
            sendJson(res, { installs: await byName(agent).detect() });
        },

        '/api/agent/connect': async (req, res) => {
            const { agent, id } = await readJson(req);
            const adapter = byName(agent);
            const targets = adapter.targets();
            // id окружения приходит из localStorage вкладки, а он стареет: у
            // коннектора переименовали цель, CLI переехал на другую машину, и
            // вернувшийся после рестарта сервер отвечал «Unknown environment».
            // Страница считала это неудачным восстановлением и писала
            // «is not connected» при живо установленном CLI, хотя у OpenCode
            // выбор один и гадать тут не о чем. Поэтому единственная цель
            // принимается вместо сохранённого имени
            const target = targets.find((t) => t.id === id)
                || (targets.length === 1 ? targets[0] : null);
            if (!target) {
                sendJson(res, { ok: false, error: `Unknown environment: ${id}` });
                return;
            }

            const version = await adapter.version(target);
            const models = adapter.models ? await adapter.models(target) : undefined;
            adapter.activate(target);
            // подключение снова есть — забытая поломка этого агента больше не
            // повод его не звать (SYSTEM/core/agent-cooldown.js, DOCS/decisions/071)
            cooldowns.forget(agent);
            sendJson(res, { ok: true, id: target.id, label: target.label, version, models });
        },

        '/api/agent/stop': async (req, res) => {
            const { sessionId } = await readJson(req);
            // реестр запусков общий на все CLI (runs), поэтому и остановка одна
            sendJson(res, { ok: true, stopped: runs.stop(sessionId || null) });
        },

        // память о недоступных исполнителях (DOCS/decisions/071): посмотреть,
        // кого и до какого времени пульт сейчас не берёт, и сбросить, когда
        // лимит обновился раньше срока или пометка больше не нужна
        '/api/agent/cooldowns': async (req, res) => {
            sendJson(res, { ok: true, cooldowns: cooldowns.list() });
        },

        '/api/agent/cooldowns/clear': async (req, res) => {
            sendJson(res, { ok: true, cooldowns: cooldowns.clear() });
        },

        '/api/agent/ask': async (req, res) => {
            const body = await readJson(req);
            byName(body.agent); // неизвестный коннектор — ошибка, и до проверки перезапуска, как раньше
            // сторожу уже сказано «можно» — этот процесс доживает последние мгновения
            // и запускать в нём CLI нельзя: ход умрёт вместе с ним, не дописавшись
            // ответ — строка того же потока событий, а не sendJson: клиент читает
            // ask построчным NDJSON и обычный JSON без перевода строки не разберёт
            if (runs.isStopping()) {
                res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' });
                res.end(`${JSON.stringify({ type: 'error', error: runs.restartError })}\n`);
                return;
            }
            res.writeHead(200, {
                'Content-Type': 'application/x-ndjson; charset=utf-8',
                'Cache-Control': 'no-store',
            });
            // вкладку могли перезагрузить или закрыть — работа CLI продолжается,
            // ответ всё равно попадёт в базу, мы лишь перестаём писать в мёртвый сокет.
            // Слушаем именно res: у req событие close приходит сразу после того, как
            // тело запроса прочитано (Node 16+), и open становился false до первого
            // события — поток уходил в браузер пустым, без единой строки
            let open = true;
            res.on('close', () => { open = false; });
            const emit = (event) => {
                if (open && !res.writableEnded) res.write(`${JSON.stringify(event)}\n`);
            };

            // записки DOCS/decisions, обязательные к прочтению именно под этот
            // запрос, — подбирает TypeSafe (DOCS/decisions/051). Ждём: подсказка
            // должна уехать вместе с запросом, а не догонять его. Без ключа
            // функция сразу отдаёт null, и ход идёт как раньше
            // сломавшегося исполнителя сменяет следующий подключённый; его события
            // идут в этот же поток — для страницы это продолжение той же работы.
            // Всё, что падает здесь, уже после writeHead, поэтому ошибка уходит
            // событием в поток, а не исключением из обработчика: иначе вкладка
            // видела «Failed to fetch» вместо причины
            try {
                // приём из памяти работника и домашняя работа — тем же способом
                // и из того же места (skill-hints.js, homework-hint.js, решение 088).
                // Все суждения независимы и едут вместе: подсказка обязана попасть
                // в запрос, а не догонять его
                const [hints, skill, homework] = await Promise.all([
                    pickHints(body.prompt),
                    skillHints.pickSkill({ request: body.prompt, agent: body.agent, profile: body.profile }).catch(() => null),
                    // отчёт разведки собирает код по якорям из сообщения и едет в
                    // запрос сам: агент на эту работу ходов тратить не должен.
                    // sessionId нужен памяти сессии: у продолжающего хода своих
                    // якорей нет, и вместо нового отчёта едет карта собранного
                    homeworkHint.pickHomework({ request: body.prompt, sessionId: body.sessionId }).catch(() => null),
                ]);
                body.hints = hints;
                body.skill = skill;
                body.homework = homework;
                await askWithFallback(body.agent, body, emit);
            } catch (err) {
                emit({ type: 'error', error: err.message });
            }
            if (open && !res.writableEnded) res.end();
        },
    };
}

module.exports = { createRoutes };