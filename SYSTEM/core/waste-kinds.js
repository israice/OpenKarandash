// Что считается лишним шагом хода: один список на замер (TOOLS/steps/run.mjs)
// и на подсказку агенту (waste-hints.js). Списка два быть не должно —
// подсказка и замер обязаны говорить об одном и том же, иначе агента предупреждают
// не о том, что потом меряют.
//
// Каждый вид — проверка факта, а не мнение: шаг либо повторяет то, что уже
// сделано в этой же сессии, либо идёт в обход инструмента, который для этого
// есть. Виды, где «лишним» можно считать только на глаз, помечены soft и в
// общий счёт с нарушениями не идут.
//
// Замер на 8 последних сессиях 2026-10-04: 326 шагов, 112 лишних (34 %),
// жёстких 58 (18 %). По видам: read-untouched 54, homework-late 22,
// console-read 18, list-to-guess 11, check-again 5, homework-skipped 2.

// ---------- признаки шага ----------

const CHECK_RE = /npm run check|npx\s+(eslint|madge)/;
const HOMEWORK_RE = /TOOLS[\\/]homework[\\/]run\.mjs/;
// чтение файла и поиск по нему консолью там, где есть инструмент чтения и grep:
// русский текст оттуда приходит кракозябрами (AGENTS.override.md)
const CONSOLE_READ_RE = /Get-Content|Select-String|findstr|git\s+grep|grep\s+-r|\btype\s+\S+\.(js|mjs|md|css|html|json)\b|cat\s+\S+\.(js|mjs|md|css|html|json)\b/;
// перечисление папки, чтобы вспомнить имена файлов: они перечислены в README
// раздела и в карте проекта, а список папок к ответу ничего не добавляет
const LIST_RE = /^\s*(Get-ChildItem|gci|ls|dir)\b/i;
const SEARCH_TOOLS = /^(grep|glob|read|find)$/;
const WRITE_TOOLS = /^(write|edit|multiedit|patch)$/;

const norm = (p) => String(p || '').replace(/\\/g, '/').toLowerCase();

function arg(input, key) {
    try { return JSON.parse(input || '{}')[key]; } catch { return undefined; }
}

// ---------- виды ----------

const KINDS = [
    {
        id: 'check-again',
        what: 'повторный прогон npm run check: правило требует один раз, после всех правок',
        remedy: 'npm run check запускай один раз, в самом конце, после всех правок',
    },
    {
        id: 'console-read',
        what: 'чтение файла или поиск консолью вместо инструмента чтения и grep',
        remedy: 'читать и искать инструментами чтения и grep, не консолью: консоль отдаёт русский текст кракозябрами',
    },
    {
        id: 'list-to-guess',
        what: 'перечисление папки, чтобы вспомнить имена файлов: они описаны в README',
        remedy: 'имена сценариев и файлов перечислены в README раздела — читай README, а не перечисляй папку',
    },
    {
        id: 'read-untouched',
        soft: true,
        what: 'чтение файла, в котором ход нигде не менял ни строчки (мягкий вид)',
        remedy: 'файл, в котором не меняешь ни строчки, не читай: точного поиска по классу достаточно',
    },
    {
        id: 'homework-late',
        what: 'разведка grep/glob/read раньше домашней работы: на замере 122 шага против 37',
        remedy: 'первым ходом запускай node TOOLS/homework/run.mjs с текстом задачи, а не grep и не чтение наугад',
    },
];

// вид, который считается один раз за сессию, а не за шаг: у него нет проверки
// шага, поэтому и записи в KINDS у него нет — описание живёт здесь
const SESSION_KIND = {
    id: 'homework-skipped',
    what: 'домашняя работа не запускалась ни разу (счёт за сессию, не за шаг)',
    remedy: 'первым ходом запускай node TOOLS/homework/run.mjs с текстом задачи',
};

// ---------- разбор шага ----------

// файлы, которых ход коснулся: по ним видно, какие из прочитанных он правда
// менял, а какие прочитал просто так
function editedFiles(steps) {
    const set = new Set();
    for (const s of steps) {
        if (!WRITE_TOOLS.test(s.tool_name || '')) continue;
        const fp = arg(s.tool_input, 'filePath') || arg(s.tool_input, 'path');
        if (fp) set.add(norm(fp));
    }
    return set;
}

function stepOf(row) {
    return {
        position: row.position,
        tool_name: row.tool_name,
        tool_error: row.tool_error,
        cmd: arg(row.tool_input, 'command') || '',
        file: norm(arg(row.tool_input, 'filePath') || arg(row.tool_input, 'path')),
    };
}

// где в сессии лежит домашняя работа: «разведка раньше неё» — свойство всей
// сессии, а не отдельного шага, поэтому оно ищется первым проходом
function homeworkAt(steps) {
    for (const s of steps) {
        if (HOMEWORK_RE.test(arg(s.tool_input, 'command') || '')) return s.position;
    }
    return 0;
}

// проверка шага на вид. hit возвращает истину или ложь и может менять состояние
// сессии (счётчики), поэтому порядок видов в KINDS важен для check-again
function hits(kind, step, st) {
    switch (kind.id) {
        case 'check-again':
            return CHECK_RE.test(step.cmd) && st.checks++ > 0;
        case 'console-read':
            return Boolean(step.cmd) && CONSOLE_READ_RE.test(step.cmd);
        case 'list-to-guess':
            return Boolean(step.cmd) && LIST_RE.test(step.cmd) && /TOOLS|SYSTEM|PROJECTS|DOCS/.test(step.cmd);
        case 'read-untouched':
            return step.tool_name === 'read' && Boolean(step.file) && !st.edited.has(step.file);
        case 'homework-late':
            return st.homeworkAt > 0 && step.position < st.homeworkAt && SEARCH_TOOLS.test(step.tool_name || '');
        default:
            return false;
    }
}

// карта вид → позиции шагов, которые под него подошли. Шаги приходят по
// position; порядок не нужен, но база отдаёт его как есть — сортируем на входе
function classify(steps) {
    const st = { checks: 0, edited: editedFiles(steps), homeworkAt: homeworkAt(steps) };
    const found = new Map();
    for (const row of steps.slice().sort((a, b) => a.position - b.position)) {
        const step = stepOf(row);
        for (const kind of KINDS) {
            if (!hits(kind, step, st)) continue;
            if (!found.has(kind.id)) found.set(kind.id, []);
            found.get(kind.id).push(step.position);
        }
    }
    // сессия без домашней работы: один счёт за сессию, а не за каждый шаг —
    // это не шаг, а сам факт, и в сумме лишних он стоит единицу
    if (!st.homeworkAt) found.set(SESSION_KIND.id, [steps[0]?.position ?? 0]);
    return found;
}

// жёсткий лишний шаг — тот, что нарушает правило буквально; мягкий (чтение
// файла без правки) в общий счёт с нарушениями не идёт
function hardCount(found) {
    return [...found.entries()]
        .filter(([id]) => !KINDS.find((k) => k.id === id)?.soft)
        .reduce((n, [, p]) => n + p.length, 0);
}

module.exports = { KINDS, SESSION_KIND, classify, hardCount, stepOf };
