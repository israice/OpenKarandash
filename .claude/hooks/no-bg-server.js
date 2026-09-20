// PreToolUse-хук: не даёт из сессии поднять, погасить или продублировать стек проекта —
// server.js, мосты claude-bridge/exec-bridge и Hermes в Docker. Стек один, и запускает его
// пользователь сам («node server.js» в своём терминале).
// server.js: без NO_RELOAD=1 сервер поднимает сторожа с дочерним процессом, а на Windows
// смерть оболочки не шлёт им сигналов — оба переживают сессию, держат cwd проекта (папку
// не переименовать), крутят опрос файлов и дерутся за .sessions.db со следующей копией.
// Остальной стек: правило было шире хука. AGENTS.override.md запрещает и hermes-start.sh /
// hermes-stop.sh, а владелец запретил второй мост, Hermes или сервер «даже на другом порту
// и только для проверки»: дубли дерутся за claude CLI, DATA и порты, а проверка на копии не
// показывает поведение настоящего стека. Прежнее выражение знало только «node server.js» и
// пропускало «bash hermes-start.sh», «docker compose … up -d gateway», «python3 server.py»
// в claude-bridge/ и запуск сервера по абсолютному пути.
// Новые правила смотрят только ПОЗИЦИЮ КОМАНДЫ: поиск имён по всему тексту запретил бы
// «cat hermes-start.sh», «git add hermes-start.sh» и «grep "docker compose up" DOCS».
// Открытыми остаются диагностика (docker ps/logs/inspect/exec, compose ps/logs/config),
// docker pause/unpause — ими владелец проверяет прямой путь к Claude — и проверки разбором:
// «bash -n», «node --check», «python -m py_compile», «python -c». Стек — DOCS/decisions/029.
// Регистрация — .claude/settings.json, ключ hooks.PreToolUse.
const path = require('path');

// перед node допускаем переменные окружения, путь и кавычку внешней оболочки,
// после — флаги Node: «PORT=3001 node --inspect ./server.js», «pwsh -c "node server.js"».
// Исключение — «node --check server.js»: это разбор файла, а не запуск сервера.
// Путь перед server.js любой (абсолютный раньше проходил мимо). Правило, как и прежде,
// смотрит весь текст команды, а не позицию
const RUNS_SERVER = /(^|[\s;&|("'])(\S*[\\/])?node(\.exe)?["']?\s+((?!--?(check|c)\b)-\S+\s+)*["']?(\S*[\\/])?server\.js/i;
const SERVER_REASON = 'Запускать server.js из сессии нельзя: сторож и дочерний процесс переживут её, '
    + 'займут папку проекта (её нельзя будет переименовать) и .sessions.db. '
    + 'Серверный файл проверяй разбором — «node --check <файл>»; живьём смотри на сервере, '
    + 'который поднял пользователь: «npm run ui» и SYSTEM/live-check.mjs.';

// ---------- пути ----------
// Корень проекта — от места самого хука, а не из окружения: так он одинаков под WSL,
// Windows и в безголовых сессиях. Все пути сводим к одному виду: прямые слэши,
// «/mnt/c» и «/c» → «c:», нижний регистр
const norm = (p) => String(p).replace(/\\/g, '/').replace(/^\/(mnt\/)?([a-z])(?=\/|$)/i, '$2:')
    .replace(/\/+$/, '').toLowerCase();
const ROOT = norm(path.resolve(__dirname, '..', '..'));
const baseName = (token) => norm(token).split('/').pop().replace(/\.(exe|cmd|bat)$/, '');
// «?» — каталог неизвестен, «$…» — путь из переменной: про такие считаем худшее
const unknown = (p) => !p || /^[?$]/.test(p);
const insideProject = (p) => unknown(p) || p === ROOT || p.startsWith(`${ROOT}/`);
const inBridge = (p) => unknown(p) || /(^|\/)(claude|exec)-bridge(\/|$)/.test(p);

function resolveFrom(dir, target) {
    const t = norm(target);
    const parts = [];
    for (const part of (/^([a-z]:|\/|~|\$)/.test(t) ? t : `${dir || '?'}/${t}`).split('/')) {
        if (part === '.' || (part === '' && parts.length)) continue;
        if (part === '..') { if (parts.length > 1) parts.pop(); } else parts.push(part);
    }
    return parts.join('/');
}

// ---------- разбор текста команды ----------
// оболочка в позиции команды — сама или за обёрткой: «bash», «sudo bash», «wsl.exe -d U bash»
function runsShell(tokens) {
    const words = (tokens || []).map(baseName);
    return words.some((w, k) => SHELLS.has(w) && (k === 0 || WRAPPERS.has(words[0]) || ASSIGN.test(words[0])));
}

// heredoc — данные, а не команды (сообщение коммита, текст файла): тело вырезаем.
// Исключение — heredoc, скормленный оболочке («bash <<EOF», «wsl.exe bash <<EOF»,
// «cat <<EOF | bash»): его тело исполнится
function cutHeredocs(text) {
    const lines = text.split(/\r?\n/);
    const out = [];
    for (let i = 0; i < lines.length; i++) {
        out.push(lines[i]);
        const m = lines[i].match(/(?<!<)<<(?!<)-?\s*(["']?)([A-Za-z_][\w.-]*)\1/);
        if (!m) continue;
        const end = lines.findIndex((line, at) => at > i && line.replace(/^\t+/, '') === m[2]);
        if (end < 0) continue; // конца нет — не режем, иначе в «теле» спрятался бы хвост команды
        const head = parse(lines[i].slice(0, m.index).split(/[;&|(]/).pop()).segments.pop();
        const piped = lines[i].slice(m.index + m[0].length).split('|').slice(1);
        if (runsShell(head) || piped.some((part) => runsShell(parse(part).segments[0]))) continue;
        i = end;
    }
    return out.join('\n');
}

// текст между скобкой на позиции open и парной ей закрывающей
function insideParens(text, open) {
    let depth = 0;
    for (let i = open; i < text.length; i++) {
        if (text[i] === '(') depth++;
        else if (text[i] === ')' && --depth === 0) return text.slice(open + 1, i);
    }
    return text.slice(open + 1);
}

// Режет текст на сегменты по && || ; | & ( ) ` и переводам строк, сегмент — на слова.
// Кавычки снимаются, и всё, что в них, остаётся одним словом: «git commit -m "docker
// compose up"» даёт слово-сообщение, а не команду. subs — подстановки $(…) внутри двойных
// кавычек: они исполняются, их смотрим отдельно («`» в кавычках — экранирование PowerShell)
function parse(text) {
    const segments = [];
    const subs = [];
    let tokens = [];
    let cur = '';
    let started = false; // слово начато — нужно, чтобы «""» осталось пустым словом
    let quote = '';
    let subEnd = 0; // вложенные $(…) отдельно не берём: их увидит разбор внешней подстановки
    const endToken = () => { if (started) tokens.push(cur); cur = ''; started = false; };
    const endSegment = () => { endToken(); if (tokens.length) segments.push(tokens); tokens = []; };
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        const next = text[i + 1] || '';
        if (quote) {
            if (ch === quote) quote = '';
            else if (quote === '"' && ch === '\\' && (next === '"' || next === '\\')) cur += text[++i];
            else {
                if (quote === '"' && ch === '$' && next === '(' && i >= subEnd) {
                    subs.push(insideParens(text, i + 1));
                    subEnd = i + subs[subs.length - 1].length + 2;
                }
                cur += ch;
            }
        } else if (ch === '"' || ch === '\'') {
            quote = ch;
            started = true;
        } else if ((ch === '\\' || ch === '`') && /[\r\n]/.test(next)) {
            endToken(); // перенос строки внутри одной команды: «\» в bash, «`» в PowerShell
            i += next === '\r' && text[i + 2] === '\n' ? 2 : 1;
        } else if (ch === '\\' && /["' ;&|()`$#<>\\]/.test(next)) {
            cur += text[++i]; // «grep a\|b», «find … \;» — знак, а не разделитель; «C:\dir» не трогаем
            started = true;
        } else if (ch === '#' && !started) {
            while (i + 1 < text.length && text[i + 1] !== '\n') i++; // комментарий до конца строки
        } else if (ch === '(' && /=$/.test(cur)) {
            i += insideParens(text, i).length + 1; // «files=(a.sh b.sh)» — массив, слова в нём не команды
        } else if (ch === '\n' || ';&|()`'.includes(ch)) {
            endSegment();
        } else if (/\s/.test(ch)) {
            endToken();
        } else {
            cur += ch;
            started = true;
        }
    }
    endSegment();
    return { segments, subs };
}

// ---------- позиция команды ----------
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', 'time', '!', '{', '}']);
const ASSIGN = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ash', 'ksh', 'source', '.']);
// обёртки, запускающие команду, что идёт за ними; значение — их флаги с аргументом
const WRAPPERS = new Map([
    ['sudo', /^-[ugpCDhRT]$/], ['doas', /^-u$/], ['env', /^-[uC]$/], ['nice', /^-n$/],
    ['ionice', /^-[cnp]$/], ['timeout', /^(-[ks]|--kill-after|--signal)$/], ['exec', /^-a$/],
    ['nohup', null], ['setsid', null], ['stdbuf', null], ['command', null], ['builtin', null],
    ['winpty', null], ['start', /^\/d$/i],
    ['start-process', /^-(windowstyle|redirectstandard\w+|verb|credential)$/i],
    ['wsl', /^(-d|--distribution|-u|--user|--cd|--shell-type)$/],
]);
const PS_VALUE_FLAGS = /^-(executionpolicy|ep|ex|windowstyle|w|workingdirectory|wd|inputformat|outputformat|configurationname|version|settingsfile)$/i;

function stripWrapper(tokens, valueFlags, state) {
    const name = baseName(tokens[0]);
    const rest = tokens.slice(1);
    if (name === 'start-process') { // -WorkingDirectory бывает и после самой команды
        const at = rest.findIndex((t) => /^-workingdirectory$/i.test(t));
        if (at >= 0) state.dir = resolveFrom(state.dir, rest.splice(at, 2)[1] || '');
    }
    let i = 0;
    let duration = name === 'timeout';
    for (; i < rest.length; i++) {
        const t = rest[i];
        if (valueFlags && valueFlags.test(t)) {
            if (/^(--cd|\/d)$/i.test(t)) state.dir = resolveFrom(state.dir, rest[i + 1] || '');
            i++;
        } else if (duration && /^\d+(\.\d+)?[smhd]?$/.test(t)) duration = false;
        else if (t !== '' && !t.startsWith('-') && !ASSIGN.test(t) && !(name === 'start' && /^\/[a-z]+$/i.test(t))) break;
    }
    return rest.slice(i);
}

// bash/sh/source: либо текст команды (-c, -lc), либо файл скрипта на запуск
function shellTarget(tokens) {
    let i = 1;
    for (; i < tokens.length && /^[-+]./.test(tokens[i]); i++) {
        const flag = tokens[i];
        if (flag === '--') { i++; break; }
        if (flag.startsWith('--')) { if (/^--(rcfile|init-file)$/.test(flag)) i++; continue; }
        if (flag.includes('c')) return { payload: tokens[i + 1] || '' };
        if (flag.includes('n')) return null; // «bash -n» — только разбор, без запуска
        if (/^[-+][A-Za-z]*[oO]$/.test(flag)) i++; // «bash -euo pipefail скрипт»: у -o есть значение
    }
    let script = tokens[i] || '';
    if (script === '<') script = tokens[++i] || ''; // «bash < hermes-start.sh» — тот же запуск
    else if (/^<[^<]/.test(script)) script = script.slice(1);
    return script ? { tokens: [script, ...tokens.slice(i + 1)] } : null;
}

// pwsh/powershell: -Command забирает весь хвост и склеивает его пробелами
function powershellPayload(tokens) {
    let i = 1;
    for (; i < tokens.length && tokens[i].startsWith('-'); i++) {
        if (/^-(c|command|commandwithargs|cwa)$/i.test(tokens[i])) { i++; break; }
        if (/^-(f|file|e|ec|encodedcommand)$/i.test(tokens[i])) return null; // файл или base64 — не читаем
        if (PS_VALUE_FLAGS.test(tokens[i])) i++;
    }
    return { payload: tokens.slice(i).join(' ') };
}

// Снимает с сегмента всё, что стоит перед настоящей командой: служебные слова,
// VAR=значение, обёртки. Итог — { tokens, env }, либо { payload } (текст для вложенной
// оболочки), либо null, когда проверять нечего
function unwrap(tokens, state) {
    let rest = tokens;
    const env = {};
    for (let guard = 0; guard < 16; guard++) {
        while (rest.length && (KEYWORDS.has(rest[0]) || ASSIGN.test(rest[0]))) {
            const m = rest[0].match(ASSIGN);
            if (m && !KEYWORDS.has(rest[0])) env[m[1]] = m[2];
            rest = rest.slice(1);
        }
        if (!rest.length) return null;
        const name = baseName(rest[0]);
        if (WRAPPERS.has(name)) { rest = stripWrapper(rest, WRAPPERS.get(name), state); continue; }
        if (SHELLS.has(name)) {
            const target = name === 'source' || name === '.' ? { tokens: rest.slice(1) } : shellTarget(rest);
            if (!target || target.payload !== undefined) return target;
            return target.tokens.length ? { tokens: target.tokens, env } : null;
        }
        if (name === 'pwsh' || name === 'powershell') return powershellPayload(rest);
        if (/^(eval|iex|invoke-expression)$/.test(name)) return { payload: rest.slice(1).join(' ') };
        if (name === 'cmd') {
            const at = rest.findIndex((t, i) => i > 0 && /^\/[ck]$/i.test(t));
            return at < 0 ? null : { payload: rest.slice(at + 1).join(' ') };
        }
        // перенаправления вывода команде не аргументы: «docker run … hermes-agent >log»
        const clean = rest.filter((t, i) => !/^\d*>>?/.test(t) && !/^\d*>>?$/.test(rest[i - 1] || ''));
        return clean.length ? { tokens: clean, env } : null;
    }
    return null;
}

// идёт по флагам с позиции i, значения флагов из withValue отдаёт в onValue;
// возвращает позицию первого слова, которое не флаг
function takeFlags(tokens, i, withValue, onValue) {
    for (; i < tokens.length && tokens[i].startsWith('-'); i++) {
        const [flag, inline] = tokens[i].split(/=(.*)/s);
        if (!withValue.test(flag)) continue;
        onValue(flag, inline !== undefined ? inline : tokens[++i] || '');
    }
    return i;
}

// ---------- правила ----------
const DOCKER_GLOBAL = /^(-c|--context|-H|--host|--config|-l|--log-level|--tlscacert|--tlscert|--tlskey)$/;
const COMPOSE_GLOBAL = /^(-f|--file|-p|--project-name|--project-directory|--env-file|--profile|--ansi|--progress|--parallel)$/;
const COMPOSE_VERBS = new Set(['up', 'down', 'restart', 'start', 'stop', 'rm', 'run', 'create', 'kill']);
const DOCKER_VERBS = new Set(['run', 'create', 'start', 'stop', 'restart', 'rm', 'kill']);
const LIVE = 'Живое поведение смотри на стеке, который поднял пользователь: docker ps, '
    + '«docker logs openkarandash-hermes», docker inspect, docker exec, logs/bridge.log, SYSTEM/live-check.mjs.';

const RULES = [
    {
        name: 'hermes-script',
        test: (ctx) => /^hermes-(start|stop)\.sh$/.test(norm(ctx.tokens[0]).split('/').pop()),
        reason: 'Запускать hermes-start.sh / hermes-stop.sh из сессии нельзя: стек у пользователя один, '
            + 'его поднимает и гасит сторож server.js. start заведёт второй мост и второй Hermes — они '
            + 'подерутся за порт, claude CLI и DATA; stop уронит живой Hermes пользователя. '
            + 'Сам скрипт проверяй разбором — «bash -n hermes-start.sh», читать и коммитить его можно. ' + LIVE,
    },
    {
        name: 'docker-stack',
        test(ctx) {
            const t = ctx.tokens;
            let compose = ctx.base === 'docker-compose';
            if (ctx.base !== 'docker' && !compose) return false;
            let i = compose ? 1 : takeFlags(t, 1, DOCKER_GLOBAL, () => {});
            if (!compose && t[i] === 'compose') { compose = true; i++; }
            if (compose) {
                // чей это compose: по файлам -f и каталогу; без них решает текущая папка
                const files = ctx.env.COMPOSE_FILE ? [ctx.env.COMPOSE_FILE] : [];
                let project = '';
                i = takeFlags(t, i, COMPOSE_GLOBAL, (flag, value) => {
                    if (/^(-f|--file|--project-directory)$/.test(flag)) files.push(value);
                    if (/^(-p|--project-name)$/.test(flag)) project = value;
                });
                if (!COMPOSE_VERBS.has(t[i])) return false; // ps, logs, config, exec, pause, build — можно
                if (/hermes|openkarandash/i.test(project)) return true;
                if (!files.length) return insideProject(ctx.dir);
                return files.some((file) => /hermes/i.test(file) || insideProject(resolveFrom(ctx.dir, file)));
            }
            if (t[i] === 'container') i++;
            if (!DOCKER_VERBS.has(t[i])) return false; // ps, logs, inspect, exec, pause, unpause — можно
            // имя могло прийти подстановкой или переменной: «docker stop $(docker ps -q --filter
            // name=…)», «for c in …; do docker restart "$c"» — тогда ищем его по всей команде;
            // «docker ps -q» без фильтра — это все контейнеры разом, Hermes среди них.
            // У run/create «$» в аргументах обычен («-v "$PWD:/w"») и на имя не указывает
            const viaVar = !/^(run|create)$/.test(t[i]) && t.slice(i + 1).some((word) => word.includes('$'));
            const scope = t.includes('$') || viaVar ? ctx.raw : t.slice(i + 1).join(' ');
            if (/openkarandash-hermes/i.test(scope)) return true;
            if (t.includes('$') && /docker(\.exe)?\s+(container\s+)?(ps|ls)(\s+-[a-z]+)*\s*\)/i.test(scope)) return true;
            // образ последним словом — запуск с командой по умолчанию, то есть ещё один Hermes
            return /^(run|create)$/.test(t[i]) && /^(\S*\/)?hermes-agent(:[\w.-]+)?$/i.test(t[t.length - 1]);
        },
        reason: 'Поднимать, гасить и перезапускать Hermes из сессии нельзя (docker compose up/down/restart/'
            + 'start/stop/rm/run/create/kill; docker run/start/stop/restart/rm/kill для openkarandash-hermes*): '
            + 'контейнер один, им управляет сторож server.js (SYSTEM/core/hermes-stack.js), а вторая копия '
            + 'дерётся за порты и DATA. Для диагностики открыты docker ps / logs / inspect / exec и '
            + '«docker compose … ps|logs|config»; прямой путь к Claude проверяется через «docker pause '
            + 'openkarandash-hermes» и потом «docker unpause». Нужен настоящий перезапуск — попроси пользователя. ' + LIVE,
    },
    {
        name: 'bridge-process',
        test(ctx) {
            if (!/^(python[\d.]*|pypy[\d.]*|py)$/.test(ctx.base)) return false;
            const t = ctx.tokens;
            for (let i = 1; i < t.length; i++) {
                if (/^-[bBdEiIOqsSuvx]*c$/.test(t[i])) return false; // «python -c …» — однострочник
                if (/^-[bBdEiIOqsSuvx]*m$/.test(t[i])) { // py_compile и прочие модули — можно
                    const mod = t[i + 1] || '';
                    return /(claude|exec)[-_]bridge/i.test(mod) || (/^server(\.|$)/.test(mod) && inBridge(ctx.dir));
                }
                if (t[i] === '-W' || t[i] === '-X') i++;
                else if (!t[i].startsWith('-')) { // первое слово без дефиса — сам скрипт
                    const file = resolveFrom(ctx.dir, t[i]);
                    return /(^|\/)(claude|exec)-bridge\/server\.py$/.test(file)
                        || (unknown(file) && /(^|\/)server\.py$/.test(file));
                }
            }
            return false;
        },
        reason: 'Запускать мост (claude-bridge/server.py, exec-bridge/server.py) из сессии нельзя — даже на '
            + 'другом порту и «только для проверки»: второй мост дерётся за порт и claude CLI, а проверка на '
            + 'отдельной копии не показывает поведение настоящей. Правку claude-bridge/*.py сторож подхватывает '
            + 'сам и перезапускает один мост (DOCS/decisions/029); exec-bridge поднимает пользователь. '
            + 'Код проверяй разбором — «python3 -m py_compile <файл>». ' + LIVE,
    },
];

const CD = new Set(['cd', 'chdir', 'pushd', 'set-location', 'sl', 'push-location']);

// Возвращает сработавшее правило или null. state.dir — текущая папка: её двигают cd и
// их родня, потому что «cd claude-bridge && python3 server.py» запускает мост
function scan(text, state, depth) {
    if (depth > 4) return null;
    const { segments, subs } = parse(text);
    for (const segment of segments) {
        const found = unwrap(segment, state);
        if (!found) continue;
        let rule = null;
        if (found.payload !== undefined) {
            rule = scan(cutHeredocs(found.payload), { ...state }, depth + 1);
        } else if (CD.has(baseName(found.tokens[0]))) {
            const target = found.tokens.slice(1).find((t) => !/^(-\S*|\/d)$/i.test(t));
            state.dir = target && target !== '-' ? resolveFrom(state.dir, target) : '?';
        } else {
            const ctx = { tokens: found.tokens, env: found.env, base: baseName(found.tokens[0]), dir: state.dir, raw: state.raw };
            rule = RULES.find((candidate) => candidate.test(ctx)) || null;
        }
        if (rule) return rule;
    }
    for (const sub of subs) {
        const rule = scan(sub, { ...state }, depth + 1);
        if (rule) return rule;
    }
    return null;
}

function verdict(input) {
    if (input.tool_name !== 'Bash' && input.tool_name !== 'PowerShell') return '';
    const command = input.tool_input?.command;
    if (typeof command !== 'string' || !command) return '';
    if (RUNS_SERVER.test(command)) return SERVER_REASON;
    const dir = typeof input.cwd === 'string' && input.cwd ? norm(input.cwd) : ''; // нет папки — считаем худшее
    const rule = scan(cutHeredocs(command), { dir, raw: command }, 0);
    return rule ? rule.reason : '';
}

// Когда сказать нечего, хук молчит и выходит с нулём: явное «allow» перебило бы решения
// других хуков и правила разрешений. process.exit не зовём — вывод должен успеть уйти
let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { data += chunk; });
process.stdin.on('error', () => {});
process.stdin.on('end', () => {
    try {
        const reason = verdict(JSON.parse(data));
        if (!reason) return;
        const hookSpecificOutput = { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason };
        console.log(JSON.stringify({ hookSpecificOutput }));
    } catch {
        // не разобрали вход или споткнулись сами — сторож не должен ломать сессию
    }
});
