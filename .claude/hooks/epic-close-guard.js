// PreToolUse-хук: не даёт закрыть эпик, пока у него есть незакрытые дети.
// Зачем: bd 1.2.2 сам такого запрета не знает — «bd close <эпик>» проходит молча, и
// незакрытые задачи остаются висеть под закрытым родителем, выпадая из обзора работ.
// Случай: прежний сторож validate-epic-close.sh читал вход из переменной
// CLAUDE_TOOL_INPUT, которой Claude Code не задаёт (вход хука приходит в stdin),
// поэтому выходил с нулём на каждом вызове и не проверил ни одного закрытия.
// Ему же нужны были bash и jq, которых нет в сессии под Windows.
// Эпиком считаем любую задачу с детьми, а не только issue_type = epic: OpenKarandash-f59,
// ради которого сторожа и чинили (30 детей, половина открыта), заведён как feature —
// проверка по типу промолчала бы ровно на нём.
// Данные берём ТОЛЬКО через «bd list»: «bd show» переписывает .beads/last-touched, а
// «bd close» без номера закрывает именно last-touched — после отказа повтор без номера
// закрыл бы тот самый эпик. Любая неясность (нет bd, ошибка, не JSON, не уложились
// по времени) — молча выходим с нулём: сторож не должен ломать сессию.
// Регистрация — .claude/settings.json, ключ hooks.PreToolUse.
const { execFile } = require('child_process');

const BD_BUDGET_MS = 20000; // на все вызовы bd вместе; не уложились — молчим
const KILL_GRACE_MS = 2000; // сколько ждём смерти bd после SIGTERM, прежде чем добить
const MAX_LISTED = 15; // детей в тексте отказа; остальные — числом
const CLOSE_VERBS = new Set(['close', 'done']); // done — псевдоним close
// флаги bd close и общие флаги bd, у которых значение идёт отдельным словом: его нельзя
// принять за номер задачи («--reason "готово"», «-r готово», «-C ../other»)
const LONG_VALUE_FLAGS = new Set(['--reason', '--reason-file', '--session', '--actor',
    '--db', '--directory', '--dolt-auto-commit']);
const SHORT_VALUE_FLAGS = 'rC';
// слова, после которых команда всё ещё впереди: «env X=1 bd close», «then bd close»,
// «timeout 60 bd close» (флаги и числа после такого слова тоже пропускаем)
const PREFIX_WORDS = new Set(['env', 'command', 'builtin', 'exec', 'time', 'nohup', 'sudo',
    'timeout', 'nice', '{', '!', 'if', 'then', 'else', 'elif', 'do', 'while', 'until']);
const WRAPPER_ARG = /^(-.*|\d+(\.\d+)?[smhd]?)$/;
// в номере осталась подстановка оболочки («a1u.{1,2}», «a1u.$n», «$ID», «a1u.*»):
// какие задачи закроет команда, мы не знаем
const EXPANSION = /[$*?[\]{}]/;
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;
const OPEN_STATUSES = new Set(['open', 'in_progress', 'blocked', 'deferred', 'hooked']);
// pinned «остаётся открытой навсегда» — такой ребёнок эпик не держит
const DONE_STATUSES = new Set(['closed', 'tombstone', 'pinned']);

// Тело heredoc — данные, а не команды: «cat <<EOF … bd close X … EOF» ничего не закрывает.
// ponytail: маркер ищем регуляркой по строке, без учёта кавычек; потолок — «<<» внутри
// строки в кавычках съест хвост команды, и сторож промолчит; апгрейд: настоящий разбор.
function cutHeredocs(text) {
    const kept = [];
    const waiting = [];
    for (const line of text.split(/\r?\n/)) {
        if (waiting.length) {
            const probe = waiting[0].dash ? line.replace(/^\t+/, '') : line;
            if (probe === waiting[0].word) waiting.shift();
            continue;
        }
        kept.push(line);
        // «<<<» — строка-вход, не heredoc; слово с буквы, чтобы не ловить сдвиг «1<<2»
        const marker = /(?<!<)<<(?!<)(-?)\s*(?:'([^']+)'|"([^"]+)"|\\?([A-Za-z_][\w.-]*))/g;
        for (const m of line.matchAll(marker)) {
            waiting.push({ dash: m[1] === '-', word: m[2] || m[3] || m[4] });
        }
    }
    return kept.join('\n');
}

// Режет команду на сегменты, а сегменты на слова — как оболочка: вне кавычек сегмент
// кончается на && || ; | & перевод строки и скобки/обратные кавычки подстановки.
// Внутри кавычек ничего не режем: «git commit -m "bd close X; готово"» — одно слово.
// ponytail: «$(…)» внутри двойных кавычек — целиком часть слова, команды в ней не ищем;
// потолок — «echo "$(bd close X)"» пройдёт мимо; апгрейд: рекурсивный разбор подстановок.
// Но границу такой подстановки находим честно: кавычки внутри неё свои и внешнюю строку
// не закрывают, иначе в «echo "$(grep "x; bd close X" f)"» хвост выпал бы из кавычек.
function substitutionEnd(text, from) {
    let depth = 0;
    let quote = '';
    for (let i = from; i < text.length; i++) {
        const ch = text[i];
        if (quote) {
            if (ch === '\\' && quote === '"') i++;
            else if (ch === quote) quote = '';
        } else if (ch === '\\') i++;
        else if (ch === '\'' || ch === '"') quote = ch;
        else if (ch === '(') depth++;
        else if (ch === ')' && --depth === 0) return i;
    }
    return text.length; // не закрыта — всё до конца считаем строкой, сторож промолчит
}

function splitSegments(text) {
    const segments = [];
    let words = [];
    let word = '';
    let started = false;
    let quote = '';
    const endWord = () => {
        if (started) words.push(word);
        word = '';
        started = false;
    };
    const endSegment = () => {
        endWord();
        if (words.length) segments.push(words);
        words = [];
    };
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (quote === '\'') {
            if (ch === '\'') quote = '';
            else word += ch;
        } else if (quote === '$') {
            // $'…' — единственные кавычки, где «\'» апостроф, а не конец строки
            if (ch === '\'') quote = '';
            else if (ch === '\\') word += text[++i] || '';
            else word += ch;
        } else if (quote === '"') {
            if (ch === '"') quote = '';
            else if (ch === '\\' && /["\\$`\n]/.test(text[i + 1] || '')) {
                i++;
                if (text[i] !== '\n') word += text[i];
            } else if (ch === '$' && text[i + 1] === '(') {
                const end = substitutionEnd(text, i + 1);
                word += text.slice(i, end + 1);
                i = end;
            } else word += ch;
        } else if (ch === '\'' || ch === '"') {
            quote = ch === '\'' && text[i - 1] === '$' ? '$' : ch;
            started = true;
        } else if (ch === '\\') {
            i++; // экранированный символ — часть слова, «\» + перевод строки — склейка строк
            if (i < text.length && text[i] !== '\n') {
                word += text[i];
                started = true;
            }
        } else if (ch === '#' && !started) {
            while (i + 1 < text.length && text[i + 1] !== '\n') i++; // комментарий до конца строки
        } else if (ch === ' ' || ch === '\t' || ch === '\r') {
            endWord();
        } else if ('\n;|()`'.includes(ch)) {
            endSegment();
        } else if (ch === '&') {
            // «2>&1» и «&>файл» — перенаправления, а не конец сегмента
            if (/^\d*[<>]+$/.test(word)) word += ch;
            else if (text[i + 1] === '>') {
                endWord();
                word = ch;
                started = true;
            } else endSegment();
        } else if (ch === '<' || ch === '>') {
            // «bd close X>/dev/null»: номер кончился, дальше перенаправление отдельным словом;
            // цифры перед знаком («2>») — его часть
            if (started && !/^(\d+|\d*[<>]+|&)$/.test(word)) endWord();
            word += ch;
            started = true;
        } else {
            word += ch;
            started = true;
        }
    }
    endSegment();
    return segments;
}

// Разбирает один сегмент. Если это «bd [общие флаги] close|done …» — кладёт в found
// запись { ids, pass, force }: номера задач и флаги выбора базы, которые надо повторить в
// своём вызове bd. Номера из сегмента с --force/-f не проверяем: это осознанное «закрыть
// несмотря ни на что», — но помним как закрываемые той же командой.
function inspectSegment(words, found, depth) {
    let i = 0;
    let wrapped = false;
    while (i < words.length) {
        if (PREFIX_WORDS.has(words[i])) wrapped = true;
        else if (!ASSIGNMENT.test(words[i]) && !(wrapped && WRAPPER_ARG.test(words[i]))) break;
        i++;
    }
    if (i >= words.length) return;
    const name = words[i].split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, '');

    if (SHELLS.has(name)) {
        // «bash -lc "bd close X"» — внутри такая же команда, разбираем её тем же способом
        const at = words.findIndex((w, k) => k > i && /^-[a-z]*c$/i.test(w));
        if (at !== -1 && words[at + 1] && depth < 2) scan(words[at + 1], found, depth + 1);
        return;
    }
    if (name !== 'bd') return;

    const rest = words.slice(i + 1);
    const positional = [];
    const pass = [];
    let force = false;
    let help = false;
    let onlyPositional = false;
    for (let j = 0; j < rest.length; j++) {
        const w = rest[j];
        if (onlyPositional) {
            positional.push(w);
        } else if (w === '--') {
            onlyPositional = true;
        } else if (/^(\d*[<>]|&>)/.test(w)) {
            // перенаправление: у голого оператора («>», «2>>») следующее слово — файл
            if (/^(\d*[<>]+&?|&>>?)$/.test(w)) j++;
        } else if (w.startsWith('--')) {
            const eq = w.indexOf('=');
            const flag = eq === -1 ? w : w.slice(0, eq);
            let value = eq === -1 ? undefined : w.slice(eq + 1);
            if (eq === -1 && LONG_VALUE_FLAGS.has(flag)) value = rest[++j];
            if (flag === '--force') force = true;
            if (flag === '--help') help = true;
            if (flag === '--global') pass.push(flag);
            if ((flag === '--directory' || flag === '--db') && value) pass.push(flag, value);
        } else if (/^-[A-Za-z]/.test(w)) {
            // короткие флаги можно склеивать («-fq»), значение — слитно или следующим словом
            for (let k = 1; k < w.length; k++) {
                if (w[k] === 'f') force = true;
                if (w[k] === 'h') help = true;
                if (!SHORT_VALUE_FLAGS.includes(w[k])) continue;
                const value = w.slice(k + 1).replace(/^=/, '') || rest[++j];
                if (w[k] === 'C' && value) pass.push('--directory', value);
                break;
            }
        } else {
            positional.push(w);
        }
    }
    // первое слово без дефиса — подкоманда: «bd update X --status closed» сюда не попадёт
    if (!CLOSE_VERBS.has(positional[0]) || help) return;
    const ids = positional.slice(1);
    if (ids.length) found.push({ ids, pass, force }); // без номера bd закрывает last-touched — молчим
}

function scan(command, found, depth) {
    for (const words of splitSegments(cutHeredocs(command))) inspectSegment(words, found, depth);
}

// Вызов bd не блокирующий (execFile, а не execFileSync): по timeout Node шлёт SIGTERM и
// ждёт смерти процесса. bd, повисший на замке базы и не умерший по SIGTERM, держал бы хук
// до timeout из settings.json (без него — 600 с), а при блокирующем вызове таймер-сторож
// из main не сработал бы вовсе.
const running = new Set();
function runBd(args, cwd, timeout) {
    return new Promise((resolve, reject) => {
        if (timeout < 500) throw new Error('время вышло');
        const options = { cwd, timeout, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true };
        const child = execFile('bd', args, options, (error, stdout) => {
            running.delete(child);
            if (error) reject(error);
            else resolve(stdout);
        });
        running.add(child);
        child.stdin?.on('error', () => {});
        child.stdin?.end(); // bd не должен ждать ввода
    }).then(JSON.parse);
}

// Свои статусы проекта и их категории. Не узнали — пустой список: дети с таким статусом
// в отказ не попадут, а дети с заведомо открытым статусом эпик всё равно удержат.
async function customStatuses(pass, cwd, deadline) {
    try {
        const known = await runBd([...pass, 'statuses', '--json'], cwd, deadline - Date.now());
        return new Map((known.custom_statuses || []).map((s) => [s.name, s.category]));
    } catch {
        return new Map();
    }
}

// Как bd: сначала точное совпадение, потом номер без префикса проекта («a1u» →
// «OpenKarandash-a1u»). Совпадение по куску хеша не берём — отказ только при уверенности.
function resolveId(word, issues) {
    const exact = issues.find((issue) => issue.id === word);
    if (exact) return exact;
    const tail = issues.filter((issue) => String(issue.id).endsWith(`-${word}`));
    return tail.length === 1 ? tail[0] : null;
}

function isChildOf(issue, epicId) {
    if (issue.parent === epicId) return true;
    return Array.isArray(issue.dependencies) && issue.dependencies.some(
        (dep) => dep && dep.type === 'parent-child' && dep.depends_on_id === epicId);
}

async function main(data) {
    const input = JSON.parse(data);
    if (input.tool_name !== 'Bash') return;
    const command = input.tool_input?.command;
    if (typeof command !== 'string') return;
    // дешёвый отсев: хук зовут на каждую команду Bash, а bd отвечает секундами
    if (!/\bbd\b/i.test(command) || !/\b(close|done)\b/.test(command)) return;

    const found = [];
    scan(command, found, 0);
    if (!found.length) return;

    const deadline = Date.now() + BD_BUDGET_MS;
    // сторож на случай bd, пережившего SIGTERM: добиваем и выходим молча
    setTimeout(() => {
        for (const child of running) child.kill('SIGKILL');
        process.exit(0);
    }, BD_BUDGET_MS + KILL_GRACE_MS).unref();
    const cwd = input.cwd || process.cwd();
    // обычно база одна; разные -C/--db в одной команде — отдельный запрос на каждую
    const groups = new Map();
    for (const { ids, pass, force } of found) {
        const key = JSON.stringify(pass);
        if (!groups.has(key)) groups.set(key, { pass, ids: [], checked: [] });
        groups.get(key).ids.push(...ids);
        if (!force) groups.get(key).checked.push(...ids);
    }

    const verdicts = [];
    for (const { pass, ids, checked } of groups.values()) {
        // «bd close a1u.{1,2} && bd close a1u», «for n …; do bd close a1u.$n; done»: детей
        // закрывает та же команда, но назвать их мы не можем — отказ был бы ложным
        if (!checked.length || ids.some((word) => EXPANSION.test(word))) continue;
        // один вызов на всю базу: и типы, и статусы, и родители; --all — вместе с закрытыми
        let issues;
        try {
            issues = await runBd([...pass, 'list', '--all', '--json', '--limit', '0'],
                cwd, deadline - Date.now());
        } catch {
            continue; // эта база не ответила («bd -C нет/такой close X») — другие проверяем
        }
        if (!Array.isArray(issues)) continue;
        issues = issues.filter((issue) => issue && typeof issue.id === 'string');
        // ребёнок, закрываемый той же командой (пусть и с --force), эпик не держит
        const closingIds = new Set(ids.map((word) => resolveId(word, issues))
            .filter(Boolean).map((issue) => issue.id));
        const closing = checked.map((word) => resolveId(word, issues)).filter(Boolean);
        let custom = null; // статусы проекта сверх встроенных, читаем только если встретились

        for (const epic of new Set(closing)) {
            // тип не спрашиваем: родитель с детьми — эпик по сути (см. шапку про f59)
            if (DONE_STATUSES.has(epic.status)) continue;
            const open = [];
            for (const child of issues) {
                if (closingIds.has(child.id) || !isChildOf(child, epic.id)) continue;
                if (DONE_STATUSES.has(child.status)) continue;
                if (!OPEN_STATUSES.has(child.status)) {
                    // свой статус проекта («inreview»): открытый он или завершающий,
                    // знает только bd — категория done значит «закрыто»
                    if (!custom) custom = await customStatuses(pass, cwd, deadline);
                    if (!custom.has(child.status) || custom.get(child.status) === 'done') continue;
                }
                open.push(child);
            }
            // bd отдаёт список от новых к старым; в отказе удобнее по порядку: .1, .2, … .10
            open.sort((a, b) => String(a.id).localeCompare(String(b.id), 'en', { numeric: true }));
            if (open.length) verdicts.push({ epic, open });
        }
    }
    if (!verdicts.length) return;

    const clip = (text) => {
        const line = String(text || '').replace(/\s+/g, ' ').trim();
        return line.length > 90 ? `${line.slice(0, 89)}…` : line;
    };
    const parts = verdicts.map(({ epic, open }) => {
        const lines = open.slice(0, MAX_LISTED)
            .map((child) => `- ${child.id} [${child.status}] ${clip(child.title)}`.trimEnd());
        if (open.length > MAX_LISTED) lines.push(`- … и ещё ${open.length - MAX_LISTED}`);
        // заголовка или типа может не быть — «undefined» в тексте отказа не нужен
        const label = [clip(epic.title) && `«${clip(epic.title)}»`, epic.issue_type]
            .filter(Boolean).join(', ');
        return `Закрывать ${epic.id}${label ? ` (${label})` : ''} рано — `
            + `незакрытых детей: ${open.length}.\n${lines.join('\n')}`;
    });
    const reason = `${parts.join('\n\n')}\n\n`
        + 'Сначала закрой этих детей или перенеси их под другого родителя, потом закрывай родителя. '
        + 'Только если пользователь прямо велел закрыть родителя вместе с незакрытыми детьми — '
        + 'повтори команду с --force.';
    console.log(JSON.stringify({
        hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: reason,
        },
    }));
}

// сторож не должен ломать сессию: ошибка мимо main (поток, обратный вызов) — тоже молчание
process.on('uncaughtException', () => process.exit(0));
let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { data += chunk; });
process.stdin.on('error', () => process.exit(0));
process.stdin.on('end', () => {
    // не разобрали вход, нет bd, bd ответил ошибкой или не JSON, вышло время — молчим
    main(data).catch(() => {});
});
