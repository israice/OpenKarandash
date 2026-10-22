// Разбор потока хода для CLI, имя которых мы не знаем заранее.
//
// Список агентов приходит с сайта (SYSTEM/cli-agents.js) и меняется, поэтому
// заводить коннектор на каждое имя нельзя, а разбирать поток приходится по
// тому, что CLI сам о себе сказал в `--help`. Здесь живут обе известные схемы
// событий и подпись шага, общая для них; выбор схемы — в any.js.
//
// Схем три, и четвёртая (обычный текст без событий) разбирается в самом any.js:
// - pi: `session`, `tool_execution_start/end`, `message_end` с message.content;
// - opencode (на нём говорят kilo, opencode и их производные): `text`,
//   `reasoning`, `tool_use`, `step_finish`, `error`, у каждого события part;
// - openclaw: не поток событий вовсе, а один JSON-объект на весь ход, напечатанный
//   в конце (см. openclawResult).
//
// openclaw отдаёт не NDJSON, а один объект, разбитый `JSON.stringify(…, null, 2)`
// на сотни строк: построчный разбор его не возьмёт (каждая строка — обрывок),
// а «просто текст» (plain) выдал бы в ответ весь этот JSON. Поэтому openclaw —
// отдельное семейство: ответ и usage собираются из объекта целиком.
//
// hermes разбирается не здесь вовсе: у него нет потока событий, ответом
// считается весь stdout хода `-z`, а учёт лежит в отдельном файле отчёта —
// обе формы живут в any-hermes.js.
const path = require('path');

// Подпись действия: «read index.html», «bash npm test». Ключи аргументов
// читаются и pi-стиля (args.path/args.command), и opencode-стиля
// (input.filePath/input.query): без этого половина живых шагов осталась бы
// голым тегом инструмента без содержимого
function toolLabel(part) {
    const input = part.args || part.input || {};
    const file = input.path || input.file_path || input.filePath;
    const detail = file ? path.basename(file)
        : input.command || input.pattern || input.url || input.query || '';
    return { type: 'tool', name: part.toolName || part.name || part.tool || 'tool', detail: String(detail).slice(0, 120) };
}

// Семейство протокола по тексту `--help`: это единственное, что мы знаем о
// незнакомом CLI до первого запуска. Порядок проверок важен: у kilo есть и
// `--format`, и `--model`, но нет непечатного режима с `--mode`, а у pi и его
// производных (omp) оба есть. Значение флага в справке пишут по-разному —
// «--mode <mode>» у pi и «--mode=<value>» у omp, — поэтому допускаем оба вида
function familyOf(help) {
    const text = String(help || '');
    // openclaw проверяется первым: у него есть и `--model`, и `--json`, и
    // подкоманда `run`, так что по общим признакам он не отличим от
    // opencode-схемы, а ход у него другой — `agent`, не `run`
    if (/--message-file/.test(text)) return 'openclaw';
    // hermes проверяется до pi и opencode: ход у него делает не подкоманда, а
    // флагом (`-z/--oneshot PROMPT`) — подкоманды `run` у него нет вовсе, и
    // без этой проверки он уходил в plain, а тот слал `hermes run "…"`
    if (/--oneshot\s+PROMPT|--usage-file\s+PATH/.test(text)) return 'hermes';
    if (/--mode\s*[=<]/.test(text) && /--print/.test(text)) return 'pi';
    // opencode-схема: ход делает подкоманда run, у неё есть --format (json) и
    // --model. Прежний признак «run [message]» в новой справке не встречается:
    // там «opencode run [flags] [<message...>]», — поэтому ищем по usage-строке
    // подкоманды и её флагам. Без этого opencode уходил в plain: ход шёл без
    // --model и без потока событий, а каталог моделей был пуст
    if (/run \[/i.test(text) && /--format/.test(text)) return 'opencode';
    return 'plain';
}

// `openclaw agent --local --json` печатает один объект на весь ход, в конце
// процесса. Перед ним в stdout может идти служебное (приветствие, предупреждения),
// поэтому ищем первую `{` и разбираем от неё до последней `}` — напечатанный
// JSON всегда сплошной, и лишний хвост после него разбору не мешает. Без
// распознанного объекта возвращаем null: вызывающая сторона тогда покажет весь
// вывод как есть, а не выдаст человеку ошибку вместо ответа.
function openclawResult(stdout) {
    const text = String(stdout || '');
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    let result;
    try {
        result = JSON.parse(text.slice(start, end + 1));
    } catch {
        return null;
    }
    // ответ лежит в payloads: у первого payload текст, у следующих — вложения
    const answer = (result?.payloads || [])
        .map((payload) => (payload && typeof payload.text === 'string' ? payload.text : ''))
        .filter(Boolean)
        .join('\n')
        .trim();
    return {
        answer,
        aborted: Boolean(result?.aborted),
        stopReason: result?.stopReason || null,
        // id сессии openclaw — это id его собственной сессии, а не sessionFile:
        // в --session-id идёт первый, и по нему ход продолжается
        sessionId: result?.meta?.agentMeta?.sessionId || null,
        model: result?.meta?.agentMeta ? `${result.meta.agentMeta.provider}/${result.meta.agentMeta.model}` : null,
        usage: result?.meta?.agentMeta?.usage || null,
    };
}

// `pi --list-models` печатает таблицу с заголовком «provider model …», колонки
// разделены двумя и более пробелами; без логина вместо таблицы идёт подсказка
// про /login, и такой список пустым и остаётся
function piModels(stdout) {
    const lines = String(stdout).trim().split('\n').map((line) => line.trim()).filter(Boolean);
    if (!lines.length || !lines[0].startsWith('provider')) return [];
    return lines.slice(1)
        .map((line) => line.split(/\s{2,}/))
        .filter((columns) => columns.length >= 2)
        .map(([provider, model]) => `${provider}/${model}`);
}

// `kilo models` (и `opencode models`) печатают по строке на модель путём
// «шлюз/поставщик/модель». Перед именем модели у kilo стоит «~» — это пометка
// нечёткого совпадения для --model, а не часть имени, поэтому её снимаем:
// собранная строка должна совпасть с тем, что понимает CLI. Само значение
// сохраняем целиком, вместе с префиксом шлюза: у kilo это «kilo/…», и
// покупатель путать «kilo/stealth/space-bunny-alpha» с «openrouter/…» не
// станет — свой префикс у CLI один и тот же на всех его моделях
function opencodeModels(stdout) {
    const models = [];
    for (const line of String(stdout).split(/\r?\n/)) {
        // «~» у kilo стоит перед именем модели, а не в начале строки:
        // «kilo/~anthropic/claude-fable-latest». Это пометка нечёткого
        // совпадения для --model, а не часть имени, поэтому её снимаем:
        // собранная строка должна совпасть с тем, что понимает CLI
        const value = line.trim().replace(/~/g, '');
        if (!value || value.startsWith('#') || !value.includes('/')) continue;
        if (!models.includes(value)) models.push(value);
    }
    return models;
}

// Причина, по которой модель собиралась звать инструменты: на схеме opencode
// это «tool-calls», у pi — «toolUse». Написание приводим к одному виду:
// набор имён у каждого CLI свой, а признак один и тот же — модель ещё не
// закончила и собиралась продолжать работу
const TOOL_REASONS = new Set(['toolcalls', 'tooluse', 'toolcall']);

function isToolReason(reason) {
    return TOOL_REASONS.has(String(reason || '').toLowerCase().replace(/[-_\s]/g, ''));
}

// Дошёл ли ход до ответа. Три признака, и все три нужны:
//   - инструмент, так и не завершившийся: процесс умер посреди шага;
//   - последний шаг закончился намерением звать инструменты: CLI вышел раньше,
//     чем довёл работу;
//   - ошибка хода: с ней продолжение не имеет смысла, решение за человеком
//     (DOCS/decisions/097).
// Причину шага ставит step_finish, а текст события отменяет: opencode-схема
// финальному тексту step_finish не шлёт, и причина шага с инструментами —
// не про конец хода (DOCS/decisions/133).
// Счётчики копит разбор потока (opencodeEvent / piEvent) — там, где видно
// границы шага, и больше нигде.
function turnUnfinished(ctx) {
    if (!ctx || ctx.errorText) return false;
    const meta = ctx.meta || {};
    if ((meta.pendingTools || 0) > 0) return true;
    return meta.wantsTools === true;
}

// Обработчик одной строки потока под схему family. ctx — общая обвязка хода
// (SYSTEM/core/run-turn.js): она же пишет в базу, поэтому разборчики ничего не
// знают о Sessions, Feed и Flow
function lineHandler(family, db) {
    const { recordAssistantText, recordStep, setMessageToolResult, appendRaw, clip } = db;
    // вызов инструмента -> позиция строки шага: он приходит дважды на один
    // callID (сперва начало, потом конец), и вторая запись только дописывает
    // результат в ту же строку
    const positions = new Map();
    // открытые вызовы инструментов: их номера строк может не быть, а сам факт
    // «вызов начат и не закрыт» нужен всегда — по нему видно, что процесс умер
    // посреди шага (turnUnfinished)
    const openCalls = new Set();
    let sessionSeen = false;

    return (ctx, line) => {
        let event;
        try {
            event = JSON.parse(line);
        } catch {
            return; // не JSON — служебный вывод CLI
        }

        // id сессии самого CLI нужен один раз: он же уходит в его --session
        const cliSession = (family === 'pi' ? (event.type === 'session' && event.id) : event.sessionID) || null;
        if (cliSession && !sessionSeen) {
            sessionSeen = true;
            ctx.begin(cliSession);
            return;
        }

        if (family === 'pi') return piEvent(ctx, event, { positions, openCalls, db, recordAssistantText, recordStep, setMessageToolResult, appendRaw, clip });
        return opencodeEvent(ctx, event, { positions, openCalls, db, recordAssistantText, recordStep, setMessageToolResult, appendRaw, clip });
    };
}

function piEvent(ctx, event, { positions, openCalls, db: { recordAssistantText, recordStep, setMessageToolResult, appendRaw, clip } }) {
    if (event.type === 'tool_execution_start' && ctx.session) {
        const step = toolLabel(event);
        if (!openCalls.has(event.toolCallId)) {
            openCalls.add(event.toolCallId);
            ctx.meta.pendingTools = (ctx.meta.pendingTools || 0) + 1;
        }
        positions.set(event.toolCallId, recordStep(ctx.session, `${step.name} ${step.detail}`.trim(), step.name, event.args || {}, event.toolCallId, null, null, event, ctx.origin));
        ctx.emit(step);
        return;
    }

    if (event.type === 'tool_execution_end' && ctx.session) {
        const position = positions.get(event.toolCallId);
        // вызов закрыт — одним открытым вызовом меньше, независимо от того,
        // вернулась ли строка: сам факт закрытия известен и без неё
        if (openCalls.delete(event.toolCallId)) {
            ctx.meta.pendingTools = Math.max(0, (ctx.meta.pendingTools || 0) - 1);
        }
        if (position === undefined) return;
        const output = typeof event.result === 'string' ? event.result : JSON.stringify(event.result ?? '');
        setMessageToolResult.run(clip(output), event.isError ? 1 : 0, null, ctx.session, position);
        appendRaw(ctx.session, position, event);
        return;
    }

    // message_end — законченный ответ одного вызова модели: текст, размышления
    // и usage лежат в нём целиком
    if (event.type !== 'message_end' || event.message?.role !== 'assistant') return;
    const message = event.message;
    const usage = message.usage || {};
    ctx.meta.usage.inputTokens += usage.input || 0;
    ctx.meta.usage.outputTokens += usage.output || 0;
    ctx.meta.usage.cacheReadTokens += usage.cacheRead || 0;
    ctx.meta.usage.cacheCreationTokens += usage.cacheWrite || 0;
    // заполнение окна — не накопительная величина, а то, что лежит сейчас
    ctx.meta.lastRequestTokens = (usage.input || 0) + (usage.cacheRead || 0) + (usage.cacheWrite || 0);
    if (typeof usage.cost?.total === 'number') ctx.meta.costUsd = (ctx.meta.costUsd || 0) + usage.cost.total;
    if (message.stopReason) {
        ctx.meta.stopReason = message.stopReason;
        ctx.meta.wantsTools = isToolReason(message.stopReason);
        if (!ctx.meta.wantsTools) ctx.meta.pendingTools = 0;
    }
    // модель мог выбрать сам CLI (флаг --model не передали)
    if (!ctx.meta.model && message.provider) ctx.meta.model = `${message.provider}/${message.model}`;

    for (const part of message.content || []) {
        if (part.type === 'text' && part.text?.trim()) {
            ctx.answer = part.text;
            if (ctx.session) ctx.assistantPosition = recordAssistantText(ctx.session, part.text, ctx.meta.model, null, null, part, ctx.origin);
            ctx.emit({ type: 'text', text: part.text });
        } else if (part.type === 'thinking' && part.thinking?.trim()) {
            // блок мыслей собирает общая обвязка хода (ctx.think)
            ctx.think(part.thinking, part, part.thinkingSignature || null);
        }
        // part.type === 'toolCall' пропускаем: свою строку шаг уже получил
    }
    // ошибка вызова модели приходит полем сообщения, а не кодом возврата
    if (message.errorMessage) ctx.fail(message.errorMessage);
}

function opencodeEvent(ctx, event, { positions, openCalls, db: { recordAssistantText, recordStep, setMessageToolResult, appendRaw, clip } }) {
    if (event.type === 'error') {
        ctx.fail(event.error?.data?.message || event.error?.name || 'CLI returned an error');
        return;
    }

    if (event.type === 'reasoning' && event.part?.text) {
        // рассуждение CLI отдаёт уже собранным, склеивать куски нечего
        const signature = typeof event.part.signature === 'string' ? event.part.signature : null;
        ctx.think(event.part.text, event.part, signature);
        return;
    }

    if (event.type === 'text' && event.part?.text?.trim()) {
        ctx.answer = event.part.text;
        if (ctx.session) ctx.assistantPosition = recordAssistantText(ctx.session, event.part.text, ctx.meta.model, null, null, event.part, ctx.origin);
        // opencode-схема финальному тексту step_finish не шлёт вовсе: поток
        // кончается событием text. Причина прежнего step_finish («tool-calls»
        // у шага с инструментами) оставалась бы в wantsTools навсегда, и ход
        // с готовым ответом читался как незавершённый — продолжения по кругу
        // и «ход не доведён за 6 продолжений» (DOCS/decisions/133)
        ctx.meta.wantsTools = false;
        ctx.meta.stopReason = null;
        ctx.emit({ type: 'text', text: event.part.text });
        return;
    }

    if (event.type === 'tool_use' && event.part) {
        const part = event.part;
        const state = part.state || {};
        let position = positions.get(part.callID);
        // Отдельно от positions: там номер строки в базе, а здесь — сам факт,
        // что вызов открыт. Привязывать счётчик недозвонных инструментов
        // (turnUnfinished) к номеру строки нельзя — запись строки может не
        // вернуться, и тогда открытый вызов из счёта выпал бы, а ход с
        // незакрытым инструментом читался бы как доведённый
        if (!openCalls.has(part.callID)) {
            openCalls.add(part.callID);
            ctx.meta.pendingTools = (ctx.meta.pendingTools || 0) + 1;
        }
        const closed = state.status === 'completed' || state.status === 'error';
        if (closed && openCalls.delete(part.callID)) {
            // вызов закрыт — одним открытым вызовом меньше. С проверкой по
            // openCalls, а не вычитанием: событие о закрытии одного вызова
            // некоторые CLI шлют дважды, и счётчик ушёл бы в минус
            ctx.meta.pendingTools = Math.max(0, (ctx.meta.pendingTools || 0) - 1);
        }
        if (position === undefined && ctx.session) {
            // подпись шага — та же, что уходит в живую ленту, иначе строка в базе
            // и живой шаг разъезжаются, и после перечитывания лента показывает
            // другой текст
            const step = toolLabel({ name: part.tool, input: state.input || {} });
            // заголовок шага у этой схемы приходит отдельно от аргументов
            if (!step.detail && state.title) step.detail = String(state.title).slice(0, 120);
            position = recordStep(ctx.session, `${step.name} ${step.detail}`.trim(), step.name || 'tool', state.input, part.callID, null, null, part, ctx.origin);
            positions.set(part.callID, position);
            ctx.emit(step);
        }
        if (position !== undefined && ctx.session && closed) {
            const output = typeof state.output === 'string' ? state.output : JSON.stringify(state.output ?? '');
            setMessageToolResult.run(clip(output), state.status === 'error' ? 1 : 0, null, ctx.session, position);
            appendRaw(ctx.session, position, part);
        }
        return;
    }

    if (event.type === 'step_finish' && event.part) {
        const tokens = event.part.tokens || {};
        ctx.meta.usage.inputTokens += tokens.input || 0;
        ctx.meta.usage.outputTokens += tokens.output || 0;
        ctx.meta.usage.cacheReadTokens += tokens.cache?.read || 0;
        ctx.meta.usage.cacheCreationTokens += tokens.cache?.write || 0;
        ctx.meta.lastRequestTokens = (tokens.input || 0) + (tokens.cache?.read || 0) + (tokens.cache?.write || 0);
        if (typeof event.part.cost === 'number') ctx.meta.costUsd = (ctx.meta.costUsd || 0) + event.part.cost;
        if (event.part.reason) {
            ctx.meta.stopReason = event.part.reason;
            // граница шага: шаг, закончившийся не намерением звать
            // инструменты, закрывает и всё, что было начато внутри него, —
            // иначе недозвонный вызов прошлого шага держал бы ход открытым
            ctx.meta.wantsTools = isToolReason(event.part.reason);
            if (!ctx.meta.wantsTools) ctx.meta.pendingTools = 0;
        }
    }
}

// `omp models list` печатает каталог рамкой: строкой сверху идёт шлюз
// («openrouter (561)»), дальше рамка с колонками, и имя модели лежит в первой
// колонке с префиксом «~». Собираем путь из шлюза и этого имени. Список omp
// приходит такой же таблицей, как у pi, только в рамке и с другой подписью
// колонок, поэтому узнаём её по рамке и по тому, что колонка называется model
function boxedModels(stdout) {
    const lines = String(stdout).split(/\r?\n/).map((line) => line.trim());
    const models = [];
    let gateway = '';
    for (const line of lines) {
        if (!line) continue;
        if (!line.startsWith('│')) {
            // строка вне рамки: заголовок шлюза, у которого модельный путь
            // начинается с него самого. Дальше идут сами рамки (┌ ├ └) и рамки
            // других шлюзов, поэтому прежний шлюз на них не сбрасывается — иначе
            // первая же горизонтальная линия обнулила бы путь и в моделях не
            // осталось бы ничего
            const heading = line.match(/^([\w.-]+)\s+\(\d+\)$/);
            if (heading) gateway = heading[1];
            continue;
        }
        const columns = line.split('│').map((cell) => cell.trim()).filter(Boolean);
        if (!columns.length || columns[0] === 'model') continue;
        const name = columns[0].replace(/^~/, '');
        if (!name.includes('/') || !gateway) continue;
        const value = `${gateway}/${name}`;
        if (!models.includes(value)) models.push(value);
    }
    return models;
}

// `openclaw models list --all --json` отдаёт объект с полем models, где у каждой
// модели свой key вида «шлюз/поставщик/модель». Без `--all` openclaw печатает
// только модели текущей сессии, а их ноль, пока ход ещё не начинался, — поэтому
// каталог читается всегда полным. Недоступные модели (available: false) в список
// не берём: выбор должен состоять из моделей, на которые ход пойдёт, а лента
// Gateway-ошибок по несуществующей модели — худший подарок в каскаде выбора
function openclawModels(stdout) {
    const text = String(stdout || '');
    const start = text.indexOf('{');
    if (start === -1) return [];
    let listing;
    try {
        listing = JSON.parse(text.slice(start, text.lastIndexOf('}') + 1));
    } catch {
        return [];
    }
    const models = [];
    for (const entry of listing?.models || []) {
        if (!entry?.key || entry.available === false) continue;
        if (!models.includes(entry.key)) models.push(entry.key);
    }
    return models;
}

module.exports = { familyOf, piModels, opencodeModels, boxedModels, openclawModels, openclawResult, lineHandler, toolLabel, turnUnfinished };

