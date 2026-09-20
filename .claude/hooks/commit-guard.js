// PreToolUse-хук: сторож коммита. Правило «Автокоммит по завершении задачи» (AGENTS.override.md)
// держалось на памяти агента и уже ломалось, поэтому три его механические части проверяет хук:
//  1. Нельзя стейджить оптом: git add -A / --all / -u / . / * и git commit -a. В основной папке
//     лежат незакоммиченные правки других сессий и вечно «грязный» указатель hermes (gitlink без
//     .gitmodules); единственный оптовый коммит в истории, 599363b, унёс с собой и его, и *.pyc.
//     «git add -A путь/файл.js VERSION.md» оптовым не считается: -A при названных путях берёт их.
//  2. Нельзя коммитить без версии: VERSION.md входит в тот же коммит, а vX.Y.Z из первой строки
//     сообщения совпадает с одной из строк, ДОПИСАННЫХ в VERSION.md относительно HEAD (не
//     обязательно с последней — соседняя сессия могла дописать свою). 2026-09-19 из-за этого
//     переписывали восемь коммитов, а уже после записи правила 8edc25a ушёл без версии —
//     строку за него досылал 5199a7c. Из VERSION.md пульт строит список версий.
//  3. Если в коммит идёт код, который смотрит линтер (eslint.config.mjs), хук сам гонит
//     SYSTEM/checks.js: «одна команда вместо надежды на внимательность» (DOCS/decisions/034)
//     зависела от того, вспомнит ли о ней агент. Проверка идёт по всей папке, поэтому отказ —
//     только если упавший файл входит в этот коммит, нашёлся цикл или состав коммита не понять;
//     чужая недописанная правка коммит не держит, но попадает агенту в контекст.
// Не трогает: рабочие копии веток (.worktrees/, .claude/worktrees/ — чужих правок там нет, и
// validate-completion.sh сам велит -A), чужие репозитории (вложенный клон hermes/), --amend в
// части версии, слияние и перенос коммитов на полпути.
// Запасной выход владельца (полные права, DOCS/decisions/044): COMMIT_GUARD=off перед командой
// («COMMIT_GUARD=off git add -A») или в окружении отключает сторожа целиком.
// Любой сбой разбора или git — молчаливый выход 0: сторож не должен ронять сессию. Когда сказать
// нечего, хук не печатает ничего: явное «allow» перебило бы решения других хуков.
// Регистрация — .claude/settings.json, ключ hooks.PreToolUse.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const CHECK_TIMEOUT = 150000; // checks.js на /mnt/c идёт около 20 с; остальное — запас на холодный диск
const TAIL = 2000; // сколько вывода проверки отдаём агенту
const WORKTREE = /(^|\/)(\.worktrees|\.claude\/worktrees)(\/|$)/;
const HEREDOC = /(?<!<)<<(?!<)-?\s*\\?(['"]?)([A-Za-z_]\w*)\1/g;
const ASSIGN = /^[A-Za-z_]\w*=/;
const SHELL_VALUE = /[$`]/; // слово подставит оболочка — по тексту команды его не узнать
const WRAPPERS = new Set(['{', '!', 'if', 'elif', 'while', 'until', 'then', 'do', 'else', 'time', 'command', 'env', 'exec']);
const SHELL = /(^|[\\/])(ba|da|z)?sh(\.exe)?$/;
const GIT = /(^|[\\/])git(\.exe)?$/i;
// git за запускалкой — тот же git: сессии здесь гоняют «python3 retry.py git add …» из-за index.lock.
// node в список не входит: «node PROJECTS/Graph/search.js git add» — поиск слов, а не git
const RUNNERS = /^(python3?|timeout|sudo|nice|nohup|flock|xargs)(\.exe)?$/;
const GIT_VALUE_OPTS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env']);
const ADD_FLAGS = new Set(['-A', '--all', '--no-ignore-removal', '-u', '--update']);
const ADD_PATHS = new Set(['.', './', '*', './*', ':/', ':/.', ':/*', ':(top)', ':(top).']);
// -p/-i/-e и список путей из файла: что окажется в индексе, по тексту не понять
const ADD_DYNAMIC = /^(-[a-zA-Z]*[pie][a-zA-Z]*|--patch|--interactive|--edit|--pathspec-from-file.*)$/;
const COMMIT_SWITCH = { '--all': 'all', '--amend': 'amend', '--include': 'include' };
// длинные флаги commit со значением → короткая буква, по которой значение разбирается ('' — пропустить)
const COMMIT_VALUE = { '--message': 'm', '--file': 'F', '--reuse-message': 'C', '--reedit-message': 'C',
    '--fixup': 'C', '--squash': 'C', '--pathspec-from-file': 'P', '--author': '', '--date': '',
    '--template': '', '--cleanup': '', '--trailer': '' };
const NO_COMMIT = new Set(['--dry-run', '--short', '--porcelain', '--long', '--help', '-h']);
const LINT_IGNORED = /^(node_modules|DATA|hermes|hermes-home|\.worktrees|\.claude\/worktrees|PROJECTS\/Graph\/vendor)\//;
const DENY = {
    add: (arg) => `«git add ${arg}» здесь запрещён: в основной папке лежат незакоммиченные правки других сессий и указатель hermes, оптовое добавление унесёт их в твой коммит. Добавляй только файлы своей задачи, поимённо: git add путь/файл.js VERSION.md`,
    all: '«git commit -a/--all» здесь запрещён: он заберёт в коммит все изменённые файлы, включая правки других сессий и указатель hermes. Сначала добавь свои файлы поимённо (git add путь/файл.js VERSION.md), потом git commit без -a.',
    noVersion: 'В коммите нет VERSION.md. Одна задача — один коммит и одна версия: допиши в конец DEV LOG в VERSION.md следующую строку «vX.Y.Z - что сделано», добавь файл в этот же коммит (git add VERSION.md …) и начни сообщение коммита с той же строки.',
    noSubject: (subject) => `Первая строка сообщения коммита должна повторять строку версии из VERSION.md: «vX.Y.Z - что сделано». Сейчас она начинается так: «${subject.slice(0, 80)}».`,
    mismatch: (version, have) => `В сообщении коммита стоит v${version}, а среди строк, дописанных в VERSION.md относительно HEAD, такой нет (${have}). Сначала допиши в конец DEV LOG строку «v${version} - что сделано», потом коммить — первая строка сообщения должна с ней совпадать.`,
    check: (tail) => `Коммит остановлен: npm run check (SYSTEM/checks.js) завершился с ошибкой. По правилу автокоммита при ошибке проверки не коммитят — почини и повтори; если ошибка в чужом незакоммиченном файле, не трогай его и скажи об этом пользователю.\n${tail}`,
};

const attempt = (fn, fallback = null) => { try { return fn(); } catch { return fallback; } };
const slashes = (p) => String(p).replace(/\\/g, '/');
const inWorktree = (p) => WORKTREE.test(slashes(p));
const isOff = (value) => /^off$/i.test(value || '');
// Git Bash на Windows пишет диски как /c/…, path.resolve такого не понимает
const native = (p) => (process.platform === 'win32' ? p.replace(/^\/([a-zA-Z])(?=\/|$)/, '$1:') : p);
const resolveFrom = (dir, p) => path.resolve(dir, native(p));
// пути может ещё или уже не быть — тогда сравниваем как написано; с памятью — на /mnt/c каждый
// realpath идёт на диск Windows, а сравнений при красной проверке бывают тысячи
const known = new Map();
const real = (p) => known.get(p) ?? known.set(p, attempt(() => fs.realpathSync(resolveFrom('.', p)), resolveFrom('.', p))).get(p);
const fold = (p) => (process.platform === 'win32' ? real(p).toLowerCase() : real(p));
const samePath = (a, b) => fold(a) === fold(b);

// имя из git add покрывает файл: он сам, папка над ним или шаблон со звёздочкой
function covers(name, file) {
    const [a, b] = [slashes(fold(name)), slashes(fold(file))];
    if (a === b || b.startsWith(`${a}/`)) return true;
    if (!/[*?[]/.test(a)) return false;
    const pattern = a.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
    return attempt(() => new RegExp(`^${pattern}$`).test(b), false);
}

// Тела heredoc вырезаем до разбора: в тексте сообщения бывают и «;», и «git add .».
// На месте «<<'EOF'» остаётся метка «<<__HD0__», по ней потом находим первую строку сообщения.
// Нет ниже строки-конца — это не heredoc, а «<<EOF» в тексте сообщения: резать нечего
function cutHeredocs(command) {
    const bodies = [];
    const kept = [];
    const lines = command.split(/\r?\n/);
    const lastAt = new Map(lines.map((line, k) => [line.trim(), k]));
    for (let i = 0; i < lines.length; i++) {
        const ends = [];
        kept.push(lines[i].replace(HEREDOC, (match, quote, word) => {
            if (!(lastAt.get(word) > i)) return match;
            ends.push(word);
            return `<<__HD${bodies.length + ends.length - 1}__`;
        }));
        for (const word of ends) {
            const body = [];
            while (++i < lines.length && lines[i].trim() !== word) body.push(lines[i]);
            bodies.push(body.join('\n'));
        }
    }
    return { text: kept.join('\n'), bodies };
}

// Разбор строки оболочки на команды: кавычки уважаем, делим по && || ; | & скобкам и переводам
// строки — так содержимое «out=$(git commit -am x)» само становится командой. Перенаправления
// уходят в redirects, иначе «> /dev/null» сошло бы за путь для коммита; «#» в начале слова —
// комментарий до конца строки. Последняя ветка съедает непарную кавычку, чтобы разбор не встал.
// «\» в конце строки — перенос, а не конец команды: иначе «git add a.js \⏎ VERSION.md» теряет VERSION.md.
// ponytail: это не полный разбор bash; потолок — case/esac и кавычки внутри "$(…)"
const TOKEN = /(?:[ \t\r]|\\\r?\n)+|#[^\n]*|(\d*[<>][<>&|]*[ \t]*)?((?:[^\s'"\\;&|()<>]|\\[^]|'[^']*'|"(?:[^"\\]|\\[^])*")+)|([\n;&|()])|[^]/g;

const unquote = (word) => word.replace(/\\([^])|'([^']*)'|"((?:[^"\\]|\\[^])*)"/g, (match, escaped, single, double) => {
    if (escaped !== undefined) return escaped === '\n' ? '' : escaped;
    // в двойных кавычках обратная черта снимает смысл только с " \ $ ` и перевода строки
    return single ?? double.replace(/\\(["\\$`\n])/g, (pair, ch) => (ch === '\n' ? '' : ch));
});

function lex(text) {
    const segments = [];
    let seg = { tokens: [], redirects: [] };
    for (const [, op, word, separator] of text.matchAll(TOKEN)) {
        if (word !== undefined) (op ? seg.redirects : seg.tokens).push((op || '').trim() + unquote(word));
        if (separator === undefined) continue;
        if (seg.tokens.length) segments.push(seg);
        seg = { tokens: [], redirects: [] };
    }
    if (seg.tokens.length) segments.push(seg);
    return segments;
}

// «ИМЯ=значение» перед командой и слова-обёртки снимаем; присваивания (и из export) отдаём отдельно
function unwrap(tokens) {
    const env = {};
    const assign = (token) => { env[token.slice(0, token.indexOf('='))] = token.slice(token.indexOf('=') + 1); };
    let i = 0;
    for (; i < tokens.length && (ASSIGN.test(tokens[i]) || WRAPPERS.has(tokens[i])); i++) if (ASSIGN.test(tokens[i])) assign(tokens[i]);
    const words = tokens.slice(i);
    if (words[0] === 'export') words.slice(1).filter((word) => ASSIGN.test(word)).forEach(assign);
    return { env, words };
}

// «bash -c "…"» и «bash -lc '…'»: текст внутри — такие же команды, разбираем и его
function withInner(seg) {
    const { words } = unwrap(seg.tokens);
    const flag = SHELL.test(words[0] || '') ? words.findIndex((word) => /^-[a-z]*c$/.test(word)) : -1;
    return flag > 0 && words[flag + 1] ? [seg, ...lex(words[flag + 1]).flatMap(withInner)] : [seg];
}

// Команда считается git-ом, только если git — её первое слово. Общие флаги (-C, -c k=v, --git-dir)
// пропускаем; -C сдвигает папку, в которой надо спрашивать репозиторий
function gitCall(words, startDir) {
    const at = RUNNERS.test(path.basename(words[0] || '')) ? words.findIndex((word) => GIT.test(word)) : 0;
    if (at < 0 || !GIT.test(words[at] || '')) return null;
    let dir = startDir;
    let i = at + 1;
    for (; i < words.length && words[i].startsWith('-'); i++) {
        const opt = words[i];
        const value = GIT_VALUE_OPTS.has(opt) ? words[++i] || '' : '';
        if (inWorktree(opt) || inWorktree(value)) return null; // --git-dir=.worktrees/…
        if (opt === '-C' && /[$`~]/.test(value)) return null;
        if (opt === '-C') dir = resolveFrom(dir, value);
    }
    // у xargs имена придут из stdin — помечаем подстановкой, чтобы состав считался неизвестным
    const args = [...words.slice(i + 1), ...(at && /xargs/.test(words[0]) ? ['$@'] : [])];
    return inWorktree(dir) ? null : { sub: words[i], args, dir };
}

function parseAdd(args, dir, top) {
    const add = { blanket: null, flag: null, names: [], dynamic: false };
    let pathsOnly = false;
    // пробный прогон ничего не добавляет: «git add -n .» только показывает список
    if (args.some((arg) => arg === '--dry-run' || /^-[a-zA-Z]*n/.test(arg))) return add;
    for (const arg of args) {
        // «:/путь» git считает от корня репозитория, а не от текущей папки
        const full = arg.startsWith(':/') ? resolveFrom(top, arg.slice(2)) : resolveFrom(dir, arg);
        if (!pathsOnly && arg === '--') pathsOnly = true;
        else if (!pathsOnly && arg.startsWith('-') && arg.length > 1) {
            // связка коротких флагов (-Av, -fu) — то же оптовое добавление
            if (ADD_FLAGS.has(arg) || (!arg.startsWith('--') && /[Au]/.test(arg))) add.flag = add.flag || arg;
            else if (ADD_DYNAMIC.test(arg)) add.dynamic = true;
        } else if (SHELL_VALUE.test(arg)) add.dynamic = true;
        else if (/^:(!|\^|\(exclude\))/.test(arg)) continue; // исключение «:!hermes» круг не сужает
        else if (ADD_PATHS.has(arg) || samePath(full, top)) add.blanket = add.blanket || arg;
        else add.names.push(full);
    }
    // «git add -A путь VERSION.md» берёт только названное — это всё ещё поимённо; оптом — -A без путей
    if (!add.blanket && !add.names.length && !add.dynamic) add.blanket = add.flag;
    return add;
}

function parseCommit(args) {
    const c = { all: false, amend: false, include: false, noCommit: false, reuse: false, dynamic: false,
        messages: [], file: null, paths: [] };
    const take = (flag, value) => {
        if (flag === 'm') c.messages.push(value ?? '');
        else if (flag === 'F') c.file = value ?? null;
        else if (flag === 'C' || flag === 'c') c.reuse = true; // сообщение берётся у другого коммита
        else if (flag === 'P') c.dynamic = true;
    };
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        const name = arg.split('=')[0];
        if (arg === '--') { c.paths.push(...args.slice(i + 1)); break; }
        if (NO_COMMIT.has(arg)) c.noCommit = true;
        else if (Object.hasOwn(COMMIT_SWITCH, arg)) c[COMMIT_SWITCH[arg]] = true;
        else if (Object.hasOwn(COMMIT_VALUE, name)) take(COMMIT_VALUE[name], arg.includes('=') ? arg.slice(name.length + 1) : args[++i]);
        else if (arg.startsWith('--') || arg === '-') continue;
        else if (arg.startsWith('-')) {
            // связка коротких флагов: у -m -F -C -c -t значение — остаток слова или следующее слово,
            // поэтому «-am» — это --all, а «-ma» — сообщение «a»; у -S и -u значение только слитно
            for (let k = 1; k < arg.length; k++) {
                if (arg[k] === 'a') c.all = true;
                if (arg[k] === 'i') c.include = true;
                if (!'mFCctSu'.includes(arg[k])) continue;
                if (!'Su'.includes(arg[k])) take(arg[k], arg.slice(k + 1) || args[++i]);
                break;
            }
        } else if (SHELL_VALUE.test(arg)) c.dynamic = true;
        else c.paths.push(arg);
    }
    return c;
}

// Первая строка сообщения или null, когда её не узнать (редактор, -C, stdin из трубы, файла ещё нет)
function subjectOf(c, seg, bodies, dir) {
    let message = null;
    if (c.reuse) return null;
    if (c.messages.length) message = c.messages[0];
    else if (c.file === '-' || c.file === '/dev/stdin') message = seg.redirects.find((r) => r.includes('__HD')) ?? null;
    else if (c.file !== null) message = attempt(() => fs.readFileSync(resolveFrom(dir, c.file), 'utf8'));
    if (message === null) return null;
    // обычная форма у агентов: -m "$(cat <<'EOF' … EOF)" — сам текст лежит в теле heredoc
    const heredoc = message.match(/<<__HD(\d+)__/);
    if (heredoc) message = bodies[Number(heredoc[1])] ?? '';
    const line = message.split(/\r?\n/).find((text) => text.trim());
    return line === undefined ? null : line.trim();
}

function subjectProblem(subject, added) {
    const found = subject.match(/^v(\d+\.\d+\.\d+)(?![\d.])/);
    // без версии, но с $ или ` — сообщение подставит оболочка, не угадываем
    if (!found) return SHELL_VALUE.test(subject) ? null : DENY.noSubject(subject);
    if (added === null || added.includes(found[1])) return null; // null — git не ответил, зря не отказываем
    return DENY.mismatch(found[1], added.length ? `дописаны: ${added.map((v) => `v${v}`).join(', ')}` : 'новых строк нет вообще');
}

// файл, который смотрит линтер: глобы из eslint.config.mjs плюс сам конфиг и package.json
function linted(rel) {
    if (rel === 'eslint.config.mjs' || rel === 'package.json') return true;
    if (!rel.endsWith('.js') || rel.endsWith('.min.js') || LINT_IGNORED.test(rel)) return false;
    return /^(PROJECTS|SYSTEM|\.claude\/hooks|\.claude\/skills\/finish-task)\//.test(rel) || rel === 'server.js' || /(^|\/)[^/]*-server\.js$/.test(rel);
}

function maybeLinted(file, top) {
    const rel = slashes(path.relative(real(top), real(file)));
    const fuzzy = rel === '' || rel.startsWith('..') || /[*?[]/.test(rel)
        || attempt(() => fs.statSync(file).isDirectory(), false); // удалённый файл судим по имени
    // папка или шаблон: гоним проверку, если имя явно не про другой тип файлов («DOCS/*.md»)
    return fuzzy ? !/\.(?!js$)\w+$/.test(rel) : linted(rel);
}

function checkVerdict(output, commits) {
    const tail = output.trim().slice(-TAIL);
    const lint = /неизвестные имена\.\.\. НАШЛОСЬ/.test(output);
    const cycles = /циклические связи\.\.\. НАШЛОСЬ/.test(output);
    // eslint (формат stylish) печатает путь файла отдельной строкой без отступа
    const failing = output.split(/\r?\n/).filter((line) => /\.[cm]?js$/.test(line) && path.isAbsolute(line));
    const mine = commits.some((c) => c.unknown)
        || failing.some((file) => commits.some((c) => c.files.some((name) => covers(name, file))));
    if (!lint || cycles || !failing.length || mine) return { deny: DENY.check(tail) };
    const names = [...new Set(failing.map((file) => path.basename(file)))];
    const shown = names.slice(0, 5).join(', ') + (names.length > 5 ? ` и ещё ${names.length - 5}` : ''); // предел поля — 10 000 знаков
    return { context: `npm run check упал, но не на файлах этого коммита (${shown}) — похоже на незаконченную правку другой сессии. Коммит пропущен; чужие файлы не чини, в отчёте скажи, что проверка красная не из-за тебя.\n${tail}` };
}

function decide(input, env, git) {
    const command = input && input.tool_name === 'Bash' && input.tool_input && input.tool_input.command;
    if (typeof command !== 'string' || !/\bgit\b/i.test(command.replace(/['"\\]/g, ''))) return null; // g"i"t — тоже git
    const cwd = input.cwd || process.cwd();
    if (isOff(env.COMMIT_GUARD) || inWorktree(cwd)) return null;

    const { text, bodies } = cutHeredocs(command);
    const segments = lex(text).flatMap(withInner);
    if (segments.some((seg) => isOff(unwrap(seg.tokens).env.COMMIT_GUARD))) return null;

    // корень проекта: где началась сессия, иначе — по месту самого хука (<проект>/.claude/hooks)
    const project = env.CLAUDE_PROJECT_DIR || path.resolve(__dirname, '..', '..');
    const repos = new Map();
    const repoAt = (dir) => repos.get(dir) ?? repos.set(dir, git.repo(dir) || false).get(dir);

    let dir = cwd; // null — ушли через cd туда, куда по тексту не проследить
    let named = []; // файлы из git add/rm/mv этой же команды: к моменту хука они ещё не в индексе
    let dynamic = false; // индекс меняют так, что состав не узнать: apply --cached, add -p, $ПЕРЕМЕННАЯ
    let indexSpent = false; // после первого коммита цепочки индекс уже не тот, что видит хук
    const commits = [];
    for (const seg of segments) {
        const { words } = unwrap(seg.tokens);
        if (words[0] === 'cd' || words[0] === 'pushd') {
            const target = words[1] === '--' ? words[2] : words[1];
            const lost = !target || target === '-' || /[$`~]/.test(target) || (dir === null && !path.isAbsolute(native(target)));
            dir = lost ? null : resolveFrom(dir || cwd, target);
        }
        const call = dir === null ? null : gitCall(words, dir);
        const repo = call && repoAt(call.dir);
        if (!repo || !samePath(repo.top, project)) continue; // не git, не репозиторий или не этот проект

        const paths = (args) => args.filter((arg) => !arg.startsWith('-')).map((arg) => resolveFrom(call.dir, arg));
        if (call.sub === 'add' || call.sub === 'stage') {
            const add = parseAdd(call.args, call.dir, repo.top);
            if (add.blanket) return { deny: DENY.add(add.blanket) };
            named.push(...add.names);
            dynamic = dynamic || add.dynamic;
        }
        if (call.sub === 'rm' || call.sub === 'mv') named.push(...paths(call.args));
        // так стейджат по кускам (git apply --cached отфильтрованный.patch) — что попало в индекс, не видно
        if (call.sub === 'apply' && call.args.some((arg) => arg === '--cached' || arg === '--index')) dynamic = true;
        if (call.sub !== 'commit') continue;

        const c = parseCommit(call.args);
        if (c.noCommit) continue;
        if (c.all) return { deny: DENY.all };
        const only = c.paths.length > 0 && !c.include; // «git commit <пути>» берёт только их, индекс не в счёт
        const staged = only || indexSpent ? [] : git.staged(repo.top);
        const files = [...(staged || []).map((rel) => path.join(repo.top, rel)), ...(only ? [] : named), ...paths(c.paths)];
        const unknown = c.dynamic || staged === null || (dynamic && !only);
        if (!c.amend && !git.busy(repo.gitDir)) {
            if (!unknown && !files.some((name) => covers(name, path.join(repo.top, 'VERSION.md')))) return { deny: DENY.noVersion };
            const subject = subjectOf(c, seg, bodies, call.dir);
            const problem = subject === null ? null : subjectProblem(subject, git.added(repo.top));
            if (problem) return { deny: problem };
        }
        commits.push({ files, unknown, top: repo.top });
        if (!only) [named, dynamic, indexSpent] = [[], false, true];
    }

    if (!commits.some((c) => c.unknown || c.files.some((file) => maybeLinted(file, c.top)))) return null;
    const result = git.checks(project);
    if (!result || result.ok) return null;
    if (!result.timedOut) return checkVerdict(result.output, commits);
    return { context: `Сторож коммита не получил ответа от SYSTEM/checks.js (предел ${CHECK_TIMEOUT / 1000} с) и коммит пропустил. Прогони npm run check сам и скажи о результате.` };
}

// --no-optional-locks: diff не должен попутно переписывать индекс — рядом коммитят другие сессии
const runGit = (dir, args) => execFileSync('git', ['--no-optional-locks', ...args], { cwd: dir, encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'], timeout: 20000, windowsHide: true });

// всё, что хук узнаёт у git и у проверки, собрано здесь — решение можно проверить на подставных ответах
const realGit = {
    repo: (dir) => attempt(() => {
        const [top, gitDir] = runGit(dir, ['rev-parse', '--show-toplevel', '--absolute-git-dir']).split(/\r?\n/);
        return top ? { top, gitDir } : null;
    }),
    staged: (top) => attempt(() => runGit(top, ['diff', '--cached', '--ignore-submodules=none', '--name-only', '-z']).split('\0').filter(Boolean)),
    // версии из строк «+vX.Y.Z …»: и уже в индексе, и просто в рабочей папке — add обычно идёт той же командой
    added(top) {
        const diffs = [['diff', '--cached', '-U0', '--', 'VERSION.md'], ['diff', 'HEAD', '-U0', '--', 'VERSION.md']]
            .map((args) => attempt(() => runGit(top, args)));
        if (diffs.includes(null)) return null; // git не ответил (или HEAD ещё нет) — версию не сверяем
        return [...new Set([...diffs.join('\n').matchAll(/^\+v(\d+\.\d+\.\d+)(?![\d.])/gm)].map((found) => found[1]))];
    },
    busy: (gitDir) => ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']
        .some((name) => fs.existsSync(path.join(gitDir || '', name))),
    checks(project) {
        const script = path.join(project, 'SYSTEM', 'checks.js');
        if (!fs.existsSync(script)) return null;
        try {
            execFileSync(process.execPath, [script], { cwd: project, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
                timeout: CHECK_TIMEOUT, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
            return { ok: true };
        } catch (error) {
            if (typeof error.status !== 'number') return { ok: false, timedOut: true };
            return { ok: false, output: String(error.stdout || '') + String(error.stderr || '') };
        }
    },
};

function main() {
    // не разобрали вход или споткнулись сами — не наша забота, сессию не роняем
    const result = attempt(() => decide(JSON.parse(fs.readFileSync(0, 'utf8').replace(/^\uFEFF/, '')), process.env, realGit));
    if (!result) return;
    const hookSpecificOutput = { hookEventName: 'PreToolUse' };
    if (result.deny) Object.assign(hookSpecificOutput, { permissionDecision: 'deny', permissionDecisionReason: result.deny });
    if (result.context) hookSpecificOutput.additionalContext = result.context;
    console.log(JSON.stringify({ hookSpecificOutput }));
}

if (require.main === module) main();
else module.exports = { decide, lex, cutHeredocs, parseAdd, parseCommit, linted };
