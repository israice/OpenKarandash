const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const ROOT = __dirname;

// ---------- .env: единственное место для порта и секретов ----------
// файла нет — создаём его с портом 3001 и на нём же поднимаемся. значения из .env
// не перетирают то, что уже задано в окружении: так `PORT=3999 node server.js`
// (смоук поднимает сервер на свободном порту) продолжает работать
const ENV_FILE = path.join(ROOT, '.env');

const ENV_TEMPLATE = `# Настройки и секреты проекта. В git не попадает — правьте прямо здесь.
PORT=3001

# Путь к CLI Claude, если его нет в PATH
# CLAUDE_BIN=
# Внешний Obsidian-vault вместо папки vault/ внутри проекта
# OBSIDIAN_VAULT=
`;

function loadEnv() {
    if (!fs.existsSync(ENV_FILE)) {
        fs.writeFileSync(ENV_FILE, ENV_TEMPLATE, 'utf8');
        console.log('Создан .env с портом 3001 — порт и секреты правьте в нём');
    }
    for (const line of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
        const pair = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/); // комментарии и пустые строки не подходят
        if (!pair) continue;
        const value = pair[2].trim().replace(/^(['"])([\s\S]*)\1$/, '$2'); // кавычки вокруг значения необязательны
        if (process.env[pair[1]] === undefined) process.env[pair[1]] = value;
    }
}

loadEnv();

const PORT = Number(process.env.PORT) || 3001;
const LIVE_RELOAD = process.env.NO_RELOAD !== '1';
const POLL_MS = 400; // как часто сверяем время изменения файлов

// ---------- перезапуск при изменении самого server.js ----------
// Node читает файл один раз при старте, поэтому сервер работает в дочернем процессе,
// а родительский следит за server.js и поднимает дочерний заново после правок
if (LIVE_RELOAD && !process.env.SERVER_CHILD) {
    let child = null;
    let restarting = false;
    let busy = false;          // дочерний процесс сейчас ведёт запрос к Claude
    let waiting = false;       // файл изменился, но перезапуск отложен до конца запроса

    // сломанная правка не должна ронять сторожа вместе с сервером:
    // файл с синтаксической ошибкой не запускаем, старый процесс продолжает работать
    const isValid = () => {
        try {
            execFileSync(process.execPath, ['--check', __filename], { stdio: 'ignore' });
            return true;
        } catch {
            console.error('server.js не парсится — оставляю работать прежнюю версию');
            return false;
        }
    };

    const restart = () => {
        waiting = false;
        if (!isValid()) return; // починят файл — mtime изменится, и мы придём сюда снова
        console.log('server.js изменён — перезапускаю сервер...');
        if (!child) return start(); // прошлый процесс упал сам — просто поднимаем заново
        restarting = true;
        child.kill();
    };

    const start = () => {
        child = spawn(process.execPath, [__filename], {
            stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
            env: { ...process.env, SERVER_CHILD: '1' },
        });

        // Claude из чата правит файлы проекта, в том числе server.js. перезапуск
        // посреди работы убил бы запущенный CLI, поэтому ждём окончания запроса
        child.on('message', (message) => {
            busy = Boolean(message && message.busy);
            if (!busy && waiting) restart();
        });

        child.on('exit', (code, signal) => {
            child = null;
            busy = false;
            if (restarting) {
                restarting = false;
                start();
                return;
            }
            if (signal || code === 0) process.exit(0); // остановлен снаружи или завершился штатно
            // упал сам (например, ошибка в коде): сторож остаётся жив и поднимет
            // сервер, как только server.js поправят — иначе чинить было бы нечем
            console.error(`сервер упал (код ${code}) — жду исправления server.js`);
        });
    };

    let mtime = fs.statSync(__filename).mtimeMs;

    setInterval(() => {
        let current;
        try {
            current = fs.statSync(__filename).mtimeMs;
        } catch {
            return;
        }
        if (current === mtime) return;

        mtime = current;

        if (busy) {
            if (!waiting) console.log('server.js изменён — перезапущу после текущего запроса');
            waiting = true;
            return;
        }

        restart();
    }, POLL_MS);

    for (const signal of ['SIGINT', 'SIGTERM']) {
        process.on(signal, () => {
            if (child) child.kill(signal);
            process.exit(0);
        });
    }

    start();
    return; // код ниже выполняется только в дочернем процессе
}

// версия страницы — единственный источник истины: последняя строка DEV LOG в VERSION.md
function currentVersion() {
    try {
        const text = fs.readFileSync(path.join(ROOT, 'VERSION.md'), 'utf8');
        const matches = text.match(/^v\d+\.\d+\.\d+.*$/gm);
        return matches ? matches[matches.length - 1].split(' ')[0] : '';
    } catch {
        return '';
    }
}

// строки VERSION.md попадают прямо в HTML, а в сообщениях коммитов встречается
// разметка (например «inline <script>») — без экранирования она рвёт страницу
function escapeHtml(text) {
    return text.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
}

// список версий для модального окна: новые сверху
function versionHistory() {
    try {
        const text = fs.readFileSync(path.join(ROOT, 'VERSION.md'), 'utf8');
        const lines = text.match(/^v\d+\.\d+\.\d+.*$/gm) || [];
        return lines.reverse().map((line) => `<li class="version-list__item">${escapeHtml(line)}</li>`).join('');
    } catch {
        return '';
    }
}

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
};

// ---------- live reload ----------

// скрипт подмешивается в HTML на лету, файлы проекта не трогаются
const RELOAD_SNIPPET = `
<script>
(function () {
    let source;
    let lost = false;
    let hold = false;   // идёт запрос к Claude — перезагрузка оборвала бы ответ
    let queued = false;

    // страница просит подождать, пока читает поток ответа
    window.__holdReload = (on) => {
        hold = on;
        if (!on && queued) location.reload();
    };

    function reload() {
        if (hold) queued = true;
        else location.reload();
    }

    function connect() {
        source = new EventSource('/__reload');
        // карта пересобирается позже самой правки, поэтому у неё своё событие:
        // страницу перезагружать незачем, достаточно перерисовать граф
        source.onmessage = (event) => {
            if (event.data === 'map') window.__onMapUpdate && window.__onMapUpdate();
            else reload();
        };
        // связь восстановилась после перезапуска сервера — берём свежую страницу
        source.onopen = () => { if (lost) reload(); };
        source.onerror = () => { lost = true; source.close(); setTimeout(connect, 500); };
    }

    connect();
})();
</script>
`;

const clients = new Set();

function notifyClients(event = 'reload') {
    for (const res of clients) res.write(`data: ${event}\n\n`);
}

// fs.watch не даёт событий на некоторых ФС (диски Windows в WSL, сетевые шары),
// поэтому следим за временем изменения файлов опросом — работает везде
const VAULT_DIR = 'vault'; // Obsidian vault проекта: создаётся сам, лежит рядом с кодом
const SKIP = new Set(['node_modules', '.git', VAULT_DIR]);

function snapshot(dir, acc = new Map()) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || SKIP.has(entry.name)) continue;

        const full = path.join(dir, entry.name);
        if (full === __filename) continue; // за server.js следит надзорный процесс
        if (entry.isDirectory()) snapshot(full, acc);
        else acc.set(full, fs.statSync(full).mtimeMs);
    }
    return acc;
}

// правки идут пачками — пересобираем карту после паузы, и не посреди запроса к Claude
const MAP_DEBOUNCE_MS = 3000;
let mapTimer = null;

function scheduleMapUpdate() {
    if (mapTimer) clearTimeout(mapTimer);
    mapTimer = setTimeout(() => {
        mapTimer = null;
        if (running > 0) {
            scheduleMapUpdate(); // Claude ещё правит файлы — пересоберём, когда закончит
            return;
        }
        prepareVault();
    }, MAP_DEBOUNCE_MS);
}

function watchFiles() {
    let previous = snapshot(ROOT);
    let previousList = projectFiles().join('|');

    setInterval(() => {
        let current;
        try {
            current = snapshot(ROOT);
        } catch {
            return; // файл исчез посреди обхода — проверим на следующем круге
        }

        let changed = current.size !== previous.size;
        if (!changed) {
            for (const [file, mtime] of current) {
                if (previous.get(file) !== mtime) { changed = true; break; }
            }
        }

        previous = current;
        if (changed) {
            if (clients.size > 0) notifyClients();
            scheduleMapUpdate();
            return;
        }

        // snapshot намеренно не видит скрытые файлы: .sessions.db переписывается на
        // каждом сообщении, и страница перезагружалась бы без конца. но в карту такие
        // файлы входят, поэтому отдельно следим за составом папки — без чтения mtime
        const list = projectFiles().join('|');
        if (list === previousList) return;
        previousList = list;
        scheduleMapUpdate(); // появился или исчез файл — перерисовываем карту, страницу не трогаем
    }, POLL_MS).unref();
}

// ---------- коннектор Claude CLI ----------

// где искать CLI: набор зависит от того, из какого окружения запущен сервер.
// wsl.exe нужен именно с login-шеллом — при `wsl -e claude` в PATH нет ~/.local/bin
const CLAUDE_BIN = process.env.CLAUDE_BIN;
const TARGETS = CLAUDE_BIN
    ? [{ id: 'custom', label: 'CLAUDE_BIN', cmd: CLAUDE_BIN, args: [] }]
    : process.platform === 'win32'
        ? [
            { id: 'windows', label: 'Windows', cmd: 'claude', args: [] },
            { id: 'wsl', label: 'WSL', cmd: 'wsl.exe', args: ['bash', '-lc'], viaShell: true },
          ]
        : [
            { id: 'wsl', label: 'WSL', cmd: 'claude', args: [] },
            { id: 'windows', label: 'Windows', cmd: 'claude.exe', args: [] },
          ];

// модель подставляется в командную строку, поэтому принимаем только известные значения
const CLAUDE_MODELS = [
    'claude-opus-5',
    'claude-sonnet-5',
    'claude-fable-5',
    'claude-haiku-4-5',
    'opus',
    'sonnet',
    'haiku',
    'fable',
];

const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

let activeTarget = null;

// промпт всегда идёт через stdin: так он не попадает в командную строку
// и не требует экранирования, даже когда команда собирается для `bash -lc`
function runClaude(target, cliArgs, { input = '', timeoutMs, onLine, onSpawn } = {}) {
    return new Promise((resolve, reject) => {
        const args = target.viaShell
            ? [...target.args, ['claude', ...cliArgs].join(' ')]
            : [...target.args, ...cliArgs];

        const child = spawn(target.cmd, args, { windowsHide: true });
        onSpawn?.(child);

        let stdout = '';
        let stderr = '';
        let finished = false;

        const timer = setTimeout(() => {
            finished = true;
            child.kill();
            reject(new Error(`Превышено время ожидания (${Math.round(timeoutMs / 1000)} с)`));
        }, timeoutMs);

        const done = (err, value) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            err ? reject(err) : resolve(value);
        };

        child.on('error', (err) => {
            done(new Error(err.code === 'ENOENT' ? `${target.cmd} не найден` : err.message));
        });

        let tail = '';
        child.stdout.on('data', (chunk) => {
            if (!onLine) {
                stdout += chunk;
                return;
            }
            // stream-json приходит построчно, но кусками — отдаём только целые строки
            tail += chunk;
            const lines = tail.split('\n');
            tail = lines.pop();
            for (const line of lines) {
                if (line.trim()) onLine(line);
            }
        });
        child.stderr.on('data', (chunk) => { stderr += chunk; });

        child.on('close', (code) => {
            if (code === 0) done(null, stdout);
            else done(new Error(child.__stoppedByUser ? 'Остановлено пользователем' : (stderr.trim() || `CLI завершился с кодом ${code}`)));
        });

        child.stdin.on('error', () => {}); // процесс мог закрыться раньше, чем мы дописали
        child.stdin.end(input);
    });
}

// версия из строки вида «2.1.245 (Claude Code)»
function parseVersion(stdout) {
    const match = stdout.match(/\d+\.\d+\.\d+/);
    return match ? match[0] : stdout.trim().split('\n')[0];
}

async function detectInstalls() {
    const checks = await Promise.allSettled(
        TARGETS.map(async (target) => ({
            id: target.id,
            label: target.label,
            version: parseVersion(await runClaude(target, ['--version'], { timeoutMs: 15000 })),
        }))
    );

    return checks.filter((c) => c.status === 'fulfilled').map((c) => c.value);
}

// короткая подпись действия: «Read index.html», «Bash npm test»
function toolLabel(part) {
    const input = part.input || {};
    // от пути оставляем имя файла — в строке состояния важно «что», а не «где»
    const detail = part.name === 'Task' ? `${input.subagent_type || ''}: ${input.description || ''}`.trim()
        : input.file_path ? path.basename(input.file_path)
        : input.command || input.pattern || input.url || '';
    return { type: 'tool', name: part.name, detail: String(detail).slice(0, 120) };
}

// эти инструменты реально правят файлы (см. CHAT_DENIED_TOOLS) — только по ним
// имеет смысл ловить конфликты; Bash тоже может писать в файлы, но команду не разобрать
const WRITE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);

// ход работы уходит на страницу по мере поступления: id сессии, вызовы
// инструментов и текст ответа. send() пишет по событию в поток ответа
let running = 0;

// сессии выполняются параллельно, но не по одним и тем же файлам: у каждого
// активного запуска есть набор файлов (угаданный по тексту промпта и уточнённый
// по факту Edit/Write) — новый запуск ждёт, только если пересекается с активным
const activeRuns = new Map(); // runId -> { sessionId, files: Set<string>, child, done }
let nextRunId = 1;
let waitingCount = 0; // сколько запросов сейчас реально ждут освобождения файла

// имена файлов проекта, упомянутые в тексте промпта — грубая, но дешёвая эвристика:
// точно узнать, какие файлы затронет Claude, можно только по факту (см. WRITE_TOOLS ниже)
function candidateFiles(prompt) {
    const lower = prompt.toLowerCase();
    const found = new Set();
    for (const file of snapshot(ROOT).keys()) {
        const base = path.basename(file).toLowerCase();
        if (base.length > 3 && lower.includes(base)) found.add(file);
    }
    return found;
}

function conflictingRuns(files, exclude) {
    return [...activeRuns.values()].filter((run) => run !== exclude && [...run.files].some((f) => files.has(f)));
}

// ждём, только если реально пересекаемся файлами с уже активным запуском —
// иначе стартуем сразу, параллельно с остальными сессиями
async function waitForFileTurn(files, send) {
    let blockers = conflictingRuns(files);
    if (blockers.length === 0) return;

    waitingCount += 1;
    try {
        while (blockers.length > 0) {
            send({ type: 'queued', ahead: blockers.length });
            await Promise.race(blockers.map((r) => r.done));
            blockers = conflictingRuns(files);
        }
    } finally {
        waitingCount -= 1;
    }
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// эвристика по промпту — только первая линия обороны. Точную проверку делает
// PreToolUse-хук (.claude/hooks/file-lock.js): он спрашивает сюда прямо перед
// вызовом Edit/Write/NotebookEdit, и мы либо пускаем, либо ждём освобождения файла
const LOCK_CHECK_TIMEOUT_MS = 85_000; // короче таймаута хука (100с в settings.json) — успеваем ответить

async function checkFileLock(file, sessionId) {
    const resolved = path.resolve(file);
    const all = [...activeRuns.values()];
    // sessionId известен хуку с самого начала (в отличие от нашего run.sessionId,
    // который заполняется только после первой строки стрима) — но пока запрос
    // самый первый, стрим мог не успеть догнать: тогда берём самый свежий безымянный,
    // как и в stopActiveRun. Вызов извне (например, интерактивная сессия в этом же
    // проекте) сюда просто не попадёт — caller останется null, и это нормально
    const caller = sessionId
        ? all.find((r) => r.sessionId === sessionId) || null
        : all.filter((r) => !r.sessionId).pop() || null;

    const files = new Set([resolved]);
    const deadline = Date.now() + LOCK_CHECK_TIMEOUT_MS;
    for (;;) {
        const blockers = conflictingRuns(files, caller);
        if (blockers.length === 0) break;
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
            return { ok: false, reason: `${path.basename(resolved)} сейчас редактирует другая сессия` };
        }
        await Promise.race([...blockers.map((r) => r.done), sleep(remaining)]);
    }

    if (caller) caller.files.add(resolved); // теперь это факт, а не догадка
    return { ok: true };
}

// sessionId известен не всегда (CLI ещё не прислал id для только что стартовавшего
// запуска) — тогда останавливаем самый свежий безымянный: неоднозначность возможна,
// только если два новых запуска стартовали в одну и ту же секунду
function stopActiveRun(sessionId) {
    const candidates = [...activeRuns.values()];
    const target = sessionId
        ? candidates.find((r) => r.sessionId === sessionId)
        : candidates.filter((r) => !r.sessionId).pop();
    if (!target || !target.child) return false;
    target.child.__stoppedByUser = true;
    target.child.kill();
    return true;
}

// запущенные сейчас запросы: id сессии -> подключённые слушатели.
// страницу могли перезагрузить, и она подключается к уже идущей работе
const runs = new Map();

function broadcast(sessionId, event) {
    const listeners = runs.get(sessionId);
    if (!listeners) return;

    const line = JSON.stringify(event) + '\n';
    for (const res of listeners) res.write(line);
}

// пока идёт хотя бы один запрос, родительский процесс откладывает перезапуск
function setBusy(delta) {
    running += delta;
    if (process.send) process.send({ busy: running > 0 });
}

// Chat — обсуждение без последствий. запрета Edit/Write мало: в прошлый раз правка
// прошла через PowerShell, а субагент мог бы обойти и это, поэтому глушим всё,
// чем можно изменить файл или запустить команду. чтение (Read/Grep/Glob) остаётся
const CHAT_DENIED_TOOLS = [
    'Edit', 'Write', 'NotebookEdit',
    'Bash', 'PowerShell', 'BashOutput', 'KillShell',
    'Task', 'Agent', 'SlashCommand',
].join(',');

// преамбула идёт вместе с промптом через stdin, а не флагом: аргументы для WSL
// склеиваются в одну строку, и текст с пробелами там развалился бы
const CHAT_PREAMBLE = `Режим обсуждения. Отвечай текстом: объясняй, предлагай варианты, задавай уточняющие вопросы.
Ничего не меняй и не запускай — инструменты правки файлов и запуска команд отключены.
Если для ответа нужен код, прочитай его (Read/Grep/Glob) и расскажи словами, что бы ты сделал.

`;

async function askClaude({ prompt, model, effort, sessionId, mode }, send) {
    if (!activeTarget) return send({ type: 'error', error: 'Claude не подключён' });
    if (!prompt) return send({ type: 'error', error: 'Пустой запрос' });
    if (model && !CLAUDE_MODELS.includes(model)) {
        return send({ type: 'error', error: `Неизвестная модель: ${model}` });
    }
    if (effort && !EFFORT_LEVELS.includes(effort)) {
        return send({ type: 'error', error: `Неизвестный уровень effort: ${effort}` });
    }

    const args = ['-p', '--output-format', 'stream-json', '--verbose'];
    if (model) args.push('--model', model);
    if (effort) args.push('--effort', effort);
    if (sessionId) args.push('--resume', sessionId);
    // headless -p не может показать интерактивный запрос на разрешение, поэтому оба
    // режима идут без него: Chat — через plan (ничего не меняет и не запускает),
    // Action — через bypassPermissions (выполняет сразу)
    if (mode === 'Chat') {
        args.push('--permission-mode', 'plan');
        args.push('--disallowedTools', CHAT_DENIED_TOOLS);
        args.push('--strict-mcp-config'); // MCP-инструменты тоже умеют писать — отключаем их целиком
    } else {
        args.push('--permission-mode', 'bypassPermissions');
    }

    let startedSession = null;
    let answer = '';

    // событие видит и тот, кто прислал запрос, и тот, кто подключился к сессии
    const emit = (event) => {
        send(event);
        if (startedSession) broadcast(startedSession, event);
    };

    // --resume: sessionId известен ещё до старта CLI и до появления в activeRuns
    const runId = nextRunId++;
    const run = { sessionId: sessionId || null, files: candidateFiles(prompt), child: null, done: null };
    let resolveDone;
    run.done = new Promise((resolve) => { resolveDone = resolve; });

    // конфликтующие по файлам запуски уже идут — ждём именно их, а не общую очередь
    await waitForFileTurn(run.files, send);
    activeRuns.set(runId, run);
    setBusy(1);

    const onLine = (line) => {
        let event;
        try {
            event = JSON.parse(line);
        } catch {
            return; // не JSON — служебный вывод CLI
        }

        if (event.session_id && !startedSession) {
            startedSession = event.session_id;
            run.sessionId = startedSession;
            startExchange(startedSession, prompt);
            runs.set(startedSession, new Set());
            emit({ type: 'session', id: startedSession });
        }

        if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
            for (const part of event.message.content) {
                if (part.type === 'tool_use') {
                    const step = toolLabel(part);
                    if (startedSession) recordStep(startedSession, `${step.name} ${step.detail}`.trim());
                    emit(step);
                    // уточняем набор файлов по факту — эвристика по промпту могла его не назвать
                    if (WRITE_TOOLS.has(part.name) && part.input?.file_path) {
                        run.files.add(path.resolve(part.input.file_path));
                    }
                }
                else if (part.type === 'text' && part.text.trim()) {
                    answer = part.text;
                    emit({ type: 'text', text: part.text });
                }
            }
        }

        if (event.type === 'result') {
            if (event.is_error) emit({ type: 'error', error: event.result || 'CLI вернул ошибку' });
            else answer = event.result || answer;
        }

        // лимиты подписки (5 часов / 7 дней) CLI присылает сам, на каждый запрос —
        // это те же цифры, что показывает /usage, только уже в JSON
        if (event.type === 'rate_limit_event') {
            emit({ type: 'rate_limit', info: event.rate_limit_info });
        }
    };

    try {
        const input = mode === 'Chat' ? CHAT_PREAMBLE + prompt : prompt;
        await runClaude(activeTarget, args, {
            input, timeoutMs: 600000, onLine,
            onSpawn: (child) => { run.child = child; },
        });
        if (startedSession && answer) finishExchange(startedSession, answer);
        emit({ type: 'done', text: answer });
    } catch (err) {
        emit({ type: 'error', error: err.message });
    } finally {
        // работа окончена — отпускаем подключившиеся страницы
        if (startedSession) {
            for (const listener of runs.get(startedSession) || []) listener.end();
            runs.delete(startedSession);
        }
        // снимаем занятость только после записи в базу, иначе отложенный
        // перезапуск сервера может оборвать нас между ответом и записью
        setBusy(-1);
        activeRuns.delete(runId);
        resolveDone();
        // переписка живёт в .sessions.db, а этот файл слежение намеренно не видит:
        // без явного вызова память о только что прошедшей сессии не попала бы
        // ни в vault, ни в поиск до следующей правки любого файла
        scheduleMapUpdate();
    }
}

// ---------- разбор тела запроса ----------

function readJson(req, limit = 100_000) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', (chunk) => {
            body += chunk;
            if (body.length > limit) {
                reject(new Error('Слишком большой запрос'));
                req.destroy();
            }
        });
        req.on('end', () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            } catch {
                reject(new Error('Некорректный JSON'));
            }
        });
        req.on('error', reject);
    });
}

// ---------- хранилище сессий (SQLite) ----------

// файл базы начинается с точки, поэтому слежение за файлами его не замечает
// и правки базы не вызывают перезагрузку страницы
const DB_FILE = path.join(ROOT, '.sessions.db');
const db = new DatabaseSync(DB_FILE);
// WAL: чтение не блокирует запись, поэтому сборка карты и поиск не мешают чату.
// busy_timeout: если папку обслуживает второй экземпляр сервера, ждём его
// транзакцию, а не падаем сразу с «database is locked»
db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');

db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
        session_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        role TEXT NOT NULL,
        text TEXT NOT NULL,
        PRIMARY KEY (session_id, position)
    );
`);

// колонка добавлена уже после первых версий базы — CREATE TABLE IF NOT EXISTS
// её не добавит в старый файл, поэтому дозаводим миграцией и глушим ошибку,
// если она там уже есть
try {
    db.exec('ALTER TABLE sessions ADD COLUMN thumb TEXT');
} catch { /* колонка уже есть */ }

const upsertSession = db.prepare(`
    INSERT INTO sessions (id, title, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at
`);

const upsertMessage = db.prepare(`
    INSERT INTO messages (session_id, position, role, text)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(session_id, position) DO NOTHING
`);

const touchSession = db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?');
const setSessionThumb = db.prepare('UPDATE sessions SET thumb = ? WHERE id = ?');

const listSessions = db.prepare(`
    SELECT s.id, s.title, s.updated_at AS updatedAt, s.thumb AS thumb,
           (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id AND m.role <> 'tool') AS messageCount
    FROM sessions s
    ORDER BY s.updated_at DESC
`);

const listMessages = db.prepare(
    'SELECT role, text FROM messages WHERE session_id = ? ORDER BY position'
);

const countMessages = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE session_id = ?');

// очистка списка: база пустеет. файлы истории Claude CLI не трогаем — они не наши
function resetSessions() {
    db.exec('DELETE FROM messages; DELETE FROM sessions;');
}

const deleteMessagesBySession = db.prepare('DELETE FROM messages WHERE session_id = ?');
const deleteSessionById = db.prepare('DELETE FROM sessions WHERE id = ?');

function deleteSession(id) {
    deleteMessagesBySession.run(id);
    deleteSessionById.run(id);
}

// ---------- запись сообщений из чата ----------

// вопрос записываем сразу, как CLI сообщил id: сессия появляется в списке
// в начале работы, а не после ответа
function startExchange(sessionId, question) {
    upsertSession.run(sessionId, extractTitle(question, 120), new Date().toISOString());
    upsertMessage.run(sessionId, countMessages.get(sessionId).n, 'user', question);
}

// шаги работы (вызовы инструментов) хранятся вместе с перепиской,
// иначе при открытии сессии от них не остаётся следа
function recordStep(sessionId, text) {
    upsertMessage.run(sessionId, countMessages.get(sessionId).n, 'tool', text);
}

function finishExchange(sessionId, answer) {
    touchSession.run(new Date().toISOString(), sessionId);
    upsertMessage.run(sessionId, countMessages.get(sessionId).n, 'assistant', answer);
}

// ---------- граф Obsidian ----------

// vault читаем прямо с диска: Local REST API требует запущенного Obsidian и токена,
// а нам нужны только имена заметок и ссылки [[...]] между ними
const VAULT = process.env.OBSIDIAN_VAULT || path.join(ROOT, VAULT_DIR);

// подпапка vault под карту файлов проекта. её содержимое генерируем мы, поэтому
// перезаписываем целиком; заметки, написанные руками, лежат вне её и не страдают
const MAP_DIR = 'Проект';
const UNIT_DIR = 'Секции';   // заметки секций и функций внутри крупных файлов
const API_SUBDIR = 'API';    // заметки API-роутов: стык клиента и сервера
const SESSION_DIR = 'Сессии'; // память о прошлых сессиях, эту папку не сносим

// в этих файлах ищем упоминания других файлов проекта — из них и получаются рёбра
const TEXT_FILES = /\.(js|mjs|cjs|ts|tsx|jsx|json|html|css|md|txt|yml|yaml|sh|py|sql)$/i;
const MAX_SCAN_BYTES = 512 * 1024; // огромные файлы (дампы, бандлы) не сканируем

// служебные папки Obsidian: настройки и корзина — не заметки
const VAULT_SKIP = new Set(['.obsidian', '.trash', '.git']);

function collectNotes(dir, base, acc = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (VAULT_SKIP.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) collectNotes(full, base, acc);
        else if (entry.name.endsWith('.md')) acc.push(path.relative(base, full).split(path.sep).join('/'));
    }
    return acc;
}

// в карту идёт всё, что физически лежит в папке проекта, включая скрытые файлы
// и то, что игнорирует git (.sessions.db, .env, локальные настройки).
// исключений ровно два, и оба вынужденные:
//   .git — служебная база на тысячи объектов, содержимое проекта в ней дублируется
//   vault — сама карта: заметки о заметках плодились бы с каждой пересборкой
const MAP_SKIP = new Set(['.git', 'node_modules', VAULT_DIR]);

function projectFiles(dir = ROOT, acc = []) {
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return acc; // папка исчезла или недоступна — пропускаем её целиком
    }
    for (const entry of entries) {
        if (MAP_SKIP.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) projectFiles(full, acc);
        else acc.push(path.relative(ROOT, full).split(path.sep).join('/'));
    }
    return dir === ROOT ? acc.sort() : acc;
}

// карта проекта в виде заметок Obsidian. рёбра берём только из якорных мест —
// строковых литералов, атрибутов и wikilinks. свободный поиск имени файла в тексте
// даёт слишком много ложных связей, поэтому от него отказались
const API_REF = /['"`](\/api\/[a-z0-9/_-]+)['"`]/gi;      // и fetch('/api/…'), и api('/api/…'), и path: в хуках
const API_ROUTE = /urlPath === '(\/api\/[a-z0-9/_-]+)'/g; // объявление роута в server.js
const HTML_REF = /(?:src|href)\s*=\s*["']([^"':#?]+)["']/gi;
const MODULE_REF = /(?:require\(|from\s+|import\()\s*['"](\.[^'"]+)['"]/g;
const SECTION = /^\s*\/\/ -{3,} (.+?) -{3,}\s*$/;
const TOP_FUNCTION = /^(\s*)(?:async )?function ([A-Za-z0-9_$]+)\s*\(/;
const BIG_FILE_LINES = 200; // мелкие файлы на секции не режем — только зашумит граф

// имя заметки должно быть уникальным по всему vault: buildVaultGraph резолвит
// [[ссылки]] по basename, как это делает сам Obsidian
function noteName(text) {
    return text.replace(/[\\/:*?"<>|]/g, '-').trim();
}

// секции (комментарии-разделители) и функции верхнего уровня — узлы внутри файла.
// тело функции считаем до следующего объявления того же отступа: без AST, но
// этого хватает, чтобы увидеть, кто кого вызывает
// перед поиском вызовов вычищаем строки и комментарии: имя функции, упомянутое
// в тексте сообщения или в пояснении, вызовом не является. содержимое заменяем
// пробелами, а не выкусываем — так не склеятся соседние идентификаторы
function stripStringsAndComments(code) {
    let out = '';
    let mode = null;      // '//' | '/*' | "'" | '"' | '`'
    const inserts = [];   // вложенные ${...}: в них лежит код, его сохраняем
    let braces = 0;       // глубина фигурных скобок внутри текущей подстановки

    for (let i = 0; i < code.length; i++) {
        const ch = code[i];
        const next = code[i + 1];

        if (mode === '//') {
            if (ch === '\n') { mode = null; out += ch; } else out += ' ';
            continue;
        }
        if (mode === '/*') {
            if (ch === '*' && next === '/') { mode = null; out += '  '; i++; }
            else out += ch === '\n' ? ch : ' ';
            continue;
        }
        if (mode) { // внутри строки или шаблона
            if (ch === '\\') { out += '  '; i++; continue; } // экранированный символ целиком
            // ${...} в шаблоне — это выражение, а не текст: возвращаемся к разбору кода
            if (mode === '`' && ch === '$' && next === '{') {
                inserts.push(braces);
                braces = 0;
                mode = null;
                out += '  ';
                i++;
                continue;
            }
            if (ch === mode) { mode = null; out += ' '; continue; }
            out += ch === '\n' ? ch : ' ';
            continue;
        }

        if (ch === '/' && next === '/') { mode = '//'; out += '  '; i++; continue; }
        if (ch === '/' && next === '*') { mode = '/*'; out += '  '; i++; continue; }
        if (ch === "'" || ch === '"' || ch === '`') { mode = ch; out += ' '; continue; }

        // выходим из подстановки только по её закрывающей скобке, а не по вложенной
        if (inserts.length) {
            if (ch === '{') braces++;
            else if (ch === '}') {
                if (braces === 0) { braces = inserts.pop(); mode = '`'; out += ' '; continue; }
                braces--;
            }
        }
        out += ch;
    }
    return out;
}

function parseUnits(file, text) {
    const lines = text.split(/\r?\n/); // файлы проекта в CRLF
    if (lines.length < BIG_FILE_LINES) return [];

    const units = [];
    lines.forEach((line, i) => {
        const section = line.match(SECTION);
        if (section) {
            units.push({ kind: 'section', title: section[1], line: i + 1, indent: 0 });
            return;
        }
        const fn = line.match(TOP_FUNCTION);
        if (fn) units.push({ kind: 'function', title: fn[2], line: i + 1, indent: fn[1].length });
    });

    // границы: юнит тянется до следующего юнита с тем же или меньшим отступом
    units.forEach((unit, i) => {
        const next = units.slice(i + 1).find((other) => other.indent <= unit.indent);
        unit.body = lines.slice(unit.line, next ? next.line - 1 : lines.length).join('\n');
        unit.code = stripStringsAndComments(unit.body); // по нему ищем вызовы
        unit.note = `${MAP_DIR}/${UNIT_DIR}/${noteName(`${path.basename(file)} ${unit.title}`)}`;
        // функция принадлежит последней секции выше себя — так граф становится
        // деревом файл → секция → функция, а не плоским веером от файла
        if (unit.kind === 'function') {
            const owner = units.slice(0, i).reverse().find((other) => other.kind === 'section');
            unit.parent = owner ? owner.note : null;
        }
    });
    return units;
}

// история git: когда файл появился, как часто меняется и с чем меняется вместе
function gitHistory() {
    const empty = { byFile: new Map(), pairs: new Map(), commits: 0 };
    let out;
    try {
        out = execFileSync('git', ['log', '--pretty=format:%h|%ad|%s', '--date=short', '--name-only'], {
            cwd: ROOT,
            encoding: 'utf8',
            windowsHide: true,
            maxBuffer: 16 * 1024 * 1024,
        });
    } catch {
        return empty; // не репозиторий или пустая история
    }

    const commits = out.split(/\r?\n\s*\r?\n/).map((block) => {
        const [head, ...rest] = block.split(/\r?\n/);
        const [hash, date, subject] = (head || '').split('|');
        return { hash, date, subject, files: rest.filter(Boolean) };
    }).filter((commit) => commit.hash);
    if (!commits.length) return empty;

    const byFile = new Map();
    for (const commit of commits) {
        for (const file of commit.files) {
            const entry = byFile.get(file) || { commits: 0, last: commit, first: commit };
            entry.commits++;
            entry.first = commit; // log идёт от новых к старым, последний перезаписавший — самый старый
            byFile.set(file, entry);
        }
    }

    // файл, который меняется почти в каждом коммите (VERSION.md), связан со всем
    // подряд и превратился бы в ложный хаб — из пар его исключаем
    const noisy = new Set([...byFile].filter(([, e]) => e.commits / commits.length > 0.6).map(([f]) => f));
    const pairs = new Map();
    for (const commit of commits) {
        const files = commit.files.filter((file) => !noisy.has(file));
        for (let i = 0; i < files.length; i++) {
            for (let j = i + 1; j < files.length; j++) {
                const key = JSON.stringify([files[i], files[j]].sort());
                pairs.set(key, (pairs.get(key) || 0) + 1);
            }
        }
    }
    return { byFile, pairs, commits: commits.length };
}

function readText(file) {
    try {
        if (fs.statSync(path.join(ROOT, file)).size > MAX_SCAN_BYTES) return '';
        return fs.readFileSync(path.join(ROOT, file), 'utf8');
    } catch {
        return ''; // файл исчез между обходом и чтением
    }
}

// заметки, записанные в текущую пересборку: по ним видно, что устарело
let writtenNotes = new Set();

// правки идут пачками, а меняется обычно одна заметка из двух сотен. переписывать
// весь vault каждые три секунды — лишняя работа и лишний износ диска
function writeNote(notePath, frontmatter, body) {
    const note = [
        '---',
        ...Object.entries(frontmatter).filter(([, value]) => value !== undefined && value !== '').map(([k, v]) => `${k}: ${v}`),
        '---',
        '',
        ...body,
        '',
    ].join('\n');

    writtenNotes.add(path.resolve(notePath));
    try {
        if (fs.readFileSync(notePath, 'utf8') === note) return; // содержимое то же — не трогаем
    } catch {
        // заметки ещё нет — создадим ниже
    }
    fs.mkdirSync(path.dirname(notePath), { recursive: true });
    fs.writeFileSync(notePath, note);
}

// осиротевшие заметки: файл удалили или переименовали, а заметка о нём осталась
function dropStaleNotes(dir) {
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return;
    }
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            dropStaleNotes(full);
            try {
                if (!fs.readdirSync(full).length) fs.rmdirSync(full); // папка опустела
            } catch {
                // не удалось — не беда, попробуем в следующий раз
            }
            continue;
        }
        if (entry.name.endsWith('.md') && !writtenNotes.has(path.resolve(full))) fs.unlinkSync(full);
    }
}

function syncProjectMap() {
    const files = projectFiles();
    const known = new Set(files);
    const history = gitHistory();

    const mapRoot = path.join(VAULT, MAP_DIR);
    writtenNotes = new Set(); // начинаем новый круг: что не запишем — то устарело

    // первый проход: разбираем тексты, собираем роуты и юниты
    const texts = new Map();
    const units = new Map();
    const routeImpl = new Map(); // роут → файл, где он объявлен
    for (const file of files) {
        if (!TEXT_FILES.test(file)) continue;
        const text = readText(file);
        texts.set(file, text);
        units.set(file, parseUnits(file, text));
        for (const match of text.matchAll(API_ROUTE)) routeImpl.set(match[1], file);
    }

    // второй проход: заметки файлов со ссылками
    const routeCallers = new Map();
    for (const file of files) {
        const text = texts.get(file) || '';
        const links = new Set();

        for (const match of text.matchAll(API_REF)) {
            const route = match[1];
            if (!routeImpl.has(route)) continue; // роут, которого нет — не узел
            links.add(`${MAP_DIR}/${API_SUBDIR}/${noteName(route.slice(5))}`);
            if (routeImpl.get(route) !== file) {
                const callers = routeCallers.get(route) || new Set();
                callers.add(file);
                routeCallers.set(route, callers);
            }
        }
        for (const match of [...text.matchAll(HTML_REF), ...text.matchAll(MODULE_REF)]) {
            const target = resolveRef(match[1], file, known);
            if (target && target !== file) links.add(`${MAP_DIR}/${target}`);
        }
        if (file.endsWith('.md')) {
            for (const match of text.matchAll(/\[\[([^\]|#^]+)/g)) links.add(match[1].trim());
        }

        const git = history.byFile.get(file);
        const fileUnits = units.get(file) || [];
        writeNote(path.join(mapRoot, `${file}.md`), {
            kind: 'file',
            file,
            lines: text ? text.split(/\r?\n/).length : undefined,
            commits: git ? git.commits : undefined,
            first_seen: git ? git.first.date : undefined,
            last_commit: git ? `${git.last.date} ${git.last.subject}` : undefined,
        }, [
            `Файл проекта: \`${file}\``,
            '',
            ...section('Ссылается на', [...links].sort().map((target) => `- [[${target}]]`)),
            ...section('Внутри', fileUnits
                .filter((unit) => !unit.parent) // функции внутри секций перечислит сама секция
                .map((unit) => `- [[${unit.note}]] (строка ${unit.line})`)),
        ]);
    }

    // заметки секций и функций: связь с родителем и вызовы соседей
    for (const [file, fileUnits] of units) {
        const names = new Map(fileUnits.filter((u) => u.kind === 'function').map((u) => [u.title, u]));
        for (const unit of fileUnits) {
            // секция не «вызывает» свои функции — она их содержит, иначе одна и та же
            // связь попадёт в граф дважды и разными смыслами
            const own = unit.kind === 'section'
                ? fileUnits.filter((other) => other.parent === unit.note)
                : [];
            const calls = new Set();
            if (unit.kind === 'function') {
                for (const [name, target] of names) {
                    // (?<![.\w$]) отсекает методы объектов: res.close(), Promise.resolve() —
                    // иначе общие имена вроде open/close дают лавину ложных вызовов
                    if (target !== unit && new RegExp(`(?<![.\\w$])${name}\\s*\\(`).test(unit.code)) calls.add(target.note);
                }
            }
            writeNote(path.join(VAULT, `${unit.note}.md`), {
                kind: unit.kind,
                file,
                line: unit.line,
            }, [
                // ссылаемся только на прямого родителя: функция внутри секции —
                // на секцию, иначе в графе появится второе ребро до файла
                `${unit.kind === 'section' ? 'Секция' : 'Функция'} \`${unit.title}\` в [[${unit.parent || `${MAP_DIR}/${file}`}]], строка ${unit.line}.`,
                '',
                ...section('Внутри', own.map((other) => `- [[${other.note}]] (строка ${other.line})`)),
                ...section('Вызывает', [...calls].sort().map((note) => `- [[${note}]]`)),
            ]);
        }
    }

    // заметки API-роутов: точка стыковки клиента и сервера
    for (const [route, impl] of routeImpl) {
        const callers = [...(routeCallers.get(route) || [])].sort();
        writeNote(path.join(mapRoot, API_SUBDIR, `${noteName(route.slice(5))}.md`), {
            kind: 'route',
            route,
        }, [
            `API-роут \`${route}\`, реализован в [[${MAP_DIR}/${impl}]].`,
            '',
            ...section('Вызывают', callers.map((file) => `- [[${MAP_DIR}/${file}]]`)),
        ]);
    }

    // заметка «менялись вместе»: рёбра из истории git, вес = число общих коммитов
    const pairs = [...history.pairs].filter(([, weight]) => weight >= 2);
    if (pairs.length) {
        writeNote(path.join(mapRoot, 'История git.md'), {
            kind: 'history',
            commits: history.commits,
        }, [
            `Файлы, которые меняются вместе (из ${history.commits} коммитов).`,
            '',
            ...pairs.sort((a, b) => b[1] - a[1]).flatMap(([key, weight]) => {
                const [a, b] = JSON.parse(key);
                return known.has(a) && known.has(b) ? [`- ${weight}× [[${MAP_DIR}/${a}]] ↔ [[${MAP_DIR}/${b}]]`] : [];
            }),
        ]);
    }
}

// путь из src=/href=/require() относительно файла, где встретился
function resolveRef(ref, from, known) {
    if (/^[a-z]+:/i.test(ref)) return null; // http:, data:, obsidian: — не файлы проекта
    const base = ref.startsWith('.') ? path.posix.join(path.posix.dirname(from), ref) : ref.replace(/^\//, '');
    for (const candidate of [base, `${base}.js`, `${base}.mjs`, `${base}/index.js`]) {
        if (known.has(candidate)) return candidate;
    }
    return null;
}

function section(title, items) {
    return items.length ? [`## ${title}`, ...items, ''] : [];
}

// vault заводим и наполняем при старте сервера, дальше обновляем после правок —
// к моменту, когда пользователь откроет вкладку Graph, карта уже готова
function prepareVault() {
    try {
        fs.mkdirSync(VAULT, { recursive: true });
        syncProjectMap();
        syncSessionNotes();
        dropStaleNotes(path.join(VAULT, MAP_DIR)); // карта: файл исчез — заметка тоже
        dropStaleNotes(path.join(VAULT, SESSION_DIR)); // сессию удалили из списка — и заметку
    } catch (error) {
        console.error(`Не удалось собрать карту проекта в vault: ${error.message}`);
    }
    rebuildSearchIndex(); // индекс строим и при частичной карте: поиск лучше устаревшего ничего
    if (clients.size) notifyClients('map');
}

// frontmatter заметки: только простые «ключ: значение», без вложенности —
// ровно то, что пишет writeNote
function readFrontmatter(text) {
    const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!match) return {};
    const meta = {};
    for (const line of match[1].split(/\r?\n/)) {
        const pair = line.match(/^([a-z_]+):\s*(.*)$/i);
        if (pair) meta[pair[1]] = pair[2];
    }
    return meta;
}

function buildVaultGraph() {
    if (!fs.existsSync(VAULT)) return { ok: false, error: `Vault не найден: ${VAULT}` };

    const paths = collectNotes(VAULT, VAULT);

    // ссылку ищем сначала по полному пути — так одноимённые файлы из разных папок
    // остаются разными узлами. по короткому имени резолвим только то, что однозначно:
    // именно так ведёт себя и сам Obsidian, требуя путь при совпадении имён
    const byPath = new Map(paths.map((note) => [note.toLowerCase(), note]));
    const byName = new Map();
    const ambiguous = new Set();
    for (const note of paths) {
        const name = path.basename(note, '.md').toLowerCase();
        if (byName.has(name)) ambiguous.add(name);
        byName.set(name, note);
    }
    for (const name of ambiguous) byName.delete(name);

    function resolveLink(raw) {
        const link = raw.trim().replace(/\.md$/i, '');
        return byPath.get(`${link.toLowerCase()}.md`) || byName.get(path.basename(link).toLowerCase());
    }

    const notes = [];
    const links = new Set();
    for (const note of paths) {
        let text;
        try {
            text = fs.readFileSync(path.join(VAULT, note), 'utf8');
        } catch {
            continue; // заметку удалили между обходом и чтением
        }

        const meta = readFrontmatter(text);
        notes.push({
            path: note,
            kind: meta.kind || 'note', // написанные руками заметки без frontmatter
            file: meta.file,
            line: meta.line ? Number(meta.line) : undefined,
            route: meta.route,
            date: meta.date,
            group: note.split('/')[0],
        });

        // из [[Имя|подпись#заголовок]] нужна только часть до | # ^
        for (const match of text.matchAll(/\[\[([^\]|#^]+)/g)) {
            const target = resolveLink(match[1]);
            // пара нормализуется: заметка ссылается на родителя, родитель — на неё,
            // но в графе это одно ребро
            if (target && target !== note) links.add(JSON.stringify([note, target].sort()));
        }
    }

    return {
        ok: true,
        vault: path.basename(VAULT),
        notes,
        links: [...links].map((pair) => JSON.parse(pair)),
    };
}

// ---------- память о сессиях ----------

// заметки сессий лежат вне MAP_DIR и потому переживают пересборку карты.
// это память: её не сносим даже при сбросе списка сессий
const EDITING_TOOLS = /^(Edit|Write|NotebookEdit) (.+)$/;

// тема сессии: режим комментариев кладёт в вопрос «Элемент интерфейса… Комментарий: …»,
// и настоящее намерение — именно текст комментария
function extractTitle(raw, maxLen) {
    const text = String(raw || '').trim();
    const comment = text.match(/Комментарий:\s*([\s\S]+)/);
    const line = (comment ? comment[1] : text).split(/\r?\n/)[0].trim();
    return line.slice(0, maxLen) || 'Без темы';
}

function sessionTitle(session) {
    return extractTitle(session.title, 80);
}

function sessionNote(session) {
    const date = String(session.updatedAt || '').slice(0, 10);
    return noteName(`${date} ${sessionTitle(session)} ${String(session.id).slice(0, 8)}`);
}

function syncSessionNotes() {
    const files = projectFiles();
    const byName = new Map();
    for (const file of files) byName.set(path.basename(file).toLowerCase(), file);

    const noteDir = path.join(VAULT, SESSION_DIR);
    for (const session of listSessions.all()) {
        const messages = listMessages.all(session.id);
        const spoken = messages.filter((m) => m.role === 'user' || m.role === 'assistant');
        const touched = new Set();
        for (const message of messages) {
            if (message.role !== 'tool') continue;
            const edit = message.text.match(EDITING_TOOLS);
            const target = edit && byName.get(path.basename(edit[2]).toLowerCase());
            if (target) touched.add(target);
        }

        // оборванные сессии без ответа и без правок памяти не заслуживают
        if (!spoken.some((m) => m.role === 'assistant') && !touched.size) continue;

        // сессия устарела, если затронутые файлы правились уже после неё —
        // иначе прошлое решение читалось бы как актуальное
        const when = Date.parse(session.updatedAt) || 0;
        const changed = [...touched].filter((file) => {
            try {
                return fs.statSync(path.join(ROOT, file)).mtimeMs > when + 60_000;
            } catch {
                return false;
            }
        });

        const answer = [...spoken].reverse().find((m) => m.role === 'assistant');
        writeNote(path.join(noteDir, `${sessionNote(session)}.md`), {
            kind: 'session',
            date: String(session.updatedAt || '').slice(0, 10),
            messages: session.messageCount,
            stale: changed.length ? 'true' : undefined,
        }, [
            ...(changed.length ? [`⚠ После этой сессии менялись: ${changed.join(', ')}`, ''] : []),
            `## Что просили`,
            sessionTitle(session),
            '',
            ...section('Чем закончилось', answer ? [answer.text.split(/\r?\n\r?\n/)[0].slice(0, 400)] : []),
            ...section('Файлы', [...touched].sort().map((file) => `- [[${MAP_DIR}/${file}]]`)),
        ]);
    }
}

// ---------- поиск по проекту (FTS5) ----------

// индекс — производный кэш, его можно удалить и пересобрать, поэтому он живёт
// отдельно от .sessions.db, где переписка существует в единственном экземпляре.
// имя с точки: snapshot() такие пропускает, и запись в базу не вызовет перезагрузку
const INDEX_FILE = path.join(ROOT, '.index.db');
const searchDb = new DatabaseSync(INDEX_FILE);
searchDb.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');

// unicode61 нужен для кириллицы, prefix — чтобы работал поиск по началу слова
searchDb.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS docs USING fts5(
        kind UNINDEXED,
        ref  UNINDEXED,
        title,
        body,
        tokenize = 'unicode61 remove_diacritics 2',
        prefix = '2 3'
    );
`);

const insertDoc = searchDb.prepare('INSERT INTO docs(kind, ref, title, body) VALUES (?, ?, ?, ?)');

// сырой ввод в MATCH роняет запрос («fts5: syntax error near "."»), поэтому каждое
// слово оборачиваем в кавычки, а последнему разрешаем префиксный поиск
function ftsQuery(raw) {
    const terms = String(raw || '')
        .split(/\s+/)
        .filter(Boolean)
        .map((term) => `"${term.replace(/"/g, '""')}"`);
    if (!terms.length) return '';
    terms[terms.length - 1] += '*';
    return terms.join(' ');
}

// индекс собираем целиком: весь проект — сотни килобайт, полная пересборка
// занимает единицы миллисекунд, инкрементальность тут не окупается
function rebuildSearchIndex() {
    searchDb.exec('BEGIN');
    try {
        searchDb.exec('DELETE FROM docs');

        // код: крупные файлы режем по секциям, чтобы попадание указывало на узел графа
        for (const file of projectFiles()) {
            if (!TEXT_FILES.test(file)) continue;
            const text = readText(file);
            if (!text) continue;

            const units = parseUnits(file, text).filter((unit) => unit.kind === 'section');
            if (units.length) {
                for (const unit of units) insertDoc.run('code', unit.note, `${file} › ${unit.title}`, unit.body);
            } else {
                insertDoc.run('code', `${MAP_DIR}/${file}`, file, text);
            }
        }

        // заметки vault: и сгенерированные, и написанные руками
        for (const note of collectNotes(VAULT, VAULT)) {
            const text = readText(path.join(VAULT_DIR, note)) || safeRead(path.join(VAULT, note));
            if (text) insertDoc.run('note', note.replace(/\.md$/, ''), note, text);
        }

        // сессии: только человеческая часть переписки. вывод инструментов — это
        // 1500 строк вида «Read index.html», в поиске от них один шум
        for (const session of listSessions.all()) {
            const messages = listMessages.all(session.id).filter((m) => m.role === 'user' || m.role === 'assistant');
            if (!messages.length) continue;
            insertDoc.run(
                'session',
                `${SESSION_DIR}/${sessionNote(session)}`,
                sessionTitle(session),
                messages.map((m) => m.text).join('\n\n'),
            );
        }

        searchDb.exec('COMMIT');
    } catch (error) {
        searchDb.exec('ROLLBACK');
        console.error(`Не удалось собрать поисковый индекс: ${error.message}`);
    }
}

function safeRead(file) {
    try {
        return fs.readFileSync(file, 'utf8');
    } catch {
        return '';
    }
}

function searchProject(query, limit = 20) {
    const match = ftsQuery(query);
    if (!match) return { ok: true, hits: [] };
    try {
        // веса по колонкам: совпадение в заголовке важнее, чем в теле
        const hits = searchDb.prepare(`
            SELECT kind, ref, title, snippet(docs, 3, '«', '»', '…', 12) AS snippet
            FROM docs WHERE docs MATCH ? ORDER BY bm25(docs, 0, 0, 10.0, 1.0) LIMIT ?
        `).all(match, Math.min(Number(limit) || 20, 100));
        return { ok: true, hits };
    } catch (error) {
        return { ok: false, error: `Не удалось выполнить поиск: ${error.message}` };
    }
}

// ---------- чтение и правка файла из графа ----------

// узел графа открывается в окне с содержимым, поэтому нужен доступ к самому файлу.
// путь приходит от клиента — проверяем его так же, как при раздаче статики
const MAX_EDIT_BYTES = 2 * 1024 * 1024; // больше в textarea всё равно не отредактировать

// сравнивать надо реальные пути: символическая ссылка внутри проекта указывала бы
// наружу, а обычная склейка строк этого не заметила бы
const ROOT_REAL = fs.realpathSync(ROOT);

function resolveInsideRoot(relative) {
    const candidate = path.resolve(ROOT_REAL, String(relative || ''));
    let real;
    try {
        real = fs.realpathSync(candidate);
    } catch {
        // файла может не быть — тогда проверяем папку, в которой он должен лежать
        try {
            real = path.join(fs.realpathSync(path.dirname(candidate)), path.basename(candidate));
        } catch {
            return null;
        }
    }
    return real === ROOT_REAL || real.startsWith(ROOT_REAL + path.sep) ? real : null;
}

function readProjectFile(relative) {
    const full = resolveInsideRoot(relative);
    if (!full) return { ok: false, error: 'Путь за пределами проекта' };

    let stat;
    try {
        stat = fs.statSync(full);
    } catch {
        return { ok: false, error: `Файл не найден: ${relative}` };
    }
    if (stat.isDirectory()) return { ok: false, error: 'Это папка, а не файл' };

    const rel = path.relative(ROOT_REAL, full).split(path.sep).join('/');
    if (!TEXT_FILES.test(rel)) {
        return { ok: true, path: rel, binary: true, size: stat.size, editable: false };
    }
    if (stat.size > MAX_EDIT_BYTES) {
        return { ok: true, path: rel, binary: true, size: stat.size, editable: false, note: 'Файл слишком велик для правки' };
    }

    // заметки vault генерируются заново при каждой пересборке: править их бессмысленно,
    // правка исчезнет через несколько секунд
    const generated = rel.startsWith(`${VAULT_DIR}/`);
    return {
        ok: true,
        path: rel,
        text: fs.readFileSync(full, 'utf8'),
        size: stat.size,
        editable: !generated,
        note: generated ? 'Заметка собирается сервером — правки затрутся при следующей пересборке' : undefined,
    };
}

function writeProjectFile(relative, text) {
    const full = resolveInsideRoot(relative);
    if (!full) return { ok: false, error: 'Путь за пределами проекта' };

    const rel = path.relative(ROOT_REAL, full).split(path.sep).join('/');
    if (rel.startsWith(`${VAULT_DIR}/`)) return { ok: false, error: 'Заметки vault пересобираются автоматически' };
    if (!TEXT_FILES.test(rel)) return { ok: false, error: 'Двоичные файлы не редактируются' };
    if (!fs.existsSync(full)) return { ok: false, error: `Файл не найден: ${rel}` };
    if (typeof text !== 'string') return { ok: false, error: 'Нет текста для записи' };

    try {
        fs.writeFileSync(full, text);
    } catch (error) {
        return { ok: false, error: `Не удалось записать файл: ${error.message}` };
    }
    return { ok: true, path: rel, size: Buffer.byteLength(text) };
}

// ---------- API коннектора ----------

// снимок экрана для миниатюры сессии: canvas на фронтенде не видит ничего
// за пределами вкладки браузера, поэтому реальный скриншот системы делает
// сервер — PowerShell копирует экран через System.Drawing и сохраняет JPEG во
// временный файл, который потом сам читает и кодирует в base64 Node. Раньше
// кодировали в base64 прямо в PowerShell через ImageCodecInfo/EncoderParameters
// (ручной контроль quality) — эта связка «скриншот экрана + ручное JPEG-
// кодирование» ловится антивирусом как эвристика скрин-скрейпинга
// (ScriptContainedMaliciousContent) и скрипт блокируется целиком. Save(path,
// ImageFormat.Jpeg) без EncoderParameters под ту же эвристику не попадает.
// Ширину держим заметно больше старых 192px, чтобы миниатюру можно было
// разобрать, не оставляя мыло. 'powershell.exe' с расширением, а не
// 'powershell': под WSL это тот же самый Windows-хост, но interop ищет
// исполняемый файл по точному имени с .exe — без расширения Linux не найдёт
// его в PATH. На нативном Windows работает так же
const SCREENSHOT_WIDTH = 480;

function captureScreenshot() {
    const tmpFile = path.join(os.tmpdir(), `noname-shot-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`);
    const script = `
        Add-Type -AssemblyName System.Windows.Forms
        Add-Type -AssemblyName System.Drawing
        $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
        $full = New-Object System.Drawing.Bitmap $b.Width, $b.Height
        $g = [System.Drawing.Graphics]::FromImage($full)
        $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
        $w = ${SCREENSHOT_WIDTH}
        $h = [Math]::Max(1, [int]([double]$b.Height / $b.Width * $w))
        $thumb = New-Object System.Drawing.Bitmap $full, $w, $h
        $thumb.Save('${tmpFile.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Jpeg)
    `;
    const encoded = Buffer.from(script, 'utf16le').toString('base64');

    return new Promise((resolve) => {
        const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true });
        child.on('error', () => resolve(null));
        child.on('close', (code) => {
            if (code !== 0 || !fs.existsSync(tmpFile)) {
                resolve(null);
                return;
            }
            try {
                const base64 = fs.readFileSync(tmpFile).toString('base64');
                resolve(base64 ? `data:image/jpeg;base64,${base64}` : null);
            } catch {
                resolve(null);
            } finally {
                fs.unlink(tmpFile, () => {});
            }
        });
    });
}

function sendJson(res, payload, status = 200) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
    });
    res.end(body);
}

async function handleApi(req, res, urlPath) {
    if (req.method !== 'POST') {
        sendJson(res, { ok: false, error: 'Ожидается POST' }, 405);
        return;
    }

    try {
        if (urlPath === '/api/claude/detect') {
            sendJson(res, { installs: await detectInstalls() });
            return;
        }

        if (urlPath === '/api/claude/connect') {
            const { id } = await readJson(req);
            const target = TARGETS.find((t) => t.id === id);
            if (!target) {
                sendJson(res, { ok: false, error: `Неизвестное окружение: ${id}` });
                return;
            }

            const version = parseVersion(await runClaude(target, ['--version'], { timeoutMs: 15000 }));
            activeTarget = target;
            sendJson(res, { ok: true, id: target.id, label: target.label, version });
            return;
        }

        if (urlPath === '/api/claude/stop') {
            const { sessionId } = await readJson(req);
            sendJson(res, { ok: true, stopped: stopActiveRun(sessionId || null) });
            return;
        }

        // вызывается PreToolUse-хуком (.claude/hooks/file-lock.js) прямо перед
        // Edit/Write/NotebookEdit — может держать ответ до минуты, пока файл не освободится
        if (urlPath === '/api/claude/lock-check') {
            const { file, sessionId } = await readJson(req);
            if (!file) {
                sendJson(res, { ok: false, reason: 'Не указан файл' });
                return;
            }
            const result = await checkFileLock(file, sessionId || null);
            console.log(`[lock-check] ${path.basename(file)}: ${result.ok ? 'свободен' : 'занят — ' + result.reason}`);
            sendJson(res, result);
            return;
        }

        if (urlPath === '/api/claude/ask') {
            const body = await readJson(req);
            res.writeHead(200, {
                'Content-Type': 'application/x-ndjson; charset=utf-8',
                'Cache-Control': 'no-store',
            });
            // вкладку могли перезагрузить или закрыть — работа CLI продолжается,
            // ответ всё равно попадёт в базу, мы лишь перестаём писать в мёртвый сокет
            let open = true;
            req.on('close', () => { open = false; });

            await askClaude(body, (event) => {
                if (open) res.write(JSON.stringify(event) + '\n');
            });
            if (open) res.end();
            return;
        }

        if (urlPath === '/api/obsidian/graph') {
            sendJson(res, buildVaultGraph());
            return;
        }

        if (urlPath === '/api/file/read') {
            const { path: target } = await readJson(req);
            sendJson(res, readProjectFile(target));
            return;
        }

        if (urlPath === '/api/file/write') {
            // в теле идёт весь файл целиком: index.html один весит больше
            // стандартного лимита readJson, поэтому лимит здесь свой
            const { path: target, text } = await readJson(req, MAX_EDIT_BYTES + 100_000);
            sendJson(res, writeProjectFile(target, text));
            return;
        }

        if (urlPath === '/api/search') {
            const { q, limit } = await readJson(req);
            sendJson(res, searchProject(q, limit));
            return;
        }

        if (urlPath === '/api/sessions') {
            // тему чистим на выдаче, а не только при записи: так короткий заголовок
            // получают и сессии, заведённые до этого правила — миграция базы не нужна
            const sessions = listSessions.all().map((session) => ({
                ...session,
                title: sessionTitle(session),
                running: runs.has(session.id),
            }));
            sendJson(res, { ok: true, sessions, queued: waitingCount });
            return;
        }

        if (urlPath === '/api/sessions/reset') {
            resetSessions();
            scheduleMapUpdate(); // список опустел — уберём и заметки о сессиях
            sendJson(res, { ok: true });
            return;
        }

        // удаление одной сессии из списка. работающую не трогаем: её запрос
        // ещё допишет в базу ответ, и строка воскреснет наполовину пустой
        if (urlPath === '/api/sessions/delete') {
            const { id } = await readJson(req);
            if (!id) {
                sendJson(res, { ok: false, error: 'Не указана сессия' });
                return;
            }
            if (runs.has(id)) {
                sendJson(res, { ok: false, error: 'Сессия ещё выполняется' });
                return;
            }
            deleteSession(id);
            scheduleMapUpdate(); // заметка удалённой сессии тоже должна уйти
            sendJson(res, { ok: true });
            return;
        }

        if (urlPath === '/api/sessions/attach') {
            const { id } = await readJson(req);
            const listeners = runs.get(id);
            if (!listeners) {
                sendJson(res, { ok: true, running: false });
                return;
            }

            res.writeHead(200, {
                'Content-Type': 'application/x-ndjson; charset=utf-8',
                'Cache-Control': 'no-store',
            });
            listeners.add(res);
            req.on('close', () => listeners.delete(res));
            return; // ответ закроется, когда закончится работа
        }

        // снимок экрана из режима Edit: клиент попросил его сразу после отправки
        // комментария, пока выбранный элемент ещё обведён рамкой
        if (urlPath === '/api/screenshot') {
            const thumb = await captureScreenshot();
            if (!thumb) {
                sendJson(res, { ok: false, error: 'Не удалось сделать скриншот' });
                return;
            }
            sendJson(res, { ok: true, thumb });
            return;
        }

        // превью элемента, к которому был оставлен комментарий из режима Edit —
        // приходит уже готовой data URL (скриншот системы либо клиентский снимок)
        if (urlPath === '/api/sessions/thumb') {
            const { id, thumb } = await readJson(req);
            const MAX_THUMB_BYTES = 300 * 1024;
            // строгий формат data-URL: только base64, без пробелов, кавычек и скобок —
            // это то, что реально отдаёт canvas.toDataURL, и ничего сверх этого
            const THUMB_RE = /^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/]+=*$/;
            if (!id || typeof thumb !== 'string' || thumb.length > MAX_THUMB_BYTES || !THUMB_RE.test(thumb)) {
                sendJson(res, { ok: false, error: 'Некорректное превью' });
                return;
            }
            setSessionThumb.run(thumb, id);
            sendJson(res, { ok: true });
            return;
        }

        if (urlPath === '/api/sessions/messages') {
            const { id } = await readJson(req);
            sendJson(res, { ok: true, messages: listMessages.all(id) });
            return;
        }

        sendJson(res, { ok: false, error: 'Неизвестный эндпоинт' }, 404);
    } catch (err) {
        sendJson(res, { ok: false, error: err.message });
    }
}

// ---------- сервер ----------

// сервер запускает локальный CLI, поэтому обслуживаем только запросы с этой машины
function isLocalRequest(req) {
    const address = req.socket.remoteAddress || '';
    return address === '127.0.0.1'
        || address === '::1'
        || address === '::ffff:127.0.0.1'
        || address.startsWith('127.');
}

const server = http.createServer((req, res) => {
    if (!isLocalRequest(req)) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('403 Forbidden: сервер отвечает только на локальные запросы');
        return;
    }

    const urlPath = decodeURIComponent(new URL(req.url, `http://${req.headers.host}`).pathname);

    if (LIVE_RELOAD && urlPath === '/__reload') {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
        });
        res.write('retry: 1000\n\n');
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
    }

    if (urlPath.startsWith('/api/')) {
        handleApi(req, res, urlPath);
        return;
    }

    const filePath = path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath);

    // не выпускаем запросы за пределы каталога проекта
    if (!filePath.startsWith(ROOT + path.sep)) {
        res.writeHead(403).end('403 Forbidden');
        return;
    }

    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
            return;
        }

        const ext = path.extname(filePath).toLowerCase();
        let body = data;

        if (ext === '.html') {
            let html = data.toString('utf8')
                .replace('{{APP_VERSION}}', currentVersion())
                .replace('{{VERSION_LIST}}', versionHistory());
            if (LIVE_RELOAD) {
                html = html.includes('</body>')
                    ? html.replace('</body>', `${RELOAD_SNIPPET}</body>`)
                    : html + RELOAD_SNIPPET;
            }
            body = Buffer.from(html, 'utf8');
        }

        res.writeHead(200, {
            'Content-Type': MIME[ext] || 'application/octet-stream',
            'Cache-Control': 'no-store',
        });
        res.end(body);
    });
});

// порт ровно один — тот, что записан в .env. соседние не пробуем: вторая копия
// сервера на той же папке дерётся за .sessions.db и .index.db («database is locked»)
// и вслепую перезаписывает vault/
server.on('error', (err) => {
    if (err.code !== 'EADDRINUSE') throw err;
    console.error(`Порт ${PORT} занят — скорее всего, сервер уже запущен: http://localhost:${PORT}`);
    console.error('Другой порт задаётся строкой PORT= в .env');
    process.exit(1);
});

server.listen(PORT, () => {
    console.log(`Сервер запущен: http://localhost:${PORT}`);
    prepareVault();
    if (LIVE_RELOAD) {
        watchFiles();
        console.log('Автообновление включено — страница перезагрузится после сохранения файла.');
    }
});
