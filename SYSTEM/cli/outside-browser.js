// Ходы, начатые не из браузера — сейчас это ответ человека в Telegram.
//
// Исполнителя и параметры берём из самой сессии, поток событий никуда не пишем:
// подключённые страницы всё равно получат его через broadcast внутри runTurn,
// а человеку в Telegram уйдёт готовый ответ из notifyTurnFinished.
//
// Модуль ни о Telegram не знает: его зовёт телеграм-мост (PROJECTS/Settings/
// telegram-server.js) и просит начать ход или продолжить сессию.
// create({ agents, agentByName, agentNameByTarget, cooldowns, askWithFallback,
//          turnJudgment, db, runs })
function create({ agents, agentByName, agentNameByTarget, cooldowns, askWithFallback, turnJudgment, db, runs }) {
    const skillHints = require('../core/skill-hints.js');
    const homeworkHint = require('../core/homework-hint.js');
    const { getSessionTitle, getSessionMeta, getLastTurnParams } = db;
    // имя разбора аргументов — как в соседних модулях слоя и как передаёт
    // SYSTEM/cli/index.js; короткое `judgment` сюда не доезжало (см. там же)
    const judgment = turnJudgment || {};
    // Подсказки — украшение хода, а не его условие: без суждения (нет ключа
    // TypeSafe, не доехал модуль) ход идёт как раньше, просто без записок
    const pickHints = (text) => (typeof judgment.pickDecisionHints === 'function'
        ? judgment.pickDecisionHints(text).catch(() => null)
        : Promise.resolve(null));
    // приём из памяти работника — тем же путём, что и в пульте (DOCS/decisions/088):
    // ход из Telegram ничем не отличается, иначе подсказка работала бы только на
    // одной половине входов. Профиль берём по имени исполнителя, уже выбранного
    // для этого хода
    const pickSkill = (text, name) => (typeof skillHints.pickSkill === 'function'
        ? skillHints.pickSkill({ request: text, agent: name }).catch(() => null)
        : Promise.resolve(null));
    // отчёт домашней работы — тем же путём, что и в пульте (homework-hint.js):
    // ход из Telegram ничем не отличается, иначе разведка шла бы по старой
    // дороге только на одной половине входов
    const pickHomework = (text) => (typeof homeworkHint.pickHomework === 'function'
        ? homeworkHint.pickHomework({ request: text }).catch(() => null)
        : Promise.resolve(null));

    // Кто поведёт ход не из браузера. Подключение живёт в памяти процесса, а сторож
    // перезапускает сервер на каждой правке серверного файла. Страница пульта после
    // этого подключает свой CLI заново, но у хода не из браузера страницы нет: ответ
    // человека из Telegram упирался в «pi is not connected», хотя pi стоял на месте.
    // Поэтому сначала возвращаем подключение сами — тем же путём, что
    // /api/agent/connect: запуск версии доказывает, что CLI жив
    async function readyExecutor(sessionTarget, label, note) {
        let name = agentNameByTarget(sessionTarget);
        const adapter = agentByName(name);
        if (!adapter.connected()) {
            const target = adapter.targets().find((t) => t.id === sessionTarget);
            try {
                if (!target) throw new Error(`unknown environment ${sessionTarget}`);
                await adapter.version(target);
                if (!adapter.connected()) adapter.activate(target); // пока ждали версию, человек мог подключить сам
            } catch (err) {
                console.warn(`Reconnect ${name} for ${label} failed: ${err.message}`);
            }
        }
        // Свой CLI так и не поднялся — работу берёт любой подключённый: сессию
        // может продолжить кто угодно, контекст он получит пересказом
        // (handoffPreamble). Человеку об этом говорим: замена может стоить денег.
        // Тех, кто в кулдауне (071), пропускаем: знаем заранее, что они не в ладах
        if (adapter.connected()) return { name, replaced: false };
        const spare = Object.keys(agents).find((key) => agents[key].connected() && !cooldowns.cooled(key, null));
        if (!spare) {
            const any = Object.keys(agents).some((key) => agents[key].connected());
            throw new Error(any
                ? `${name} is not connected and the connected agents are cooling down — work paused until they recover`
                : `${name} is not connected and no other agent is — open Settings and connect one`);
        }
        if (note) note(`🔁 ${name} недоступен — работу ведёт ${spare}.`);
        name = spare;
        return { name, replaced: true };
    }

    // mode — режим, выбранный мостом по виду поручения (вопрос — Chat, без правок;
    // DOCS/decisions/067); не задан — как в прошлом ходе этой сессии
    async function ask({ sessionId, text, note, mode }) {
        if (!getSessionTitle.get(sessionId)) throw new Error('Session not found');
        if (runs.isStopping()) throw new Error(runs.restartError);

        const { name, replaced } = await readyExecutor(getSessionMeta.get(sessionId)?.target, sessionId, note);
        // модель и effort у каждого CLI свои — чужому агенту их не передаём
        const last = replaced ? { mode: getLastTurnParams.get(sessionId)?.mode } : (getLastTurnParams.get(sessionId) || {});
        // отказ до старта хода (не подключён, пустой запрос) в базу не попадёт и
        // обратно сам не уедет — такой возвращаем ошибкой. Всё, что случилось уже
        // внутри хода, дописано в сессию и уйдёт в Telegram обычным путём
        const [hints, skill, homework] = await Promise.all([pickHints(text), pickSkill(text, name), pickHomework(text)]);
        const { failure, started } = await askWithFallback(
            name,
            {
                prompt: text,
                sessionId,
                model: last.model || undefined,
                effort: last.effort || undefined,
                mode: mode || last.mode || undefined,
                hints,
                skill,
                homework,
                plan: true,
            },
            (event) => { if (event.type === 'plan' && note) note(`📋 План: ${event.text}`); },
        );
        if (failure && !started) throw new Error(failure);
    }

    // Новая работа не из браузера: человек нажал в Telegram END и написал поручение.
    // Исполнителя, модель и режим берём у его прошлой работы (likeSessionId) — это
    // тот агент, которым он пользуется; прошлой нет — первый подключённый.
    // onSession сообщает id новой сессии сразу, не дожидаясь конца хода: мосту он
    // нужен, чтобы следующие сообщения шли уже в неё
    async function startNew({ text, likeSessionId, note, onSession, mode }) {
        if (runs.isStopping()) throw new Error(runs.restartError);
        const like = likeSessionId && getSessionTitle.get(likeSessionId) ? likeSessionId : null;
        const { name, replaced } = await readyExecutor(like ? getSessionMeta.get(like)?.target : null, 'new session', note);
        const last = like ? (getLastTurnParams.get(like) || {}) : {};
        const [hints, skill, homework] = await Promise.all([pickHints(text), pickSkill(text, name), pickHomework(text)]);
        const { failure, started } = await askWithFallback(
            name,
            {
                prompt: text,
                model: (!replaced && last.model) || undefined,
                effort: (!replaced && last.effort) || undefined,
                mode: mode || last.mode || undefined,
                hints,
                skill,
                homework,
                plan: true,
            },
            (event) => {
                if (event.type === 'session' && onSession) onSession(event.id);
                if (event.type === 'plan' && note) note(`📋 План: ${event.text}`);
            },
        );
        if (failure && !started) throw new Error(failure);
    }

    return { ask, startNew, readyExecutor };
}

module.exports = { create };