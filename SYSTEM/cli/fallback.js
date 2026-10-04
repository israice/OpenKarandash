// Сломался исполнитель — работу берёт следующий (DOCS/decisions/061).
//
// Выбор модели сделал человек: каскад в настройках и строка выбора в шапке сессии
// (SYSTEM/model-cascade.js) — единственный источник, и ход обязан уйти именно туда
// (решение владельца 2026-10-03). Раньше при первой поломке цепочка молча перебирала
// бесплатные модели по списку CLI и подставляла любую: человек выбирал
// openrouter/stealth/space-bunny-alpha, а работу выполняла opencode/ling-3.0-flash-fin-free
// — в ленте это и выглядело как «задание делают совсем другие модели».
//
// Теперь модель, заданная человеком, не подменяется ничем: список бесплатных моделей
// и перебор моделей в nextExecutor убраны — держать тут нечего, когда просить больше
// некого. Подхват остался только между АГЕНТАМИ и тоже не трогает модель
// (model: null — «как выбрал человек»). Прежнее поведение выключается
// AGENT_FALLBACK=0 в .env.

// сессия → кто её уже пробовал в этой цепочке. По нему же runTurn решает,
// слать ли письмо об ошибке: если работу сейчас подхватят, письмо — шум
const handoverWatch = new Map();

// остановил человек или уходит сам сервер — это не поломка исполнителя
const NO_HANDOVER = /Stopped by the user|restarting/i;

const MAX_HANDOVERS = 4;

// create({ agents, cooldowns, turnJudgment, fallbackOff }): agents — таблица
// коннекторов (кто подключён), cooldowns — память о недоступных, turnJudgment —
// разбор причины поломки (turn-judgment.js). Имя ровно то, каким модуль передаёт
// SYSTEM/cli/index.js: с прошлым коротким `judgment` он приходил сюда undefined,
// и ход падал на turnJudgment.classifyFailure вместо работы (см. комментарий там).
//
// Суждение — необязательная добавка: без него цепочка решает по таблице шаблонов,
// как и до появления jev. Поэтому все обращения к нему идут через оборотитель,
// а не напрямую: undefined здесь означал бы падение хода на ровном месте.
function create({ agents, cooldowns, turnJudgment, fallbackOff }) {
    // Повод всё же упасть мы здесь не ищем, но и TypeError выпускать не даём:
    // без суждения ход обязан идти ровно как раньше (DOCS/decisions/051).
    const judgment = turnJudgment || {};
    // Один вход ко всем суждениям: нет суждения — ведём себя как до его появления
    // (таблица шаблонов), а не падаем. Каждый вызов поимённо, потому что набор
    // функций у модуля широкий, и молчаливый заглушечный proxy легко скрыл бы
    // опечатку в имени так же, как её скрывал прежний разбор аргументов.
    const judge = {
        classify: (text) => (typeof judgment.classifyFailure === 'function'
            ? judgment.classifyFailure(text).catch(() => null)
            : Promise.resolve(null)),
        known: (text) => (typeof judgment.knownFailure === 'function'
            ? judgment.knownFailure(text)
            : null),
    };
    // Есть ли смысл менять исполнителя, решает суждение jev о причине поломки
    // (classifyFailure в turn-judgment.js, DOCS/decisions/065): переполненный
    // контекст или отказ по содержанию следующий агент не исправит, а стоить будет.
    // Суждение выносится заранее (await classifyFailure перед вызовом), сюда
    // приходит уже из памяти; нет суждения — как раньше, передаём всё, кроме
    // остановки человеком и перезапуска
    function nextExecutor(errorText, state) {
        if (fallbackOff || NO_HANDOVER.test(String(errorText || ''))) return null;
        if (judge.known(errorText)?.handover === false) return null;
        if (state.attempts >= MAX_HANDOVERS) return null;
        const dead = new Set(state.dead);
        // Другой агент — да; другая модель того же агента — нет: модель выбрал человек,
        // и молча уводить ход на любую другую он не просил (см. выше). model: null —
        // агенту достаётся ровно та модель, которую выбрал человек
        const spare = Object.keys(agents).find((key) => !dead.has(key)
            && agents[key].connected() && !cooldowns.cooled(key, null));
        return spare ? { name: spare, model: null } : null;
    }

    function willHandOver(sessionId, errorText) {
        // подхватывают только сломавшийся ход. Без этой строки успешный ход при
        // подключённом запасном агенте тоже считался «сейчас подхватят» — и письмо
        // о конце работы не уходило вовсе
        if (!errorText) return false;
        const state = sessionId && handoverWatch.get(sessionId);
        if (!state) return false;
        return Boolean(nextExecutor(errorText, state));
    }

    // { failure, started }: failure — ошибка последнего, кто пробовал (null — работа
    // сделана), started — завёлся ли вообще ход (отказ до старта в базу не попал)
    async function askWithFallback(name, params, onEvent) {
        // tried — пары «агент|модель», dead — агенты, исчерпанные целиком
        const state = { tried: new Set(), dead: new Set(), attempts: 0, current: name };
        let request = params;
        let sessionId = params.sessionId || null;
        let everStarted = false;

        // общий хвост «работа переходит дальше» — и для поломки, и для кулдауна
        // (DOCS/decisions/071). Возвращает true, если есть кому. Ход даже не
        // начался (сессии нет) — следующий получает поручение как есть, оно же
        // станет заголовком сессии; иначе — с пометкой, кто и почему уступил
        function handOver(cause, cool) {
            state.tried.add(`${state.current}|${request.model || ''}`);
            if (sessionId) handoverWatch.set(sessionId, state);
            const spare = nextExecutor(cause, state);
            if (!spare) return false;
            // поломка агента — агент выбывает из цепочки целиком: его модель человек
            // выбрал сам, а чужих моделей в цепочке больше нет (см. блок выше)
            state.dead.add(state.current);
            state.attempts += 1;
            const was = request.model ? `${state.current} (${request.model})` : state.current;
            const short = cool
                ? `временно недоступен (${cooldowns.words(cool.reason)})`
                : `оборвался с ошибкой: «${String(cause).slice(0, 300)}»`;
            request = {
                prompt: !everStarted ? params.prompt
                    : `[OpenKarandash] Предыдущий исполнитель (${was}) ${short}. `
                    + `Доведи до конца последнее поручение человека:\n\n${params.prompt}`,
                sessionId: sessionId || undefined,
                // модель остаётся той, что выбрал человек: spare.model тут всегда null
                model: params.model,
                mode: params.mode,
                hints: params.hints,
                plan: params.plan,
            };
            state.current = spare.name;
            return true;
        }

        try {
            for (;;) {
                // просили того, о ком уже известно, что он недоступен (дневной
                // лимит, снятая модель) — не пробуем и не ждём знакомой ошибки:
                // цепочка начинается со следующего свободного (071)
                const cool = cooldowns.cooled(state.current, request.model || null);
                if (cool) {
                    if (!handOver(`${state.current} cooling after ${cool.reason}`, cool)) {
                        // дальше некого: браузеру это тоже событие, а не пустой конец
                        // потока — иначе вкладка «закончила» работу, которой не было
                        const message = `${state.current} ${cooldowns.words(cool.reason)} до ${cooldowns.untilText(cool.until)}`;
                        onEvent({ type: 'error', error: message });
                        return { failure: message, started: everStarted };
                    }
                    continue;
                }
                state.tried.add(`${state.current}|${request.model || ''}`);
                if (sessionId) handoverWatch.set(sessionId, state);
                let failure = null;
                await agents[state.current].ask(request, (event) => {
                    if (event.type === 'session') {
                        everStarted = true;
                        sessionId = event.id;
                        handoverWatch.set(sessionId, state);
                    }
                    if (event.type === 'error') failure = event.error;
                    onEvent(event);
                });
                if (!failure) return { failure: null, started: true };
                await judge.classify(failure);
                // поломку помним на будущее (071): агент выбывает из цепочки целиком
                state.dead.add(state.current);
                cooldowns.record(state.current, null, judge.known(failure)?.reason);
                if (!handOver(failure, null)) return { failure, started: everStarted };
            }
        } finally {
            if (sessionId) handoverWatch.delete(sessionId);
        }
    }

    return { askWithFallback, willHandOver };
}

module.exports = { create };