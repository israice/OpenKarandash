// Семейство протокола CLI: по справке CLI узнаётся, по какой схеме с ним
// говорить (pi, opencode, openclaw, hermes, plain), и какие у него флаги
// запуска. Отдельный файл от any.js: это разбор чужого вывода, а в any.js
// рядом с ним — запуск хода (DOCS/decisions/022).
const { spawnSync } = require('child_process');
const { familyOf } = require('./any-parse.js');
const { headlessApproveFlag } = require('./headless-approve.js');

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

// create(): семейство узнаётся один раз на цель и запоминается — `--help` при
// каждом ходе стоил бы целого запуска процесса
function create(captureCommand = capture) {
    const families = new WeakMap();
    return {
        capture: captureCommand,
        // Помощь спрашивается прямой capture, а не через spawn.js: kilo печатает
        // её в stderr, а spawn.js отдаёт stderr только текстом ошибки — по нему
        // family остался бы «plain», и ход пошёл бы без потока событий и без
        // --model. Общая помощь и помощь подкоманды run складываются: свои флаги
        // хода у kilo (`--format`, `--thinking`) видны только в `kilo run --help`,
        // а не в общей справке, и по общей мы признали бы его самым простым
        // случаем
        async of(target) {
            if (families.has(target)) return families.get(target).family;
            let help = await captureCommand(target, ['--help']);
            // Признак прежний («run [message]») в новой справке opencode не
            // встречается: там в списке команд просто «run — Run OpenCode with a
            // message», а usage-строка «opencode run [flags] [<message...>]», —
            // и по старому признаку подкоманда не опознавалась: семейство
            // оставалось plain, ход шёл без --model и без потока событий, а
            // каталог моделей был пуст
            if (/^\s*run\s/im.test(help) || /run \[/i.test(help)) {
                help += await captureCommand(target, ['run', '--help']);
            }
            const family = familyOf(help);
            // уровни размышления и флаг одобрения прав запоминаются рядом с
            // семейством — из той же справки, второй их запуск стоил бы целого
            // запуска процесса
            families.set(target, { family, variants: variantEfforts(help), approve: headlessApproveFlag(help) });
            return family;
        },
        // флаги запуска — те же, что достались семейству
        flags: (target) => families.get(target) || {},
    };
}

module.exports = { create, capture };
