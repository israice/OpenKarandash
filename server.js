const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const graph = require('./PROJECTS/Graph/graph-server.js');
const { readJson, escapeHtml, sendJson, sendHtml } = require('./SYSTEM/core/http.js');
const scan = require('./SYSTEM/core/scan.js');
const { reloadEvents } = require('./SYSTEM/core/reload.js');

const ROOT = __dirname;

// ---------- .env: единственное место для порта и секретов ----------
// файла нет — создаём его с портом 3001 и на нём же поднимаемся. значения из .env
// не перетирают то, что уже задано в окружении: так `PORT=3999 node server.js`
// (смоук поднимает сервер на свободном порту) продолжает работать
const ENV_FILE = path.join(ROOT, '.env');

const ENV_TEMPLATE = `# Project settings and secrets. Not tracked by git — edit it right here.
PORT=3001
# The screen the Karandash button captures (index in the monitor list, starting
# from zero) — can also be changed from Settings in the interface
SCREENSHOT_SCREEN=0

# Path to the Claude CLI, if it is not in PATH
# CLAUDE_BIN=
# External Obsidian vault instead of the DATA/vault/ folder inside the project
# OBSIDIAN_VAULT=
`;

function loadEnv() {
    if (!fs.existsSync(ENV_FILE)) {
        fs.writeFileSync(ENV_FILE, ENV_TEMPLATE, 'utf8');
        console.log('Created .env with port 3001 — edit the port and secrets there');
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


// под чем реально запущен процесс — Windows-CLI или WSL: process.platform внутри
// WSL тоже 'linux', поэтому WSL отличаем по WSL_DISTRO_NAME / метке в /proc/version
function detectRuntimePlatform() {
    if (process.platform !== 'linux') return 'Windows';
    if (process.env.WSL_DISTRO_NAME) return `WSL (${process.env.WSL_DISTRO_NAME})`;
    try {
        if (/microsoft/i.test(fs.readFileSync('/proc/version', 'utf8'))) return 'WSL';
    } catch { /* не Linux/WSL — обычный контейнер, например */ }
    return 'Linux';
}

const PORT = Number(process.env.PORT) || 3001;
const LIVE_RELOAD = process.env.NO_RELOAD !== '1';
// ход диалога может уйти в долгую агентную работу (субагенты, Task-цепочки) —
// час по умолчанию вместо прежних жёстких 10 минут; останов всё ещё доступен
// вручную через /api/claude/stop, поэтому большой таймаут тут не риск зависания
const CLAUDE_ASK_TIMEOUT_MS = Number(process.env.CLAUDE_ASK_TIMEOUT_MS) || 3_600_000;
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

    // server.js подключает через require и серверные модули вне себя самого — их
    // правки тоже должны рестартовать сервер, иначе Node продолжает работать со
    // старой версией из памяти. Список собираем по правилам раскладки, а не руками:
    // перечисленный руками отставал от кода (PROJECTS/Chat/pages-server.js и
    // SYSTEM/core/* в нём не было, и правка страниц молча не доезжала до сервера).
    // Новый файл сторож увидит после ручного перезапуска — список читается один раз
    const serverModules = (dir) => {
        try {
            return fs.readdirSync(dir).filter((f) => f.endsWith('-server.js')).map((f) => path.join(dir, f));
        } catch {
            return []; // не папка или её нет — просто нечего смотреть
        }
    };
    const WATCHED_FILES = [
        __filename,
        ...fs.readdirSync(path.join(ROOT, 'PROJECTS')).flatMap((name) => serverModules(path.join(ROOT, 'PROJECTS', name))),
        ...serverModules(path.join(ROOT, 'SYSTEM')),
        ...fs.readdirSync(path.join(ROOT, 'SYSTEM/core')).map((f) => path.join(ROOT, 'SYSTEM/core', f)),
    ];

    // сломанная правка не должна ронять сторожа вместе с сервером:
    // файл с синтаксической ошибкой не запускаем, старый процесс продолжает работать
    const isValid = () => {
        try {
            for (const file of WATCHED_FILES) execFileSync(process.execPath, ['--check', file], { stdio: 'ignore' });
            return true;
        } catch {
            console.error('one of the server files does not parse — keeping the previous version running');
            return false;
        }
    };

    const restart = () => {
        waiting = false;
        if (!isValid()) return; // починят файл — mtime изменится, и мы придём сюда снова
        console.log('server file changed — restarting the server...');
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
            console.error(`server crashed (code ${code}) — waiting for server.js to be fixed`);
        });
    };

    // непрочитанный файл пропускаем, а не бросаем весь замер: раньше на любую
    // ошибку statSync замер падал целиком и опрос молча выходил из строя навсегда.
    // Достаточно было переименовать любой из watched-файлов (screenshot.js →
    // karandash-server.js) — и сервер до конца дня продолжал крутить старый код
    const latestMtime = () => WATCHED_FILES.reduce((max, file) => {
        try {
            return Math.max(max, fs.statSync(file).mtimeMs);
        } catch {
            return max; // файла нет — его правку всё равно поймает соседний
        }
    }, 0);
    let mtime = latestMtime();

    setInterval(() => {
        const current = latestMtime();
        if (current === mtime) return;

        mtime = current;

        if (busy) {
            if (!waiting) console.log('server file changed — will restart after the current request');
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

    // правка .eta трогает ровно один фрагмент — просим htmx перезапросить только его,
    // сохранив состояние остальной страницы. Контейнер ищем по его же hx-get: другого
    // источника этой разметки нет. Не нашли — правка не должна пропасть незамеченной
    function swapFragment(name) {
        const nodes = document.querySelectorAll('[hx-get="/api/fragment/' + name + '"]');
        if (!nodes.length || !window.htmx) { reload(); return; }
        nodes.forEach((node) => window.htmx.ajax('GET', '/api/fragment/' + name, {
            source: node,
            target: node,
            swap: node.getAttribute('hx-swap') || 'none',
        }));
    }

    // css правится чаще всего и перезагрузки не требует вовсе: меняем href у <link>,
    // страница со всем её состоянием остаётся на месте
    function swapStyles(file) {
        let found = false;
        document.querySelectorAll('link[rel="stylesheet"]').forEach((link) => {
            if ((link.getAttribute('href') || '').split('?')[0] !== file) return;
            found = true;
            link.setAttribute('href', file + '?v=' + Date.now());
        });
        if (!found) reload();
    }

    function connect() {
        source = new EventSource('/__reload');
        source.onmessage = (event) => {
            const data = event.data;
            // карта пересобирается позже самой правки, поэтому у неё своё событие:
            // страницу перезагружать незачем, достаточно перерисовать граф
            if (data === 'map') { window.__onMapUpdate && window.__onMapUpdate(); return; }
            // точечные события: обновляем один фрагмент или одну таблицу стилей.
            // hold здесь не смотрим — в отличие от перезагрузки, поток ответа они не рвут
            if (data.startsWith('fragment:')) { swapFragment(data.slice(9)); return; }
            if (data.startsWith('css:')) { swapStyles(data.slice(4)); return; }
            // правка модуля страницы кнопки «+»: пересобираем только её саму.
            // false — такой страницы в интерфейсе нет (переименовали, удалили,
            // список ещё не пришёл), и тогда обычная полная перезагрузка
            if (data.startsWith('page:')) {
                if (!window.MissionPages || !window.MissionPages.rebuildPage(data.slice(5))) reload();
                return;
            }
            reload();
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
const SKIP = new Set([...scan.SKIP_NAMES, DATA_DIR]);

function snapshot(dir, acc = new Map()) {
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return acc; // папку не прочитать — не повод ронять сервер, просто не следим за ней
    }

    for (const entry of entries) {
        if (entry.name.startsWith('.') || SKIP.has(entry.name)) continue;

        const full = path.join(dir, entry.name);
        if (full === __filename) continue; // за server.js следит надзорный процесс

        if (entry.isDirectory()) {
            snapshot(full, acc);
            continue;
        }
        // один нечитаемый файл не должен прекращать обход остальных: битая ссылка,
        // файл занят другим процессом, права — всё это норма посреди рабочей папки
        try {
            acc.set(full, fs.statSync(full).mtimeMs);
        } catch { /* пропускаем — за ним просто не следим */ }
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

        // собираем не флаг, а список правок: по нему решается, хватит ли точечного
        // события. Удаление файла в список не попадает — его видно только по размеру
        const changed = [];
        for (const [file, mtime] of current) {
            if (previous.get(file) !== mtime) changed.push(file);
        }
        const removed = current.size !== previous.size && changed.length === 0;

        previous = current;
        if (changed.length || removed) {
            if (clients.size > 0) {
                for (const event of reloadEvents(ROOT, removed ? null : changed)) notifyClients(event);
            }
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

// Кнопка Stop гасила только тот процесс, который мы породили сами, и этого мало
// в двух случаях: на Windows потомки убитого процесса сигнала не получают и живут
// дальше, а при viaShell мы вообще породили wsl.exe — сам CLI работает внутри
// виртуалки и потомком wsl.exe в понимании Windows не является. Поэтому запуск
// в шелле первым делом сообщает свой PID внутри WSL, и гасим мы всё дерево.
const REMOTE_PID_MARK = '__karandash_pid__';

// `exec` обязателен: без него claude станет потомком bash и $$ укажет не на него
function shellLaunch(command) {
    return `echo ${REMOTE_PID_MARK}$$ >&2; exec ${command}`;
}

// строка с PID идёт в stderr — в текст ошибки её пускать нельзя, поэтому
// вырезаем сразу и запоминаем на процессе-обёртке
function takeRemotePid(child, text) {
    const match = text.match(new RegExp(`${REMOTE_PID_MARK}(\\d+)\\s*`));
    if (!match) return text;
    child.__remotePid = match[1];
    return text.replace(match[0], '');
}

function killProcessTree(child, target) {
    if (target?.viaShell && child.__remotePid) {
        // у виртуалки свой PID-namespace: номер знает только она сама
        spawn(target.cmd, [...target.args, `kill -TERM ${child.__remotePid} 2>/dev/null`], { windowsHide: true })
            .on('error', () => {}); // wsl.exe мог исчезнуть вместе с виртуалкой — гасить уже нечего
    }
    if (process.platform === 'win32' && child.pid) {
        // /T — вместе с потомками, /F — принудительно: сигналов на Windows нет
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
            .on('error', () => {}); // процесс мог завершиться сам, пока мы собирались
    }
    child.kill();
}

// промпт всегда идёт через stdin: так он не попадает в командную строку
// и не требует экранирования, даже когда команда собирается для `bash -lc`
function runClaude(target, cliArgs, { input = '', timeoutMs, onLine, onSpawn } = {}) {
    return new Promise((resolve, reject) => {
        const args = target.viaShell
            ? [...target.args, shellLaunch(['claude', ...cliArgs].join(' '))]
            : [...target.args, ...cliArgs];

        const child = spawn(target.cmd, args, { windowsHide: true });
        onSpawn?.(child);

        let stdout = '';
        let stderr = '';
        let finished = false;

        const timer = setTimeout(() => {
            finished = true;
            killProcessTree(child, target);
            reject(new Error(`Timed out (${Math.round(timeoutMs / 1000)}s)`));
        }, timeoutMs);

        const done = (err, value) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            err ? reject(err) : resolve(value);
        };

        child.on('error', (err) => {
            done(new Error(err.code === 'ENOENT' ? `${target.cmd} not found` : err.message));
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
        child.stderr.on('data', (chunk) => { stderr += takeRemotePid(child, String(chunk)); });

        child.on('close', (code) => {
            if (code === 0) done(null, stdout);
            else done(new Error(child.__stoppedByUser ? 'Stopped by the user' : (stderr.trim() || `CLI exited with code ${code}`)));
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

// ход работы уходит на страницу по мере поступления: id сессии, вызовы
// инструментов и текст ответа. send() пишет по событию в поток ответа
let running = 0;

// сессии работают параллельно: новый ход стартует сразу, не дожидаясь уже идущих,
// и файлы под ним не блокируются. Одновременная правка одного файла двумя агентами
// остаётся на внешнем хуке (.claude/hooks/file-lock.js -> /api/agent/lock-check),
// сервер сам ходы друг от друга не удерживает
const activeRuns = new Map(); // runId -> { sessionId, child, done, target }
let nextRunId = 1;

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
    // не target.child.kill(): при запуске через wsl.exe убитой окажется одна обёртка,
    // а сам CLI внутри виртуалки продолжит работать — из-за этого Stop и «не работал»
    killProcessTree(target.child, target.target);
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

// ---------- общая обвязка хода: одна на все CLI ----------
//
// Коннекторы отличаются ровно двумя вещами: как запустить свой процесс и как
// разобрать его вывод. Всё остальное у хода общее — очередь по одному ходу за раз,
// счётчик занятости (откладывает перезапуск сервера), поток событий
// живым слушателям, запись хода в базу и уборка в finally. Эта общая часть
// живёт здесь, а различия коннектор передаёт функцией drive(ctx).
//
// ctx, который получает drive():
//   begin(cliSessionId)  — открыть ход в базе (startExchange) и объявить сессию
//                          наружу; повторные вызовы игнорируются
//   emit(event)          — событие и отправителю, и подключённым к сессии
//   session              — наш id сессии (null, пока не позвали begin)
//   meta                 — turnMeta хода: usage/cost/stopReason/resultMeta
//   run                  — запись в activeRuns: сюда драйвер кладёт child
//   answer / fail(text)  — итоговый текст ответа и текст ошибки хода
async function runTurn({ target, prompt, sessionId, model, effort, mode }, send, drive) {
    const runId = nextRunId++;
    const run = { sessionId: sessionId || null, child: null, done: null, target };
    let resolveDone;
    run.done = new Promise((resolve) => { resolveDone = resolve; });

    // usage/cost/duration копим по ходу стрима и пишем разом в finishExchange:
    // событие с итогами приходит раньше, чем процесс CLI завершится
    const meta = {
        model: model || null, effort: effort || null, mode: mode || null,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
        costUsd: null, durationMs: null, stopReason: null,
        thinkingTokensPeak: null, resultMeta: null, lastRequestTokens: null,
    };

    const ctx = {
        run, target, meta,
        session: null,
        answer: '',
        errorText: null,
        // позиция последней записанной строки ответа: finishExchange дописывает
        // метаданные хода на неё, а не вставляет ещё одну строку
        assistantPosition: null,
        emit(event) {
            send(event);
            if (ctx.session) broadcast(ctx.session, event);
        },
        fail(text) {
            ctx.errorText = text;
            ctx.emit({ type: 'error', error: text });
        },
        // позиция строки с вопросом человека — на неё драйвер дописывает то,
        // что реально ушло модели (input_sent), если это не сам prompt
        userPosition: null,
        // cliSessionId — id, который выдал сам CLI. Наш id сессии от него не зависит
        // (заведён в open() ещё до очереди), этот нужен только для «--resume» того же
        // CLI и потому живёт отдельно, в session_cli
        begin(cliSessionId) {
            if (cliSessionId) setCliSession.run(ctx.session, target.id, cliSessionId);
        },
    };

    // сессию заводим ДО очереди: пока ход ждёт своей очереди, он уже должен быть
    // виден в списке как обычная активная сессия — иначе отправленный запрос
    // выглядит потерянным, пока не закончит предыдущий (событие 'queued' клиент
    // показывает статусом, но без id ему нечего выделять в списке)
    ctx.session = sessionId || `${target.id}-${Date.now().toString(36)}`;
    run.sessionId = ctx.session;
    // владельца сессии не перебиваем: её мог завести другой CLI, и продолжать
    // её должен уметь он же — target проставляется только при заведении строки
    // (upsertSession: ON CONFLICT обновляет одну updated_at). Кто выполнил
    // конкретный ход, видно в result_meta этого сообщения
    ctx.userPosition = startExchange(ctx.session, prompt, target.id, meta.model, meta.effort);
    setMessageMode.run(mode || null, ctx.session, ctx.userPosition);
    runs.set(ctx.session, new Set());
    ctx.emit({ type: 'session', id: ctx.session });
    // без этого push сессия появлялась в списке только у вкладки, которая её
    // завела (там 'sessions-changed' шлёт сам app.js), — у остальных открытых
    // вкладок только через опрос раз в 5с. Тот же канал, что и у live reload
    if (clients.size) {
        notifyClients('fragment:chat-sessions');
        notifyClients('fragment:home-observation');
    }

    activeRuns.set(runId, run);
    setBusy(1);

    try {
        await drive(ctx);
        ctx.emit({ type: 'done', text: ctx.answer });
    } catch (err) {
        ctx.errorText = ctx.errorText || err.message;
        ctx.emit({ type: 'error', error: err.message });
    } finally {
        // ход с ошибкой дописывается наравне с успешным: answer при ошибке пуст,
        // поэтому условие смотрит и на errorText (см. DOCS/decisions/012)
        if (ctx.session && (ctx.answer || ctx.errorText)) {
            finishExchange(ctx.session, ctx.answer || ctx.errorText, {
                ...meta,
                assistantPosition: ctx.assistantPosition,
                stopReason: meta.stopReason || (ctx.errorText ? 'error' : null),
            });
        }
        // работа окончена — отпускаем подключившиеся страницы
        if (ctx.session) {
            for (const listener of runs.get(ctx.session) || []) listener.end();
            runs.delete(ctx.session);
        }
        // занятость снимаем только после записи в базу, иначе отложенный
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

// продолжать сессию можно только тем id, который выдал этот же CLI: история
// запусков у каждого своя (~/.claude/projects/<путь>), и путь к проекту у Windows
// и WSL разный. Своей записи нет — CLI начнёт свою сессию, а контекст получит
// пересказом последних ходов (handoffPreamble)
function resumeAndHandoff(sessionId, targetId) {
    const resumeId = sessionId ? getCliSession.get(sessionId, targetId)?.id : null;
    return { resumeId, handoff: sessionId && !resumeId ? handoffPreamble(sessionId) : '' };
}

// Chat — обсуждение без последствий. запрета Edit/Write мало: в прошлый раз правка
// прошла через PowerShell, а субагент мог бы обойти и это, поэтому глушим всё,
// чем можно изменить файл или запустить команду. чтение (Read/Grep/Glob) остаётся
const CHAT_DENIED_TOOLS = [
    'Edit', 'Write', 'NotebookEdit',
    'Bash', 'PowerShell', 'BashOutput', 'KillShell',
    'Task', 'Agent', 'SlashCommand',
].join(',');

// Сессии запускаются только с настройками самого проекта. Глобальный ~/.claude
// (у Windows и WSL он свой) тянет за собой чужие плагины: замер на пустом «hi»
// дал 129 инструментов, 76 субагентов, 310 скиллов и 4 MCP-сервера — ~34 000
// токенов системного промпта до первого слова задания, и вдобавок хук-«ворота»
// одного из плагинов отклонял первый Bash и первую правку каждого файла (27 из
// 207 вызовов в истории сессий — чистые отказы с повторным вызовом следом).
// С этими флагами остаётся 30 инструментов, 8 агентов, 18 скиллов, 0 MCP:
// собственные хуки, скиллы и агенты проекта (.claude/) продолжают работать.
// Подробности — DOCS/decisions/013.
const LEAN_ARGS = ['--setting-sources', 'project,local', '--strict-mcp-config'];

// system-подтипы, у которых есть своя явная обработка ниже (onLine) — любой
// другой подтип ловит recordSystemEvent (см. DOCS/decisions/012)
const HANDLED_SYSTEM_SUBTYPES = new Set(['init', 'hook_started', 'hook_response', 'thinking_tokens']);

// snake_case из события CLI -> camelCase ключ в JSON, который мы кладём в базу
const camelKey = (key) => key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
// поля system/init, которые уходят в session_info как есть (остальные — руками,
// см. askClaude: их имена по этому правилу не выводятся)
const INIT_FIELDS = [
    'cwd', 'tools', 'slash_commands', 'terminal_slash_commands', 'model', 'claude_code_version',
    'output_style', 'agents', 'skills', 'plugins', 'capabilities', 'fast_mode_state',
    'fast_mode_disabled_reason', 'analytics_disabled', 'product_feedback_disabled',
    'memory_paths', 'messaging_socket_path',
];
// поля события result сверх тех, что уже лежат в своих колонках turnMeta
const RESULT_FIELDS = [
    'duration_api_ms', 'num_turns', 'ttft_ms', 'ttft_stream_ms', 'time_to_request_ms',
    'queued_turn_count', 'api_error_status', 'terminal_reason', 'permission_denials',
    'subagent_stats', 'modelUsage',
];
// поля usage из того же события — кладём туда же, но под своими именами
const RESULT_USAGE_FIELDS = {
    outputTokensDetails: 'output_tokens_details', cacheCreationBreakdown: 'cache_creation',
    serviceTier: 'service_tier', inferenceGeo: 'inference_geo', speed: 'speed',
};

// размер контекстного окна разный по моделям: у Sonnet/Opus/Fable — 1M, у Haiku — 200k
function contextWindowFor(model) {
    if (typeof model === 'string' && /haiku/i.test(model)) return 200000;
    return 1000000;
}

// верхнеуровневые event.type, у которых есть своя явная обработка ниже — любой
// другой (например, control_response/interrupt-хендшейк, который CLI заявляет
// в system/init.capabilities) ловит recordTopLevelEvent (см. DOCS/decisions/012)
const HANDLED_TOP_LEVEL_TYPES = new Set(['system', 'assistant', 'user', 'result', 'rate_limit_event']);

// преамбула идёт вместе с промптом через stdin, а не флагом: аргументы для WSL
// склеиваются в одну строку, и текст с пробелами там развалился бы
const CHAT_PREAMBLE = `Discussion mode. Answer in prose: explain, offer options, ask clarifying questions.
Do not change or run anything — the file-editing and command-running tools are disabled.
If you need the code to answer, read it (Read/Grep/Glob) and describe in words what you would do.
Reply in the same language the person writes to you in.

`;

async function askClaude({ prompt, model, effort, sessionId, mode }, send) {
    if (!activeTarget) return send({ type: 'error', error: 'Claude is not connected' });
    // цель фиксируем на весь запуск: пока идёт работа, в настройках могли переключить CLI
    const target = activeTarget;
    if (!prompt) return send({ type: 'error', error: 'Empty request' });
    if (model && !CLAUDE_MODELS.includes(model)) {
        return send({ type: 'error', error: `Unknown model: ${model}` });
    }
    if (effort && !EFFORT_LEVELS.includes(effort)) {
        return send({ type: 'error', error: `Unknown effort level: ${effort}` });
    }

    const { resumeId, handoff } = resumeAndHandoff(sessionId, target.id);

    const args = ['-p', '--output-format', 'stream-json', '--verbose', ...LEAN_ARGS];
    if (model) args.push('--model', model);
    if (effort) args.push('--effort', effort);
    if (resumeId) args.push('--resume', resumeId);
    // headless -p не может показать интерактивный запрос на разрешение, поэтому оба
    // режима идут без него: Chat — через plan (ничего не меняет и не запускает),
    // Action — через bypassPermissions (выполняет сразу)
    if (mode === 'Chat') {
        args.push('--permission-mode', 'plan');
        args.push('--disallowedTools', CHAT_DENIED_TOOLS);
    } else {
        args.push('--permission-mode', 'bypassPermissions');
    }

    // в Chat модели уходит не сам prompt, а CHAT_PREAMBLE + prompt; handoff непуст
    // только при переключении CLI (своей истории у этой цели нет)
    const input = handoff + (mode === 'Chat' ? CHAT_PREAMBLE + prompt : prompt);

    return runTurn({ target, prompt, sessionId, model, effort, mode }, send, async (ctx) => {
        // id сессии CLI приходит в каждом событии — связываем один раз
        let cliSessionSeen = false;
        // tool_use_id -> позиция строки шага: tool_result приходит отдельным
        // событием 'user' уже после того, как шаг записан, и должен лечь в ту же строку
        const toolPositions = new Map();
        // hook_id -> позиция строки: hook_started создаёт строку, hook_response
        // (тот же hook_id) дописывает в неё вывод — та же схема, что у toolPositions
        const hookPositions = new Map();

        const onLine = (line) => {
            let event;
            try {
                event = JSON.parse(line);
            } catch {
                return; // не JSON — служебный вывод CLI
            }

            // id, который выдал CLI, нужен для его же «--resume» — привязываем к нашей
            // сессии при первом событии, где он есть
            if (event.session_id && !cliSessionSeen) {
                cliSessionSeen = true;
                ctx.begin(event.session_id);
                // в базе оставляем след от добавок к промпту: модели ушёл не тот
                // текст, что видно в чате
                if (input !== prompt) setMessageInputSent.run(input, ctx.session, ctx.userPosition);
            }

            // самый внешний перехватчик: событие с верхнеуровневым type, для которого
            // ниже нет ни одной ветки
            if (ctx.session && !HANDLED_TOP_LEVEL_TYPES.has(event.type)) {
                recordTopLevelEvent(ctx.session, event);
            }

            // модель CLI мог выбрать сам (флаг --model не передали) — берём из первого ответа
            if (!ctx.meta.model && event.message?.model) ctx.meta.model = event.message.model;

            // событие system/init приходит один раз в самом начале стрима и несёт
            // около двух десятков полей — по колонкам их не раскладываем, кладём одним
            // JSON в session_info (INIT_FIELDS выше; camelCase имена получаются из
            // snake_case автоматически, руками — только те, что не выводятся правилом)
            if (event.type === 'system' && event.subtype === 'init' && ctx.session) {
                const info = {};
                for (const key of INIT_FIELDS) info[camelKey(key)] = event[key] ?? null;
                info.permissionMode = event.permissionMode || event.permission_mode || null;
                info.apiKeySource = event.apiKeySource || null;
                info.mcpServers = Array.isArray(event.mcp_servers)
                    ? event.mcp_servers.map((server) => (typeof server === 'string' ? server : server?.name || null)).filter(Boolean)
                    : null;
                info.initUuid = event.uuid || null;
                setSessionInfo.run(JSON.stringify(info), ctx.session);
            }

            // вывод хуков (PreToolUse/PostToolUse/SessionStart/…) тоже есть в стриме:
            // hook_started создаёт строку роли 'hook', hook_response (тот же hook_id)
            // дописывает в неё вывод — используем те же tool_name/tool_input/tool_result,
            // что и у обычных шагов, лишних колонок под это не заводим
            if (event.type === 'system' && event.subtype === 'hook_started' && ctx.session) {
                const position = recordHookStart(ctx.session, event);
                if (event.hook_id) hookPositions.set(event.hook_id, position);
            }
            if (event.type === 'system' && event.subtype === 'hook_response' && ctx.session) {
                const position = event.hook_id ? hookPositions.get(event.hook_id) : undefined;
                if (position !== undefined) recordHookResponse(ctx.session, position, event);
            }

            // текущая оценка токенов рассуждения — шлётся многократно за ход по мере
            // стриминга, храним только пик (последнее/наибольшее значение)
            if (event.type === 'system' && event.subtype === 'thinking_tokens') {
                if (typeof event.estimated_tokens === 'number') ctx.meta.thinkingTokensPeak = event.estimated_tokens;
            }

            // любой другой system-подтип, который явно не разобран выше: например
            // permission_denied — модель попыталась запрещённое действие
            if (event.type === 'system' && !HANDLED_SYSTEM_SUBTYPES.has(event.subtype) && ctx.session) {
                recordSystemEvent(ctx.session, event);
            }

            if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
                // каждое событие assistant — отдельный вызов модели в рамках этого хода
                // (агентный цикл: модель -> инструмент -> модель -> ...), суммируем все
                const mu = event.message.usage;
                if (mu) {
                    ctx.meta.usage.inputTokens += mu.input_tokens || 0;
                    ctx.meta.usage.outputTokens += mu.output_tokens || 0;
                    ctx.meta.usage.cacheReadTokens += mu.cache_read_input_tokens || 0;
                    ctx.meta.usage.cacheCreationTokens += mu.cache_creation_input_tokens || 0;
                    // а вот заполнение окна — величина не накопительная: сколько лежит
                    // в контексте прямо сейчас, показывает последний вызов модели
                    ctx.meta.lastRequestTokens =
                        (mu.input_tokens || 0) + (mu.cache_read_input_tokens || 0) + (mu.cache_creation_input_tokens || 0);
                }
                // берём последний непустой — на ход может прийтись несколько вызовов
                // модели подряд, и только у последнего stop_reason содержателен
                if (event.message.stop_reason) ctx.meta.stopReason = event.message.stop_reason;
                // вложенный шаг субагента (Task): CLI помечает его тем же id родительского
                // tool_use, что запустил Task — без поля это обычный шаг верхнего уровня
                const parentToolUseId = event.parent_tool_use_id || event.message?.parent_tool_use_id || null;
                for (const part of event.message.content) {
                    if (part.type === 'tool_use') {
                        const step = toolLabel(part);
                        if (ctx.session) {
                            const position = recordStep(ctx.session, `${step.name} ${step.detail}`.trim(), part.name, part.input, part.id, parentToolUseId, part.caller);
                            toolPositions.set(part.id, position);
                        }
                        ctx.emit(step);
                    }
                    else if (part.type === 'text' && part.text.trim()) {
                        ctx.answer = part.text;
                        // каждый кусок — своя строка (как у tool/thinking), а не общая
                        // answer на весь ход: за один ход модель может выдать текст
                        // несколько раз подряд (реплика -> инструмент -> ещё текст -> ...),
                        // и в чате каждый кусок — свой пузырь
                        if (ctx.session) ctx.assistantPosition = recordAssistantText(ctx.session, part.text, ctx.meta.model, ctx.meta.effort, parentToolUseId);
                        ctx.emit({ type: 'text', text: part.text });
                    }
                    else if (part.type === 'thinking') {
                        // пустой thinking-кусок (например, чисто сигнатурный, без текста)
                        // — молча пропускаем: это всё ещё известный тип части, не unknown
                        // (раньше проверка text.trim() стояла в одном условии с type, и
                        // пустой кусок проваливался в recordUnknownPart ниже, где текстом
                        // писалось буквально "thinking" — само имя типа, а не рассуждение)
                        if (part.thinking?.trim()) {
                            if (ctx.session) recordThinking(ctx.session, part.thinking, part.signature);
                            ctx.emit({ type: 'thinking', text: part.thinking });
                        }
                    }
                    else if (part.type === 'redacted_thinking') {
                        // API само решило скрыть рассуждение (data — непрозрачный
                        // зашифрованный блок для контекста, а не текст)
                        if (ctx.session) {
                            recordThinking(ctx.session, '[reasoning redacted by the Anthropic API (redacted_thinking) — no content, just an opaque block for the model context]');
                        }
                    }
                    else {
                        // любой другой тип части: WebSearch/WebFetch сюда не попадают
                        // (идут обычным tool_use), но CLI может прислать и что-то ещё
                        if (ctx.session) recordUnknownPart(ctx.session, part, parentToolUseId);
                    }
                }
            }

            // результат вызова инструмента приходит отдельным сообщением роли user —
            // ложится в ту же строку, что и сам вызов
            if (event.type === 'user' && Array.isArray(event.message?.content)) {
                for (const part of event.message.content) {
                    if (part.type !== 'tool_result') continue;
                    const position = toolPositions.get(part.tool_use_id);
                    if (position === undefined || !ctx.session) continue;
                    setMessageToolResult.run(clip(toolResultText(part.content)), part.is_error ? 1 : 0, toolResultImages(part.content), ctx.session, position);
                }
            }

            if (event.type === 'result') {
                if (event.is_error) ctx.fail(event.result || 'CLI returned an error');
                else ctx.answer = event.result || ctx.answer;

                // usage.*_tokens в result — сумма по всем вызовам модели за ход, а не
                // состав окна: в длинных сессиях она перевалила за 6 млн при окне в 1 млн,
                // и заполнение показывалось как 100 % задолго до настоящего предела.
                // Поэтому окно считаем по последнему вызову модели (lastRequestTokens),
                // а сумму из result оставляем только как запасной вариант
                const u = event.usage;
                if (u) {
                    const used = ctx.meta.lastRequestTokens
                        ?? ((u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0));
                    const window = contextWindowFor(ctx.meta.model);
                    const percent = Math.min(100, Math.round(used / window * 100));
                    if (ctx.session) setSessionContext.run(percent, window, ctx.session);
                    ctx.emit({ type: 'context', percent, window, used });
                }
                if (typeof event.total_cost_usd === 'number') ctx.meta.costUsd = event.total_cost_usd;
                if (typeof event.duration_ms === 'number') ctx.meta.durationMs = event.duration_ms;

                // всё остальное, что несёт result сверх структурных полей выше — тайминги,
                // отказы в разрешении, статистика субагентов, разбивка usage — одним JSON
                ctx.meta.resultMeta = { thinkingTokensPeak: ctx.meta.thinkingTokensPeak };
                for (const key of RESULT_FIELDS) ctx.meta.resultMeta[camelKey(key)] = event[key] ?? null;
                for (const [name, key] of Object.entries(RESULT_USAGE_FIELDS)) ctx.meta.resultMeta[name] = u?.[key] ?? null;
            }

            // лимиты подписки (5 часов / 7 дней) CLI присылает сам, на каждый запрос —
            // это те же цифры, что показывает /usage, только уже в JSON
            if (event.type === 'rate_limit_event') {
                ctx.emit({ type: 'rate_limit', info: event.rate_limit_info });
                // храним и в базе, иначе после перезагрузки страницы этих цифр не достать
                if (ctx.session && event.rate_limit_info) {
                    setSessionRateLimit.run(JSON.stringify(event.rate_limit_info), ctx.session);
                }
            }
        };

        await runClaude(target, args, {
            input, timeoutMs: CLAUDE_ASK_TIMEOUT_MS, onLine,
            onSpawn: (child) => { ctx.run.child = child; },
        });
    });
}

// ---------- коннектор OpenCode CLI ----------
//
// сознательно не переиспользует ничего Claude-специфичного (TARGETS/activeTarget/
// runClaude/askClaude) — в проекте нет общей абстракции над CLI, это её осознанный
// отказ (см. CLAUDE.md и память команды .claude/agents/memory/opencode-integration.md).
// Общими остаются только провайдеро-независимые вещи: таблицы sessions/messages
// и DB-хелперы, реестр идущих ходов activeRuns (один на все провайдеры — задания
// всех CLI выполняются строго по очереди, параллельно не работает больше одного).

// бинарник не лежит в PATH (проверено вживую — см. память команды), поэтому ищем
// его там, а при неудаче — по известному пути. Windows-путь по аналогии не
// проверялся живьём, но код реально спрашивает `where`, а не подставляет путь вслепую
function resolveOpenCodeBin(pathName, fallbackParts) {
    try {
        execFileSync(process.platform === 'win32' ? 'where' : 'which', [pathName], { stdio: 'ignore' });
        return pathName; // нашёлся в PATH
    } catch {
        const fallback = path.join(os.homedir(), ...fallbackParts);
        return fs.existsSync(fallback) ? fallback : pathName; // не нашли — оставляем как есть, ENOENT покажет runOpenCode
    }
}

const OPENCODE_BIN = process.env.OPENCODE_BIN;
// id всех целей — с префиксом opencode-, а не голые wsl/windows/custom, как у Claude:
// оба набора идут в общую колонку sessions.target, и совпадение id перепутало бы
// принадлежность сессии не тому CLI (см. проверку владельца в askOpenCode)
const OPENCODE_TARGETS = OPENCODE_BIN
    ? [{ id: 'opencode-custom', label: 'OPENCODE_BIN', cmd: OPENCODE_BIN, args: [] }]
    : process.platform === 'win32'
        ? [
            { id: 'opencode-windows', label: 'Windows', cmd: resolveOpenCodeBin('opencode.exe', ['.opencode', 'bin', 'opencode.exe']), args: [] },
            // на Windows-хосте зовём WSL-копию так же, как это делает Claude (wsl.exe bash -lc "...") —
            // но своей команде внутри shell-строки нужно кавычить аргументы (см. shQuote), т.к.
            // opencode, в отличие от claude, принимает промпт позиционным аргументом, а не через stdin
            { id: 'opencode-wsl', label: 'WSL', cmd: 'wsl.exe', args: ['bash', '-lc'], viaShell: true, binName: '~/.opencode/bin/opencode' },
          ]
        : [
            { id: 'opencode-wsl', label: 'WSL', cmd: resolveOpenCodeBin('opencode', ['.opencode', 'bin', 'opencode']), args: [] },
            { id: 'opencode-windows', label: 'Windows', cmd: 'opencode.exe', args: [] },
          ];

let activeOpenCodeTarget = null; // отдельная переменная от activeTarget Claude — иначе подключения затирают друг друга

const OPENCODE_ASK_TIMEOUT_MS = Number(process.env.OPENCODE_ASK_TIMEOUT_MS) || 3_600_000;

// одинарные кавычки для bash -lc: нужно только для viaShell-цели (wsl.exe), где вся
// команда склеивается в одну строку — обычный spawn с массивом аргументов кавычек не требует
function shQuote(value) {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

// runOpenCode — аналог runClaude, тот же паттерн (построчный NDJSON, таймаут, kill),
// но prompt здесь не идёт через stdin: opencode run принимает его позиционным
// аргументом (проверено вживую, см. память команды), stdin CLI не читает вовсе
function runOpenCode(target, cliArgs, { timeoutMs, onLine, onSpawn } = {}) {
    return new Promise((resolve, reject) => {
        const args = target.viaShell
            ? [...target.args, shellLaunch([target.binName || 'opencode', ...cliArgs].map(shQuote).join(' '))]
            : [...target.args, ...cliArgs];

        const child = spawn(target.cmd, args, { windowsHide: true });
        onSpawn?.(child);

        let stdout = '';
        let stderr = '';
        let finished = false;

        const timer = setTimeout(() => {
            finished = true;
            killProcessTree(child, target);
            reject(new Error(`Timed out (${Math.round(timeoutMs / 1000)}s)`));
        }, timeoutMs);

        const done = (err, value) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            err ? reject(err) : resolve(value);
        };

        child.on('error', (err) => {
            done(new Error(err.code === 'ENOENT' ? `${target.cmd} not found` : err.message));
        });

        let tail = '';
        child.stdout.on('data', (chunk) => {
            if (!onLine) {
                stdout += chunk;
                return;
            }
            tail += chunk;
            const lines = tail.split('\n');
            tail = lines.pop();
            for (const line of lines) {
                if (line.trim()) onLine(line);
            }
        });
        child.stderr.on('data', (chunk) => { stderr += takeRemotePid(child, String(chunk)); });

        child.on('close', (code) => {
            // opencode шлёт ошибку хода событием type:'error' внутри NDJSON, а не
            // ненулевым кодом выхода (проверено вживую) — код нужен только для
            // случаев, когда сам процесс не смог стартовать/упал вне протокола
            if (code === 0) done(null, stdout);
            else done(new Error(child.__stoppedByUser ? 'Stopped by the user' : (stderr.trim() || `CLI exited with code ${code}`)));
        });

        child.stdin.on('error', () => {});
        child.stdin.end(); // CLI не читает stdin — промпт уже в аргументах
    });
}

async function detectOpenCodeInstalls() {
    const checks = await Promise.allSettled(
        OPENCODE_TARGETS.map(async (target) => ({
            id: target.id,
            label: target.label,
            version: parseVersion(await runOpenCode(target, ['--version'], { timeoutMs: 15000 })),
        }))
    );

    return checks.filter((c) => c.status === 'fulfilled').map((c) => c.value);
}

// список моделей — реальный, не хардкод: `opencode models` без флагов формата
// печатает плоский текстовый список `provider/model`, по строке на модель
// (проверено вживую — 6 бесплатных моделей opencode/* без авторизации)
async function fetchOpenCodeModels(target) {
    const stdout = await runOpenCode(target, ['models'], { timeoutMs: 15000 });
    return stdout.trim().split('\n').map((line) => line.trim()).filter(Boolean);
}

async function askOpenCode({ prompt, model, sessionId, mode }, send) {
    if (!activeOpenCodeTarget) return send({ type: 'error', error: 'OpenCode is not connected' });
    const target = activeOpenCodeTarget;
    if (!prompt) return send({ type: 'error', error: 'Empty request' });

    const { resumeId, handoff } = resumeAndHandoff(sessionId, target.id);
    const args = ['run', handoff + prompt, '--format', 'json'];
    if (model) args.push('--model', model);
    if (resumeId) args.push('--session', resumeId);
    // у OpenCode нет проверенного аналога --permission-mode/--disallowedTools у Claude
    // (см. память команды) — режим Chat/Action пока только помечает строки в базе
    // (mode-колонка), инструменты CLI на уровне флагов не ограничивает

    return runTurn({ target, prompt, sessionId, model, mode }, send, async (ctx) => {
        let cliSessionSeen = false;
        // callID вызова инструмента -> позиция строки шага: tool_use приходит дважды
        // на один callID (сперва running, потом completed), вторая запись только
        // дописывает tool_result в ту же строку
        const toolPositions = new Map();

        const onLine = (line) => {
            let event;
            try {
                event = JSON.parse(line);
            } catch {
                return; // не JSON — служебный вывод CLI
            }

            // sessionID лежит в каждом событии (не только в первом, как у Claude) —
            // связываем его с нашей сессией один раз, для «--session» этого же CLI
            if (event.sessionID && !cliSessionSeen) {
                cliSessionSeen = true;
                ctx.begin(event.sessionID);
            }

            if (event.type === 'text' && event.part?.text?.trim()) {
                ctx.answer = event.part.text;
                if (ctx.session) ctx.assistantPosition = recordAssistantText(ctx.session, event.part.text, ctx.meta.model, null, null);
                ctx.emit({ type: 'text', text: event.part.text });
                return;
            }

            if (event.type === 'tool_use' && event.part) {
                const part = event.part;
                const toolName = part.tool || 'tool';
                const state = part.state || {};
                let position = toolPositions.get(part.callID);
                if (position === undefined && ctx.session) {
                    const detail = state.title || state.input?.command || state.input?.filePath || '';
                    position = recordStep(ctx.session, `${toolName} ${detail}`.trim(), toolName, state.input, part.callID, null, null);
                    toolPositions.set(part.callID, position);
                    ctx.emit(toolLabel({ name: toolName, input: state.input || {} }));
                }
                if (position !== undefined && ctx.session && (state.status === 'completed' || state.status === 'error')) {
                    const output = typeof state.output === 'string' ? state.output : JSON.stringify(state.output ?? '');
                    setMessageToolResult.run(clip(output), state.status === 'error' ? 1 : 0, null, ctx.session, position);
                }
                return;
            }

            if (event.type === 'step_finish' && event.part) {
                const tokens = event.part.tokens || {};
                ctx.meta.usage.inputTokens += tokens.input || 0;
                ctx.meta.usage.outputTokens += tokens.output || 0;
                ctx.meta.usage.cacheReadTokens += tokens.cache?.read || 0;
                ctx.meta.usage.cacheCreationTokens += tokens.cache?.write || 0;
                if (typeof event.part.cost === 'number') ctx.meta.costUsd = (ctx.meta.costUsd || 0) + event.part.cost;
                if (event.part.reason) ctx.meta.stopReason = event.part.reason;
                return;
            }

            if (event.type === 'error') {
                // ошибка хода приходит внутри потока, а не кодом возврата процесса
                // (проверено вживую — запуск с несуществующей моделью завершился кодом 0)
                ctx.fail(event.error?.data?.message || event.error?.name || 'OpenCode returned an error');
                return;
            }

            // step_start и прочие неразобранные события: у OpenCode нет аналога
            // thinking/rate_limit, своей ветки в общей схеме под них нет
        };

        await runOpenCode(target, args, {
            timeoutMs: OPENCODE_ASK_TIMEOUT_MS, onLine,
            onSpawn: (child) => { ctx.run.child = child; },
        });
    });
}

// ---------- коннектор Codex CLI ----------
//
// пока только detect/connect — тот же поток «найти в Windows и WSL, дать выбрать»,
// что и у Claude/OpenCode (см. AGENTS ниже). Реальный ход диалога (ask) ещё не
// реализован — намеренно, задача сейчас только про порядок подключения кнопки Connect.

const CODEX_BIN = process.env.CODEX_BIN;
const CODEX_TARGETS = CODEX_BIN
    ? [{ id: 'codex-custom', label: 'CODEX_BIN', cmd: CODEX_BIN, args: [] }]
    : process.platform === 'win32'
        ? [
            { id: 'codex-windows', label: 'Windows', cmd: 'codex', args: [] },
            { id: 'codex-wsl', label: 'WSL', cmd: 'wsl.exe', args: ['bash', '-lc'], viaShell: true },
          ]
        : [
            { id: 'codex-wsl', label: 'WSL', cmd: 'codex', args: [] },
            { id: 'codex-windows', label: 'Windows', cmd: 'codex.exe', args: [] },
          ];

let activeCodexTarget = null;

// та же схема, что у runClaude: shellLaunch/killProcessTree/takeRemotePid общие
// для всех целей через wsl.exe, они не завязаны на конкретный CLI
function runCodex(target, cliArgs, { input = '', timeoutMs, onLine, onSpawn } = {}) {
    return new Promise((resolve, reject) => {
        const args = target.viaShell
            ? [...target.args, shellLaunch(['codex', ...cliArgs].join(' '))]
            : [...target.args, ...cliArgs];

        const child = spawn(target.cmd, args, { windowsHide: true });
        onSpawn?.(child);

        let stdout = '';
        let stderr = '';
        let finished = false;

        const timer = setTimeout(() => {
            finished = true;
            killProcessTree(child, target);
            reject(new Error(`Timed out (${Math.round(timeoutMs / 1000)}s)`));
        }, timeoutMs);

        const done = (err, value) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            err ? reject(err) : resolve(value);
        };

        child.on('error', (err) => {
            done(new Error(err.code === 'ENOENT' ? `${target.cmd} not found` : err.message));
        });

        let tail = '';
        child.stdout.on('data', (chunk) => {
            if (!onLine) {
                stdout += chunk;
                return;
            }
            tail += chunk;
            const lines = tail.split('\n');
            tail = lines.pop();
            for (const line of lines) {
                if (line.trim()) onLine(line);
            }
        });
        child.stderr.on('data', (chunk) => { stderr += takeRemotePid(child, String(chunk)); });

        child.on('close', (code) => {
            if (code === 0) done(null, stdout);
            else done(new Error(child.__stoppedByUser ? 'Stopped by the user' : (stderr.trim() || `CLI exited with code ${code}`)));
        });

        child.stdin.on('error', () => {});
        child.stdin.end(input);
    });
}

async function detectCodexInstalls() {
    const checks = await Promise.allSettled(
        CODEX_TARGETS.map(async (target) => ({
            id: target.id,
            label: target.label,
            version: parseVersion(await runCodex(target, ['--version'], { timeoutMs: 15000 })),
        }))
    );

    return checks.filter((c) => c.status === 'fulfilled').map((c) => c.value);
}

// ход диалога ещё не реализован — Connect уже настоящий, но сообщения пока
// возвращают понятную ошибку вместо падения сервера на неизвестном методе
async function askCodex(_body, send) {
    if (!activeCodexTarget) return send({ type: 'error', error: 'Codex is not connected' });
    send({ type: 'error', error: 'Codex chat is not implemented yet' });
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

    -- у каждого CLI своя история запусков: id сессии Claude в OpenCode не существует,
    -- а у Windows-claude и WSL-claude разные папки историй. Поэтому наш id сессии
    -- живёт в sessions, а id внутри конкретного CLI — здесь, по одному на цель.
    -- Так переключение исполнителя продолжает ту же переписку, а не упирается в запрет
    CREATE TABLE IF NOT EXISTS session_cli (
        session_id TEXT NOT NULL,
        target TEXT NOT NULL,
        cli_session_id TEXT NOT NULL,
        PRIMARY KEY (session_id, target)
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

try {
    db.exec('ALTER TABLE sessions ADD COLUMN context_window INTEGER');
} catch { /* колонка уже есть */ }

// метаданные сессии, которые CLI присылает только раз — событием system/init
// в самом начале стрима (рабочая папка, доступные инструменты, режим разрешений,
// подключённые MCP-серверы, слэш-команды) — и лимиты подписки (rate_limit_event,
// те же цифры, что показывает /usage): в базе, а не только у живых слушателей
try {
    db.exec('ALTER TABLE sessions ADD COLUMN session_info TEXT');
} catch { /* колонка уже есть */ }
try {
    db.exec('ALTER TABLE sessions ADD COLUMN rate_limit TEXT');
} catch { /* колонка уже есть */ }

// разбор сессии по шагам (Flow, поиск раздувающих контекст мест): время,
// модель/effort запроса и — только на строке ответа, где CLI реально их
// присылает (событие result — на весь ход, а не на отдельный вызов инструмента) —
// потраченные токены/стоимость/длительность. tool_input/tool_result хранятся
// целиком (лимит — clip ниже), а не обрезанными до 120 символов строки статуса,
// чтобы по ним можно было разобрать, что именно сделал шаг
for (const [col, type] of [
    ['created_at', 'TEXT'],
    ['model', 'TEXT'],
    ['effort', 'TEXT'],
    ['input_tokens', 'INTEGER'],
    ['output_tokens', 'INTEGER'],
    ['cache_read_tokens', 'INTEGER'],
    ['cache_creation_tokens', 'INTEGER'],
    ['cost_usd', 'REAL'],
    ['duration_ms', 'INTEGER'],
    ['tool_input', 'TEXT'],
    ['tool_result', 'TEXT'],
    ['tool_result_images', 'TEXT'],
    ['tool_name', 'TEXT'],
    ['tool_error', 'INTEGER'],
    // tool_use_id — id вызова инструмента (part.id из событий assistant/tool_use),
    // parent_tool_use_id — тот же id, но родительского вызова, если этот шаг выполнен
    // внутри субагента (Task): CLI шлёт вложенные шаги в тот же стрим, и только это
    // поле отличает их от шагов верхнего уровня. stop_reason — почему модель остановилась
    // (end_turn/max_tokens/refusal/…), с события assistant.message.stop_reason
    ['tool_use_id', 'TEXT'],
    ['parent_tool_use_id', 'TEXT'],
    ['stop_reason', 'TEXT'],
    // режим хода (Chat/Action) — от него зависит доступный набор инструментов
    // (CHAT_DENIED_TOOLS) и permission-mode CLI; input_sent — то, что реально
    // ушло модели на stdin, если это отличается от text (в Chat перед вопросом
    // приклеивается CHAT_PREAMBLE, см. askClaude)
    ['mode', 'TEXT'],
    ['input_sent', 'TEXT'],
    // всё, что result присылает сверх duration_ms/total_cost_usd/usage (проверено
    // живым тестовым запросом): тайминги до первого токена, отказы в разрешении,
    // статистика субагентов и т.д. — одним JSON, как session_info/rate_limit
    ['result_meta', 'TEXT'],
    // разное по конкретной строке, что не влезает по смыслу в готовые колонки:
    // у tool_use — part.caller (прямой вызов или из субагента), у thinking —
    // факт/длина part.signature (крипто-подпись блока для API, не текст для
    // чтения) — держим одной универсальной JSON-колонкой, а не заводим по
    // колонке на каждое такое поле
    ['extra_meta', 'TEXT'],
]) {
    try {
        db.exec(`ALTER TABLE messages ADD COLUMN ${col} ${type}`);
    } catch { /* колонка уже есть */ }
}

// каким CLI начата сессия: у Windows-claude и WSL-claude свои хранилища истории
// (~/.claude/projects/<путь проекта>, а путь к проекту у них разный), поэтому
// «--resume» чужого id всегда возвращает ошибку — см. askClaude
try {
    db.exec('ALTER TABLE sessions ADD COLUMN target TEXT');
} catch { /* колонка уже есть */ }

// хранилище вкладки Flow (PROJECTS/Flow/flow.js): на сервере, а не в localStorage
// браузера — ключи совпадают с прежними именами localStorage, чтобы код вокруг
// чтения/записи каждого поля остался прежним
// ---------- агенты: один контракт на все CLI ----------
// Claude и OpenCode отличаются только тем, как их запускают и как разбирают
// вывод; снаружи оба отвечают одинаковым NDJSON. Всё различие собрано здесь,
// чтобы маршруты /api/agent/* не знали, какой CLI за ними стоит, а третий
// коннектор добавлялся строкой в этой таблице, а не четвёртой копией роутов.
const AGENTS = {
    claude: {
        targets: () => TARGETS,
        detect: () => detectInstalls(),
        version: (target) => runClaude(target, ['--version'], { timeoutMs: 15000 }).then(parseVersion),
        // список моделей у Claude фиксированный и лежит на клиенте
        models: null,
        activate: (target) => { activeTarget = target; },
        connected: () => Boolean(activeTarget),
        ask: askClaude,
    },
    opencode: {
        targets: () => OPENCODE_TARGETS,
        detect: () => detectOpenCodeInstalls(),
        version: (target) => runOpenCode(target, ['--version'], { timeoutMs: 15000 }).then(parseVersion),
        // а здесь его отдаёт сам CLI — заранее знать его нельзя
        models: (target) => fetchOpenCodeModels(target),
        // отдельная переменная от activeTarget: иначе подключения затирают друг друга
        activate: (target) => { activeOpenCodeTarget = target; },
        connected: () => Boolean(activeOpenCodeTarget),
        ask: askOpenCode,
    },
    codex: {
        targets: () => CODEX_TARGETS,
        detect: () => detectCodexInstalls(),
        version: (target) => runCodex(target, ['--version'], { timeoutMs: 15000 }).then(parseVersion),
        // список моделей у Codex пока фиксированный и лежит на клиенте, как у Claude
        models: null,
        activate: (target) => { activeCodexTarget = target; },
        connected: () => Boolean(activeCodexTarget),
        ask: askCodex,
    },
};

function agentByName(name) {
    const agent = AGENTS[name];
    if (!agent) throw new Error(`Unknown agent: ${name}`);
    return agent;
}

const upsertSession = db.prepare(`
    INSERT INTO sessions (id, title, updated_at, target)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at
`);

const getSessionTarget = db.prepare('SELECT target FROM sessions WHERE id = ?');

// id этой сессии внутри конкретного CLI — им и только им можно продолжать
const getCliSession = db.prepare('SELECT cli_session_id AS id FROM session_cli WHERE session_id = ? AND target = ?');
const setCliSession = db.prepare(`
    INSERT INTO session_cli (session_id, target, cli_session_id) VALUES (?, ?, ?)
    ON CONFLICT(session_id, target) DO UPDATE SET cli_session_id = excluded.cli_session_id
`);

// Переключились на другой CLI: его историю продолжить нечем — своей записи об этой
// переписке у него нет. Вместо запрета отдаём ему пересказ: последние ходы из нашей
// базы, чтобы он понимал, о чём речь, и продолжал по существу
const RESUME_MESSAGES = 12;

function handoffPreamble(sessionId) {
    const history = listMessages.all(sessionId)
        .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.text?.trim())
        .slice(-RESUME_MESSAGES);
    if (!history.length) return '';

    const lines = history.map((m) => `${m.role === 'user' ? 'Human' : 'Assistant'}: ${clip(m.text.trim())}`);
    return [
        'This continues a conversation that was held by a different CLI, so you have no history of your own.',
        'Below are the latest turns so you have the context. Answer the last message from the human,',
        'in the same language they used.',
        '',
        ...lines,
        '',
        '--- continuation ---',
        '',
    ].join('\n');
}

const upsertMessage = db.prepare(`
    INSERT INTO messages (session_id, position, role, text, created_at, model, effort)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id, position) DO NOTHING
`);

// usage/cost/duration CLI присылает только раз на весь ход (событие result),
// а не на отдельный вызов инструмента — поэтому это отдельный UPDATE поверх
// уже вставленной строки ответа, а не поле в upsertMessage
const setMessageUsage = db.prepare(`
    UPDATE messages
    SET input_tokens = ?, output_tokens = ?, cache_read_tokens = ?, cache_creation_tokens = ?, cost_usd = ?, duration_ms = ?
    WHERE session_id = ? AND position = ?
`);
// имя инструмента — отдельной колонкой, а не только первым словом text: клиенту
// (Flow) нужно название узла как структурные данные, а не парсинг строки статуса
const setMessageToolCall = db.prepare('UPDATE messages SET tool_name = ?, tool_input = ? WHERE session_id = ? AND position = ?');
const setMessageToolResult = db.prepare('UPDATE messages SET tool_result = ?, tool_error = ?, tool_result_images = ? WHERE session_id = ? AND position = ?');
const setMessageToolIds = db.prepare('UPDATE messages SET tool_use_id = ?, parent_tool_use_id = ? WHERE session_id = ? AND position = ?');
const setMessageStopReason = db.prepare('UPDATE messages SET stop_reason = ? WHERE session_id = ? AND position = ?');
const setMessageMode = db.prepare('UPDATE messages SET mode = ? WHERE session_id = ? AND position = ?');
const setMessageInputSent = db.prepare('UPDATE messages SET input_sent = ? WHERE session_id = ? AND position = ?');
const setMessageResultMeta = db.prepare('UPDATE messages SET result_meta = ? WHERE session_id = ? AND position = ?');
const setMessageExtraMeta = db.prepare('UPDATE messages SET extra_meta = ? WHERE session_id = ? AND position = ?');

const touchSession = db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?');
const setSessionThumb = db.prepare('UPDATE sessions SET thumb = ? WHERE id = ?');
const setSessionContext = db.prepare('UPDATE sessions SET context_percent = ?, context_window = ? WHERE id = ?');
const setSessionInfo = db.prepare('UPDATE sessions SET session_info = ? WHERE id = ?');
const setSessionRateLimit = db.prepare('UPDATE sessions SET rate_limit = ? WHERE id = ?');
const getSessionMeta = db.prepare('SELECT context_percent AS contextPercent, context_window AS contextWindow, session_info AS sessionInfo, rate_limit AS rateLimit, target, thumb FROM sessions WHERE id = ?');

const listSessions = db.prepare(`
    SELECT s.id, s.title, s.updated_at AS updatedAt, s.thumb AS thumb,
           s.rowid AS createdOrder,
           (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id AND m.role NOT IN ('tool', 'thinking', 'hook', 'system', 'unknown', 'top_level')) AS messageCount
    FROM sessions s
    ORDER BY s.updated_at DESC
`);

const listMessages = db.prepare(`
    SELECT role, text, created_at AS createdAt, model, effort,
           input_tokens AS inputTokens, output_tokens AS outputTokens,
           cache_read_tokens AS cacheReadTokens, cache_creation_tokens AS cacheCreationTokens,
           cost_usd AS costUsd, duration_ms AS durationMs,
           tool_name AS toolName, tool_input AS toolInput, tool_result AS toolResult, tool_error AS toolError,
           tool_result_images AS toolResultImages,
           tool_use_id AS toolUseId, parent_tool_use_id AS parentToolUseId, stop_reason AS stopReason,
           mode, input_sent AS inputSent, result_meta AS resultMeta, extra_meta AS extraMeta
    FROM messages WHERE session_id = ? ORDER BY position
`);

// сводка по сессии целиком — сколько токенов/денег/времени она стоила разом,
// без пересчёта по сообщениям на клиенте (Flow, панель сессий)
const sumSessionUsage = db.prepare(`
    SELECT COALESCE(SUM(input_tokens), 0) AS inputTokens,
           COALESCE(SUM(output_tokens), 0) AS outputTokens,
           COALESCE(SUM(cache_read_tokens), 0) AS cacheReadTokens,
           COALESCE(SUM(cache_creation_tokens), 0) AS cacheCreationTokens,
           COALESCE(SUM(cost_usd), 0) AS costUsd,
           COALESCE(SUM(duration_ms), 0) AS durationMs
    FROM messages WHERE session_id = ?
`);

const countMessages = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE session_id = ?');

// потолок на tool_input/tool_result/thinking: без лимита один Bash с гигантским
// выводом раздул бы .sessions.db, но значение выбрано так, чтобы обычные ответы
// инструментов не резались вовсе
const DETAIL_CLIP_LEN = 50000;
function clip(text) {
    if (typeof text !== 'string') return text;
    return text.length > DETAIL_CLIP_LEN ? text.slice(0, DETAIL_CLIP_LEN) + '…' : text;
}

// tool_result приходит как строка либо как массив блоков (text/image/…) —
// картинки и прочее нетекстовое просто помечаем именем типа
function toolResultText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content.map((part) => (part.type === 'text' ? part.text : `[${part.type}]`)).join('\n');
    }
    return '';
}

// картинки из tool_result (скриншоты Playwright/Chrome DevTools и т.п.): в тексте
// шага от них остаётся метка «[image]», а сами байты лежат здесь —
// как data-URL, тем же способом, что и sessions.thumb (см. THUMB_RE
// ниже), с тем же лимитом на картинку — иначе один шаг с несколькими большими
// скриншотами раздул бы .sessions.db
const MAX_TOOL_IMAGE_BYTES = 300 * 1024;
const MAX_TOOL_IMAGES_PER_RESULT = 6;
function toolResultImages(content) {
    if (!Array.isArray(content)) return null;
    const images = [];
    for (const part of content) {
        if (images.length >= MAX_TOOL_IMAGES_PER_RESULT) break;
        if (part.type !== 'image' || !part.source || part.source.type !== 'base64') continue;
        const { media_type: mediaType, data } = part.source;
        if (!mediaType || typeof data !== 'string' || data.length > MAX_TOOL_IMAGE_BYTES) continue;
        images.push(`data:${mediaType};base64,${data}`);
    }
    return images.length ? JSON.stringify(images) : null;
}

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
// в начале работы, а не после ответа. Возвращает позицию строки — вызывающий
// код дописывает сюда же mode/input_sent (см. askClaude)
function startExchange(sessionId, question, target, model, effort) {
    upsertSession.run(sessionId, extractTitle(question, 300), new Date().toISOString(), target || null);
    const position = countMessages.get(sessionId).n;
    upsertMessage.run(sessionId, position, 'user', question, new Date().toISOString(), model || null, effort || null);
    return position;
}

// тема сессии: режим комментариев кладёт в вопрос «Элемент интерфейса… Комментарий: …»,
// и настоящее намерение — именно текст комментария
function extractTitle(raw, maxLen) {
    const text = String(raw || '').trim();
    const comment = text.match(/(?:Comment|Комментарий):\s*([\s\S]+)/);
    const line = (comment ? comment[1] : text).split(/\r?\n/)[0].trim();
    return line.slice(0, maxLen) || 'No subject';
}

function sessionTitle(session) {
    // 80 символов подходили под старую фиксированную панель 210px — при
    // ресайзе (sidebar-resize.js) в две строки реально влезает больше, а
    // сервер обрезал текст ещё до браузера, так что расширение панели ничего
    // не добавляло. -webkit-line-clamp сам подрежет визуально и добавит «…»,
    // поэтому здесь достаточно щедрого запаса, а не точного расчёта под ширину
    return extractTitle(session.title, 240);
}

// шаги работы (вызовы инструментов) хранятся вместе с перепиской,
// иначе при открытии сессии от них не остаётся следа. text — по-прежнему
// «Bash grep -n ...» для строки статуса чата (короткая, режется в toolLabel());
// toolName/toolInput — те же данные структурно и без обрезки в 120 символов,
// ими пользуется Flow, чтобы показать на ноде название инструмента и реальную
// команду, а не общее слово «Шаг». Возвращаем позицию, чтобы вызывающий код
// мог позже дописать сюда же tool_result (он приходит отдельным событием)
function recordStep(sessionId, text, toolName, toolInput, toolUseId, parentToolUseId, caller) {
    const position = countMessages.get(sessionId).n;
    upsertMessage.run(sessionId, position, 'tool', text, new Date().toISOString(), null, null);
    setMessageToolCall.run(toolName || null, toolInput !== undefined ? clip(JSON.stringify(toolInput)) : null, sessionId, position);
    if (toolUseId || parentToolUseId) setMessageToolIds.run(toolUseId || null, parentToolUseId || null, sessionId, position);
    // caller — {"type":"direct"} у обычного вызова, отличает прямой вызов
    // от вызова изнутри субагента; не кладём в toolInput —
    // Flow (flow.js:1669 toolInputSummary) читает его как есть, обёртка сломала бы вывод
    if (caller) setMessageExtraMeta.run(JSON.stringify({ caller }), sessionId, position);
    return position;
}

// вывод хука (SessionStart/PreToolUse/PostToolUse/…) — своя строка роли 'hook',
// использует те же tool_name/tool_input/tool_result, что и обычные шаги
// (см. комментарий у hookPositions выше). hook_started создаёт строку,
// hook_response тем же hook_id дописывает результат — recordHookResponse
function recordHookStart(sessionId, event) {
    const position = countMessages.get(sessionId).n;
    const label = [event.hook_name, event.hook_event].filter(Boolean).join(' · ') || 'hook';
    upsertMessage.run(sessionId, position, 'hook', label, new Date().toISOString(), null, null);
    setMessageToolCall.run(
        event.hook_name || null,
        clip(JSON.stringify({ hookId: event.hook_id || null, hookEvent: event.hook_event || null })),
        sessionId, position,
    );
    return position;
}

function recordHookResponse(sessionId, position, event) {
    const text = clip([
        event.stdout || null,
        event.output && event.output !== event.stdout ? event.output : null,
        event.stderr ? `[stderr]\n${event.stderr}` : null,
    ].filter(Boolean).join('\n\n'));
    setMessageToolResult.run(text || null, event.exit_code ? 1 : 0, null, sessionId, position);
}

// рассуждения модели (блоки thinking) — отдельной строкой в той же таблице, рядом с шагами
function recordThinking(sessionId, text, signature) {
    const position = countMessages.get(sessionId).n;
    upsertMessage.run(sessionId, position, 'thinking', clip(text), new Date().toISOString(), null, null);
    // signature (600-2348 символов) — крипто-подпись блока для API, не читаемый
    // текст; храним факт и длину, не саму строку
    if (signature) setMessageExtraMeta.run(JSON.stringify({ signaturePresent: true, signatureLength: signature.length }), sessionId, position);
}

// текстовый кусок ответа — своя строка на каждое событие 'text' (за один ход
// модель может выдать текст несколько раз подряд, чередуя с вызовами
// инструментов); parentToolUseId — как у recordStep, отличает текст субагента
// (Task) от текста верхнего уровня. Возвращаем позицию — finishExchange
// дописывает на неё usage/stopReason/mode, а не вставляет ещё одну строку
function recordAssistantText(sessionId, text, model, effort, parentToolUseId) {
    const position = countMessages.get(sessionId).n;
    upsertMessage.run(sessionId, position, 'assistant', text, new Date().toISOString(), model || null, effort || null);
    if (parentToolUseId) setMessageToolIds.run(null, parentToolUseId, sessionId, position);
    return position;
}

// перехватчик для частей ответа с типом, который сервер явно не разбирает:
// WebSearch/WebFetch идут обычным tool_use, но CLI может прислать и что-то ещё
// (см. DOCS/decisions/012)
function recordUnknownPart(sessionId, part, parentToolUseId) {
    const position = countMessages.get(sessionId).n;
    upsertMessage.run(sessionId, position, 'unknown', part.type || 'unknown', new Date().toISOString(), null, null);
    setMessageToolCall.run(part.type || null, clip(JSON.stringify(part)), sessionId, position);
    if (parentToolUseId) setMessageToolIds.run(null, parentToolUseId, sessionId, position);
    return position;
}

// перехватчик для system-подтипов, которые сервер явно не разбирает (init/
// hook_started/hook_response/thinking_tokens — см. HANDLED_SYSTEM_SUBTYPES);
// такие подтипы реально приходят, например permission_denied
function recordSystemEvent(sessionId, event) {
    const position = countMessages.get(sessionId).n;
    upsertMessage.run(sessionId, position, 'system', event.subtype || 'system', new Date().toISOString(), null, null);
    setMessageToolCall.run(event.subtype || null, clip(JSON.stringify(event)), sessionId, position);
    return position;
}

// последний уровень перехвата: верхнеуровневый event.type, для которого нет
// ни одной ветки в onLine (см. HANDLED_TOP_LEVEL_TYPES и DOCS/decisions/012)
function recordTopLevelEvent(sessionId, event) {
    const position = countMessages.get(sessionId).n;
    upsertMessage.run(sessionId, position, 'top_level', event.type || 'unknown', new Date().toISOString(), null, null);
    setMessageToolCall.run(event.type || null, clip(JSON.stringify(event)), sessionId, position);
    return position;
}

// usage/cost/duration — только на весь ход (см. setMessageUsage) — приходят
// с CLI в событии result до того, как известна позиция строки ответа, поэтому
// finishExchange принимает их вместе с текстом и сам решает, что записать.
// assistantPosition — если текст уже записан построчно (recordAssistantText),
// новую строку вставлять не нужно, только дописать метаданные хода на неё же
function finishExchange(sessionId, answer, meta = {}) {
    touchSession.run(new Date().toISOString(), sessionId);
    let position = meta.assistantPosition;
    if (position == null) {
        position = countMessages.get(sessionId).n;
        upsertMessage.run(sessionId, position, 'assistant', answer, new Date().toISOString(), meta.model || null, meta.effort || null);
    }
    const u = meta.usage || {};
    const hasUsage = u.inputTokens || u.outputTokens || u.cacheReadTokens || u.cacheCreationTokens;
    if (hasUsage || meta.costUsd != null || meta.durationMs != null) {
        setMessageUsage.run(
            u.inputTokens || 0, u.outputTokens || 0, u.cacheReadTokens || 0, u.cacheCreationTokens || 0,
            meta.costUsd ?? null, meta.durationMs ?? null,
            sessionId, position,
        );
    }
    if (meta.stopReason) setMessageStopReason.run(meta.stopReason, sessionId, position);
    if (meta.mode) setMessageMode.run(meta.mode, sessionId, position);
    if (meta.resultMeta) setMessageResultMeta.run(JSON.stringify(meta.resultMeta), sessionId, position);
    return position;
}

// ---------- граф Obsidian ----------

// вся вкладка Graph живёт в PROJECTS/Graph; здесь остаётся только её запуск —
// маршруты вкладка отдаёт сама (graph.createRoutes в featureRoutes ниже)
const { prepareVault, projectFiles } = graph.init({
    listSessions,
    listMessages,
    sessionTitle,
    sumSessionUsage,
    onMapReady: () => { if (clients.size) notifyClients('map'); },
});

// сводка по сессиям для списков и панелей: заголовок уже почищен, а running
// посчитан по реестру запусков. Тему чистим на выдаче, а не только при записи:
// так короткий заголовок получают и сессии, заведённые до этого правила, —
// миграция базы не нужна
function sessionSummaries() {
    return listSessions.all().map((session) => ({
        ...session,
        title: sessionTitle(session),
        running: runs.has(session.id),
    }));
}

// серверные половины фич: каждая заводит свои таблицы сама и отдаёт готовую
// таблицу маршрутов. server.js их только собирает и не знает, что внутри.
// Список ниже — единственное место, где ядро знает про фичи вообще
const featureRoutes = {
    ...graph.createRoutes(),
    ...require('./PROJECTS/Flow/flow-server.js').createRoutes({ db }),
    ...require('./PROJECTS/Chat/pages-server.js').createRoutes({ db, root: ROOT }),
    ...require('./PROJECTS/Chat/chat-server.js').createRoutes({ sessions: sessionSummaries }),
    ...require('./PROJECTS/Home/home-server.js').createRoutes({
        sessions: sessionSummaries,
        activeCount: () => activeRuns.size,
    }),
    ...require('./PROJECTS/Karandash/karandash-server.js').createRoutes({ setEnvValue }),
    ...require('./SYSTEM/toolbar-icons-server.js').createRoutes({ db }),
};

// ---------- API коннектора ----------

async function handleApi(req, res, urlPath) {
    // фрагменты только читают состояние, и htmx тянет их обычным hx-get —
    // остальному API по-прежнему нужен POST
    const readOnly = urlPath.startsWith('/api/fragment/');
    if (req.method !== 'POST' && !(readOnly && req.method === 'GET')) {
        sendJson(res, { ok: false, error: readOnly ? 'Expected GET or POST' : 'Expected POST' }, 405);
        return;
    }

    try {
        // сначала маршруты, вынесенные в фичи, — они не знают друг о друге
        // и не могут перехватить чужой путь: ключ здесь всегда полный
        const feature = featureRoutes[urlPath];
        if (feature) {
            await feature(req, res);
            return;
        }

        // ---- агенты: один набор маршрутов на все CLI (таблица AGENTS выше) ----
        // имя CLI приходит полем agent в теле, а не в пути: так добавление
        // третьего коннектора не добавляет ни одного маршрута

        if (urlPath === '/api/agent/detect') {
            const { agent } = await readJson(req);
            sendJson(res, { installs: await agentByName(agent).detect() });
            return;
        }

        if (urlPath === '/api/agent/connect') {
            const { agent, id } = await readJson(req);
            const adapter = agentByName(agent);
            const target = adapter.targets().find((t) => t.id === id);
            if (!target) {
                sendJson(res, { ok: false, error: `Unknown environment: ${id}` });
                return;
            }

            const version = await adapter.version(target);
            const models = adapter.models ? await adapter.models(target) : undefined;
            adapter.activate(target);
            sendJson(res, { ok: true, id: target.id, label: target.label, version, models });
            return;
        }

        if (urlPath === '/api/agent/stop') {
            const { sessionId } = await readJson(req);
            // реестр запусков общий на все CLI (activeRuns), поэтому и остановка одна
            sendJson(res, { ok: true, stopped: stopActiveRun(sessionId || null) });
            return;
        }

        if (urlPath === '/api/agent/ask') {
            const body = await readJson(req);
            const adapter = agentByName(body.agent);
            res.writeHead(200, {
                'Content-Type': 'application/x-ndjson; charset=utf-8',
                'Cache-Control': 'no-store',
            });
            // вкладку могли перезагрузить или закрыть — работа CLI продолжается,
            // ответ всё равно попадёт в базу, мы лишь перестаём писать в мёртвый сокет
            let open = true;
            req.on('close', () => { open = false; });

            await adapter.ask(body, (event) => {
                if (open) res.write(JSON.stringify(event) + '\n');
            });
            if (open) res.end();
            return;
        }

        if (urlPath === '/api/sessions') {
            sendJson(res, { ok: true, sessions: sessionSummaries(), active: activeRuns.size });
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
                sendJson(res, { ok: false, error: 'No session specified' });
                return;
            }
            if (runs.has(id)) {
                sendJson(res, { ok: false, error: 'The session is still running' });
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

        // превью элемента, к которому был оставлен комментарий из режима Karandash —
        // приходит уже готовой data URL (скриншот системы либо клиентский снимок)
        if (urlPath === '/api/sessions/thumb') {
            const { id, thumb } = await readJson(req);
            const MAX_THUMB_BYTES = 300 * 1024;
            // строгий формат data-URL: только base64, без пробелов, кавычек и скобок —
            // это то, что реально отдаёт canvas.toDataURL, и ничего сверх этого
            const THUMB_RE = /^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/]+=*$/;
            if (!id || typeof thumb !== 'string' || thumb.length > MAX_THUMB_BYTES || !THUMB_RE.test(thumb)) {
                sendJson(res, { ok: false, error: 'Invalid preview' });
                return;
            }
            setSessionThumb.run(thumb, id);
            sendJson(res, { ok: true });
            return;
        }

        if (urlPath === '/api/sessions/messages') {
            const { id } = await readJson(req);
            const meta = getSessionMeta.get(id) || {};
            let sessionInfo = null;
            let rateLimit = null;
            try { sessionInfo = meta.sessionInfo ? JSON.parse(meta.sessionInfo) : null; } catch { /* битая запись — пропускаем */ }
            try { rateLimit = meta.rateLimit ? JSON.parse(meta.rateLimit) : null; } catch { /* битая запись — пропускаем */ }
            sendJson(res, {
                ok: true,
                messages: listMessages.all(id),
                contextPercent: meta.contextPercent ?? null,
                contextWindow: meta.contextWindow ?? null,
                sessionInfo,
                rateLimit,
                usage: sumSessionUsage.get(id),
                target: meta.target ?? null,
                thumb: meta.thumb ?? null,
            });
            return;
        }

        sendJson(res, { ok: false, error: 'Unknown endpoint' }, 404);
    } catch (err) {
        // сюда попадают только неожиданные падения: там, где ошибка предусмотрена,
        // обработчик сам отвечает 200 с { ok: false }. Поэтому здесь код 500 и
        // запись в консоль — иначе баг в сервере выглядит как успешный ответ
        // и находится потом по симптомам в интерфейсе
        console.error(`[api] ${urlPath}: ${err.stack || err.message}`);

        // htmx на 200 попробовал бы разложить тело по oob-целям, ничего не нашёл
        // и тихо оставил панель замороженной
        if (urlPath.startsWith('/api/fragment/')) {
            sendHtml(res, `<!-- fragment error: ${escapeHtml(err.message)} -->`, 500);
            return;
        }
        // тело прежнее: App.api() читает JSON независимо от кода ответа
        sendJson(res, { ok: false, error: err.message }, 500);
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
        res.end('403 Forbidden: the server only answers local requests');
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
    console.error(`Port ${PORT} is busy — the server is most likely already running: http://localhost:${PORT}`);
    console.error('A different port is set with the PORT= line in .env');
    process.exit(EXIT_PORT_BUSY); // отдельный код: по нему сторож понимает, что ждать правок бессмысленно
});

server.listen(PORT, () => {
    // prepareVault() синхронна и на этом проекте занимает ~20 с: пока она идёт,
    // event loop занят и сокет никому не отвечает. Поэтому «Сервер запущен»
    // печатается после неё — иначе и человек, и смоук идут на порт, который
    // молчит, и получают таймаут вместо страницы
    console.log('Building the project map — this takes a few seconds...');
    prepareVault();
    console.log(`Server started: http://localhost:${PORT} (runtime: ${detectRuntimePlatform()})`);

    if (LIVE_RELOAD) {
        watchFiles();
        console.log('Auto-reload is on — the page will reload after a file is saved.');
    }
});
