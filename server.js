const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const graph = require('./PROJECTS/Graph/graph-server.js');
const { readJson, escapeHtml, sendJson, sendHtml } = require('./SYSTEM/core/http.js');
const scan = require('./SYSTEM/core/scan.js');
const { reloadEvents } = require('./SYSTEM/core/reload.js');
const hostDeps = require('./SYSTEM/core/host-deps.js');
const branchPreview = require('./SYSTEM/core/branch-preview.js');
const turnJudgment = require('./SYSTEM/core/turn-judgment.js');
const agentCooldown = require('./SYSTEM/core/agent-cooldown.js');

const ROOT = __dirname;

// ---------- журнал выключений ----------
// почему сервер выключился, иначе видно только в терминале, где он запущен, —
// а к моменту разбора окно уже закрыто или затёрто выводом. Пишем рядом с данными
// (DATA/ не отслеживается сторожем файлов и не попадает в git)
const EXIT_LOG = path.join(ROOT, 'DATA', 'server-exits.log');
function logExit(text) {
    try {
        fs.appendFileSync(EXIT_LOG, `${new Date().toISOString()} [${process.pid}] ${text}\n`);
    } catch { /* журнал не повод падать */ }
}

// ---------- .env: единственное место для порта и секретов ----------
// файла нет — создаём его с портом 3001 и на нём же поднимаемся. значения из .env
// не перетирают то, что уже задано в окружении: так `PORT=3999 node server.js`
// продолжает работать
const ENV_FILE = path.join(ROOT, '.env');

const ENV_TEMPLATE = `# Project settings and secrets. Not tracked by git — edit it right here.
PORT=3001
# The screen the Karandash button captures (index in the monitor list, starting
from zero) — can also be changed from Settings in the interface
SCREENSHOT_SCREEN=0
# Host dependencies checked/installed by the watchdog (git, python); 0 turns it off
HOST_DEPS=1
# When an agent fails mid-work (provider error, limit, missing model) the next connected agent takes the work over; 0 turns it off
AGENT_FALLBACK=1

# Telegram bridge: the bot token and the ids of the users allowed to talk to it
# (comma separated). Both are filled from Settings in the interface
# TELEGRAM_BOT_TOKEN=
# TELEGRAM_USER_IDS=

# Path to the Claude CLI, if it is not in PATH
# CLAUDE_BIN=
# External Obsidian vault instead of the DATA/vault/ folder inside the project
# OBSIDIAN_VAULT=

# exec-bridge pilot (DOCS/decisions/037, DOCS/план-докеризации-коннекторов.md):
# EXEC_MODE=remote makes spawn() go through the host bridge instead of the
# local process — only meaningful when server.js itself runs in a container
# EXEC_MODE=remote
# EXEC_BRIDGE_URL=http://host.docker.internal:8789
# EXEC_BRIDGE_TOKEN=
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
const EXIT_LOCK_HELD = 4; // то же для занятого замка DATA/server.lock: другая копия уже работает
const LOCK_FILE = path.join(ROOT, 'DATA', 'server.lock');

// ---------- перезапуск при изменении самого server.js ----------
// Node читает файл один раз при старте, поэтому сервер работает в дочернем процессе,
// а родительский следит за server.js и поднимает дочерний заново после правок
if (LIVE_RELOAD && !process.env.SERVER_CHILD) {
    let child = null;
    let restarting = false;    // перезапуск запрошен: ждём от сервера «можно»

    // server.js подключает через require и серверные модули вне себя самого — их
    // правки тоже должны рестартовать сервер, иначе Node продолжает работать со
    // старой версией из памяти. Список собираем по правилам раскладки, а не руками:
    // перечисленный руками отставал от кода (PROJECTS/Sessions/pages-server.js и
    // SYSTEM/core/* в нём не было, и правка страниц молча не доезжала до сервера).
    //
    // Список перечитывается на каждом замере, а не собирается один раз при старте
    // сторожа: иначе модуль, заведённый уже после запуска, не попадал в него
    // никогда. Так и вышло с SYSTEM/core/typesafe.js и turn-judgment.js — сервер
    // сутки крутил бы их первую версию, а правки молча не доезжали, потому что
    // Node держит require-кэш до перезапуска процесса. Соседний замер файлов
    // моста читает свой список именно так, и по той же причине
    const serverModules = (dir) => {
        try {
            return fs.readdirSync(dir).filter((f) => f.endsWith('-server.js')).map((f) => path.join(dir, f));
        } catch {
            return []; // не папка или её нет — просто нечего смотреть
        }
    };
    const watchedFiles = () => {
        try {
            return [
                __filename,
                ...fs.readdirSync(path.join(ROOT, 'PROJECTS')).flatMap((name) => serverModules(path.join(ROOT, 'PROJECTS', name))),
                ...serverModules(path.join(ROOT, 'SYSTEM')),
                ...fs.readdirSync(path.join(ROOT, 'SYSTEM/core')).map((f) => path.join(ROOT, 'SYSTEM/core', f)),
            ];
        } catch {
            return [__filename]; // папку переименовывают прямо сейчас — замер не повод падать
        }
    };

    // сломанная правка не должна ронять сторожа вместе с сервером:
    // файл с синтаксической ошибкой не запускаем, старый процесс продолжает работать
    const isValid = () => {
        try {
            for (const file of watchedFiles()) execFileSync(process.execPath, ['--check', file], { stdio: 'ignore' });
            return true;
        } catch {
            console.error('one of the server files does not parse — keeping the previous version running');
            return false;
        }
    };

    // момент смерти выбирает не сторож, а сам сервер: он один знает, идёт ли сейчас
    // ход и не начинается ли новый прямо сейчас. Сторож только просит — и ждёт
    // ответа readyToRestart, сколько бы ни длились текущие ходы
    const restart = () => {
        if (!isValid()) return; // починят файл — mtime изменится, и мы придём сюда снова
        if (!child) return start(); // прошлый процесс упал сам — просто поднимаем заново
        if (restarting) return; // уже попросили: перезапустимся с последней версией файлов
        restarting = true;
        console.log('server file changed — restarting as soon as the current turns finish...');
        // канал мог закрыться, если процесс умирает прямо сейчас: без колбэка ошибка
        // прилетела бы событием 'error' на child и унесла сторожа вместе с сервером
        child.send({ prepareRestart: true }, () => {});
    };

    const start = () => {
        child = spawn(process.execPath, [__filename], {
            stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
            env: { ...process.env, SERVER_CHILD: '1' },
        });

        // Claude из чата правит файлы проекта, в том числе server.js. перезапуск
        // посреди работы убил бы запущенный CLI, поэтому гасим сервер только
        // по его собственному «можно»: к этому мгновению ходов нет, а новые он
        // уже не берёт — раньше между этими двумя событиями была щель, и запрос,
        // отправленный в неё, умирал вместе с процессом
        child.on('message', (message) => {
            if (message && message.readyToRestart) child.kill();
        });

        child.on('exit', (code, signal) => {
            // На Windows kill() — это TerminateProcess: сервер не успевает ничего
            // подчистить, и его замок DATA/server.lock лежит ещё STALE_MS. Запуск
            // следом в эти секунды отказывал «другая копия уже работает». Ребёнок
            // мёртв — значит, его замок заведомо ничей, снимаем его сами (только
            // свой: в файле лежит pid держателя)
            try {
                if (fs.readFileSync(LOCK_FILE, 'utf8').trim() === String(child.pid)) fs.unlinkSync(LOCK_FILE);
            } catch { /* замка нет или он чужой — не трогаем */ }
            child = null;
            logExit(`child exited: code=${code} signal=${signal} restarting=${restarting}`);
            if (restarting) {
                restarting = false;
                start();
                return;
            }
            if (signal || code === 0) process.exit(0); // остановлен снаружи или завершился штатно
            // порт занят: правкой server.js это не лечится, ждать нечего. иначе сторож
            // жил бы вечно — крутил опрос файлов и держал cwd проекта, из-за чего папку
            // проекта нельзя переименовать, пока процесс не убьют вручную
            if (code === EXIT_PORT_BUSY || code === EXIT_LOCK_HELD) process.exit(code);
            // упал сам (например, ошибка в коде): сторож остаётся жив и поднимет
            // сервер, как только server.js поправят — иначе чинить было бы нечем
            console.error(`server crashed (code ${code}) — waiting for server.js to be fixed`);
        });
    };

    // непрочитанный файл пропускаем, а не бросаем весь замер: раньше на любую
    // ошибку statSync замер падал целиком и опрос молча выходил из строя навсегда.
    // Достаточно было переименовать любой из watched-файлов (screenshot.js →
    // karandash-server.js) — и сервер до конца дня продолжал крутить старый код
    const latestMtime = () => watchedFiles().reduce((max, file) => {
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
        restart();
    }, POLL_MS);

    process.on('exit', (code) => logExit(`watchdog exit: code=${code}`));

    // Ctrl+C — кнопка «стоп» для сервера. Остановка синхронная: process.exit
    // не ждёт промисов
    const shutdown = (why) => {
        logExit(`watchdog got ${why}`);
        if (child) child.kill('SIGTERM');
        process.exit(0);
    };
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => shutdown(signal));

    // На Windows сигнала с клавиатуры может и не быть: консоль переходит в сырой
    // режим, и Ctrl+C перестаёт превращаться в событие — сторож живёт вечно.
    // Программный сигнал (GenerateConsoleCtrlEvent) при этом проходит. Поэтому
    // слушаем клавиатуру сами: в сыром режиме Ctrl+C приходит байтом 0x03
    // независимо от того, что сделали с консолью до нас. Режим переустанавливаем
    // раз в секунду — переключение false→true нужно, иначе setRawMode(true) при
    // уже «своём» сыром режиме ничего не делает
    if (process.platform === 'win32' && process.stdin.isTTY) {
        const arm = () => { try { process.stdin.setRawMode(false); process.stdin.setRawMode(true); } catch { /* консоль отобрали */ } };
        arm();
        process.stdin.resume();
        process.stdin.on('data', (chunk) => { if (chunk.includes(3)) shutdown('Ctrl+C (raw stdin)'); });
        setInterval(arm, 1000).unref();
    }

    // Системные зависимости хоста (git, python): чего нет — ставится,
    // SYSTEM/core/host-deps.js. HOST_DEPS=0 в .env выключает проверку.
    // Агентский CLI туда не входит: его подключает человек кнопкой в Settings
    if (process.env.HOST_DEPS !== '0') hostDeps.ensureHost();
    start();
    return; // код ниже выполняется только в дочернем процессе
}

// ---------- замок от параллельного запуска ----------
// Порт-гвард ниже (server.on('error', ...)) ловит вторую копию только на том
// же порту. Если у копий разные PORT в .env (например, Windows и WSL запущены
// одновременно с разными портами) или .env вовсе разные — обе поднимаются
// молча и дерутся за общие DATA/sessions.db, vault и телеграм-токен (Conflict
// от getUpdates). Порт тут не судья, а вот файл в DATA/ виден обеим сторонам
// одинаково — на нём и делаем общий замок, независимый от PORT.
//
// PID в замке не помогает: Windows и WSL — разные пространства процессов,
// чужой PID в них ничего не значит. Вместо этого держим «пульс» — раз в
// HEARTBEAT_MS обновляем время правки файла. Свежий пульс при старте значит
// «кто-то уже работает» — отказываем. Пульс не обновлялся дольше STALE_MS —
// прошлый процесс упал, не подчистив за собой, замок можно перехватить
const HEARTBEAT_MS = 3000;
const STALE_MS = HEARTBEAT_MS * 4;

function acquireLock() {
    try {
        const age = Date.now() - fs.statSync(LOCK_FILE).mtimeMs;
        if (age < STALE_MS) {
            console.error(`Another OpenKarandash server is already holding ${LOCK_FILE} (last heartbeat ${Math.round(age / 1000)}s ago).`);
            console.error('Stop that instance first — running two at once fights over the database, the vault and the Telegram bot token.');
            process.exit(EXIT_LOCK_HELD);
        }
    } catch { /* замка ещё нет — первый запуск */ }
    fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true });
    fs.writeFileSync(LOCK_FILE, String(process.pid));
    setInterval(() => {
        try { fs.utimesSync(LOCK_FILE, new Date(), new Date()); } catch { /* пропустим удар — догоним следующим */ }
    }, HEARTBEAT_MS).unref();
}

acquireLock();

// исключение вне обработчика запроса (таймер пересборки карты, колбэк процесса CLI)
// иначе гасит сервер без следа: сторож видит только код выхода, а стек уходит
// в закрытое окно терминала
for (const event of ['uncaughtException', 'unhandledRejection']) {
    process.on(event, (error) => {
        logExit(`${event}: ${(error && error.stack) || error}`);
        console.error(error);
        process.exit(1);
    });
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
    '.mjs': 'text/javascript; charset=utf-8', // ES-модули из node_modules без обёртки .js (rapier.mjs)
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.glb': 'model/gltf-binary', // 3D-модели (персонаж в ноде QA на Flow)
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
            // страницу перезагружать незачем, достаточно забыть прежнюю карту
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

// Папки, правки в которых не трогают страницу и не гоняют пересборку карты.
// Penpot живёт в контейнере: работа с макетом идёт через MCP и пишет файлы рядом
// с канвасом (TOOLS/penpot-mcp/design, deploy/penpot) помимо самой страницы
// PROJECTS/Penpot. Раньше любая из этих правок проходила как обычное изменение:
// событие `reload` гасило страницу целиком, а следом запускалась пересборка vault.
// Здесь важно, что список относительных путей, а не имён папок: в SKIP_NAMES
// попадать нельзя, оттуда список общий с картой проекта (SYSTEM/core/scan.js),
// и страница Penpot тогда исчезла бы из списка проектов.
const RELOAD_SKIP = ['PROJECTS/Penpot', 'TOOLS/penpot-mcp', 'deploy/penpot']
    .map((rel) => path.join(ROOT, ...rel.split('/')));

// папка целиком пропускается, а не файлы по расширению: правка страницы идёт
// через MCP-команды, и то, что зовёт их, лежит рядом с ними
function isReloadSkipped(full) {
    return RELOAD_SKIP.some((dir) => full === dir || full.startsWith(dir + path.sep));
}

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
        if (isReloadSkipped(full)) continue;

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
let activeVersion = null; // версия CLI подключённой цели — для /api/agent/status

// Сторож уже проверил (и при нужде поставил/залогинил) claude и назвал цель в
// CLAUDE_AUTOCONNECT: подключаем её сами при старте, чтобы свежескачанный
// проект работал без похода в Settings. Страница узнаёт об этом через
// /api/agent/status. Выбор в Settings по-прежнему главнее — он перезапишет
async function autoConnectClaude() {
    const id = process.env.CLAUDE_AUTOCONNECT;
    const target = id && TARGETS.find((t) => t.id === id);
    if (!target || activeTarget) return;
    try {
        activeVersion = parseVersion(await runClaude(target, ['--version'], { timeoutMs: 15000 }));
        if (activeTarget) return; // пока ждали версию, пользователь подключился сам
        activeTarget = target;
        console.log(`Claude connected automatically: ${target.label} (CLI ${activeVersion})`);
        if (process.send) process.send({ claudeTarget: target.id }, () => {});
    } catch (err) {
        console.warn(`Claude auto-connect (${id}) failed: ${err.message}`);
    }
}

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

// ---------- exec-bridge: удалённый spawn, когда сам server.js в контейнере ----------
// Пока server.js работает на голом хосте, ничего не меняется — spawn() остаётся
// локальным. EXEC_MODE=remote включает пилот из DOCS/decisions/037: единственная
// точка, которая физически спавнит процесс, подменяется HTTP-вызовом к exec-bridge
// (exec-bridge/server.py, живёт на хосте) с тем же внешним контрактом (Promise,
// onLine, onSpawn с .kill(), таймаут) — коннектор (runOpenCode и далее прочие)
// не знает, локальный это spawn или поход через мост.
const EXEC_MODE = process.env.EXEC_MODE || null;
const EXEC_BRIDGE_URL = (process.env.EXEC_BRIDGE_URL || 'http://host.docker.internal:8789').replace(/\/+$/, '');
const EXEC_BRIDGE_TOKEN = process.env.EXEC_BRIDGE_TOKEN || '';

function execBridgeHeaders() {
    return EXEC_BRIDGE_TOKEN ? { Authorization: `Bearer ${EXEC_BRIDGE_TOKEN}` } : {};
}

// shellPrefix — не None, только когда исходная цель viaShell (wsl.exe bash -lc):
// мосту он нужен исключительно чтобы переиздать kill внутри той же виртуалки
// (см. exec-bridge/server.py, Run.kill) — саму команду сервер уже собрал целиком
function execViaBridge(cmd, args, { timeoutMs, onLine, onSpawn, shellPrefix } = {}) {
    return new Promise((resolve, reject) => {
        const url = new URL(`${EXEC_BRIDGE_URL}/exec`);
        const payload = JSON.stringify({ cmd, args, timeoutMs, shellPrefix });
        const req = http.request({
            hostname: url.hostname,
            port: url.port || 80,
            path: url.pathname,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...execBridgeHeaders() },
        });

        // мост сам применяет timeoutMs к процессу — это лишь страховка на случай,
        // если сам HTTP-запрос к мосту повиснет (сеть недоступна, мост завис)
        if (timeoutMs) {
            req.setTimeout(timeoutMs + 30_000, () => {
                req.destroy(new Error(`exec-bridge did not respond within ${Math.round(timeoutMs / 1000)}s (+30s grace)`));
            });
        }

        // тот же контракт onSpawn(child)/child.kill(), что и у локального spawn —
        // Stop (killProcessTree) не знает и не должен знать, что цель удалённая
        const fakeChild = {
            __stoppedByUser: false,
            __runId: null,
            kill() {
                this.__stoppedByUser = true;
                if (!this.__runId) { req.destroy(new Error('Stopped by the user')); return; } // мост ещё не ответил started
                const killUrl = new URL(`${EXEC_BRIDGE_URL}/exec/${this.__runId}/kill`);
                http.request({ hostname: killUrl.hostname, port: killUrl.port || 80, path: killUrl.pathname, method: 'POST', headers: execBridgeHeaders() })
                    .on('error', () => {}) // мост мог уже погасить процесс сам — обычная гонка со Stop
                    .end();
            },
        };
        onSpawn?.(fakeChild);

        let stdout = '';
        let finished = false;
        const done = (err, value) => {
            if (finished) return;
            finished = true;
            err ? reject(err) : resolve(value);
        };

        req.on('error', (err) => {
            done(fakeChild.__stoppedByUser ? new Error('Stopped by the user') : new Error(`exec-bridge unreachable: ${err.message}`));
        });

        req.on('response', (res) => {
            if (res.statusCode >= 400) {
                let body = '';
                res.on('data', (c) => { body += c; });
                res.on('end', () => done(new Error(body.trim() || `exec-bridge returned ${res.statusCode}`)));
                return;
            }
            // NDJSON: одна строка — одно событие (started/line/done), см. exec-bridge/README.md
            let tail = '';
            res.on('data', (chunk) => {
                tail += chunk;
                let cut;
                while ((cut = tail.indexOf('\n')) !== -1) {
                    const raw = tail.slice(0, cut);
                    tail = tail.slice(cut + 1);
                    if (!raw.trim()) continue;
                    let event;
                    try { event = JSON.parse(raw); } catch { continue; }
                    if (event.type === 'started') fakeChild.__runId = event.runId;
                    else if (event.type === 'line') onLine ? onLine(event.text) : (stdout += event.text + '\n');
                    else if (event.type === 'done') {
                        if (event.timedOut) return done(new Error(`Timed out (${Math.round((timeoutMs || 0) / 1000)}s)`));
                        if (event.code === 0) return done(null, stdout);
                        done(new Error(fakeChild.__stoppedByUser ? 'Stopped by the user' : ((event.stderr || '').trim() || `CLI exited with code ${event.code}`)));
                    }
                }
            });
            res.on('end', () => done(new Error('exec-bridge closed the connection before finishing')));
        });

        req.end(payload);
    });
}

// промпт всегда идёт через stdin: так он не попадает в командную строку
// и не требует экранирования, даже когда команда собирается для `bash -lc`
function runClaude(target, cliArgs, { input = '', timeoutMs, onLine, onSpawn, env } = {}) {
    return new Promise((resolve, reject) => {
        const args = target.viaShell
            ? [...target.args, shellLaunch(['claude', ...cliArgs].join(' '))]
            : [...target.args, ...cliArgs];

        // env — только для askClaude: сообщает SessionStart-хуку (context-files-node.js),
        // что этот запуск сузил --setting-sources, и пользовательский CLAUDE.md сейчас
        // точно не грузится — без этого хук не мог бы честно решить, включать ли его
        const child = spawn(target.cmd, args, { windowsHide: true, env: env ? { ...process.env, ...env } : process.env });
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
    // от пути оставляем имя файла — в строке состояния важно «что», а не «где».
    // Ключи читаем и Claude-стиля (file_path), и opencode-стиля (filePath/query):
    // read/edit у opencode шлют filePath, websearch — query, и без этих ключей
    // живой шаг остаётся голым тегом без содержимого
    const detail = part.name === 'Task' ? `${input.subagent_type || ''}: ${input.description || ''}`.trim()
        : input.file_path ? path.basename(input.file_path)
        : input.filePath ? path.basename(input.filePath)
        : input.command || input.pattern || input.url || input.query || '';
    return { type: 'tool', name: part.name, detail: String(detail).slice(0, 120) };
}

// ход работы уходит на страницу по мере поступления: id сессии, вызовы
// инструментов и текст ответа. send() пишет по событию в поток ответа
let running = 0;

// сессии работают параллельно: новый ход стартует сразу, не дожидаясь уже идущих,
// и файлы под ним не блокируются. Одновременную правку одного файла двумя агентами
// сервер не разруливает и ходы друг от друга не удерживает
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

// запущенные сейчас запросы: id сессии -> { listeners, events, seq }.
// страницу могли перезагрузить, и она подключается к уже идущей работе.
// events — события этого хода с порядковым номером seq: подключившийся называет
// номер последнего события, которое видел (after), и получает всё, что было
// после него, — иначе события между обрывом связи и переподключением в живую
// ленту не попадали вовсе. Буфер живёт ровно ход и ограничен RUN_BUFFER_MAX:
// вытесненное из него клиент доберёт из базы (seq первого события в буфере
// больше after + 1 — знак, что пора перечитать /api/sessions/messages)
const runs = new Map();
const RUN_BUFFER_MAX = 5000;

// нумерует событие хода и кладёт его в буфер; возвращает то, что уходит наружу
function stampEventSeq(sessionId, event) {
    const live = runs.get(sessionId);
    if (!live) return event;
    const stamped = { ...event, seq: ++live.seq };
    live.events.push(stamped);
    if (live.events.length > RUN_BUFFER_MAX) live.events.shift();
    return stamped;
}

function broadcast(sessionId, event) {
    const live = runs.get(sessionId);
    if (!live) return;

    const line = JSON.stringify(event) + '\n';
    for (const res of live.listeners) res.write(line);
}

// ---------- перезапуск после правки: решение за сервером ----------
// Сторож правку только объявляет, а гасить процесс просит нас: он не видит,
// идёт ли ход и не начинается ли новый прямо сейчас. Отвечаем «можно» ровно
// в тот момент, когда последний ход дописан в базу, и с этого же мгновения
// новых ходов не берём — щели между «ходов нет» и смертью процесса не остаётся
let restartRequested = false;
let stopping = false; // ответ сторожу уже отправлен: процесса вот-вот не станет

async function confirmRestart() {
    if (!restartRequested || stopping || running > 0) return;
    stopping = true;
    // опрос телеграма отпускаем до смерти процесса и ждём, пока он отпустится:
    // Telegram держит getUpdates своим таймаутом, а не смертью клиента, и снять
    // его может только наш же прощальный запрос. Не дождавшись, мы бы убили его
    // вместе с процессом, и следующий запуск встретил бы Conflict вместо
    // сообщений (require кэширован — это тот же модуль, что ниже). Ожидание
    // ограничено внутри самого stop(): недоступный Telegram перезапуск не держит.
    // Зовут нас без await, поэтому своей ошибкой отсюда наружу выходить нельзя —
    // необработанный отказ гасит сервер целиком (обработчик выше)
    try {
        await require('./PROJECTS/Settings/telegram-server.js').stop();
    } catch (err) {
        console.error('Telegram release on restart:', err.message);
    }
    process.send({ readyToRestart: true }, () => {}); // колбэк: закрытый канал не должен ронять сервер
}

// sendJson/NDJSON — обычный отказ вместо оборванного соединения: страница
// покажет его как ошибку хода, а человек повторит через пару секунд
const RESTART_ERROR = 'The server is restarting after a code change — send it again in a few seconds';

if (process.send) {
    process.on('message', (message) => {
        if (!message || !message.prepareRestart) return;
        restartRequested = true;
        confirmRestart();
    });
}

// счётчик идущих ходов: по нему откладывается и пересборка карты, и перезапуск
// сколько отложенный перезапуск ждёт письмо о конце хода (см. finally в runTurn)
const MAIL_WAIT_MS = 30000;

function setBusy(delta) {
    running += delta;
    if (running === 0) confirmRestart();
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
async function runTurn({ target, prompt, sessionId, model, effort, mode, plan }, send, drive) {
    const runId = nextRunId++;
    // startedAt — момент начала именно этого хода: по нему панель Sessions
    // тикает «живую» длительность активной сессии (см. activeRunStartedAt
    // и /api/fragment/session-list), пока finishExchange не зафиксирует
    // итоговый duration_ms в базе
    const run = { sessionId: sessionId || null, child: null, done: null, target, startedAt: Date.now() };
    let resolveDone;
    let mail = null; // письмо о конце хода: перезапуск сервера его дожидается
    run.done = new Promise((resolve) => { resolveDone = resolve; });

    // usage/cost/duration копим по ходу стрима и пишем разом в finishExchange:
    // событие с итогами приходит раньше, чем процесс CLI завершится
    const meta = {
        model: model || null, effort: effort || null, mode: mode || null,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
        costUsd: null, durationMs: null, stopReason: null,
        thinkingTokensPeak: null, resultMeta: null, lastRequestTokens: null,
        // исходные итоговые события хода (result у Claude, run.completed у
        // Hermes — у него их бывает несколько: автоповтор внутри хода)
        resultRaws: [],
    };

    const ctx = {
        run, target, meta,
        session: null,
        answer: '',
        errorText: null,
        // позиция последней записанной строки ответа: finishExchange дописывает
        // метаданные хода на неё, а не вставляет ещё одну строку
        assistantPosition: null,
        // Строка «[PLAN] …» в начале ответа — как агент понял поручение. Ловим её
        // из текста по мере прихода и отдаём только начавшему ход (send), не в
        // ленту: в ленте она и так останется частью ответа. Один раз за ход
        planBuffer: '',
        planDone: !plan,
        // flush — текста больше не будет (начался шаг): строка плана могла прийти
        // кусками и без перевода строки в конце
        planFeed(chunk, flush = false) {
            if (ctx.planDone) return;
            ctx.planBuffer += chunk;
            const found = ctx.planBuffer.match(flush ? /\[PLAN\][ \t]*([^\n]+)/ : /\[PLAN\][ \t]*([^\n]+)\n/);
            if (found) send({ type: 'plan', text: found[1].trim().slice(0, 500) });
            // длинный текст без строки плана — агент правило не выполнил, дальше не ждём
            if (found || ctx.planBuffer.length > 1500) ctx.planDone = true;
        },
        emit(event) {
            if (event.type === 'text') ctx.planFeed(`${event.text}\n`);
            // план после первого шага — уже не план, а отчёт: такой не пересылаем
            if (event.type === 'tool') { ctx.planFeed('', true); ctx.planDone = true; }
            // номер получает и отправитель: оборвись его поток — он продолжит
            // через /api/sessions/attach с того же места
            const stamped = ctx.session ? stampEventSeq(ctx.session, event) : event;
            send(stamped);
            if (ctx.session) broadcast(ctx.session, stamped);
        },
        // кусок текста по мере набора: в буфер хода не идёт и номера не получает —
        // это черновик, который целиком заменит обычное событие text/thinking;
        // иначе куски вытеснили бы из буфера настоящие события
        emitLive(event) {
            send(event);
            const live = ctx.session && runs.get(ctx.session);
            if (!live) return;
            const line = JSON.stringify(event) + '\n';
            for (const res of live.listeners) if (res.__deltas) res.write(line);
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
    runs.set(ctx.session, { listeners: new Set(), events: [], seq: 0 });
    ctx.emit({ type: 'session', id: ctx.session });
    // без этого push сессия появлялась в списке только у вкладки, которая её
    // завела (там 'sessions-changed' шлёт сам app.js), — у остальных открытых
    // вкладок только через опрос раз в 5с. Тот же канал, что и у live reload
    if (clients.size) {
        notifyClients('fragment:session-list');
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
            // типизированное суждение о ходе (DOCS/decisions/051): ход уже
            // отдан в ленту событием 'done', поэтому лишние доли секунды здесь
            // никого не ждут, а результат нужен и ленте, и телеграм-мосту.
            // Сбой суждения — не сбой хода: judgeTurn отдаёт null, и дальше всё
            // работает ровно как до него
            const judgment = await turnJudgment.judgeTurn({
                request: prompt,
                answer: ctx.answer,
                errorText: ctx.errorText,
                stopReason: meta.stopReason,
                // факт, который держит код: сделал ли ход хоть один шаг
                // инструментом. Отчёт «проверено» без единого шага — жёсткое
                // противоречие, и ловится оно здесь, а не моделью
                toolSteps: countToolSteps.get(ctx.session, ctx.userPosition).n,
            }).catch(() => null);
            // решение о письме принимается до записи хода: оно само часть
            // суждения и должно лежать в той же строке, а не теряться
            // причина поломки — до решения о письме: по ней willHandOver ниже знает,
            // подхватят ли работу, а письмо об ошибке называет её человеку
            if (ctx.errorText) await turnJudgment.classifyFailure(ctx.errorText).catch(() => null);
            const notify = turnJudgment.shouldNotify(judgment, { errorText: ctx.errorText });
            if (judgment) meta.resultMeta = { ...(meta.resultMeta || {}), judgment: { ...judgment, notified: notify } };
            // durationMs: только askClaude реально разбирает event.duration_ms
            // от CLI (см. event.type === 'result' выше) — у остальных коннекторов
            // (askOpenCode/askCodex/askPi/askHermes) meta.durationMs так и остаётся
            // null, ничего не попадает в duration_ms, и SUM(duration_ms) молча
            // пропускает этот ход: счётчик в панели честно тикал по настенному
            // времени, а после завершения хода фиксировать было нечего — отсюда
            // «0s» вместо накопленного значения. Запасной вариант — настенное
            // время самого хода (run.startedAt поставлен в начале runTurn) —
            // используем его, только если коннектор не прислал точную цифру сам
            finishExchange(ctx.session, ctx.answer || ctx.errorText, {
                ...meta,
                durationMs: meta.durationMs ?? (Date.now() - run.startedAt),
                assistantPosition: ctx.assistantPosition,
                stopReason: meta.stopReason || (ctx.errorText ? 'error' : null),
            });
            // в Telegram уходит законченный ход, а не каждый: человеку нужен
            // сигнал «задание закончено» и сообщение, ответом на которое он
            // продолжит сессию, — а не поток промежуточных реплик. Что считать
            // законченным, решает правило в turn-judgment.js поверх суждения;
            // ошибка и ход, остановившийся с вопросом к человеку, уходят всегда.
            // Без await: почта не должна ни задерживать ход, ни ронять его
            if (notify.send && !(await willHandOver(ctx.session, ctx.errorText))) {
                mail = notifyTurnFinished({
                    sessionId: ctx.session,
                    title: getSessionTitle.get(ctx.session)?.title || '',
                    text: ctx.answer || '',
                    // сломавшийся ход уходит своим письмом: причина по-человечески
                    // и шаги, которые агент успел сделать до обрыва
                    errorText: ctx.errorText || null,
                    // уверенность jev, что ход ждёт человека: по ней мост решает, считать
                    // ли список в конце ответа вариантами вопроса (опросом)
                    awaitsHuman: judgment?.awaitsHuman ?? null,
                    steps: ctx.errorText ? listToolSteps.all(ctx.session, ctx.userPosition).map((row) => row.text) : null,
                }).catch(() => {});
            }
        }
        // работа окончена — отпускаем подключившиеся страницы
        if (ctx.session) {
            for (const listener of runs.get(ctx.session)?.listeners || []) listener.end();
            runs.delete(ctx.session);
        }
        // занятость снимаем только после записи в базу, иначе отложенный
        // перезапуск сервера может оборвать нас между ответом и записью
        activeRuns.delete(runId);
        resolveDone();
        // Ход, правивший серверный файл, заканчивается отложенным перезапуском —
        // и письмо о конце работы гибло вместе с процессом: работа сделана, а в
        // Telegram тишина. Поэтому занятость держим, пока письмо не ушло (с
        // потолком: зависшая почта не должна держать перезапуск вечно). Ход для
        // страниц и очереди уже закончен — ждёт только перезапуск
        if (mail) await Promise.race([mail, new Promise((resolve) => setTimeout(resolve, MAIL_WAIT_MS))]);
        setBusy(-1);
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
    // hints — подобранные записки DOCS/decisions (SYSTEM/core/turn-judgment.js).
    // Они едут тем же каналом, что и пересказ истории: это не вопрос человека,
    // а служебная преамбула, поэтому в тексте строки сессии её быть не должно —
    // зато она попадает в «Sent to model» там, где коннектор его пишет
    async function resumeAndHandoff(sessionId, targetId, hints, plan, prompt) {
        const resumeId = sessionId ? getCliSession.get(sessionId, targetId)?.id : null;
        const history = sessionId && !resumeId ? await handoffPreamble(sessionId, prompt) : '';
        // ход начат из Telegram: агент первой строкой говорит, как понял
        // поручение, и пульт сразу пересылает её человеку (DOCS/decisions/063)
        return { resumeId, handoff: turnJudgment.hintPreamble(hints) + history + (plan ? planPreamble() : '') };
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
// В headless-пути (-p) CLI по умолчанию просит у API размышления без текста
// (display: omitted): блок thinking приходит пустым, с одной подписью. Явный
// флаг возвращает краткое изложение — то же, что видит интерактивная сессия.
// PTY и чтение ~/.claude/projects/*.jsonl для этого не нужны: замер показал,
// что и там лежит не больше этого. Подробности — DOCS/decisions/045.
const THINKING_ARGS = ['--thinking-display', 'summarized'];
// текст и размышления по мере набора (события stream_event), а не только целым
// куском в конце вызова модели — так же запускает claude мост (claude-bridge/
// cli_process.py). В базу куски не пишутся: целое сообщение придёт следом
const PARTIAL_ARGS = ['--include-partial-messages'];
// как часто отдаём накопленный кусок в ленту: токены идут десятками в секунду
const DELTA_FLUSH_MS = 150;

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
const HANDLED_TOP_LEVEL_TYPES = new Set(['system', 'assistant', 'user', 'result', 'rate_limit_event', 'stream_event']);

// преамбула идёт вместе с промптом через stdin, а не флагом: аргументы для WSL
// склеиваются в одну строку, и текст с пробелами там развалился бы
const CHAT_PREAMBLE = `Discussion mode. Answer in prose: explain, offer options, ask clarifying questions.
Do not change or run anything — the file-editing and command-running tools are disabled.
If you need the code to answer, read it (Read/Grep/Glob) and describe in words what you would do.
Reply in the same language the person writes to you in.

`;

async function askClaude({ prompt, model, effort, sessionId, mode, hints, plan }, send) {
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

    const { resumeId, handoff } = await resumeAndHandoff(sessionId, target.id, hints, plan, prompt);

    const args = ['-p', '--output-format', 'stream-json', '--verbose', ...LEAN_ARGS, ...THINKING_ARGS, ...PARTIAL_ARGS];
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

    return runTurn({ target, prompt, sessionId, model, effort, mode, plan }, send, async (ctx) => {
        // id сессии CLI приходит в каждом событии — связываем один раз
        let cliSessionSeen = false;
        // tool_use_id -> позиция строки шага: tool_result приходит отдельным
        // событием 'user' уже после того, как шаг записан, и должен лечь в ту же строку
        const toolPositions = new Map();
        // hook_id -> позиция строки: hook_started создаёт строку, hook_response
        // (тот же hook_id) дописывает в неё вывод — та же схема, что у toolPositions
        const hookPositions = new Map();
        // накопленный, но ещё не отданный в ленту кусок: { kind, text }
        let pendingDelta = null;
        let deltaTimer = null;
        const flushDelta = () => {
            deltaTimer = null;
            if (!pendingDelta) return;
            ctx.emitLive({ type: 'delta', kind: pendingDelta.kind, text: pendingDelta.text });
            pendingDelta = null;
        };
        const pushDelta = (kind, text) => {
            if (pendingDelta && pendingDelta.kind !== kind) flushDelta();
            if (pendingDelta) pendingDelta.text += text;
            else pendingDelta = { kind, text };
            if (!deltaTimer) deltaTimer = setTimeout(flushDelta, DELTA_FLUSH_MS);
        };

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

            // кусок по мере набора; шаги субагента (parent_tool_use_id) в черновик
            // не идут — их текст в ленте верхнего уровня не показывается
            if (event.type === 'stream_event') {
                const delta = event.event?.type === 'content_block_delta' ? event.event.delta : null;
                if (delta && !event.parent_tool_use_id) {
                    if (delta.type === 'text_delta' && delta.text) pushDelta('text', delta.text);
                    else if (delta.type === 'thinking_delta' && delta.thinking) pushDelta('thinking', delta.thinking);
                }
                return;
            }
            // целое сообщение заменяет черновик — недоотданный кусок уже не нужен
            if (event.type === 'assistant' || event.type === 'result') {
                if (deltaTimer) clearTimeout(deltaTimer);
                deltaTimer = null;
                pendingDelta = null;
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
                            const position = recordStep(ctx.session, `${step.name} ${step.detail}`.trim(), part.name, part.input, part.id, parentToolUseId, part.caller, part);
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
                        if (ctx.session) ctx.assistantPosition = recordAssistantText(ctx.session, part.text, ctx.meta.model, ctx.meta.effort, parentToolUseId, part);
                        ctx.emit({ type: 'text', text: part.text });
                    }
                    else if (part.type === 'thinking') {
                        // пустой thinking-кусок (например, чисто сигнатурный, без текста)
                        // — молча пропускаем: это всё ещё известный тип части, не unknown
                        // (раньше проверка text.trim() стояла в одном условии с type, и
                        // пустой кусок проваливался в recordUnknownPart ниже, где текстом
                        // писалось буквально "thinking" — само имя типа, а не рассуждение)
                        if (part.thinking?.trim()) {
                            if (ctx.session) recordThinking(ctx.session, part.thinking, part.signature, part);
                            ctx.emit({ type: 'thinking', text: part.thinking });
                        }
                    }
                    else if (part.type === 'redacted_thinking') {
                        // API само решило скрыть рассуждение (data — непрозрачный
                        // зашифрованный блок для контекста, а не текст)
                        if (ctx.session) {
                            recordThinking(ctx.session, '[reasoning redacted by the Anthropic API (redacted_thinking) — no content, just an opaque block for the model context]', null, part);
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
                    // сырым результатом служит всё событие, если результат в нём один:
                    // рядом с блоком CLI кладёт tool_use_result — разобранный вывод
                    // инструмента, которого в самом блоке нет. Если результатов
                    // несколько, событие разделить нельзя — берём только блок
                    const single = event.message.content.filter((p) => p.type === 'tool_result').length === 1;
                    appendRaw(ctx.session, position, single ? event : part);
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
                // итог хода целиком — его допишет finishExchange к строке ответа
                ctx.meta.resultRaws.push(event);
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
            // см. LEAN_ARGS — сообщаем SessionStart-хуку, что --setting-sources
            // сужены и пользовательский источник (~/.claude/CLAUDE.md) не грузится
            env: { OPENKARANDASH_SETTING_SOURCES: 'project,local' },
        });
    });
}

// ---------- коннектор OpenCode CLI ----------
//
// сознательно не переиспользует ничего Claude-специфичного (TARGETS/activeTarget/
// runClaude/askClaude) — в проекте нет общей абстракции над CLI, это её осознанный
// отказ (см. решение 006 про один набор маршрутов на все CLI).
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
    const args = target.viaShell
        ? [...target.args, shellLaunch([target.binName || 'opencode', ...cliArgs].map(shQuote).join(' '))]
        : [...target.args, ...cliArgs];

    // пилот из DOCS/decisions/037: сам server.js в контейнере, opencode остаётся
    // на хосте — единственная точка spawn подменяется HTTP-вызовом к exec-bridge
    // с тем же внешним контрактом (Promise, onLine, onSpawn с .kill()); shellPrefix
    // передаём только для viaShell-цели (wsl.exe) — мосту он нужен лишь для kill
    // внутри той же виртуалки (exec-bridge/server.py, Run.kill)
    if (EXEC_MODE === 'remote') {
        return execViaBridge(target.cmd, args, {
            timeoutMs, onLine, onSpawn,
            shellPrefix: target.viaShell ? target.args : null,
        });
    }

    return new Promise((resolve, reject) => {
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

async function askOpenCode({ prompt, model, sessionId, mode, hints, plan }, send) {
    if (!activeOpenCodeTarget) return send({ type: 'error', error: 'OpenCode is not connected' });
    const target = activeOpenCodeTarget;
    if (!prompt) return send({ type: 'error', error: 'Empty request' });

    const { resumeId, handoff } = await resumeAndHandoff(sessionId, target.id, hints, plan, prompt);
    const args = ['run', handoff + prompt, '--format', 'json'];
    if (model) args.push('--model', model);
    if (resumeId) args.push('--session', resumeId);
    // у OpenCode нет проверенного аналога --permission-mode/--disallowedTools у Claude
    // (см. память команды) — режим Chat/Action пока только помечает строки в базе
    // (mode-колонка), инструменты CLI на уровне флагов не ограничивает

    return runTurn({ target, prompt, sessionId, model, mode, plan }, send, async (ctx) => {
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
                if (ctx.session) ctx.assistantPosition = recordAssistantText(ctx.session, event.part.text, ctx.meta.model, null, null, event.part);
                ctx.emit({ type: 'text', text: event.part.text });
                return;
            }

            if (event.type === 'tool_use' && event.part) {
                const part = event.part;
                const toolName = part.tool || 'tool';
                const state = part.state || {};
                let position = toolPositions.get(part.callID);
                if (position === undefined && ctx.session) {
                    // подпись та же, что уходит в живую ленту (toolLabel), а не своя
                    // сборка: иначе строка в базе «read …» и живой шаг разъезжаются,
                    // и после перечитывания лента показывает другой текст
                    const step = toolLabel({ name: toolName, input: state.input || {} });
                    // у opencode title приходит отдельно от input — запасная деталь
                    // для шагов, чьи аргументы не знает toolLabel
                    if (!step.detail && state.title) step.detail = String(state.title).slice(0, 120);
                    position = recordStep(ctx.session, `${step.name} ${step.detail}`.trim(), toolName, state.input, part.callID, null, null, part);
                    toolPositions.set(part.callID, position);
                    ctx.emit(step);
                }
                if (position !== undefined && ctx.session && (state.status === 'completed' || state.status === 'error')) {
                    const output = typeof state.output === 'string' ? state.output : JSON.stringify(state.output ?? '');
                    setMessageToolResult.run(clip(output), state.status === 'error' ? 1 : 0, null, ctx.session, position);
                    appendRaw(ctx.session, position, part);
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

// ---------- коннектор pi CLI ----------
//
// pi (@earendil-works/pi-coding-agent) — четвёртый CLI на тех же правах, что
// Claude/OpenCode/Codex: своя цель запуска, свой detect и свой разбор потока.
// Ход идёт через `-p --mode json`: NDJSON, где первая строка — заголовок сессии
// с её id, а дальше события агента (описаны в docs/json.md внутри пакета).
// Промежуточные message_update намеренно не разбираем — это дельты без
// накопленного текста, а итог того же сообщения целиком приходит в message_end.

const PI_BIN = process.env.PI_BIN;

// глобальная установка pi на Windows — это .cmd-обёртка npm, а её spawn запустить
// не может: с Node 20.12 .bat/.cmd без shell отвечают EINVAL, а shell здесь
// недопустим — промпт многострочный, и cmd.exe его не переживёт. Поэтому ищем не
// обёртку, а сам вход пакета (bin в его package.json) и запускаем его тем же node,
// на котором работает сервер. Проверено вживую: без этого Windows-окружение просто
// не находилось, и окно выбора Windows/WSL не открывалось
const PI_ENTRY_PARTS = ['node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'cli.js'];

function resolvePiEntry() {
    const candidates = [];
    try {
        // where печатает все найденные обёртки (pi, pi.cmd, pi.ps1) — пакет лежит
        // рядом с ними, в node_modules той же папки
        const shims = execFileSync('where', ['pi'], { encoding: 'utf8' }).split('\n').map((line) => line.trim());
        for (const shim of shims.filter(Boolean)) candidates.push(path.join(path.dirname(shim), ...PI_ENTRY_PARTS));
    } catch {
        // pi нет в PATH — остаётся стандартное место глобальных пакетов npm
    }
    if (process.env.APPDATA) candidates.push(path.join(process.env.APPDATA, 'npm', ...PI_ENTRY_PARTS));
    return candidates.find((file) => fs.existsSync(file)) || null;
}

const PI_WINDOWS_ENTRY = process.platform === 'win32' ? resolvePiEntry() : null;

const PI_TARGETS = PI_BIN
    ? [{ id: 'pi-custom', label: 'PI_BIN', cmd: PI_BIN, args: [] }]
    : process.platform === 'win32'
        ? [
            // вход не нашёлся — Windows-окружения просто нет в списке, а не
            // числится найденным и падает при первом запуске
            ...(PI_WINDOWS_ENTRY ? [{ id: 'pi-windows', label: 'Windows', cmd: process.execPath, args: [PI_WINDOWS_ENTRY] }] : []),
            { id: 'pi-wsl', label: 'WSL', cmd: 'wsl.exe', args: ['bash', '-lc'], viaShell: true },
          ]
        : [
            { id: 'pi-wsl', label: 'WSL', cmd: 'pi', args: [] },
            { id: 'pi-windows', label: 'Windows', cmd: 'pi.exe', args: [] },
          ];

let activePiTarget = null; // своя переменная на провайдера — подключения не затирают друг друга

const PI_ASK_TIMEOUT_MS = Number(process.env.PI_ASK_TIMEOUT_MS) || 3_600_000;

// runPi — аналог runOpenCode: промпт идёт позиционным аргументом, stdin CLI не
// читает. Отличие одно: свои сообщения об ошибке (нет ключа, неизвестная модель)
// pi печатает в stdout обычным текстом, а не в stderr, поэтому непрочитанные
// строки потока копим отдельно — иначе от упавшего хода осталось бы только
// «exited with code 1»
function runPi(target, cliArgs, { timeoutMs, onLine, onSpawn } = {}) {
    return new Promise((resolve, reject) => {
        const args = target.viaShell
            ? [...target.args, shellLaunch(['pi', ...cliArgs].map(shQuote).join(' '))]
            : [...target.args, ...cliArgs];

        const child = spawn(target.cmd, args, { windowsHide: true });
        onSpawn?.(child);

        let stdout = '';
        let stderr = '';
        let noise = ''; // строки stdout, которые не являются событиями потока
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
                if (!line.trim()) continue;
                if (line.startsWith('{')) onLine(line);
                else if (noise.length < 500) noise += line.trim() + '\n';
            }
        });
        child.stderr.on('data', (chunk) => { stderr += takeRemotePid(child, String(chunk)); });

        child.on('close', (code) => {
            if (code === 0) done(null, stdout);
            else done(new Error(child.__stoppedByUser
                ? 'Stopped by the user'
                : (stderr.trim() || noise.trim() || `CLI exited with code ${code}`)));
        });

        child.stdin.on('error', () => {});
        child.stdin.end();
    });
}

async function detectPiInstalls() {
    const checks = await Promise.allSettled(
        PI_TARGETS.map(async (target) => ({
            id: target.id,
            label: target.label,
            version: parseVersion(await runPi(target, ['--version'], { timeoutMs: 15000 })),
        }))
    );

    return checks.filter((c) => c.status === 'fulfilled').map((c) => c.value);
}

// список моделей у pi зависит от того, куда человек залогинен, — как у OpenCode,
// спрашиваем сам CLI. `--list-models` печатает таблицу с заголовком
// «provider  model  context  max-out  thinking  images», колонки разделены
// двумя и более пробелами; без логина вместо таблицы идёт подсказка про /login
async function fetchPiModels(target) {
    // список моделей — приятное дополнение, а не условие подключения: если CLI
    // ответил ошибкой (нет сети, сломанный каталог), карточка всё равно должна
    // подключиться, просто без строки выбора модели
    const stdout = await runPi(target, ['--list-models'], { timeoutMs: 20000 }).catch(() => '');
    const lines = stdout.trim().split('\n').map((line) => line.trim()).filter(Boolean);
    if (!lines.length || !lines[0].startsWith('provider')) return [];
    return lines.slice(1)
        .map((line) => line.split(/\s{2,}/))
        .filter((columns) => columns.length >= 2)
        // именно «provider/model»: в таком виде их принимает обратно флаг --model
        .map(([provider, model]) => `${provider}/${model}`);
}

// у pi нет режимов разрешений вроде --permission-mode: обсуждение получается
// строгим списком инструментов. Из встроенных (read, bash, powershell, edit,
// write, grep, find, ls) оставляем только читающие, и этот же список гасит
// расширения — --tools у pi является allowlist'ом для всех инструментов сразу
const PI_CHAT_TOOLS = 'read,grep,find,ls';

// ключ OpenRouter из Settings кладём туда же, откуда его читает сам pi —
// ~/.pi/agent/auth.json. Файл может уже нести чужой oauth-ключ (`pi login`),
// поэтому не перезаписываем его целиком, а трогаем только секцию openrouter
const PI_AUTH_FILE = path.join(os.homedir(), '.pi', 'agent', 'auth.json');

function savePiOpenRouterKey(key) {
    let auth = {};
    try {
        auth = JSON.parse(fs.readFileSync(PI_AUTH_FILE, 'utf8'));
    } catch {
        // файла ещё нет или он битый — заводим заново
    }
    auth.openrouter = { type: 'api_key', key };
    fs.mkdirSync(path.dirname(PI_AUTH_FILE), { recursive: true });
    fs.writeFileSync(PI_AUTH_FILE, JSON.stringify(auth, null, 2));
}

async function askPi({ prompt, model, effort, sessionId, mode, hints, plan }, send) {
    if (!activePiTarget) return send({ type: 'error', error: 'pi is not connected' });
    const target = activePiTarget;
    if (!prompt) return send({ type: 'error', error: 'Empty request' });
    if (effort && !EFFORT_LEVELS.includes(effort)) {
        return send({ type: 'error', error: `Unknown effort level: ${effort}` });
    }

    const { resumeId, handoff } = await resumeAndHandoff(sessionId, target.id, hints, plan, prompt);

    const args = ['-p', '--mode', 'json'];
    if (model) args.push('--model', model);
    if (effort) args.push('--thinking', effort);
    if (resumeId) args.push('--session', resumeId);
    if (mode === 'Chat') args.push('--tools', PI_CHAT_TOOLS);

    const input = handoff + (mode === 'Chat' ? CHAT_PREAMBLE + prompt : prompt);
    // `--` обязателен: без него промпт, начинающийся с дефиса, ушёл бы в разбор флагов
    args.push('--', input);

    return runTurn({ target, prompt, sessionId, model, effort, mode, plan }, send, async (ctx) => {
        // toolCallId -> позиция строки шага: вызов инструмента приходит дважды
        // (start и end), результат дописывается в ту же строку
        const toolPositions = new Map();

        const onLine = (line) => {
            let event;
            try {
                event = JSON.parse(line);
            } catch {
                return; // не JSON — служебный вывод CLI
            }

            // первая строка потока: id сессии самого pi, нужный для его же «--session»
            if (event.type === 'session' && event.id) {
                ctx.begin(event.id);
                if (input !== prompt) setMessageInputSent.run(input, ctx.session, ctx.userPosition);
                return;
            }

            if (event.type === 'tool_execution_start' && ctx.session) {
                const toolArgs = event.args || {};
                const detail = toolArgs.path || toolArgs.file_path || toolArgs.command || toolArgs.pattern || '';
                const step = { type: 'tool', name: event.toolName || 'tool', detail: String(detail).slice(0, 120) };
                const position = recordStep(ctx.session, `${step.name} ${step.detail}`.trim(), step.name, toolArgs, event.toolCallId, null, null, event);
                toolPositions.set(event.toolCallId, position);
                ctx.emit(step);
                return;
            }

            if (event.type === 'tool_execution_end' && ctx.session) {
                const position = toolPositions.get(event.toolCallId);
                if (position === undefined) return;
                const output = typeof event.result === 'string' ? event.result : JSON.stringify(event.result ?? '');
                setMessageToolResult.run(clip(output), event.isError ? 1 : 0, null, ctx.session, position);
                appendRaw(ctx.session, position, event);
                return;
            }

            // message_end — законченный ответ одного вызова модели: текст,
            // размышления и usage лежат в нём целиком
            if (event.type === 'message_end' && event.message?.role === 'assistant') {
                const message = event.message;
                const usage = message.usage || {};
                ctx.meta.usage.inputTokens += usage.input || 0;
                ctx.meta.usage.outputTokens += usage.output || 0;
                ctx.meta.usage.cacheReadTokens += usage.cacheRead || 0;
                ctx.meta.usage.cacheCreationTokens += usage.cacheWrite || 0;
                // заполнение окна — не накопительная величина: сколько лежит в
                // контексте сейчас, показывает последний вызов модели
                ctx.meta.lastRequestTokens = (usage.input || 0) + (usage.cacheRead || 0) + (usage.cacheWrite || 0);
                if (typeof usage.cost?.total === 'number') ctx.meta.costUsd = (ctx.meta.costUsd || 0) + usage.cost.total;
                if (message.stopReason) ctx.meta.stopReason = message.stopReason;
                // модель мог выбрать сам CLI (флаг --model не передали)
                if (!ctx.meta.model && message.model) ctx.meta.model = message.model;

                for (const part of message.content || []) {
                    if (part.type === 'text' && part.text?.trim()) {
                        ctx.answer = part.text;
                        if (ctx.session) ctx.assistantPosition = recordAssistantText(ctx.session, part.text, ctx.meta.model, ctx.meta.effort, null, part);
                        ctx.emit({ type: 'text', text: part.text });
                    } else if (part.type === 'thinking' && part.thinking?.trim() && ctx.session) {
                        recordThinking(ctx.session, part.thinking, part.thinkingSignature, part);
                    }
                    // part.type === 'toolCall' пропускаем: свою строку шаг уже
                    // получил на tool_execution_start, с результатом в придачу
                }

                // ошибка вызова модели приходит полем сообщения, а не кодом возврата
                if (message.errorMessage) ctx.fail(message.errorMessage);
                return;
            }
        };

        await runPi(target, args, {
            timeoutMs: PI_ASK_TIMEOUT_MS, onLine,
            onSpawn: (child) => { ctx.run.child = child; },
        });
    });
}

// ---------- хранилище сессий (SQLite) ----------

// весь слой базы — SYSTEM/core/sessions-db.js (DOCS/decisions/022): файл SQLite,
// схема, заготовленные запросы и функции записи сообщений. Здесь только
// подключение. Таблица агентов ниже по файлу, поэтому «какой CLI вёл сессию»
// передаётся функцией: она объявлена как function и потому уже доступна
const {
    db, upsertSession, getCliSession, setCliSession, upsertMessage, setMessageToolResult,
    setMessageToolIds, setMessageMode, setMessageInputSent, setMessageExtraMeta, touchSession,
    setSessionThumb, setSessionContext, setSessionInfo, setSessionRateLimit,
    setMessageCreatedAt, lastMessageTime, getSessionMeta, getSessionTitle, getLastTurnParams,
    listSessions, listMessages, countNeedsAttention, sumSessionUsage, countMessages, listToolSteps,
    countToolSteps, getMessageRole, setMessageText, clip, toolResultText, toolResultImages, resetSessions,
    deleteSession, stampEvent, appendRaw, startExchange, extractTitle, sessionTitle, recordStep,
    recordHookStart, recordHookResponse, recordThinking, recordAssistantText, recordNotice,
    recordUnknownPart, recordSystemEvent, recordTopLevelEvent, finishExchange,
} = require('./SYSTEM/core/sessions-db.js').open({ ROOT, DATA_DIR, agentNameByTarget });

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
    pi: {
        targets: () => PI_TARGETS,
        detect: () => detectPiInstalls(),
        version: (target) => runPi(target, ['--version'], { timeoutMs: 15000 }).then(parseVersion),
        // список моделей зависит от логина — спрашиваем CLI, как у OpenCode
        models: (target) => fetchPiModels(target),
        activate: (target) => { activePiTarget = target; },
        connected: () => Boolean(activePiTarget),
        ask: askPi,
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

// какой CLI вёл сессию, видно по её target: id окружений у каждого коннектора
// свои и начинаются с его имени (кроме Claude — он в проекте был первым,
// и его окружения зовутся просто windows/wsl/custom)
function agentNameByTarget(targetId) {
    if (!targetId) return 'claude';
    const name = String(targetId).split('-')[0];
    return AGENTS[name] ? name : 'claude';
}

// Переключились на другой CLI: его историю продолжить нечем — своей записи об этой
// переписке у него нет. Вместо запрета отдаём ему пересказ: последние ходы из нашей
// базы, чтобы он понимал, о чём речь, и продолжал по существу
const RESUME_MESSAGES = 12;

// Пересказ для агента, у которого своей истории нет. Раньше — просто последние
// RESUME_MESSAGES реплик: в длинной работе (а работа из Telegram тянется днями)
// из пересказа выпадало само поручение и решения, принятые в начале. Теперь
// всегда едут первое поручение человека и свежий хвост, а из середины — те
// реплики, которые jev считает нужными для текущего запроса
// (pickRelevantTurns, DOCS/decisions/068). Нет суждения — середина пропускается
const RESUME_TAIL = 8;
const RESUME_PICKED = 4;

async function handoffPreamble(sessionId, prompt) {
    const all = listMessages.all(sessionId)
        .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.text?.trim());
    let history = all.slice(-RESUME_MESSAGES);
    if (all.length > RESUME_MESSAGES) {
        const tail = all.slice(-RESUME_TAIL);
        const middle = all.slice(1, -RESUME_TAIL);
        const picked = await turnJudgment.pickRelevantTurns(prompt, middle.map((m) => m.text), RESUME_PICKED).catch(() => []);
        history = [all[0], ...picked.map((index) => middle[index]), ...tail];
    }
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

// ---------- память о недоступных исполнителях (кулдаун) ----------

// Поломка ложится в базу (SYSTEM/core/agent-cooldown.js, DOCS/decisions/071),
// и следующий выбор исполнителя знает «кто сегодня недоступен и до какого
// времени», не повторяя ошибку. Уже по одному этому списку пульт не дёргает
// исчерпанную модель и не включает платежи, когда известно, что им тоже плохо
// память выключается тем же AGENT_FALLBACK=0, что и весь подхват: ноль значит
// «работаем как попросили, без самодеятельности пульта»
const cooldowns = agentCooldown.create({ db, enabled: () => !FALLBACK_OFF });

// причина кулдауна словами, что видела строка о замене (учёт — в
// телеграм-мосте, телефон читает его, а не код)
function cooldownWords(reason) {
    return telegramLetters.reasonText(reason);
}

// «до такого-то времени» из строки ISO — для строки о замене и письма-отказа
function cooldownUntilText(until) {
    try {
        return new Date(until).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    } catch {
        return String(until || '');
    }
}

// ---------- сломался исполнитель — работу берёт следующий ----------

// Ход оборвался ошибкой (поставщик модели, лимит, нет такой модели) — работу
// подхватывает следующий подключённый агент: сессию может продолжить любой CLI,
// контекст он получает пересказом (handoffPreamble), а поручение — с пометкой,
// кто и на чём оборвался. Решение владельца 2026-09-21 (DOCS/decisions/061):
// бесплатная модель упала — платный claude доделывает сам, человеку приходит
// строка о замене, а не письмо об ошибке. Выключатель — AGENT_FALLBACK=0 в .env
const FALLBACK_OFF = process.env.AGENT_FALLBACK === '0';
// остановил человек или уходит сам сервер — это не поломка исполнителя
const NO_HANDOVER = /Stopped by the user|restarting/i;
// сессия → кто её уже пробовал в этой цепочке. По нему же runTurn решает,
// слать ли письмо об ошибке: если работу сейчас подхватят, письмо — шум
const handoverWatch = new Map();

// Есть ли смысл менять исполнителя, решает суждение jev о причине поломки
// (classifyFailure в turn-judgment.js, DOCS/decisions/065): переполненный
// контекст или отказ по содержанию следующий агент не исправит, а стоить будет.
// Суждение выносится заранее (await classifyFailure перед вызовом), сюда
// приходит уже из памяти; нет суждения — как раньше, передаём всё, кроме
// остановки человеком и перезапуска
function nextExecutor(errorText, state) {
    if (FALLBACK_OFF || NO_HANDOVER.test(String(errorText || ''))) return null;
    if (turnJudgment.knownFailure(errorText)?.handover === false) return null;
    if (state.attempts >= MAX_HANDOVERS) return null;
    const dead = new Set(state.dead);
    if (agentIsSpent(state.current, errorText)) dead.add(state.current);
    // сначала всё бесплатное: другая бесплатная модель того же агента, потом
    // другой бесплатный агент — и только потом платные (решение владельца
    // 2026-09-21: платные подписки бережём, DOCS/decisions/066). Кого помнит
    // база кулдауна (071), не пробуем — об ошибке знаем заранее, повторяться
    // не в чем
    for (const name of FREE_AGENTS) {
        if (dead.has(name) || !AGENTS[name].connected()) continue;
        if (cooldowns.cooled(name, null)) continue;
        const model = (freeModels.get(name)?.models || []).find((m) => !state.tried.has(`${name}|${m}`) && !cooldowns.cooled(name, m));
        if (model) return { name, model };
    }
    const paid = Object.keys(AGENTS).find((key) => !FREE_AGENTS.includes(key) && !dead.has(key) && AGENTS[key].connected() && !cooldowns.cooled(key, null));
    return paid ? { name: paid, model: null } : null;
}

// агент исчерпан целиком, а не одна его модель: платного пробуем один раз, а у
// бесплатного другая модель не поможет, если не принят ключ или он не подключён
function agentIsSpent(name, errorText) {
    if (!FREE_AGENTS.includes(name)) return true;
    const reason = turnJudgment.knownFailure(errorText)?.reason;
    return reason === 'auth' || reason === 'not_connected' || /not connected/i.test(String(errorText || ''));
}

// ---------- бесплатные модели: кому отдавать работу в первую очередь ----------

const FREE_AGENTS = ['opencode', 'pi'];
const FREE_MODEL_RE = /(:free|-free|\/free)$/i;
// сколько раз за одну цепочку работа переходит дальше: бесплатных моделей у
// OpenRouter десятки, перебирать их все — минуты тишины для человека
const MAX_HANDOVERS = 4;
const FREE_MODELS_TTL_MS = 10 * 60 * 1000;
const FREE_MODELS_WAIT_MS = 25000;
// агент → { at, models }. Список спрашивается у самого CLI и стоит секунд,
// поэтому держим его в памяти: nextExecutor обязан отвечать сразу — по нему же
// runTurn решает, слать ли письмо об ошибке (willHandOver)
const freeModels = new Map();

async function refreshFreeModels() {
    const activeTargets = { opencode: activeOpenCodeTarget, pi: activePiTarget };
    await Promise.all(FREE_AGENTS.map(async (name) => {
        const target = activeTargets[name];
        if (!target || Date.now() - (freeModels.get(name)?.at || 0) < FREE_MODELS_TTL_MS) return;
        const list = await Promise.race([
            AGENTS[name].models(target).catch(() => []),
            new Promise((resolve) => setTimeout(() => resolve(null), FREE_MODELS_WAIT_MS)),
        ]);
        if (!list) return; // не дождались — остаёмся при прежнем списке
        freeModels.set(name, { at: Date.now(), models: list.filter((m) => FREE_MODEL_RE.test(m) || m === 'opencode/big-pickle') });
    }));
}

// Список бесплатных моделей нужен только после поломки первого исполнителя, а
// не до старта хода. Раньше await стоял перед стартом — каждый холодный ход
// уходил в тишину до FREE_MODELS_WAIT_MS. Теперь греем в фоне, а ждём его в
// одной точке, где и принимается решение о подхвате (handOver и willHandOver).
// Задержка та же, но она не съедает старт успешных ходов: до первой поломки
// (минуты работы) прогрев давно закончился
let freeModelsPending = null;
function warmFreeModels() {
    if (FALLBACK_OFF || freeModelsPending) return;
    freeModelsPending = refreshFreeModels()
        .catch(() => {})
        .finally(() => { freeModelsPending = null; });
}

async function willHandOver(sessionId, errorText) {
    // подхватывают только сломавшийся ход. Без этой строки успешный ход при
    // подключённом запасном агенте тоже считался «сейчас подхватят» — и письмо
    // о конце работы не уходило вовсе
    if (!errorText) return false;
    const state = sessionId && handoverWatch.get(sessionId);
    if (!state) return false;
    await freeModelsPending;
    return Boolean(nextExecutor(errorText, state));
}

// { failure, started }: failure — ошибка последнего, кто пробовал (null — работа
// сделана), started — завёлся ли вообще ход (отказ до старта в базу не попал)
async function askWithFallback(name, params, onEvent) {
    // tried — пары «агент|модель», dead — агенты, исчерпанные целиком
    const state = { tried: new Set(), dead: new Set(), attempts: 0, current: name };
    let request = params;
    let sessionId = params.sessionId || null;
    let everStarted = false;
    // список бесплатных моделей нужен до первой ошибки: после неё решать уже
    // некогда. Греем в фоне, чтобы холодный ход не уходил в тишину и не ждал
    // запроса к CLI; сама точка ожидания — в handOver ниже
    warmFreeModels();

    // общий хвост «работа переходит дальше» — и для поломки, и для кулдауна
    // (DOCS/decisions/071). Возвращает true, если есть кому. Ход даже не
    // начался (сессии нет) — следующий получает поручение как есть, оно же
    // станет заголовком сессии; иначе — с пометкой, кто и почему уступил
    function handOver(cause, cool) {
        state.tried.add(`${state.current}|${request.model || ''}`);
        if (sessionId) handoverWatch.set(sessionId, state);
        const spare = nextExecutor(cause, state);
        if (!spare) return false;
        if (agentIsSpent(state.current, cool ? cool.reason : cause)) state.dead.add(state.current);
        state.attempts += 1;
        const was = request.model ? `${state.current} (${request.model})` : state.current;
        const short = cool
            ? `временно недоступен (${cooldownWords(cool.reason)})`
            : `оборвался с ошибкой: «${String(cause).slice(0, 300)}»`;
        request = {
            prompt: !everStarted ? params.prompt
                : `[OpenKarandash] Предыдущий исполнитель (${was}) ${short}. `
                + `Доведи до конца последнее поручение человека:\n\n${params.prompt}`,
            sessionId: sessionId || undefined,
            model: spare.model || undefined,
            mode: params.mode,
            hints: params.hints,
            plan: params.plan,
        };
        state.current = spare.name;
        return true;
    }

    try {
        for (;;) {
            // просили того, о ком уже известно, что он недоступен (дневной
            // лимит, снятая модель) — не пробуем и не ждём знакомой ошибки:
            // цепочка начинается со следующего свободного (071)
            const cool = cooldowns.cooled(state.current, request.model || null);
            if (cool) {
                await freeModelsPending;
                if (!handOver(`${state.current} cooling after ${cool.reason}`, cool)) {
                    // дальше некого: браузеру это тоже событие, а не пустой конец
                    // потока — иначе вкладка «закончила» работу, которой не было
                    const message = `${state.current} ${cooldownWords(cool.reason)} до ${cooldownUntilText(cool.until)}`;
                    onEvent({ type: 'error', error: message });
                    return { failure: message, started: everStarted };
                }
                continue;
            }
            state.tried.add(`${state.current}|${request.model || ''}`);
            if (sessionId) handoverWatch.set(sessionId, state);
            let failure = null;
            await AGENTS[state.current].ask(request, (event) => {
                if (event.type === 'session') {
                    everStarted = true;
                    sessionId = event.id;
                    handoverWatch.set(sessionId, state);
                }
                if (event.type === 'error') failure = event.error;
                onEvent(event);
            });
            if (!failure) return { failure: null, started: true };
            await turnJudgment.classifyFailure(failure).catch(() => null);
            // поломку помним на будущее (071): агента, исчерпанного целиком
            // (платного, с недопущенным ключом), кладём агентом, поломку одной
            // бесплатной модели — по одной модели
            const reason = turnJudgment.knownFailure(failure)?.reason;
            cooldowns.record(state.current, agentIsSpent(state.current, failure) ? null : request.model, reason);
            await freeModelsPending;
            if (!handOver(failure, null)) return { failure, started: everStarted };
        }
    } finally {
        if (sessionId) handoverWatch.delete(sessionId);
    }
}

// ход, начатый не из браузера — сейчас это ответ человека в Telegram.
// Исполнителя и параметры берём из самой сессии, поток событий никуда не пишем:
// подключённые страницы всё равно получат его через broadcast внутри runTurn,
// а человеку в Telegram уйдёт готовый ответ из notifyTurnFinished
// mode — режим, выбранный мостом по виду поручения (вопрос — Chat, без правок;
// DOCS/decisions/067); не задан — как в прошлом ходе этой сессии
async function askOutsideBrowser({ sessionId, text, note, mode }) {
    if (!getSessionTitle.get(sessionId)) throw new Error('Session not found');
    if (stopping) throw new Error(RESTART_ERROR);

    const { name, replaced } = await readyExecutor(getSessionMeta.get(sessionId)?.target, sessionId, note);
    // модель и effort у каждого CLI свои — чужому агенту их не передаём
    const last = replaced ? { mode: getLastTurnParams.get(sessionId)?.mode } : (getLastTurnParams.get(sessionId) || {});
    // отказ до старта хода (не подключён, пустой запрос) в базу не попадёт и
    // обратно сам не уедет — такой возвращаем ошибкой. Всё, что случилось уже
    // внутри хода, дописано в сессию и уйдёт в Telegram обычным путём
    const hints = await turnJudgment.pickDecisionHints(text).catch(() => null);
    const { failure, started } = await askWithFallback(
        name,
        { prompt: text, sessionId, model: last.model || undefined, effort: last.effort || undefined, mode: mode || last.mode || undefined, hints, plan: true },
        (event) => { if (event.type === 'plan' && note) note(`📋 План: ${event.text}`); },
    );
    if (failure && !started) throw new Error(failure);
}

// Кто поведёт ход не из браузера. Подключение живёт в памяти процесса, а сторож
// перезапускает сервер на каждой правке серверного файла. Страница пульта после
// этого подключает свой CLI заново, но у хода не из браузера страницы нет: ответ
// человека из Telegram упирался в «pi is not connected», хотя pi стоял на месте.
// Поэтому сначала возвращаем подключение сами — тем же путём, что
// /api/agent/connect: запуск версии доказывает, что CLI жив
async function readyExecutor(sessionTarget, label, note) {
    let name = agentNameByTarget(sessionTarget);
    const adapter = AGENTS[name];
    if (!adapter.connected()) {
        const target = adapter.targets().find((t) => t.id === sessionTarget);
        try {
            if (!target) throw new Error(`unknown environment ${sessionTarget}`);
            const version = await adapter.version(target);
            if (!adapter.connected()) { // пока ждали версию, человек мог подключить сам
                adapter.activate(target);
                if (name === 'claude') {
                    activeVersion = version;
                    if (process.send) process.send({ claudeTarget: target.id }, () => {});
                }
            }
        } catch (err) {
            console.warn(`Reconnect ${name} for ${label} failed: ${err.message}`);
        }
    }
    // Свой CLI так и не поднялся — работу берёт любой подключённый: сессию
    // может продолжить кто угодно, контекст он получит пересказом
    // (handoffPreamble). Человеку об этом говорим: замена может стоить денег.
    // Тех, кто в кулдауне (071), пропускаем: знаем заранее, что они не в ладах
    if (adapter.connected()) return { name, replaced: false };
    const spare = Object.keys(AGENTS).find((key) => AGENTS[key].connected() && !cooldowns.cooled(key, null));
    if (!spare) {
        const any = Object.keys(AGENTS).some((key) => AGENTS[key].connected());
        throw new Error(any
            ? `${name} is not connected and the connected agents are cooling down — work paused until they recover`
            : `${name} is not connected and no other agent is — open Settings and connect one`);
    }
    if (note) note(`🔁 ${name} недоступен — работу ведёт ${spare}.`);
    name = spare;
    return { name, replaced: true };
}

// Новая работа не из браузера: человек нажал в Telegram END и написал поручение.
// Исполнителя, модель и режим берём у его прошлой работы (likeSessionId) — это
// тот агент, которым он пользуется; прошлой нет — первый подключённый.
// onSession сообщает id новой сессии сразу, не дожидаясь конца хода: мосту он
// нужен, чтобы следующие сообщения шли уже в неё
async function startOutsideBrowser({ text, likeSessionId, note, onSession, mode }) {
    if (stopping) throw new Error(RESTART_ERROR);
    const like = likeSessionId && getSessionTitle.get(likeSessionId) ? likeSessionId : null;
    const { name, replaced } = await readyExecutor(like ? getSessionMeta.get(like)?.target : null, 'new session', note);
    const last = like ? (getLastTurnParams.get(like) || {}) : {};
    const hints = await turnJudgment.pickDecisionHints(text).catch(() => null);
    const { failure, started } = await askWithFallback(
        name,
        {
            prompt: text,
            model: (!replaced && last.model) || undefined,
            effort: (!replaced && last.effort) || undefined,
            mode: mode || last.mode || undefined,
            hints,
            plan: true,
        },
        (event) => {
            if (event.type === 'session' && onSession) onSession(event.id);
            if (event.type === 'plan' && note) note(`📋 План: ${event.text}`);
        },
    );
    if (failure && !started) throw new Error(failure);
}

// ---------- карта проекта (vault Obsidian) ----------

// вся карта живёт в PROJECTS/Graph; здесь остаётся только её запуск —
// маршруты папка отдаёт сама (graph.createRoutes в featureRoutes ниже)
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

// момент старта текущего хода активной сессии (для живого тикающего счётчика
// в панели Sessions) — null, если по этой сессии сейчас ничего не выполняется.
// Один и тот же sessionId вторым активным ходом на практике не бывает (composer
// блокируется на время хода), первое совпадение достаточно
function activeRunStartedAt(sessionId) {
    for (const run of activeRuns.values()) {
        if (run.sessionId === sessionId) return run.startedAt || null;
    }
    return null;
}

// серверные половины фич: каждая заводит свои таблицы сама и отдаёт готовую
// таблицу маршрутов. server.js их только собирает и не знает, что внутри.
// Список ниже — единственное место, где ядро знает про фичи вообще.
// Вкладка Kanban сейчас чистая UI-заготовка без сервера — своих маршрутов не
// заводит, вид меняется по шагам пользователя (DOCS/decisions/032, отменяет 030 и 021)

// телеграм-мост Settings: ему нужен и .env (ключ бота), и способ начать ход
// не из браузера — ответ человека в личке продолжает ту же сессию
const telegram = require('./PROJECTS/Settings/telegram-server.js');
// stop и status нужны мосту затем, что не всякое сообщение из Telegram — это
// поручение: «стоп» и «что там» раньше запускали настоящий ход (DOCS/decisions/054)
const telegramLetters = require('./PROJECTS/Settings/telegram-letters-server.js');
const { notifyTurnFinished, planPreamble } = telegram.init({
    setEnvValue,
    ask: askOutsideBrowser,
    startNew: startOutsideBrowser,
    db,
    stop: (sessionId) => stopActiveRun(sessionId || null),
    // для вопроса опросом (telegram-polls-server.js): спросить можно только живую
    // сессию, а ответ ждёт, пока она освободится
    sessionExists: (id) => Boolean(getSessionTitle.get(id)),
    isRunning: (id) => runs.has(id),
    status: () => ({
        running: activeRuns.size,
        titles: [...activeRuns.values()]
            .map((run) => run.sessionId && getSessionTitle.get(run.sessionId)?.title)
            .filter(Boolean),
    }),
});

const featureRoutes = {
    ...graph.createRoutes(),
    ...require('./PROJECTS/Flow/flow-server.js').createRoutes({ db }),
    ...require('./PROJECTS/Sessions/pages-server.js').createRoutes({ db, root: ROOT }),
    ...require('./PROJECTS/Sessions/sessions-server.js').createRoutes({
        sessions: sessionSummaries,
        usage: (id) => sumSessionUsage.get(id),
        activeStartedAt: activeRunStartedAt,
    }),
    ...require('./PROJECTS/Home/home-server.js').createRoutes({
        // сколько сессий просят человека вмешаться: порог шкалы держит
        // turn-judgment.js, чтобы он был один на панель и на пометку в ленте
        needsAttention: () => countNeedsAttention.get(turnJudgment.THRESHOLDS.awaitsHuman, turnJudgment.THRESHOLDS.attentionShown).n,
        sessions: sessionSummaries,
        activeCount: () => activeRuns.size,
    }),
    ...require('./PROJECTS/Karandash/karandash-server.js').createRoutes({ setEnvValue }),
    ...telegram.createRoutes(),
    ...require('./SYSTEM/toolbar-icons-server.js').createRoutes({ db }),
    ...branchPreview.createRoutes({ root: ROOT }),
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

        // что подключено на сервере сейчас — страница без сохранённого выбора
        // берёт отсюда авто-подключённый claude (autoConnectClaude)
        if (urlPath === '/api/agent/status') {
            sendJson(res, { claude: activeTarget ? { id: activeTarget.id, label: activeTarget.label, version: activeVersion } : null });
            return;
        }

        if (urlPath === '/api/agent/detect') {
            const { agent } = await readJson(req);
            sendJson(res, { installs: await agentByName(agent).detect() });
            return;
        }

        if (urlPath === '/api/agent/connect') {
            const { agent, id, openRouterKey } = await readJson(req);
            const adapter = agentByName(agent);
            const target = adapter.targets().find((t) => t.id === id);
            if (!target) {
                sendJson(res, { ok: false, error: `Unknown environment: ${id}` });
                return;
            }

            // ключ из карточки pi в Settings: pi сам не читает его из тела запроса,
            // поэтому кладём его туда же, откуда берёт сам CLI, до первого запуска версии
            if (agent === 'pi' && openRouterKey) savePiOpenRouterKey(openRouterKey);

            const version = await adapter.version(target);
            const models = adapter.models ? await adapter.models(target) : undefined;
            adapter.activate(target);
            if (agent === 'claude') activeVersion = version;
            sendJson(res, { ok: true, id: target.id, label: target.label, version, models });
            return;
        }

        if (urlPath === '/api/agent/stop') {
            const { sessionId } = await readJson(req);
            // реестр запусков общий на все CLI (activeRuns), поэтому и остановка одна
            sendJson(res, { ok: true, stopped: stopActiveRun(sessionId || null) });
            return;
        }

        // память о недоступных исполнителях (DOCS/decisions/071): посмотреть,
        // кого и до какого времени пульт сейчас не берёт, и сбросить, когда
        // лимит обновился раньше срока или пометка больше не нужна
        if (urlPath === '/api/agent/cooldowns') {
            sendJson(res, { ok: true, cooldowns: cooldowns.list() });
            return;
        }

        if (urlPath === '/api/agent/cooldowns/clear') {
            sendJson(res, { ok: true, cooldowns: cooldowns.clear() });
            return;
        }

        if (urlPath === '/api/agent/ask') {
            const body = await readJson(req);
            const adapter = agentByName(body.agent);
            // сторожу уже сказано «можно» — этот процесс доживает последние мгновения
            // и запускать в нём CLI нельзя: ход умрёт вместе с ним, не дописавшись
            // ответ — строка того же потока событий, а не sendJson: клиент читает
            // ask построчным NDJSON и обычный JSON без перевода строки не разберёт
            if (stopping) {
                res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' });
                res.end(`${JSON.stringify({ type: 'error', error: RESTART_ERROR })}\n`);
                return;
            }
            res.writeHead(200, {
                'Content-Type': 'application/x-ndjson; charset=utf-8',
                'Cache-Control': 'no-store',
            });
            // вкладку могли перезагрузить или закрыть — работа CLI продолжается,
            // ответ всё равно попадёт в базу, мы лишь перестаём писать в мёртвый сокет
            let open = true;
            req.on('close', () => { open = false; });

            // записки DOCS/decisions, обязательные к прочтению именно под этот
            // запрос, — подбирает TypeSafe (DOCS/decisions/051). Ждём: подсказка
            // должна уехать вместе с запросом, а не догонять его. Без ключа
            // функция сразу отдаёт null, и ход идёт как раньше
            body.hints = await turnJudgment.pickDecisionHints(body.prompt).catch(() => null);

            // сломавшегося исполнителя сменяет следующий подключённый; его события
            // идут в этот же поток — для страницы это продолжение той же работы
            await askWithFallback(body.agent, body, (event) => {
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
            const { id, after, deltas } = await readJson(req);
            const live = runs.get(id);
            if (!live) {
                sendJson(res, { ok: true, running: false });
                return;
            }

            res.writeHead(200, {
                'Content-Type': 'application/x-ndjson; charset=utf-8',
                'Cache-Control': 'no-store',
            });
            // after — номер последнего события, которое клиент уже видел (или
            // liveSeq из /api/sessions/messages, если он только что прочитал
            // базу). Без него — как раньше: только то, что случится дальше.
            // Запись и подписка идут в одном такте, между ними событие не влезет
            if (Number.isFinite(after)) {
                for (const event of live.events) {
                    if (event.seq > after) res.write(JSON.stringify(event) + '\n');
                }
            }
            // куски текста по мере набора нужны только ленте Sessions: Feed и Flow
            // перечитывают базу на каждый пришедший байт, а в базе кусков нет
            if (deltas) res.__deltas = true;
            live.listeners.add(res);
            req.on('close', () => live.listeners.delete(res));
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

        // правка своей реплики прямо на графе Flow (§10 chat.md). Менять разрешено
        // только строку роли user: остальное — запись того, что модель и инструменты
        // действительно сделали, и подделывать её значило бы врать самой трассой.
        // Почему маршрут здесь, а не в flow-server.js — DOCS/decisions/018
        if (urlPath === '/api/sessions/message/set') {
            const { id, position, text } = await readJson(req);
            if (!id || !Number.isInteger(position) || typeof text !== 'string') {
                sendJson(res, { ok: false, error: 'id, position and text are required' });
                return;
            }
            const row = getMessageRole.get(id, position);
            if (!row) {
                sendJson(res, { ok: false, error: 'Message not found' });
                return;
            }
            if (row.role !== 'user') {
                sendJson(res, { ok: false, error: `Only your own message can be edited, not "${row.role}"` });
                return;
            }
            setMessageText.run(text, id, position);
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
                // ход идёт прямо сейчас: номер последнего события, уже отражённого
                // в этих строках, — с него клиент просит продолжение у attach
                liveSeq: runs.get(id)?.seq ?? null,
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

    // ветка исполнителя живьём: тот же клиент, но прочитанный из её рабочей копии.
    // API сюда не попадает (оно выше и абсолютное), поэтому лента и база общие.
    // Отдаёт модуль целиком — тогда эту развилку можно проверить настоящими
    // запросами, не поднимая сервера (DOCS/decisions/042)
    if (branchPreview.handle(res, urlPath, { root: ROOT, mime: MIME, renderHtml })) return;

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
        const body = ext === '.html'
            ? Buffer.from(renderHtml(data.toString('utf8'), LIVE_RELOAD ? RELOAD_SNIPPET : ''), 'utf8')
            : data;

        res.writeHead(200, {
            'Content-Type': MIME[ext] || 'application/octet-stream',
            'Cache-Control': 'no-store',
        });
        res.end(body);
    });
});

// подстановки страницы и хвост перед </body>: одинаковы для главной копии и для
// предпросмотра ветки, поэтому живут одной функцией, а не двумя похожими
function renderHtml(html, tail) {
    const page = html
        .replace('{{APP_VERSION}}', currentVersion())
        .replace('{{VERSION_LIST}}', versionHistory());
    if (!tail) return page;
    return page.includes('</body>') ? page.replace('</body>', `${tail}</body>`) : page + tail;
}

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
    // печатается после неё — иначе человек идёт на порт, который молчит,
    // и получает таймаут вместо страницы
    console.log('Building the project map — this takes a few seconds...');
    prepareVault();
    console.log(`Server started: http://localhost:${PORT} (runtime: ${detectRuntimePlatform()})`);
    // сторожу: порт занят нами, можно поднимать Hermes-стек
    if (process.send) process.send({ listening: true }, () => {});
    autoConnectClaude();

    if (LIVE_RELOAD) {
        watchFiles();
        console.log('Auto-reload is on — the page will reload after a file is saved.');
    }
});
