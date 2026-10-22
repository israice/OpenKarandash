// Сборка аргументов хода CLI: проверка без настоящего CLI.
//
// Что ловит: коннектор, который не смог собрать аргументы хода. Ход тогда не
// начинается вовсе, и человек в чате видит ошибку вместо ответа: в v0.0.191
// семейство CLI уехало в отдельный файл (SYSTEM/cli/any-family.js), а вызов
// на старом месте остался — «families.get is not a function». Ни одна
// прежняя проверка этого не видела: node --check, eslint с единственным
// правилом no-undef и madge смотрят на связи модулей, а не на то, какие
// методы у полученного объекта есть.
//
// И продолжение хода: ход, оборвавшийся на середине, пульт продолжает тем же
// CLI, и аргументы следующего запуска приходят из buildArgs — а он async.
// Без ожидания у обещания нет поля args, продолжение падало с «args is not
// iterable», и ход умирал, не досказав ничего. Та же проверка, тот же путь
// коннектора: первый запуск обрывается на середине, второй должен состояться.
//
// Что не ловит: сам ход. Он стоит минут и денег, а проверка должна быть
// быстрой и повторяемой, поэтому настоящий CLI не запускается: подменены и
// его справка (по ней опознаётся семейство), и сам запуск.
//
// Как проверяет: идёт через публичный контракт коннектора (create →
// activate → ask) и смотрит, какие аргументы ушли в CLI. Какой именно путь
// внутри коннектора это — неважно: сломается он, упадёт проверка.
const path = require('node:path');
const child = require('node:child_process');

// корень проверяемого дерева: свой — для ветки исполнителя (--root), общий —
// для главной копии
const rootArg = process.argv.indexOf('--root');
const ROOT = rootArg > 0 && process.argv[rootArg + 1] ? path.resolve(process.argv[rootArg + 1]) : path.join(__dirname, '..');

// Семейство и его справка: по справке семейство и опознаётся
// (SYSTEM/cli/any-parse.js, familyOf). Ожидаемые аргументы — те, что должны
// уйти в CLI при выбранной модели и уровне размышления
const FAMILIES = [
    {
        name: 'opencode',
        help: [
            'opencode run [flags] [<message...>]',
            'Flags:',
            '  --format <format>   output format (json|text)',
            '  --model <model>     model to use',
            '  --thinking           enable reasoning',
        ].join('\n'),
        expect: ['run', '--format', 'json', '--model', 'test/model', '--thinking'],
        // у семейства есть своя сессия CLI: ход, оборванный на середине, пульт
        // продолжает тем же CLI и с той же сессией
        session: true,
    },
    {
        name: 'pi',
        help: [
            'pi [options] [prompt]',
            'Options:',
            '  --mode <mode>       output mode',
            '  --print              print the response',
            '  --model <model>     model to use',
            '  --thinking <level>   thinking level',
        ].join('\n'),
        expect: ['-p', '--mode', 'json', '--model', 'test/model', '--thinking', 'high'],
        session: true,
    },
    {
        name: 'plain',
        help: 'some-cli 1.0.0\n  --help  show this help',
        expect: ['run'],
        // у plain нет ни сессии, ни потока событий: продолжать ему нечем, и ход
        // заканчивается вместе с ответом
        session: false,
    },
];

const MODEL = 'test/model';
const EFFORT = 'high';
const PROMPT = 'проверка сборки аргументов';
// сессия CLI, которую пульт продолжает после оборванного хода: у семейств с
// сессией она уходит в аргументы второго запуска
const SESSION_ID = 'ses_test';

// Подмена справки CLI: семейство опознаётся по ней, и помощь эта нужна
// один раз на цель. Подменяем до того, как коннектор загружен: модуль
// семейства забирает spawnSync при загрузке и дальше зовёт уже свою копию
const realSpawnSync = child.spawnSync;
let help = '';
child.spawnSync = () => ({ stdout: help, stderr: '', status: 0, error: null });

// Подмена запуска CLI: аргументы хода записываются, сам ход не идёт
const spawn = require(path.join(ROOT, 'SYSTEM', 'cli', 'spawn.js'));
const realRun = spawn.run;
let launched = [];
// ход, оборвавшийся на середине: первый запуск помечает ход незаконченным
// (модель собиралась звать инструменты, а процесс вышел) — пульт обязан
// продолжить его тем же CLI. Поднимается по требованию: обычный сценарий
// ход заканчивает, и продолжения у него нет
let cutTurn = false;
// поток событий хода: если задан, каждый запуск CLI печатает такие строки
// NDJSON — разбор хода (any-parse.js) проверяется на настоящем своём пути,
// как он проверяется на живом CLI
let stream = null;
spawn.run = async (target, args, options) => {
    launched.push(args);
    if (cutTurn && launched.length === 1) {
        ctx.meta.wantsTools = true;
        ctx.cliSessionId = SESSION_ID;
    }
    if (stream) {
        for (const line of stream) options.onLine(line);
    }
    return '';
};

const any = require(path.join(ROOT, 'SYSTEM', 'cli', 'any.js'));

// Обвязка хода: настоящая (SYSTEM/core/run-turn.js) пишет в базу и следит за
// событиями, а здесь нужно только довести ход до запуска CLI. События потока
// не приходят — CLI не отвечает, — и ход на этом заканчивается. Своя на
// каждый сценарий: состояние хода переживать не должна
let ctx = newCtx();
function newCtx() {
    return {
        noteInput() {}, run: {}, notice() {}, emit() {}, fail() {}, cliSessionId: null, begin() {},
        meta: { usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 } },
    };
}
const deps = {
    runTurn: async (params, send, body) => { await body(ctx); },
    resumeAndHandoff: async () => ({ resumeId: null, handoff: '' }),
    db: {},
};

const problems = [];

async function check(family) {
    help = family.help;
    launched = [];
    // цель у FAMILY своя: семейство запоминается на цель, и та же цель отдала
    // бы прежнее семейство
    const target = { id: `${family.name}-local`, label: family.name, cmd: family.name, args: [] };
    const connector = any.create(deps, family.name);
    connector.activate(target);
    try {
        await connector.ask({ prompt: PROMPT, model: MODEL, effort: EFFORT, mode: 'Chat' }, () => {});
    } catch (error) {
        problems.push(`${family.name}: ход не собрался — ${error.message}`);
        return;
    }
    if (launched.length === 0) {
        problems.push(`${family.name}: CLI не запущен вовсе`);
        return;
    }
    const args = launched[0];
    for (const wanted of family.expect) {
        if (!args.includes(wanted)) {
            problems.push(`${family.name}: в аргументах хода нет «${wanted}» (есть: ${args.join(' ')})`);
        }
    }
}

// Ход, оборвавшийся на середине: модель закончила шаг намерением звать
// инструменты, а процесс вышел (DOCS/decisions/101). Пульт обязан продолжить
// ход тем же CLI и с той же сессией — иначе работа остаётся на первом шаге.
//
// Проверка ловит форму того, что уходит в продолжение: аргументы следующего
// запуска — это обещание (buildArgs — async), и без ожидания у обещания нет
// поля args. Тогда продолжение падало с «args is not iterable», и ход умирал,
// не досказав ничего: человек видел в ленте обрыв без ответа.
async function checkContinuation(family) {
    help = family.help;
    launched = [];
    cutTurn = true;
    ctx = newCtx();
    const target = { id: `${family.name}-local`, label: family.name, cmd: family.name, args: [] };
    const connector = any.create(deps, family.name);
    connector.activate(target);
    try {
        await connector.ask({ prompt: PROMPT, model: MODEL, effort: EFFORT, mode: 'Chat' }, () => {});
    } catch (error) {
        problems.push(`${family.name}: продолжение хода сломано — ${error.message}`);
        return;
    }
    if (launched.length < 2) {
        problems.push(`${family.name}: оборванный ход не продолжился (запусков CLI: ${launched.length})`);
        return;
    }
    if (!launched[1].includes(SESSION_ID)) {
        problems.push(`${family.name}: продолжение пошло без прежней сессии CLI (есть: ${launched[1].join(' ')})`);
    }
}

// Чем кончился ход по разбору потока (DOCS/decisions/133). opencode-схема
// финальному тексту step_finish не шлёт вовсе, поэтому причина шага с
// инструментами («tool-calls») оставалась в wantsTools навсегда, и ход с
// готовым ответом был доведён, а читался как незавершённый — продолжения
// по кругу и «ход не доведён за 6 продолжений» в ленте. Оба сценария идут
// на opencode-семействе: форма «текст без финального step_finish» — его
// особенность, а инструменты и у pi кончаются тем же шагом
function streamEvent(event) {
    return JSON.stringify({ sessionID: SESSION_ID, ...event });
}

async function askWithStream(lines, { cliSessionId = null } = {}) {
    ctx = newCtx();
    ctx.cliSessionId = cliSessionId;
    help = FAMILIES[0].help;
    launched = [];
    stream = lines;
    const target = { id: 'opencode-local', label: FAMILIES[0].name, cmd: FAMILIES[0].name, args: [] };
    const connector = any.create(deps, FAMILIES[0].name);
    connector.activate(target);
    try {
        await connector.ask({ prompt: PROMPT, model: MODEL, effort: EFFORT, mode: 'Chat' }, () => {});
    } catch (error) {
        problems.push(`opencode: разбор хода упал — ${error.message}`);
    }
    stream = null;
}

const TOOL_STEP = () => streamEvent({ type: 'tool_use', part: { callID: 'c1', tool: 'shell', state: { status: 'completed', input: {} } } });
const TOOL_FINISH = () => streamEvent({ type: 'step_finish', part: { reason: 'tool-calls', tokens: {} } });

async function main() {
    for (const family of FAMILIES) await check(family);
    for (const family of FAMILIES.filter((one) => one.session)) await checkContinuation(family);
    // текст после последнего step_finish отменяет его причину: ход доведён
    await askWithStream([TOOL_STEP(), TOOL_FINISH(), streamEvent({ type: 'text', part: { text: 'готовый ответ' } })]);
    if (launched.length !== 1) {
        problems.push(`opencode: ход с готовым ответом продолжен (запусков CLI: ${launched.length})`);
    }
    // шаг, сам закончившийся намерением звать инструменты, продолжается, как и было
    await askWithStream([TOOL_STEP(), TOOL_FINISH()], { cliSessionId: SESSION_ID });
    if (launched.length < 2) {
        problems.push('opencode: шаг с намерением звать инструменты не продолжен');
    }
    child.spawnSync = realSpawnSync;
    spawn.run = realRun;
    if (problems.length === 0) {
        console.log('чисто');
        return 0;
    }
    for (const problem of problems) console.log(`  ${problem}`);
    return 1;
}

main()
    .then((code) => process.exit(code))
    .catch((error) => {
        child.spawnSync = realSpawnSync;
        spawn.run = realRun;
        console.error(error);
        process.exit(1);
    });
