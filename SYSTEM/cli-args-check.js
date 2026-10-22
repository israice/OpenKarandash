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
    },
    {
        name: 'plain',
        help: 'some-cli 1.0.0\n  --help  show this help',
        expect: ['run'],
    },
];

const MODEL = 'test/model';
const EFFORT = 'high';
const PROMPT = 'проверка сборки аргументов';

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
spawn.run = async (target, args) => { launched.push(args); return ''; };

const any = require(path.join(ROOT, 'SYSTEM', 'cli', 'any.js'));

// Обвязка хода: настоящая (SYSTEM/core/run-turn.js) пишет в базу и следит за
// событиями, а здесь нужно только довести ход до запуска CLI. События потока
// не приходят — CLI не отвечает, — и ход на этом заканчивается
const ctx = { noteInput() {}, run: {}, meta: {}, notice() {}, emit() {}, fail() {}, cliSessionId: null };
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

async function main() {
    for (const family of FAMILIES) await check(family);
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
