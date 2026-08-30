const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
// серверная половина кнопки Edit — вся кнопка живёт в PROJECTS/Edit
const { captureScreenshot, listScreens } = require('./PROJECTS/Edit/screenshot.js');
const graph = require('./PROJECTS/Graph/graph-server.js');

const ROOT = __dirname;

// ---------- .env: единственное место для порта и секретов ----------
// файла нет — создаём его с портом 3001 и на нём же поднимаемся. значения из .env
// не перетирают то, что уже задано в окружении: так `PORT=3999 node server.js`
// (смоук поднимает сервер на свободном порту) продолжает работать
const ENV_FILE = path.join(ROOT, '.env');

const ENV_TEMPLATE = `# Настройки и секреты проекта. В git не попадает — правьте прямо здесь.
PORT=3001
# Экран, с которого кнопка Edit снимает скриншот (индекс в списке мониторов,
# считая с нуля) — меняется также из Settings в интерфейсе
SCREENSHOT_SCREEN=0

# Путь к CLI Claude, если его нет в PATH
# CLAUDE_BIN=
# Внешний Obsidian-vault вместо папки DATA/vault/ внутри проекта
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

// правит значение прямо в .env (или дописывает строку, если её ещё нет) —
// используется настройкой экрана для скриншотов из Settings
function setEnvValue(key, value) {
    process.env[key] = value;
    const lines = fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/);
    const re = new RegExp(`^\\s*${key}\\s*=`);
    const line = `${key}=${value}`;
    const i = lines.findIndex((l) => re.test(l));
    if (i >= 0) lines[i] = line;
    else lines.push(line);
    fs.writeFileSync(ENV_FILE, lines.join('\n'), 'utf8');
}

const DEFAULT_VIEW_OPTIONS = ['graph', 'flow', 'kanban', 'chat', 'home']; // ключи App.VIEWS, доступные для вкладки по умолчанию

const PORT = Number(process.env.PORT) || 3001;
const LIVE_RELOAD = process.env.NO_RELOAD !== '1';
const POLL_MS = 400; // как часто сверяем время изменения файлов
const EXIT_PORT_BUSY = 3; // код выхода дочернего процесса, по которому сторож уходит следом

// ---------- перезапуск при изменении самого server.js ----------
// Node читает файл один раз при старте, поэтому сервер работает в дочернем процессе,
// а родительский следит за server.js и поднимает дочерний заново после правок
if (LIVE_RELOAD && !process.env.SERVER_CHILD) {
    let child = null;
    let restarting = false;
    let busy = false;          // дочерний процесс сейчас ведёт запрос к Claude
    let waiting = false;       // файл изменился, но перезапуск отложен до конца запроса

    // server.js подключает через require и серверные модули вне себя самого
    // (например PROJECTS/Edit/screenshot.js) — их правки тоже должны рестартовать
    // сервер, иначе Node продолжает работать со старой версией из памяти
    const WATCHED_FILES = [
        __filename,
        path.join(ROOT, 'PROJECTS/Edit/screenshot.js'),
        path.join(ROOT, 'PROJECTS/Graph/graph-server.js'),
    ];

    // сломанная правка не должна ронять сторожа вместе с сервером:
    // файл с синтаксической ошибкой не запускаем, старый процесс продолжает работать
    const isValid = () => {
        try {
            for (const file of WATCHED_FILES) execFileSync(process.execPath, ['--check', file], { stdio: 'ignore' });
            return true;
        } catch {
            console.error('один из файлов сервера не парсится — оставляю работать прежнюю версию');
            return false;
        }
    };

    const restart = () => {
        waiting = false;
        if (!isValid()) return; // починят файл — mtime изменится, и мы придём сюда снова
        console.log('файл сервера изменён — перезапускаю сервер...');
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
            // порт занят: правкой server.js это не лечится, ждать нечего. иначе сторож
            // жил бы вечно — крутил опрос файлов и держал cwd проекта, из-за чего папку
            // проекта нельзя переименовать, пока процесс не убьют вручную
            if (code === EXIT_PORT_BUSY) process.exit(EXIT_PORT_BUSY);
            // упал сам (например, ошибка в коде): сторож остаётся жив и поднимет
            // сервер, как только server.js поправят — иначе чинить было бы нечем
            console.error(`сервер упал (код ${code}) — жду исправления server.js`);
        });
    };

    const latestMtime = () => Math.max(...WATCHED_FILES.map((file) => fs.statSync(file).mtimeMs));
    let mtime = latestMtime();

    setInterval(() => {
        let current;
        try {
            current = latestMtime();
        } catch {
            return;
        }
        if (current === mtime) return;

        mtime = current;

        if (busy) {
            if (!waiting) console.log('файл сервера изменён — перезапущу после текущего запроса');
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
const { DATA_DIR } = graph; // 'DATA': папку заводит модуль графа при загрузке
// DATA целиком: vault переписывается при каждой пересборке, и сторож гонял бы
// страницу по кругу — правка → пересборка → правка
const SKIP = new Set(['node_modules', '.git', DATA_DIR]);

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
    // как и в stopActiveRun
    const caller = (sessionId && all.find((r) => r.sessionId === sessionId))
        || all.filter((r) => !r.sessionId).pop()
        || null;

    // не наш запуск (интерактивная сессия в терминале, другой инструмент) — очередь
    // панели Sessions его не касается: ждать 85 секунд и получить отказ он не должен
    if (!caller) return { ok: true };

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
    // цель фиксируем на весь запуск: пока идёт работа, в настройках могли переключить CLI
    const target = activeTarget;
    if (!prompt) return send({ type: 'error', error: 'Пустой запрос' });
    if (model && !CLAUDE_MODELS.includes(model)) {
        return send({ type: 'error', error: `Неизвестная модель: ${model}` });
    }
    if (effort && !EFFORT_LEVELS.includes(effort)) {
        return send({ type: 'error', error: `Неизвестный уровень effort: ${effort}` });
    }

    // история сессий у каждого CLI своя (~/.claude/projects/<путь проекта>), а путь
    // к проекту у Windows и WSL разный (C:\... и /mnt/c/...) — «--resume» чужого id
    // всё равно вернёт ошибку CLI, поэтому объясняем причину сразу
    const owner = sessionId ? getSessionTarget.get(sessionId)?.target : null;
    if (owner && owner !== target.id) {
        const label = TARGETS.find((t) => t.id === owner)?.label || owner;
        return send({ type: 'error', error: `Сессия начата через ${label} — продолжить её можно только тем же CLI` });
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
            startExchange(startedSession, prompt, target.id);
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

            // usage.*_tokens — это состав контекста последнего запроса к модели;
            // ponytail: окно фиксировано в 200k для всех моделей, свои размеры на модель — потом
            const u = event.usage;
            if (u) {
                const used = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
                const percent = Math.min(100, Math.round(used / 200000 * 100));
                if (startedSession) setSessionContext.run(percent, startedSession);
                emit({ type: 'context', percent });
            }
        }

        // лимиты подписки (5 часов / 7 дней) CLI присылает сам, на каждый запрос —
        // это те же цифры, что показывает /usage, только уже в JSON
        if (event.type === 'rate_limit_event') {
            emit({ type: 'rate_limit', info: event.rate_limit_info });
        }
    };

    try {
        const input = mode === 'Chat' ? CHAT_PREAMBLE + prompt : prompt;
        await runClaude(target, args, {
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

// база лежит в DATA, а эту папку слежение за файлами не обходит,
// поэтому правки базы не вызывают перезагрузку страницы
const DB_FILE = path.join(ROOT, DATA_DIR, '.sessions.db');
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

try {
    db.exec('ALTER TABLE sessions ADD COLUMN context_percent INTEGER');
} catch { /* колонка уже есть */ }

// каким CLI начата сессия: у Windows-claude и WSL-claude свои хранилища истории
// (~/.claude/projects/<путь проекта>, а путь к проекту у них разный), поэтому
// «--resume» чужого id всегда возвращает ошибку — см. askClaude
try {
    db.exec('ALTER TABLE sessions ADD COLUMN target TEXT');
} catch { /* колонка уже есть */ }

// хранилище вкладки Flow (PROJECTS/Flow/flow.js): раньше жило в localStorage
// браузера, теперь — здесь, ключ в ключ с прежними именами localStorage,
// чтобы не переписывать код вокруг чтения/записи каждого поля отдельно
db.exec(`
    CREATE TABLE IF NOT EXISTS flow_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );
`);
const listFlowState = db.prepare('SELECT key, value FROM flow_state');
const setFlowStateRow = db.prepare(`
    INSERT INTO flow_state (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
`);

// страницы, создаваемые кнопкой «+» в тулбаре (SYSTEM/new-button.js) — каждая
// заводит настоящую папку в PROJECTS/ с README.md, чтобы попасть в общий список
// разделов (PROJECTS/Projects/projects-tab.js) наравне со встроенными
db.exec(`
    CREATE TABLE IF NOT EXISTS pages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL
    );
`);
try {
    db.exec("ALTER TABLE pages ADD COLUMN folder TEXT NOT NULL DEFAULT ''");
} catch { /* колонка уже есть */ }
const listPages = db.prepare('SELECT id, title, folder FROM pages ORDER BY id');
const getPage = db.prepare('SELECT folder FROM pages WHERE id = ?');
const insertPage = db.prepare('INSERT INTO pages (title, folder) VALUES (?, ?)');
const deletePage = db.prepare('DELETE FROM pages WHERE id = ?');

// имя папки из заголовка: только буквы/цифры/пробелы/дефисы, без выхода за PROJECTS/
function folderNameFromTitle(title) {
    const base = title.replace(/[\\/:*?"<>|]/g, '').trim() || 'Проект';
    let folder = base;
    let n = 2;
    while (fs.existsSync(path.join(ROOT, 'PROJECTS', folder))) folder = `${base} ${n++}`;
    return folder;
}

const upsertSession = db.prepare(`
    INSERT INTO sessions (id, title, updated_at, target)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at
`);

const getSessionTarget = db.prepare('SELECT target FROM sessions WHERE id = ?');

const upsertMessage = db.prepare(`
    INSERT INTO messages (session_id, position, role, text)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(session_id, position) DO NOTHING
`);

const touchSession = db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?');
const setSessionThumb = db.prepare('UPDATE sessions SET thumb = ? WHERE id = ?');
const setSessionContext = db.prepare('UPDATE sessions SET context_percent = ? WHERE id = ?');
const getSessionContext = db.prepare('SELECT context_percent AS contextPercent FROM sessions WHERE id = ?');

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
function startExchange(sessionId, question, target) {
    upsertSession.run(sessionId, extractTitle(question, 120), new Date().toISOString(), target || null);
    upsertMessage.run(sessionId, countMessages.get(sessionId).n, 'user', question);
}

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

// вся вкладка Graph живёт в PROJECTS/Graph; здесь остаются её точки входа
const {
    prepareVault, buildVaultGraph, searchProject, readProjectFile, writeProjectFile, projectFiles, MAX_EDIT_BYTES,
} = graph.init({
    listSessions,
    listMessages,
    sessionTitle,
    onMapReady: () => { if (clients.size) notifyClients('map'); },
});

// ---------- API коннектора ----------

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
            const thumb = await captureScreenshot(Number(process.env.SCREENSHOT_SCREEN) || 0);
            if (!thumb) {
                sendJson(res, { ok: false, error: 'Не удалось сделать скриншот' });
                return;
            }
            sendJson(res, { ok: true, thumb });
            return;
        }

        // список мониторов и текущий выбор — для настройки в Settings
        if (urlPath === '/api/screenshot/screens') {
            sendJson(res, { screens: await listScreens(), current: Number(process.env.SCREENSHOT_SCREEN) || 0 });
            return;
        }

        if (urlPath === '/api/screenshot/screen') {
            const { index } = await readJson(req);
            if (!Number.isInteger(index) || index < 0) {
                sendJson(res, { ok: false, error: 'Некорректный индекс экрана' });
                return;
            }
            setEnvValue('SCREENSHOT_SCREEN', String(index));
            sendJson(res, { ok: true });
            return;
        }

        // какая вкладка открывается по умолчанию при заходе на страницу — настройка из Settings
        if (urlPath === '/api/default-view') {
            const { view } = await readJson(req);
            if (!DEFAULT_VIEW_OPTIONS.includes(view)) {
                sendJson(res, { ok: false, error: 'Неизвестная вкладка' });
                return;
            }
            setEnvValue('DEFAULT_VIEW', view);
            sendJson(res, { ok: true });
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
            sendJson(res, { ok: true, messages: listMessages.all(id), contextPercent: getSessionContext.get(id)?.contextPercent ?? null });
            return;
        }

        // хранилище вкладки Flow целиком: список пунктов меню, позиции/тексты
        // нод, граф связей, зум/пан каждого канваса — см. flow_state выше
        if (urlPath === '/api/flow/state') {
            const state = {};
            for (const row of listFlowState.all()) {
                try {
                    state[row.key] = JSON.parse(row.value);
                } catch { /* битая строка — пропускаем, лучше потерять одно поле, чем всё */ }
            }
            sendJson(res, { ok: true, state });
            return;
        }

        if (urlPath === '/api/flow/state/set') {
            const { key, value } = await readJson(req);
            if (typeof key !== 'string' || !key) {
                sendJson(res, { ok: false, error: 'Нужен key' });
                return;
            }
            setFlowStateRow.run(key, JSON.stringify(value ?? null));
            sendJson(res, { ok: true });
            return;
        }

        if (urlPath === '/api/pages') {
            sendJson(res, { ok: true, pages: listPages.all() });
            return;
        }

        if (urlPath === '/api/pages/create') {
            const { title } = await readJson(req);
            if (typeof title !== 'string' || !title) {
                sendJson(res, { ok: false, error: 'Нужен title' });
                return;
            }
            const folder = folderNameFromTitle(title);
            fs.mkdirSync(path.join(ROOT, 'PROJECTS', folder), { recursive: true });
            fs.writeFileSync(path.join(ROOT, 'PROJECTS', folder, 'README.md'), `# ${title}\n`, 'utf8');
            const info = insertPage.run(title, folder);
            sendJson(res, { ok: true, id: info.lastInsertRowid, title, folder, readme: `PROJECTS/${folder}/README.md` });
            return;
        }

        if (urlPath === '/api/pages/delete') {
            const { id } = await readJson(req);
            // страница создаётся вместе с настоящей папкой (см. /api/pages/create) —
            // удаляем вместе с ней, иначе на диске остаётся мусор
            const page = getPage.get(id);
            if (page?.folder) fs.rmSync(path.join(ROOT, 'PROJECTS', page.folder), { recursive: true, force: true });
            deletePage.run(id);
            sendJson(res, { ok: true });
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

// адрес из WSL: в виртуалке живёт свой Claude CLI, и его PreToolUse-хук
// (.claude/hooks/file-lock.js) до 127.0.0.1 хоста не достучится — при обычной (NAT)
// сети WSL2 это loopback самой виртуалки. Запрос приходит с адреса на адаптере
// «vEthernet (WSL)» — его и узнаём по маске самого адаптера, а не по зашитой
// подсети: она меняется при каждом перезапуске WSL
function ipToInt(ip) {
    const parts = String(ip).split('.');
    return parts.length === 4 ? parts.reduce((acc, part) => acc * 256 + (Number(part) & 255), 0) : null;
}

function isWslRequest(req) {
    const value = ipToInt((req.socket.remoteAddress || '').replace(/^::ffff:/, ''));
    if (value === null) return false;
    for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
        if (!/WSL/i.test(name)) continue;
        for (const item of addresses || []) {
            if (item.family !== 'IPv4') continue;
            const net = ipToInt(item.address);
            const mask = ipToInt(item.netmask);
            if (net !== null && mask !== null && (value & mask) === (net & mask)) return true;
        }
    }
    return false;
}

const server = http.createServer((req, res) => {
    // из WSL пускаем ровно один маршрут — сверку блокировок для хука.
    // остальное API читает и пишет файлы проекта и запускает CLI — открывать
    // его виртуалке целиком незачем
    if (!isLocalRequest(req)
        && !(isWslRequest(req) && (req.url || '').startsWith('/api/claude/lock-check'))) {
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

    // страница лежит в SYSTEM, но отдаётся по «/»: адреса в браузере от этого не зависят
    const filePath = path.join(ROOT, urlPath === '/' ? 'SYSTEM/index.html' : urlPath);

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
                .replace('{{VERSION_LIST}}', versionHistory())
                .replace('{{DEFAULT_VIEW}}', escapeHtml(process.env.DEFAULT_VIEW || 'home'));
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
    process.exit(EXIT_PORT_BUSY); // отдельный код: по нему сторож понимает, что ждать правок бессмысленно
});

server.listen(PORT, () => {
    console.log(`Сервер запущен: http://localhost:${PORT}`);
    prepareVault();
    if (LIVE_RELOAD) {
        watchFiles();
        console.log('Автообновление включено — страница перезагрузится после сохранения файла.');
    }
});
