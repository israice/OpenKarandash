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
// Замер на 8 последних сессиях 2026-10-04: 326 шагов, 170 лишних (52 %),
// жёстких 52 (16 %), мягких 118. По видам: read-untouched 54, console-search 22,
// homework-late 22, verify-churn 18, repeat-read 15, console-read 12,
// list-to-guess 11, same-call-twice 9, check-again 5, homework-skipped 2.
// Мягкие виды в счёт нарушений не идут: они показывают, где тратится время,
// но сами по себе правилом не запрещены.

// ---------- признаки шага ----------

const CHECK_RE = /npm run check|npx\s+(eslint|madge)/;
const HOMEWORK_RE = /TOOLS[\\/]homework[\\/]run\.mjs/;
// Два вида, а не один: чтение текста консолью и поиск консолью — разные вещи.
// Первое — прямой вред (русский текст приходит кракозябрами, и агент читает
// файл второй раз инструментом), второе формально идёт в обход grep, но
// возвращает те же совпадения за один шаг. В общий счёт с нарушениями идёт
// только первое, иначе цифра лишнего завышается
const CONSOLE_READ_RE = /Get-Content|\btype\s+\S+\.(js|mjs|md|css|html|json)\b|\bcat\s+\S+\.(js|mjs|md|css|html|json)\b/;
const CONSOLE_SEARCH_RE = /Select-String|findstr|git\s+grep|grep\s+-r|\brg\s+-\w*n?\w*\s/;
// перечисление папки, чтобы вспомнить имена файлов: они перечислены в README
// раздела и в карте проекта, а список папок к ответу ничего не добавляет
const LIST_RE = /^\s*(Get-ChildItem|gci|ls|dir)\b/i;
const SEARCH_TOOLS = /^(grep|glob|read|find)$/;
const WRITE_TOOLS = /^(write|edit|multiedit|patch)$/;
const LIVE_RE = /TOOLS[\\/]live-verify[\\/]run\.mjs/;
// сколько живых проверок за сессию ещё нормально: в замере на девятнадцати
// сессиях их было 94, то есть по пять на сессию, а в худшей девятнадцать
const VERIFY_FREE = 5;
// сколько консольных поисков по одному файлу ещё считаются разведкой, а не
// перебором: первые два ищут, третий и дальше крутятся вокруг того же места
const SEARCH_FREE = 2;

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
        soft: true,
        id: 'console-search',
        what: 'поиск консолью вместо инструмента grep (мягкий вид: совпадения те же, шаг один)',
        remedy: 'ищи инструментом grep: консольный поиск не понимает ни фильтров, ни русского текста',
    },
    {
        id: 'console-read',
        what: 'чтение текста файла консолью вместо инструмента чтения',
        remedy: 'читай файлы инструментом чтения, не консолью: консоль отдаёт русский текст кракозябрами',
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
    {
        soft: true,
        id: 'repeat-read',
        what: 'повторное чтение того же файла в той же сессии (мягкий вид)',
        remedy: 'файл, который ты уже открывал в этом ходе, повторно не читай: держи найденное в голове',
    },
    {
        soft: true,
        id: 'same-call-twice',
        what: 'повтор того же вызова с теми же аргументами (мягкий вид)',
        remedy: 'повтор с теми же аргументами вернёт то же самое — меняй аргументы или приём',
    },
    {
        soft: true,
        id: 'verify-churn',
        what: 'живая проверка сверх пятой за сессию (мягкий вид: каждая проверка стоит секунды и контекста)',
        remedy: 'живую проверку запускай после правки, а не после каждого пробного изменения',
    },
    {
        soft: true,
        id: 'search-same-file',
        what: 'третий и последующие консольные поиски по одному файлу (мягкий вид)',
        remedy: 'файл, по которому ты уже искал, не обыскивай снова другим словом: прочитай найденное место и продолжай',
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
        // подпись вызова целиком: два одинаковых вызова отличаются только
        // аргументами, а шаг «тот же самый» и значит повтор
        key: `${row.tool_name}:${String(row.tool_input || '')}`,
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
        case 'console-search':
            return Boolean(step.cmd) && CONSOLE_SEARCH_RE.test(step.cmd);
        case 'list-to-guess':
            return Boolean(step.cmd) && LIST_RE.test(step.cmd) && /TOOLS|SYSTEM|PROJECTS|DOCS/.test(step.cmd);
        case 'read-untouched':
            return step.tool_name === 'read' && Boolean(step.file) && !st.edited.has(step.file);
        case 'homework-late':
            return st.homeworkAt > 0 && step.position < st.homeworkAt && SEARCH_TOOLS.test(step.tool_name || '');
        case 'repeat-read': {
            // тот же файл во второй раз за сессию: первое чтение уже дало ответ
            if (step.tool_name !== 'read' || !step.file) return false;
            if (!st.reads.has(step.file)) { st.reads.add(step.file); return false; }
            return true;
        }
        case 'same-call-twice': {
            // ровно тот же вызов: ответ не изменится, если между ними не
            // изменилось то, что он читает, а таких мест в ходе десятки
            if (!step.key) return false;
            if (!st.calls.has(step.key)) { st.calls.add(step.key); return false; }
            return true;
        }
        case 'verify-churn':
            // первые пять проверок за сессию — нормальная работа, дальше идёт
            // перебор: в замере на девятнадцати сессиях их было 94, по пять и
            // больше в семи, а до 19 в одной
            if (!LIVE_RE.test(step.cmd)) return false;
            return st.live++ >= VERIFY_FREE;
        case 'search-same-file': {
            // третий и последующие консольные поиски по одному файлу: первые два
            // — разведка, дальше идёт перебор одного и того же места разными
            // словами (в замере: sessions-db.js на шагах 15, 16 и 19 подряд)
            if (!step.cmd || !CONSOLE_SEARCH_RE.test(step.cmd)) return false;
            let repeated = false;
            for (const m of step.cmd.matchAll(/[\w./-]+\.(?:js|mjs|css|html|eta|md)/g)) {
                const file = norm(m[0]);
                const seen = (st.searched.get(file) || 0) + 1;
                st.searched.set(file, seen);
                if (seen > SEARCH_FREE) repeated = true;
            }
            return repeated;
        }
        default:
            return false;
    }
}

// карта вид → позиции шагов, которые под него подошли. Шаги приходят по
// position; порядок не нужен, но база отдаёт его как есть — сортируем на входе.
//
// reportAttached — уехал ли в ход отчёт разведки. Тогда виды про домашнюю работу
// не считаются вовсе: их смысл был в том, что разведку делает агент сам, а с
// отчётом в запросе это уже не так, и «не запустил скрипт» становится нормой
function classify(steps, { reportAttached = false } = {}) {
    const kinds = reportAttached ? KINDS.filter((k) => k.id !== 'homework-late') : KINDS;
    const st = {
        checks: 0,
        edited: editedFiles(steps),
        homeworkAt: homeworkAt(steps),
        reads: new Set(),
        calls: new Set(),
        live: 0,
        searched: new Map(),
    };
    const found = new Map();
    for (const row of steps.slice().sort((a, b) => a.position - b.position)) {
        const step = stepOf(row);
        for (const kind of kinds) {
            if (!hits(kind, step, st)) continue;
            if (!found.has(kind.id)) found.set(kind.id, []);
            found.get(kind.id).push(step.position);
        }
    }
    // сессия без домашней работы: один счёт за сессию, а не за каждый шаг —
    // это не шаг, а сам факт, и в сумме лишних он стоит единицу. С отчётом в
    // запросе скрипт не нужен, поэтому вид не ставится вовсе
    if (!reportAttached && !st.homeworkAt) found.set(SESSION_KIND.id, [steps[0]?.position ?? 0]);
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
