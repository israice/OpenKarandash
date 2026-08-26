const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;
const LIVE_RELOAD = process.env.NO_RELOAD !== '1';
const MAX_PORT_ATTEMPTS = 10; // сколько соседних портов пробуем при занятости PORT
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
        source.onmessage = reload;
        // связь восстановилась после перезапуска сервера — берём свежую страницу
        source.onopen = () => { if (lost) reload(); };
        source.onerror = () => { lost = true; source.close(); setTimeout(connect, 500); };
    }

    connect();
})();
</script>
`;

const clients = new Set();

function notifyClients() {
    for (const res of clients) res.write('data: reload\n\n');
}

// fs.watch не даёт событий на некоторых ФС (диски Windows в WSL, сетевые шары),
// поэтому следим за временем изменения файлов опросом — работает везде
const SKIP = new Set(['node_modules', '.git', 'graphify-out']);
const GRAPH_DEBOUNCE_MS = 3000; // правки идут пачками — пересобираем граф после паузы

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

// карта проекта для сессий: после правок пересобираем граф graphify.
// это AST-разбор, без обращений к модели, поэтому дёшево и быстро
let graphTimer = null;
let graphBusy = false;

function scheduleGraphUpdate() {
    if (graphTimer) clearTimeout(graphTimer);
    graphTimer = setTimeout(updateGraph, GRAPH_DEBOUNCE_MS);
}

function updateGraph() {
    graphTimer = null;

    // Claude ещё правит файлы — пересоберём, когда закончит
    if (running > 0 || graphBusy) {
        scheduleGraphUpdate();
        return;
    }

    graphBusy = true;
    const child = spawn('graphify', ['update', '.'], { cwd: ROOT, stdio: 'ignore', windowsHide: true });
    child.on('error', () => { graphBusy = false; }); // graphify не установлен — молча пропускаем
    child.on('close', () => { graphBusy = false; });
}

function watchFiles() {
    let previous = snapshot(ROOT);

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
        if (!changed) return;

        if (clients.size > 0) notifyClients();
        scheduleGraphUpdate();
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
    const detail = input.file_path ? path.basename(input.file_path)
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

const listSessions = db.prepare(`
    SELECT s.id, s.title, s.updated_at AS updatedAt,
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
    upsertSession.run(sessionId, question.slice(0, 120), new Date().toISOString());
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

        if (urlPath === '/api/sessions') {
            const sessions = listSessions.all().map((session) => ({
                ...session,
                running: runs.has(session.id),
            }));
            sendJson(res, { ok: true, sessions, queued: waitingCount });
            return;
        }

        if (urlPath === '/api/sessions/reset') {
            resetSessions();
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

        if (LIVE_RELOAD && ext === '.html') {
            const html = data.toString('utf8');
            body = Buffer.from(
                html.includes('</body>')
                    ? html.replace('</body>', `${RELOAD_SNIPPET}</body>`)
                    : html + RELOAD_SNIPPET,
                'utf8'
            );
        }

        res.writeHead(200, {
            'Content-Type': MIME[ext] || 'application/octet-stream',
            'Cache-Control': 'no-store',
        });
        res.end(body);
    });
});

// если порт не задан явно, при занятости пробуем следующий
const PORT_FIXED = Boolean(process.env.PORT);
let port = PORT;

server.on('error', (err) => {
    if (err.code !== 'EADDRINUSE') throw err;

    if (PORT_FIXED) {
        console.error(`Порт ${port} занят. Укажите другой:`);
        console.error(`  PowerShell: $env:PORT=8123; node server.js`);
        console.error(`  bash:       PORT=8123 node server.js`);
        process.exit(1);
    }

    if (port - PORT >= MAX_PORT_ATTEMPTS) {
        console.error(`Порты ${PORT}-${port} заняты. Укажите свободный явно.`);
        process.exit(1);
    }

    console.log(`Порт ${port} занят, пробую ${port + 1}...`);
    server.listen(++port);
});

server.listen(port, () => {
    console.log(`Сервер запущен: http://localhost:${port}`);
    // читает PreToolUse-хук (.claude/hooks/file-lock.js), чтобы найти /api/claude/lock-check.
    // имя начинается с точки, поэтому слежение за файлами (snapshot()) его игнорирует
    fs.writeFileSync(path.join(ROOT, '.server-port'), String(port));
    if (LIVE_RELOAD) {
        watchFiles();
        console.log('Автообновление включено — страница перезагрузится после сохранения файла.');
    }
});
