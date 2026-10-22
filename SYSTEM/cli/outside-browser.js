// Ходы, начатые не из браузера — сейчас это ответ человека в Telegram.
//
// Исполнителя и параметры берём из самой сессии, поток событий никуда не пишем:
// подключённые страницы всё равно получат его через broadcast внутри runTurn,
// а человеку в Telegram уйдёт готовый ответ из notifyTurnFinished.
//
// Модуль ни о Telegram не знает: его зовёт телеграм-мост (PROJECTS/Settings/
// telegram-server.js) и просит начать ход или продолжить сессию.
// Исполнитель, модель и режим — те же, что у сессии: подхвата нет, работа не
// уходит к другому CLI (DOCS/decisions/097)
// create({ agents, agentByName, agentNameByTarget, ask,
//          turnJudgment, db, runs })
function create({ agentByName, agentNameByTarget, ask, turnJudgment, db, runs }) {
    const skillHints = require('../core/skill-hints.js');
    const homeworkHint = require('../core/homework-hint.js');
    const { getSessionTitle, getSessionMeta, getLastTurnParams } = db;
    // имя разбора аргументов — как в соседних модулях слоя и как передаёт
    // SYSTEM/cli/index.js; короткое `judgment` сюда не доезжало (см. там же)
    const judgment = turnJudgment || {};
    // Подсказки — украшение хода, а не его условие: без суждения (нет ключа
    // необязательный модуль анализа не доехал — ход идёт как раньше, просто без записок
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
    // дороге только на одной половине входов. sessionId обязателен: по нему
    // память сессии отдаёт карту собранного отчёта на продолжающем ходу
    const pickHomework = (text, id) => (typeof homeworkHint.pickHomework === 'function'
        ? homeworkHint.pickHomework({ request: text, sessionId: id }).catch(() => null)
        : Promise.resolve(null));

    // Кто поведёт ход не из браузера. Подключение живёт в памяти процесса, а сторож
    // перезапускает сервер на каждой правке серверного файла. Страница пульта после
    // этого подключает свой CLI заново, но у хода не из браузера страницы нет: ответ
    // человека из Telegram упирался в «pi is not connected», хотя pi стоял на месте.
    // Поэтому сначала возвращаем подключение сами — тем же путём, что
    // /api/agent/connect: запуск версии доказывает, что CLI жив
    //
    // Свой CLI так и не поднялся — работа не идёт никуда: подхвата больше нет
    // (DOCS/decisions/097), чужой исполнитель работал бы не той моделью и молча,
    // а ход не сделанный виден в ленте ошибкой с его именем
    async function readyExecutor(sessionTarget) {
        const name = agentNameByTarget(sessionTarget);
        const adapter = agentByName(name);
        if (!adapter.connected()) {
            const target = adapter.targets().find((t) => t.id === sessionTarget);
            try {
                if (!target) throw new Error(`unknown environment ${sessionTarget}`);
                await adapter.version(target);
                if (!adapter.connected()) adapter.activate(target); // пока ждали версию, человек мог подключить сам
            } catch (err) {
                console.warn(`Reconnect ${name} failed: ${err.message}`);
            }
        }
        if (!adapter.connected()) throw new Error(`${name} is not connected — open Settings and connect it`);
        return name;
    }

    // mode — режим, выбранный мостом по виду поручения (вопрос — Chat, без правок;
    // DOCS/decisions/067); не задан — как в прошлом ходе этой сессии
    async function ask({ sessionId, text, note, mode }) {
        if (!getSessionTitle.get(sessionId)) throw new Error('Session not found');
        if (runs.isStopping()) throw new Error(runs.restartError);

        const name = await readyExecutor(getSessionMeta.get(sessionId)?.target);
        // модель и effort — те же, что человек выбрал для этой сессии
        const last = getLastTurnParams.get(sessionId) || {};
        // отказ до старта хода (не подключён, пустой запрос) в базу не попадёт и
        // обратно сам не уедет — такой возвращаем ошибкой. Всё, что случилось уже
        // внутри хода, дописано в сессию и уйдёт в Telegram обычным путём
        const [hints, skill, homework] = await Promise.all([pickHints(text), pickSkill(text, name), pickHomework(text, sessionId)]);
        const { failure, started } = await ask(
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
    // тот агент, которым он пользуется.
    // onSession сообщает id новой сессии сразу, не дожидаясь конца хода: мосту он
    // нужен, чтобы следующие сообщения шли уже в неё
    async function startNew({ text, likeSessionId, note, onSession, mode }) {
        if (runs.isStopping()) throw new Error(runs.restartError);
        const like = likeSessionId && getSessionTitle.get(likeSessionId) ? likeSessionId : null;
        const name = await readyExecutor(like ? getSessionMeta.get(like)?.target : null);
        const last = like ? (getLastTurnParams.get(like) || {}) : {};
        const [hints, skill, homework] = await Promise.all([pickHints(text), pickSkill(text, name), pickHomework(text, null)]);
        const { failure, started } = await ask(
            name,
            {
                prompt: text,
                model: last.model || undefined,
                effort: last.effort || undefined,
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
