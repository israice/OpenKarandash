// Коннектор CLI, имя которого мы не знаем заранее.
//
// Список агентов приходит с сайта (SYSTEM/cli-agents.js) и меняется: сегодня в
// нём «Kilo Code», завтра будет что-то ещё. Коннектор на каждое имя заводить
// нельзя — список всё равно обгоняет код, — поэтому здесь один коннектор на
// всех, и он работает с тем словом, которое человек выбрал в строке выбора
// (SYSTEM/model-cascade.js). Слово приходит полем agent в теле запроса и
// разбирается здесь один раз: имя → команда на этой машине → семейство
// протокола → свои флаги запуска и свой разбор потока.
//
// Пять семейств, все пять проверены живьём на этой машине:
//
// - **pi.** `pi --mode json -p …` печатает NDJSON с session,
//   tool_execution_start/end и message_end. Список моделей —
//   `pi --list-models` (таблица с заголовком «provider»). На Windows у pi нет
//   бинарника: `where pi` находит npm-шим pi.cmd, а spawn без shell такой файл
//   не запускает (Node 20.12 отвечает EINVAL) — общий разбор шима ниже снимает
//   и это, и случай kilo.
// - **opencode.** `kilo run "…" --format json --thinking` печатает события с
//   part: text, reasoning, tool_use, step_finish, error. Список моделей —
//   `kilo models`. На этой же схеме говорит сам opencode, от которого kilo
//   произошёл.
// - **plain.** Всё остальное, о чём `--help` не сказал ничего похожего: ход
//   идёт как `run "…"`, ответом считается весь вывод. Шагов и размышлений такой
//   CLI не отдаёт, но работа не теряется.
// - **openclaw.** `openclaw agent --local --json --message-file …` печатает в
//   конце один JSON-объект на весь ход (ответ в payloads, сессия в
//   meta.agentMeta.sessionId), а в stderr — служебный шум. Потока событий нет
//   вовсе, поэтому ответ собирается из объекта целиком, а не построчно.
// - **hermes.** Подкоманды `run` у hermes нет: ход на один промпт делает флаг
//   `-z/--oneshot`, печатающий в stdout только ответ, а учёт (токены, цена,
//   session_id следующего хода) приходит отдельным файлом `--usage-file`.
//   Поэтому он уводился в plain и слал несуществующую команду — см. DOCS/decisions/100.
//
// Семейство определяется один раз на цель и запоминается: `--help` при каждом
// ходе стоил бы целого запуска процесса.
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { run } = require('./spawn.js');
const { familyOf, piModels, opencodeModels, boxedModels, lineHandler } = require('./any-parse.js');
const { headlessApproveFlag } = require('./headless-approve.js');
const { driveToEnd, CONTINUE_PROMPT } = require('./turn-continuation.js');

const ASK_TIMEOUT_MS = Number(process.env.CLI_ASK_TIMEOUT_MS) || Number(process.env.PI_ASK_TIMEOUT_MS) || 3_600_000;
const DETECT_TIMEOUT_MS = 15000;
const MODELS_TIMEOUT_MS = 30000;

// openclaw отличается от остальных семейств формой ответа (один JSON вместо
// потока событий) и доставкой промпта (файл вместо аргумента), поэтому всё
// его специфичное живёт в any-openclaw.js, а здесь остаётся только вызов.
// hermes отличается способом хода (не подкоманда, а флаг `-z/--oneshot`) и
// учётом (не в stdout, а отдельным файлом отчёта) — по той же причине он
// тоже живёт в any-hermes.js
const { buildArgs: openclawBuildArgs, models: openclawModels, ask: askOpenClaw } = require('./any-openclaw.js');
const { buildArgs: hermesBuildArgs, models: hermesModels, ask: askHermes } = require('./any-hermes.js');

// Заглушка уборки для семейств, у которых промпт лежит прямо в аргументах:
// файла не было — чистить нечего
const noop = () => {};

// Из слова «Kilo Code» — короткое имя для переменной окружения, id цели и
// имени в сообщениях: без пробелов и в нижнем регистре. Идёмпотентно, и
// именно эта форма стоит в target сессии, поэтому менять её нельзя без
// смены всех уже записанных сессий

const slugOf = (name) => String(name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');

// Кандидаты в имени команды для слова из списка: «Kilo Code» — это kilo,
// «Claude Code» — claude, «Command Code» — command. Полное слово без
// пробелов («kilocode») тоже пробуем: у части CLI бинарник назван именно так.
// Порядок неслучаен — короткое слово проверяется вторым, и почти каждое имя
// из списка оказывается именно таким
function commandCandidates(name) {
    const words = String(name || '').trim().toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const candidates = [];
    for (const value of [words.join(''), words[0], ...words]) {
        if (value && !candidates.includes(value)) candidates.push(value);
    }
    return candidates;
}

// npm-шим Windows — .cmd/.bat, а он не исполняем: внутри лежит настоящий вход
// пакета на node, и его путь из шима вычитывается. Это единственный способ
// запустить незнакомый CLI на Windows без shell, и он одинаков для pi, kilo и
// всего, что дальше поставят через npm
function nodeEntryFromShim(shimPath) {
    let text;
    try {
        text = fs.readFileSync(shimPath, 'utf8');
    } catch {
        return null;
    }
    // путь внутри шима написан от его папки: «%dp0%\node_modules\…»
    const found = text.match(/"[^"]*node_modules[^"]*"/g) || [];
    const last = found[found.length - 1];
    if (!last) return null;
    const relative = last.replace(/^"|"$/g, '')
        .replace(/%~dp0[\\/]|%dp0%/gi, '')
        // шим пишет путь со своим разделителем и часто с ведущим слэшем        // («\node_modules\…»): resolve на Windows понял бы его как корень
        // диска и ушёл не в ту папку, поэтому слэши приводим к разделителю
        // системы, а ведущий убираем
        .replace(/^[\\/]+/, '')
        .replace(/[\\/]+/g, path.sep);
    const entry = path.resolve(path.dirname(shimPath), relative);
    return fs.existsSync(entry) ? entry : null;
}

// Команда на этой машине: сперва переменная окружения владельца
// (KILO_BIN, PI_BIN — имя слова заглавными), потом PATH. В Windows `where`
// печатает и .exe, и .cmd, и шим без расширения: берём .exe как есть, а .cmd
// раскрываем до входа пакета. Ничего не нашлось — цели нет в списке вовсе,
// а не «найдена и падает при первом запуске»
function resolveCommand(name) {
    const override = process.env[slugOf(name).toUpperCase() + '_BIN'];
    if (override && fs.existsSync(override)) {
        return { cmd: override, args: [] };
    }
    const isWindows = process.platform === 'win32';
    for (const candidate of commandCandidates(name)) {
        let found = [];
        try {
            found = execFileSync(isWindows ? 'where' : 'which', [candidate], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
                .split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        } catch {
            continue; // этого имени в PATH нет — пробуем следующее
        }
        if (isWindows) {
            const exe = found.find((file) => file.toLowerCase().endsWith('.exe'));
            if (exe) return { cmd: exe, args: [] };
            for (const shim of found) {
                const entry = nodeEntryFromShim(shim);
                if (entry) return { cmd: process.execPath, args: [entry] };
            }
        }
        return { cmd: found[0], args: [] };
    }
    return null;
}

// Вывод CLI в одном месте: прямой запуск с перехватом и stdout, и stderr.
// Нужен для `--help` (kilo печатает помощь в stderr, pi и omp — в stdout) и
// для списка моделей. Через spawn.js не годится: там stderr уходит в текст
// ошибки, а не в ответ, и помощь незнакомого CLI молча выглядела бы как пустая
function capture(target, args, timeoutMs = 20000) {
    // spawnSync, а не execFileSync: у kilo помощь идёт в stderr при коде 0, а
    // execFileSync отдаёт только stdout — по нему family остался бы «plain»,
    // и ход пошёл бы без потока событий и без --model. stderr наш процесс не
    // наследует: иначе каждая проверка CLI печатала бы свою справку в консоль
    // сервера
    const result = spawnSync(target.cmd, [...target.args, ...args], {
        encoding: 'utf8', timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024,
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    // CLI печатает помощь или каталог и при ненулевом коде (kilo так делает
    // даже на `--help`): текст всё равно полезен для разбора family
    return `${result.stdout || ''}${result.stderr || ''}`;
}

// у pi нет режима разрешений вроде --permission-mode: обсуждение получается
// строгим списком инструментов. У opencode-схемы флага allowlist нет вовсе,
// поэтому там режим Chat помечает только строку в базе
const PI_CHAT_TOOLS = 'read,grep,find,ls';

function parseVersion(stdout) {
    const match = String(stdout).match(/\d+\.\d+\.\d+/);
    return match ? match[0] : String(stdout).trim().split('\n')[0];
}

// Уровни размышления opencode-схемы: у kilo это «--variant», и значения у него
// свои у каждой модели — справка приводит примеры («e.g., high, max, minimal»).
// Читаем их оттуда же, где family: без этого флаг ушёл бы с уровнем, которого
// эта модель не знает, и CLI ответил бы ошибкой вместо хода
function variantEfforts(help) {
    const line = String(help || '').split(/\r?\n/).find((row) => /--variant/.test(row));
    const at = line ? line.indexOf('e.g.') : -1;
    if (at < 0) return null;
    return line.slice(at + 4).split(/[^a-z0-9-]+/i).filter(Boolean);
}
// create(deps, name): deps — как у всех коннекторов (runTurn,
// resumeAndHandoff, db), name — слово из списка CLI, выбранное человеком.
// Контракт наружу прежний (targets/detect/version/models/activate/connected/
// ask), поэтому маршруты /api/agent/* одинаковы для любого имени
function create(deps, name) {
    const { runTurn, resumeAndHandoff, db } = deps;
    const slug = slugOf(name);

    let activeTarget = null;
    // семейство протокола — навсегда для этой цели: спрашивать `--help` на
    // каждом ходе означало бы платить целый запуск процесса за ничего
    const families = new WeakMap();

    const cli = (target, args, options) => run(target.cmd, [...target.args, ...args], options);

    // id цели — с префиксом-слигой: все цели идут в общую колонку sessions.target,
    // и по нему agentNameByTarget (SYSTEM/cli/index.js) понимает, чьим был ход
    function targets() {
        const command = resolveCommand(name);
        if (!command) return [];
        return [{ id: `${slug}-local`, label: name, cmd: command.cmd, args: command.args }];
    }

    async function familyOfTarget(target) {
        if (families.has(target)) return families.get(target).family;
        // Помощь спрашивается прямой capture, а не через spawn.js: kilo печатает
        // её в stderr, а spawn.js отдаёт stderr только текстом ошибки — по
        // нему family остался бы «plain», и ход пошёл бы без потока событий
        // и без --model. Общая помощь и помощь подкоманды run складываются:
        // свои флаги хода у kilo (`--format`, `--thinking`) видны только в
        // `kilo run --help`, а не в общей справке, и по общей мы признали бы
        // его самым простым случаем
        let help = capture(target, ['--help']);
        if (/run \[message/i.test(help)) help += capture(target, ['run', '--help']);
        const family = familyOf(help);
        // уровни размышления и флаг одобрения прав запоминаем рядом с
        // семейством — из той же справки, второй её запуск стоил бы целого
        // запуска процесса
        families.set(target, { family, variants: variantEfforts(help), approve: headlessApproveFlag(help) });
        return family;
    }

    // как запускать ход именно у этого CLI: его семейство и его флаг прав
    function launchFlags(target) {
        return families.get(target) || {};
    }

    async function detectInstalls() {
        const checks = await Promise.allSettled(targets().map(async (target) => ({
            id: target.id,
            label: target.label,
            version: parseVersion(await cli(target, ['--version'], { timeoutMs: DETECT_TIMEOUT_MS })),
        })));
        return checks.filter((check) => check.status === 'fulfilled').map((check) => check.value);
    }

    // Список моделей спрашивает сам CLI — заранее знать его нельзя, и способ
    // свой у каждого семейства: у pi это `--list-models` (таблица с заголовком
    // «provider»), у omp — подкоманда `models list` (та же таблица в рамке, у
    // которой шлюз подписан сверху), у opencode-схемы — `kilo models` (путь
    // по строке на модель). Ответ приходит тем же путём, что и подключение, и
    // сохраняется у человека в каскаде выбора, поэтому пустой список (нет сети,
    // сломанный каталог) оставляет строку выбора на дефолте, а не ломает
    // подключение
    async function fetchModels(target) {
        const family = await familyOfTarget(target);
        if (family === 'pi') {
            const table = capture(target, ['--list-models'], MODELS_TIMEOUT_MS);
            return piModels(table).length ? piModels(table) : boxedModels(capture(target, ['models', 'list'], MODELS_TIMEOUT_MS));
        }
        if (family === 'opencode') {
            const listing = capture(target, ['models'], MODELS_TIMEOUT_MS);
            return opencodeModels(listing).length ? opencodeModels(listing) : boxedModels(listing);
        }
        if (family === 'openclaw') {
            // каталог openclaw без `--all` пуст до первого хода: он показывает
            // только то, чем пользовалась текущая сессия
            return openclawModels({ target, capture, timeoutMs: MODELS_TIMEOUT_MS });
        }
        if (family === 'hermes') {
            return hermesModels({ target, capture, timeoutMs: MODELS_TIMEOUT_MS });
        }
        return [];
    }

    // Флаги запуска — единственное, что у семейств различается besides разбора:
    // пишет ли CLI поток событий, чем заменить `--` перед промптом и куда его
    // положить. Возвращает аргументы и уборку: у openclaw промпт живёт в
    // файле, который переживает ровно один ход
    async function buildArgs(target, family, { model, effort, resumeId, mode, text, approve }) {
        if (family === 'pi') {
            const args = ['-p', '--mode', 'json'];
            if (model) args.push('--model', model);
            // глубина размышления: у pi это `--thinking <level>`, и значения
            // называет он сам (off, minimal, low, medium, high, xhigh, max) —
            // тот же набор, что показывает строка выбора в интерфейсе
            if (effort) args.push('--thinking', effort);
            if (resumeId) args.push('--session', resumeId);
            if (mode === 'Chat') args.push('--tools', PI_CHAT_TOOLS);
            // ход неинтерактивный — спрашивать права некому (headlessApproveFlag)
            if (approve) args.push(approve);
            // `--` обязателен: без него промпт, начинающийся с дефиса, ушёл бы
            // в разбор флагов
            args.push('--', text);
            return { args, cleanup: noop };
        }
        if (family === 'opencode') {
            const args = ['run', text, '--format', 'json'];
            // рассуждение печатается отдельными событиями только с этим флагом
            args.push('--thinking');
            if (model) args.push('--model', model);
            // глубина здесь «--variant», и она provider-specific: уезжает
            // только тем значением, которое эта модель знает (variantEfforts),
            // иначе CLI ответил бы ошибкой на незнакомый вариант
            if (effort && (families.get(target)?.variants || []).includes(effort)) args.push('--variant', effort);
            if (resumeId) args.push('--session', resumeId);
            if (approve) args.push(approve);
            return { args, cleanup: noop };
        }
        if (family === 'openclaw') {
            return openclawBuildArgs({ model, resumeId, text });
        }
        if (family === 'hermes') {
            return hermesBuildArgs({ model, effort, resumeId, text });
        }
        const plain = ['run', text];
        if (approve) plain.push(approve);
        return { args: plain, cleanup: noop };
    }

async function ask({ prompt, model, effort, sessionId, mode, hints, skill, homework, plan }, send) {
    if (!activeTarget) return send({ type: 'error', error: `${name} is not connected` });
    const target = activeTarget;
    if (!prompt) return send({ type: 'error', error: 'Empty request' });

    const family = await familyOfTarget(target);
    const { resumeId, handoff } = await resumeAndHandoff(sessionId, target.id, hints, skill, homework, plan, prompt);
    const text = handoff + prompt;
    // флаг одобрения прав — из справки этого же CLI (headlessApproveFlag):
    // ход неинтерактивный, и право «спросить человека» в нём означало бы
    // молчаливый отказ на первом же шаге
    const { approve } = launchFlags(target) || {};
    const { args, cleanup, usage } = await buildArgs(target, family, { model, effort, resumeId, mode, text, approve });

        // подсказки, приём и отчёт разведки едут в runTurn не ради текста
        // запроса (он уже собран в handoff выше), а ради своих оценок: они
        // ложатся в result_meta хода
        try {
            return await runTurn({ target, prompt, sessionId, model, effort, mode, plan, hints, skill, homework }, send, async (ctx) => {
                // весь текст, который уходит в CLI, а не только вопрос человека
                ctx.noteInput(text);
                if (family === 'openclaw') {
                    await askOpenClaw({ ctx, cli, target, args, timeoutMs: ASK_TIMEOUT_MS });
                    return;
                }
                if (family === 'hermes') {
                    await askHermes({ ctx, cli, target, args, usage, timeoutMs: ASK_TIMEOUT_MS });
                    return;
                }
                if (family === 'plain') {
                    // потока событий нет — ответом считаем весь вывод процесса
                    const stdout = await cli(target, args, {
                        timeoutMs: ASK_TIMEOUT_MS,
                        onSpawn: (child) => { ctx.run.child = child; },
                    }).catch((err) => { ctx.fail(err.message); return ''; });
                    if (!stdout.trim()) return;
                    ctx.answer = stdout.trim();
                    ctx.emit({ type: 'text', text: ctx.answer });
                    return;
                }
                // Один запуск CLI. Разбор потока создаётся на каждый запуск заново: у
                // продолжения своя сессия и свои вызовы инструментов, и Position-
                // карта прошлого запуска им не нужна
                const runOnce = (current) => {
                    const onLine = lineHandler(family, db);
                    return cli(target, current, {
                        timeoutMs: ASK_TIMEOUT_MS,
                        onLine: (line) => onLine(ctx, line),
                        onSpawn: (child) => { ctx.run.child = child; },
                    });
                };
                // Пока CLI сам не довёл ход до ответа, пульт продолжает его тем же
                // CLI и тем же выбором модели (DOCS/decisions/101)
                await driveToEnd({
                    ctx,
                    args,
                    runOnce,
                    buildArgs: (resume) => buildArgs(target, family, { model, effort, resumeId: resume, mode, text: CONTINUE_PROMPT, approve }).args,
                });
            });
        } finally {
            cleanup();
        }
    }

    return {
        name,
        slug,
        targets,
        detect: detectInstalls,
        version: (target) => cli(target, ['--version'], { timeoutMs: DETECT_TIMEOUT_MS }).then(parseVersion),
        models: fetchModels,
        activate: (target) => { activeTarget = target; },
        connected: () => Boolean(activeTarget),
        ask,
    };
}

module.exports = { create, slugOf };
