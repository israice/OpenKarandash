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
const hermesStack = require('./SYSTEM/core/hermes-stack.js');
const hermesHistoryModule = require('./SYSTEM/core/hermes-history.js');
const hostDeps = require('./SYSTEM/core/host-deps.js');
const branchPreview = require('./SYSTEM/core/branch-preview.js');
const hermesTasks = require('./SYSTEM/core/hermes-tasks.js');
const turnJudgment = require('./SYSTEM/core/turn-judgment.js');

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
# Hermes stack (claude-bridge + Hermes in Docker) started by the watchdog; 0 turns it off
HERMES_STACK=1
# Host dependencies checked/installed by the watchdog (git, python, Docker, claude CLI + login); 0 turns it off
HOST_DEPS=1

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
    // перечисленный руками отставал от кода (PROJECTS/Chat/pages-server.js и
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
            // сервер слушает порт — только теперь поднимаем Hermes и мост: если
            // сервер не стартовал (замок, порт), незачем оставлять после себя
            // контейнер и мост. Один раз: при перезапусках по правке файлов
            // стек уже поднят
            if (message && message.listening && stack && !stackStarted) { stackStarted = true; hermesStack.startAsync(stack); }
            // Settings → Claude → Connect: мост Hermes должен гонять тот же claude
            if (message && message.claudeTarget) hermesStack.setClaudeTarget(message.claudeTarget);
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
            if (signal || code === 0) { hermesStack.stop(); process.exit(0); } // остановлен снаружи или завершился штатно
            // порт занят: правкой server.js это не лечится, ждать нечего. иначе сторож
            // жил бы вечно — крутил опрос файлов и держал cwd проекта, из-за чего папку
            // проекта нельзя переименовать, пока процесс не убьют вручную
            if (code === EXIT_PORT_BUSY || code === EXIT_LOCK_HELD) { hermesStack.stop(); process.exit(code); }
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

    // Мост Hermes — питон-процесс, дочерний сторожу: его код Node не перечитывает,
    // а перезапуска сервера он не требует. Поэтому за claude-bridge/*.py следим
    // отдельно и перезапускаем один мост — раньше правка вступала в силу только
    // после того, как пользователь гасил весь стек руками (DOCS/decisions/029).
    // Список читается на каждом замере: файлы моста заводятся реже, чем меняются,
    // но новый не должен ждать перезапуска сторожа
    const latestBridgeMtime = () => hermesStack.bridgeFiles().reduce((max, file) => {
        try {
            return Math.max(max, fs.statSync(file).mtimeMs);
        } catch {
            return max; // файл унесли — правку поймает соседний
        }
    }, 0);
    let bridgeMtime = latestBridgeMtime();
    let bridgeBusy = false; // перезапуск идёт: замер не должен запускать второй

    setInterval(() => {
        const currentBridge = latestBridgeMtime();
        if (currentBridge !== bridgeMtime && !bridgeBusy) {
            bridgeMtime = currentBridge;
            bridgeBusy = true;
            // сторож не должен падать из-за моста: ошибку пишем и живём дальше
            hermesStack.restartBridge('файл бриджа изменён')
                .catch((err) => console.error('bridge restart failed:', err.message))
                .finally(() => { bridgeBusy = false; });
        }

        const current = latestMtime();
        if (current === mtime) return;

        mtime = current;
        restart();
    }, POLL_MS);

    process.on('exit', (code) => logExit(`watchdog exit: code=${code}`));

    // Ctrl+C — единственная кнопка «стоп» для всего стека: вместе с сервером
    // гасим Hermes и бридж, которые сторож поднял сам (SYSTEM/core/hermes-stack.js).
    // Остановка синхронная — process.exit не ждёт промисов
    const shutdown = (why) => {
        logExit(`watchdog got ${why}`);
        if (child) child.kill('SIGTERM');
        hermesStack.stop();
        process.exit(0);
    };
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => shutdown(signal));

    // На Windows сигнала с клавиатуры может и не быть: wsl.exe (его запускает
    // сервер для WSL-claude и мост для каждого хода) переводит консоль в сырой
    // режим, а убитый (Stop, конец хода) не возвращает его — консоль перестаёт
    // превращать Ctrl+C в событие, и сторож живёт вечно. Программный сигнал
    // (GenerateConsoleCtrlEvent) при этом проходит — так этот случай раньше и
    // «проверялся». Поэтому слушаем клавиатуру сами: в сыром режиме Ctrl+C
    // приходит байтом 0x03 независимо от того, что сделали с консолью до нас.
    // Режим переустанавливаем раз в секунду — следующий wsl.exe снова его собьёт;
    // переключение false→true нужно, иначе setRawMode(true) при уже «своём»
    // сыром режиме ничего не делает
    if (process.platform === 'win32' && process.stdin.isTTY) {
        const arm = () => { try { process.stdin.setRawMode(false); process.stdin.setRawMode(true); } catch { /* консоль отобрали */ } };
        arm();
        process.stdin.resume();
        process.stdin.on('data', (chunk) => { if (chunk.includes(3)) shutdown('Ctrl+C (raw stdin)'); });
        setInterval(arm, 1000).unref();
    }

    // Hermes-стек: проверка зависимостей, .env и образа — до первого запуска
    // сервера (сервер должен стартовать с готовыми node_modules), мост и
    // контейнер — уже параллельно с ним. HERMES_STACK=0 в .env выключает всё это:
    // тогда `node server.js` — только сервер, как раньше
    // Ещё раньше — системные зависимости хоста (git, python, Docker, claude CLI
    // со входом): чего нет — ставится, SYSTEM/core/host-deps.js. Выбранная
    // там цель claude уходит дочернему серверу через env — он подключит её
    // сам, без кнопки Connect в Settings. HOST_DEPS=0 в .env выключает проверку
    const withStack = process.env.HERMES_STACK !== '0';
    if (process.env.HOST_DEPS !== '0') {
        const bridgeEnv = (() => { try { return fs.readFileSync(path.join(ROOT, 'claude-bridge', '.env'), 'utf8'); } catch { return ''; } })();
        const preferredClaude = (bridgeEnv.match(/^CLAUDE_BRIDGE_TARGET=(\w+)/m) || [])[1];
        const { claudeTarget } = hostDeps.ensureHost({ preferredClaude, withStack });
        if (claudeTarget) process.env.CLAUDE_AUTOCONNECT = claudeTarget;
    }
    const stack = withStack ? hermesStack.prepare(ROOT) : null;
    let stackStarted = false;
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
async function runTurn({ target, prompt, sessionId, model, effort, mode }, send, drive) {
    const runId = nextRunId++;
    // startedAt — момент начала именно этого хода: по нему панель Sessions
    // тикает «живую» длительность активной сессии (см. activeRunStartedAt
    // и /api/fragment/chat-sessions), пока finishExchange не зафиксирует
    // итоговый duration_ms в базе
    const run = { sessionId: sessionId || null, child: null, done: null, target, startedAt: Date.now() };
    let resolveDone;
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
        emit(event) {
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
            }).catch(() => null);
            // решение о письме принимается до записи хода: оно само часть
            // суждения и должно лежать в той же строке, а не теряться
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
            if (notify.send) {
                notifyTurnFinished({
                    sessionId: ctx.session,
                    title: getSessionTitle.get(ctx.session)?.title || '',
                    text: ctx.answer || `⚠️ ${ctx.errorText}`,
                });
            }
        }
        // работа окончена — отпускаем подключившиеся страницы
        if (ctx.session) {
            for (const listener of runs.get(ctx.session)?.listeners || []) listener.end();
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
// hints — подобранные записки DOCS/decisions (SYSTEM/core/turn-judgment.js).
// Они едут тем же каналом, что и пересказ истории: это не вопрос человека,
// а служебная преамбула, поэтому в тексте строки сессии её быть не должно —
// зато она попадает в «Sent to model» там, где коннектор его пишет
function resumeAndHandoff(sessionId, targetId, hints) {
    const resumeId = sessionId ? getCliSession.get(sessionId, targetId)?.id : null;
    const history = sessionId && !resumeId ? handoffPreamble(sessionId) : '';
    return { resumeId, handoff: turnJudgment.hintPreamble(hints) + history };
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

async function askClaude({ prompt, model, effort, sessionId, mode, hints }, send) {
    if (!activeTarget) return send({ type: 'error', error: 'Claude is not connected' });
    // цель фиксируем на весь запуск: пока идёт работа, в настройках могли переключить CLI
    const target = activeTarget;
    if (!prompt) return send({ type: 'error', error: 'Empty request' });
    // Hermes под капотом (DOCS/decisions/029): пока его агент поднят сторожем,
    // ход ведёт он — со своей памятью, скиллами и инструментами, — а мозгом ему
    // служит тот же claude, что выбран здесь (мост гоняет подключённую цель).
    // Модель и effort из шапки Hermes не принимает: модель задаёт его конфиг.
    // Агента нет (HERMES_STACK=0, Docker не запущен) — прямой claude, как раньше
    if (await hermesReady()) return askHermes({ prompt, sessionId, mode, hints }, send);
    if (model && !CLAUDE_MODELS.includes(model)) {
        return send({ type: 'error', error: `Unknown model: ${model}` });
    }
    if (effort && !EFFORT_LEVELS.includes(effort)) {
        return send({ type: 'error', error: `Unknown effort level: ${effort}` });
    }

    const { resumeId, handoff } = resumeAndHandoff(sessionId, target.id, hints);

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

    return runTurn({ target, prompt, sessionId, model, effort, mode }, send, async (ctx) => {
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

async function askOpenCode({ prompt, model, sessionId, mode, hints }, send) {
    if (!activeOpenCodeTarget) return send({ type: 'error', error: 'OpenCode is not connected' });
    const target = activeOpenCodeTarget;
    if (!prompt) return send({ type: 'error', error: 'Empty request' });

    const { resumeId, handoff } = resumeAndHandoff(sessionId, target.id, hints);
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
                    const detail = state.title || state.input?.command || state.input?.filePath || '';
                    position = recordStep(ctx.session, `${toolName} ${detail}`.trim(), toolName, state.input, part.callID, null, null, part);
                    toolPositions.set(part.callID, position);
                    ctx.emit(toolLabel({ name: toolName, input: state.input || {} }));
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

async function askPi({ prompt, model, effort, sessionId, mode, hints }, send) {
    if (!activePiTarget) return send({ type: 'error', error: 'pi is not connected' });
    const target = activePiTarget;
    if (!prompt) return send({ type: 'error', error: 'Empty request' });
    if (effort && !EFFORT_LEVELS.includes(effort)) {
        return send({ type: 'error', error: `Unknown effort level: ${effort}` });
    }

    const { resumeId, handoff } = resumeAndHandoff(sessionId, target.id, hints);

    const args = ['-p', '--mode', 'json'];
    if (model) args.push('--model', model);
    if (effort) args.push('--thinking', effort);
    if (resumeId) args.push('--session', resumeId);
    if (mode === 'Chat') args.push('--tools', PI_CHAT_TOOLS);

    const input = handoff + (mode === 'Chat' ? CHAT_PREAMBLE + prompt : prompt);
    // `--` обязателен: без него промпт, начинающийся с дефиса, ушёл бы в разбор флагов
    args.push('--', input);

    return runTurn({ target, prompt, sessionId, model, effort, mode }, send, async (ctx) => {
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

// ---------- коннектор Hermes agent API ----------
//
// Hermes живёт не рядом на хосте, как остальные CLI, а в Docker
// (docker-compose.hermes.yml) и сам отдаёт готовый OpenAI-совместимый API
// полноценного агента — со своими инструментами, памятью и скиллами, а не
// голой моделью. Поэтому коннектор не спавнит процесс, а ходит по HTTP тем же
// путём, что уже проверен в hermes-using-claude. DOCS/decisions/029.
const HERMES_API_URL = (process.env.HERMES_API_URL || 'http://127.0.0.1:8642/v1').replace(/\/+$/, '');
const HERMES_API_KEY = process.env.HERMES_API_KEY || '';
const HERMES_ASK_TIMEOUT_MS = Number(process.env.HERMES_ASK_TIMEOUT_MS) || 3_600_000;
const HERMES_TARGETS = [{ id: 'hermes-docker', label: 'Docker', url: HERMES_API_URL }];

let activeHermesTarget = null;

function hermesAuthHeaders() {
    return HERMES_API_KEY ? { Authorization: `Bearer ${HERMES_API_KEY}` } : {};
}

// проверка живости agent API: сервер маршрутизирует askClaude через Hermes,
// когда тот поднят (hermesReady), а Settings его не показывает (DOCS/decisions/029)
async function detectHermesInstalls() {
    const checks = await Promise.allSettled(
        HERMES_TARGETS.map(async (target) => {
            const res = await fetch(`${target.url}/models`, { headers: hermesAuthHeaders(), signal: AbortSignal.timeout(5000) });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return { id: target.id, label: target.label, version: 'agent API' };
        })
    );
    return checks.filter((c) => c.status === 'fulfilled').map((c) => c.value);
}

let hermesProbe = { ok: false, at: 0 };
async function probeHermes() {
    const ttl = hermesProbe.ok ? 60_000 : 3_000;
    if (Date.now() - hermesProbe.at < ttl) return hermesProbe.ok;
    let ok = false;
    try {
        const res = await fetch(`${HERMES_TARGETS[0].url}/models`, { headers: hermesAuthHeaders(), signal: AbortSignal.timeout(2000) });
        ok = res.ok;
    } catch { ok = false; }
    hermesProbe = { ok, at: Date.now() };
    if (ok && !activeHermesTarget) activeHermesTarget = HERMES_TARGETS[0];
    return ok;
}

// Контейнер Hermes поднимается около минуты после старта сервера, а первый
// вопрос из чата обычно приходит раньше. Отдать его прямому claude было бы
// тихой подменой — поэтому в стартовое окно ждём Hermes, а не обходим его.
// Позже окна не ждём: если агента нет (HERMES_STACK=0, Docker выключен),
// каждый ход тормозил бы впустую — тогда прямой claude сразу
const HERMES_STARTUP_WINDOW_MS = 150_000;
const serverStartedAt = Date.now();
async function hermesReady() {
    if (process.env.HERMES_STACK === '0') return false;
    if (await probeHermes()) return true;
    const deadline = serverStartedAt + HERMES_STARTUP_WINDOW_MS;
    while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2000));
        if (await probeHermes()) return true;
    }
    return false;
}

// Разговор с Hermes идёт через его API сессий (/api/sessions/{id}/chat/stream),
// а не через /v1/chat/completions: только поток сессии отдаёт ход по шагам —
// старт и конец каждого инструмента (tool.started/completed/failed), а по
// завершении — расшифровку всего хода (run.completed.messages) с текстами
// между вызовами и результатами инструментов. Так страница Sessions видит у
// Hermes то же, что у Claude и pi: каждый вызов и его результат, а не только
// итоговый текст — иначе разбирать, где ход споткнулся, было не по чему
// (DOCS/decisions/029). Id сессии Hermes хранится в session_cli под целью
// 'hermes', как у остальных CLI; свою историю Hermes ведёт сам, а сессии,
// начатой другим CLI, отдаём пересказ последних ходов (handoffPreamble)
const hermesSessionsBase = (url) => url.replace(/\/v1\/?$/, '');

function hermesRequest(url, { method = 'POST', body, timeoutMs, onSpawn, onEvent } = {}) {
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? '' : JSON.stringify(body);
        const target = new URL(url);
        const req = http.request({
            hostname: target.hostname,
            port: target.port || 80,
            // вместе со строкой запроса: у истории сессии (?order=oldest&limit=…)
            // без неё Hermes отдал бы последнюю страницу вместо запрошенной
            path: target.pathname + target.search,
            method,
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
                Accept: onEvent ? 'text/event-stream' : 'application/json',
                ...hermesAuthHeaders(),
            },
        });

        // Stop гасит запрос тем же способом, что и дерево процессов у CLI:
        // killProcessTree вызывает .kill() на этом объекте (child.pid тут нет —
        // ветка taskkill для Windows у неё пропускается сама собой)
        const fakeChild = { kill: () => req.destroy(new Error('Stopped by the user')), __stoppedByUser: false };
        onSpawn?.(fakeChild);

        let finished = false;
        const timer = setTimeout(() => {
            finished = true;
            req.destroy(new Error(`Timed out (${Math.round(timeoutMs / 1000)}s)`));
        }, timeoutMs);

        const done = (err, value) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            err ? reject(err) : resolve(value);
        };

        req.on('error', (err) => {
            done(fakeChild.__stoppedByUser ? new Error('Stopped by the user') : err);
        });

        req.on('response', (res) => {
            let text = '';
            // SSE: кадры разделены пустой строкой, в кадре строки event:/data:
            const frame = (raw) => {
                let name = 'message';
                const data = [];
                for (const line of raw.split(/\r?\n/)) {
                    if (line.startsWith('event:')) name = line.slice(6).trim();
                    else if (line.startsWith('data:')) data.push(line.slice(5).trim());
                }
                if (!data.length) return;
                let parsed;
                try { parsed = JSON.parse(data.join('\n')); } catch { return; }
                onEvent(name, parsed);
            };
            res.on('data', (chunk) => {
                text += chunk;
                if (!onEvent || res.statusCode >= 400) return;
                let cut;
                while ((cut = text.indexOf('\n\n')) !== -1) {
                    frame(text.slice(0, cut));
                    text = text.slice(cut + 2);
                }
            });
            res.on('end', () => {
                if (res.statusCode >= 400) return done(Object.assign(new Error(text.trim() || `Hermes returned ${res.statusCode}`), { status: res.statusCode }));
                if (onEvent) { if (text.trim()) frame(text); return done(null, null); }
                try { done(null, text.trim() ? JSON.parse(text) : null); } catch { done(new Error('Hermes returned a non-JSON response')); }
            });
        });

        req.end(payload);
    });
}

// текст, который на самом деле — запрос инструмента по текстовому протоколу
// моста: распознавание общее с разбором истории (SYSTEM/core/hermes-history.js),
// чтобы сырой объект не ушёл человеку в ленту и в телеграм под видом ответа
const { isRawToolCall } = hermesHistoryModule;

// Раньше единственный нераспознанный текстовый вызов сразу обрывал весь ход
// («Hermes ended the turn with a tool call written as text…»). Внутри моста
// уже есть своя коррекция (MAX_CORRECTIONS в claude-bridge/cli_backend.py) —
// это вторая, внешняя линия защиты: если и после неё ответ всё равно похож на
// нераспознанный вызов, просим модель переоформить его в той же сессии Hermes,
// ограниченное число раз, а не сдаёмся на первом сорвавшемся вызове.
const MAX_RAW_TOOL_CALL_RETRIES = 2;
const RAW_TOOL_CALL_RETRY_NUDGE = 'Your previous reply looked like a tool call, but it was delivered as plain '
    + 'text and NOTHING was executed. If you meant to call a tool, do it properly now. If that was your real '
    + 'final answer, restate it in plain prose without any tool-call-looking JSON.';

// короткая подпись вызова для строки шага — как toolLabel у Claude
function hermesToolDetail(args) {
    const a = args && typeof args === 'object' ? args : {};
    const detail = a.command || a.path || a.file_path || a.pattern || a.query || a.url || a.name || '';
    return String(detail).slice(0, 120);
}

// ---------- история Hermes → лента ----------
//
// Поток сессии Hermes отдаёт только старт и конец инструментов верхнего уровня.
// Тексты между вызовами, размышления, сжатие контекста, шаги помощников, пометки
// моста и ходы, пришедшие мимо нас, есть только в его истории — поэтому ход
// после завершения пересобирается по ней, а сессия перед показом добирает
// недостающее (DOCS/decisions/039). Разбор живёт в SYSTEM/core/hermes-history.js —
// здесь только доступ к нашей базе и адрес Hermes.
// доступ разбора истории к нашей базе; им же пишет ход Hermes вживую
// (размышления и шаги помощников), чтобы Sessions, Feed и Flow читали одно и то же
const hermesStore = {
    cursor: (sessionId) => hermesSyncCursor.get(sessionId)?.id ?? null,
    childCursor: (sessionId, childId) => hermesChildCursor.get(sessionId, childId)?.id ?? null,
    lastMessageTime: (sessionId) => Date.parse(lastMessageTime.get(sessionId)?.at || ''),
    touch: (sessionId) => touchSession.run(new Date().toISOString(), sessionId),
    truncate: (sessionId, fromPosition) => archiveAndDeleteFrom(sessionId, fromPosition),
    append: (sessionId, entry, { parentToolUseId = null, childSession = null, model = null } = {}) => {
        let position = null;
        if (entry.kind === 'user') {
            position = countMessages.get(sessionId).n;
            upsertMessage.run(sessionId, position, 'user', entry.text, entry.at, null, null);
            // эта ветка пишет строку человека мимо startExchange, поэтому
            // помечаем её здесь — иначе перенесённые из Hermes вопросы
            // оказались бы единственными строками без источника
            stampEvent(sessionId, position, 'text', 'human', { source: 'user', provider: null });
        } else if (entry.kind === 'assistant') {
            // сырым событием для перенесённой строки служит запись истории Hermes:
            // это и есть то, что источник нам отдал, до нашего разбора
            position = recordAssistantText(sessionId, entry.text, model || 'hermes', null, parentToolUseId, entry);
        } else if (entry.kind === 'thinking') {
            position = recordThinking(sessionId, entry.text, null, entry);
            if (parentToolUseId) setMessageToolIds.run(null, parentToolUseId, sessionId, position);
        } else if (entry.kind === 'notice') {
            position = recordNotice(sessionId, entry.name, entry.text, parentToolUseId, entry);
        } else {
            position = recordStep(
                sessionId,
                // шаг помощника — с «↳», как и вживую: в плоской ленте чата иначе не отличить
                `${childSession ? '↳ ' : ''}${entry.name} ${hermesToolDetail(entry.args)}`.trim(),
                entry.name, entry.args, entry.toolCallId || null, parentToolUseId, null, entry,
            );
            setMessageToolResult.run(clip(entry.result) || null, entry.failed ? 1 : 0, null, sessionId, position);
        }
        // время строки — когда это было у Hermes, а не когда мы перенесли
        if (entry.at) setMessageCreatedAt.run(entry.at, sessionId, position);
        // отметка «эта строка перенесена из истории Hermes» и есть курсор
        setMessageExtraMeta.run(JSON.stringify({
            hermesMessageId: entry.hermesMessageId,
            viaHermesHistory: true,
            ...(childSession ? { hermesChildSession: childSession } : {}),
        }), sessionId, position);
        // подзадача — это дочерняя сессия помощника у Hermes, её id и есть
        // настоящий task_id. Своих идентификаторов не выдумываем: граф задач
        // живёт у оркестратора (DOCS/decisions/040). Номера попытки Hermes
        // сегодня не отдаёт — attempt_id остаётся пустым до этапа 9
        stampTask(sessionId, position, childSession, null);
        return position;
    },
};
const hermesHistory = hermesHistoryModule.createHermesHistory({
    request: (url, opts) => hermesRequest(url, opts),
    log: (message) => console.error(message),
    store: hermesStore,
});

// сессия Hermes, связанная с нашей: по любой цели Hermes, а не только по той,
// что завела сессию, — сессию, начатую Claude и продолженную Hermes, тоже надо добирать
function hermesLinkFor(sessionId) {
    for (const target of HERMES_TARGETS) {
        const hermesId = getCliSession.get(sessionId, target.id)?.id;
        if (hermesId) return { target, hermesId };
    }
    return null;
}

// Дотянуть переписку сессии, если по ней не идёт наш собственный ход: во время
// хода строки пишет поток, а по его окончании — пересборка хода.
async function syncHermesHistory(sessionId) {
    // сессии у нас нет (удалена) — дотягивать некуда: строки легли бы сиротами
    if (!getSessionTitle.get(sessionId)) return 0;
    const link = hermesLinkFor(sessionId);
    if (!link) return 0;
    for (const run of activeRuns.values()) if (run.sessionId === sessionId) return 0;
    const added = await hermesHistory.sync(sessionId, link.hermesId, hermesSessionsBase(link.target.url));
    stampHermesAttempts(sessionId, link.hermesId);
    return added;
}

// Сессии Hermes, начатые не из интерфейса (его дашборд, API, расписание), тоже
// попадают в список: заводим нашу сессию, связь в session_cli и добираем
// историю. Сессию, у которой связь уже есть, не трогаем — в том числе ту, что
// человек у нас удалил: связь остаётся, и удалённая не воскресает.
const HERMES_IMPORT_EVERY_MS = 60_000;
let hermesImportAt = 0;
async function importForeignHermesSessions() {
    if (!activeHermesTarget || Date.now() - hermesImportAt < HERMES_IMPORT_EVERY_MS) return 0;
    hermesImportAt = Date.now();
    const target = activeHermesTarget;
    const base = hermesSessionsBase(target.url);
    let sessions;
    try {
        sessions = await hermesHistoryModule.fetchTopSessions((url, opts) => hermesRequest(url, opts), base);
    } catch (err) {
        console.error(`hermes session import failed: ${err.message}`);
        return 0;
    }
    let imported = 0;
    for (const s of sessions) {
        if (!s.id || hasCliSessionLink.get(s.id)) continue;
        // ok-<наш id> — сессия, которую завели мы сами, но связь на неё потерялась
        const sessionId = String(s.id).startsWith('ok-')
            ? String(s.id).slice(3)
            : `${target.id}-import-${String(s.id).replace(/[^\w-]/g, '_')}`;
        const at = new Date((Number(s.last_active || s.started_at) || Date.now() / 1000) * 1000).toISOString();
        upsertSession.run(sessionId, extractTitle(s.title || s.preview || s.id, 300), at, target.id);
        setCliSession.run(sessionId, target.id, s.id);
        await hermesHistory.sync(sessionId, s.id, base);
        touchSession.run(at, sessionId);
        imported++;
    }
    if (imported && clients.size) notifyClients('fragment:chat-sessions');
    return imported;
}
// раз в минуту, пока Hermes подключён: новая сессия у него появляется в нашем
// списке сама, без действий человека
setInterval(() => {
    importForeignHermesSessions().catch((err) => console.error(`hermes session import failed: ${err.message}`));
}, HERMES_IMPORT_EVERY_MS).unref();

// Название сессии у Hermes обязано быть неповторимым: на второй такой же он
// отвечает отказом `invalid_title` («Title already in use by session …»).
// Мы же брали названием первые строки запроса, и любой повтор одного и того же
// текста — тот же комментарий Karandash к той же кнопке — ронял ход, не начав
// его (сессия hermes-docker-mtr2tndn). Название — вещь показная, поэтому при
// таком отказе повторяем создание, дописав к нему наш id сессии: он уникален.
// Отдельно от него живёт конфликт по id (409) — это наша же сессия, которая у
// Hermes уже есть после перезапуска нашей базы, её просто продолжаем.
function isHermesTitleTaken(err) {
    return /invalid_title|title already in use/i.test(String(err?.message || ''));
}

async function createHermesSession(base, hermesId, prompt) {
    const create = (title) => hermesRequest(`${base}/api/sessions`, { body: { id: hermesId, title }, timeoutMs: 30_000 });
    try {
        await create(prompt.slice(0, 80));
        return;
    } catch (err) {
        if (err.status === 409) return;
        if (!isHermesTitleTaken(err)) throw err;
    }
    try {
        await create(`${prompt.slice(0, 60)} · ${hermesId}`);
    } catch (err) {
        if (err.status !== 409) throw err;
    }
}

// чем Hermes кончает ход — все три несут расшифровку и расход (см. onEvent ниже)
const HERMES_TERMINAL_EVENTS = new Set(['run.completed', 'run.failed', 'run.cancelled']);
// события потока, которым строка в ленте не нужна: run.started повторяет наш же
// запрос, message.started и done — пустые рамки, assistant.delta — куски текста,
// который целиком придёт в assistant.completed и в расшифровке
const HERMES_SILENT_EVENTS = new Set(['run.started', 'message.started', 'assistant.delta', 'done']);

async function askHermes({ prompt, sessionId, mode, model, effort, hints }, send) {
    // Правило «исполнитель хода = выбранный в Settings агент» (DOCS/decisions/043):
    // Hermes — оркестратор, но мозгом ему по умолчанию служит claude через
    // claude-bridge. Если сессию ведёт другой прямой CLI (opencode/codex/pi),
    // продолжать её обязан он — своей историей и своими моделями, а не Hermes
    // с всегда-клодом за спиной. Иначе «сделал, проверь» уходит в
    // claude-bridge-sonnet и падает, когда подписка claude исчерпана, хотя
    // выбранный в Settings агент жив (случай 2026-09-18). Для Claude-сессии
    // Hermes остаётся как в DOCS/decisions/029: мозг и есть тот же claude.
    if (sessionId) {
        const owner = agentNameByTarget(getSessionMeta.get(sessionId)?.target);
        if (owner && owner !== 'hermes' && owner !== 'claude') {
            const adapter = AGENTS[owner];
            if (!adapter.connected()) {
                return send({ type: 'error', error: `${owner} is not connected — open Settings and connect it` });
            }
            return adapter.ask({ prompt, sessionId, mode, model, effort, hints }, (event) => send(event));
        }
    }
    if (!activeHermesTarget) return send({ type: 'error', error: 'Hermes is not connected' });
    const target = activeHermesTarget;
    if (!prompt) return send({ type: 'error', error: 'Empty request' });

    return runTurn({ target, prompt, sessionId, mode }, send, async (ctx) => {
        const base = hermesSessionsBase(target.url);
        // Hermes принимает свой id сессии: берём производный от нашего, чтобы
        // его было видно в hermes-home/sessions рядом с нашей базой. Искать
        // запись надо под той же целью, под которой её пишет ctx.begin
        // (target.id): с жёстким 'hermes' она не находилась никогда, и каждый
        // ход уходил с преамбулой «у тебя нет своей истории», хотя Hermes держит
        // её сам — модель путалась и повторяла разбор с нуля
        const { resumeId, handoff } = resumeAndHandoff(sessionId, target.id, hints);
        let hermesId = resumeId;
        if (!hermesId) {
            hermesId = `ok-${ctx.session}`;
            await createHermesSession(base, hermesId, prompt);
            ctx.begin(hermesId);
        }
        if (handoff) setMessageInputSent.run(handoff + prompt, ctx.session, ctx.userPosition);

        // Помощники (delegate_task) работают в своих дочерних сессиях Hermes, и
        // его поток о них молчит — пока идёт вызов, опрашиваем их историю и
        // показываем новые шаги вживую. В базу пишет пересборка хода в конце.
        const shownChild = new Set();
        let childPoll = null;
        // id живой строки вызова delegate_task: к нему вкладываются шаги помощника,
        // пока пересборка хода не заменит его настоящим id вызова у Hermes
        let liveDelegateId = null;
        // опрос, начатый до конца хода, не должен дописать строки после пересборки —
        // они легли бы дублями поверх перенесённых из истории
        let pollStopped = false;
        let pollInFlight = null;
        const pollChildren = () => {
            if (pollInFlight || pollStopped) return pollInFlight;
            pollInFlight = pollChildrenOnce().finally(() => { pollInFlight = null; });
            return pollInFlight;
        };
        const pollChildrenOnce = async () => {
            let entries;
            try { entries = await hermesHistory.peekChildren(hermesId, base); } catch { return; }
            if (pollStopped) return;
            for (const entry of entries) {
                const key = entry.hermesMessageId;
                if (!key || shownChild.has(key)) continue;
                shownChild.add(key);
                // в базу сразу, а не только в поток: Feed и Flow строятся из базы
                const shown = entry.kind === 'user'
                    ? { ...entry, kind: 'notice', name: 'hermes.subagent-task', text: `Задача помощнику: ${entry.text}` }
                    : entry;
                hermesStore.append(ctx.session, shown, { parentToolUseId: liveDelegateId, childSession: entry.childSession, model: ctx.meta.model });
                emitHermesEntry(ctx, shown, true);
            }
        };
        const startChildPoll = () => {
            if (childPoll) return;
            childPoll = setInterval(pollChildren, HERMES_CHILD_POLL_MS);
            childPoll.unref?.();
        };
        let liveThinking = false;
        // сами тексты — чтобы пересборка хода не стёрла их, если в истории Hermes их нет
        const liveThoughts = [];
        // чем кончился несостоявшийся ход (run.failed / run.cancelled) — см. onEvent
        const terminalNotices = [];
        let liveToolCount = 0;

        // один запрос к Hermes и разбор его расшифровки в тексты/шаги. Вынесено в
        // функцию, чтобы при сорвавшемся текстовом вызове инструмента (весь ответ —
        // isRawToolCall) можно было отправить в ту же сессию поправку и повторить,
        // а не обрывать ход на первом же таком случае
        const runOnce = async (message) => {
            // позиции строк шагов по порядку вызовов: результат инструмента приходит
            // не в tool.completed (там нет вывода), а в расшифровке run.completed —
            // сообщения роли tool идут в том же порядке, что вызовы
            const steps = []; // { position, name, done }
            const texts = []; // тексты ассистента из расшифровки, последний — итог
            let finalText = '';
            let failure = null;

            const onEvent = (name, ev) => {
                if (name === 'tool.started') {
                    const detail = hermesToolDetail(ev.args);
                    const toolName = ev.tool_name || 'tool';
                    const position = recordStep(ctx.session, `${toolName} ${detail}`.trim(), toolName, ev.args ?? null, null, null, null, ev);
                    steps.push({ position, name: toolName, done: false });
                    liveToolCount++;
                    ctx.emit({ type: 'tool', name: toolName, detail });
                    if (toolName === 'delegate_task') {
                        liveDelegateId = `live-delegate-${ctx.session}-${position}`;
                        setMessageToolIds.run(liveDelegateId, null, ctx.session, position);
                        startChildPoll();
                    }
                    return;
                }
                // размышление модели по ходу: Hermes шлёт его событием прогресса
                // с именем _thinking (до 500 символов) — показываем сразу, полный
                // текст запишет пересборка хода
                if (name === 'tool.progress' && ev.tool_name === '_thinking' && ev.delta) {
                    liveThinking = true;
                    liveThoughts.push({ text: String(ev.delta), toolsBefore: liveToolCount, at: new Date().toISOString() });
                    // и в базу: Feed и Flow видят ход по базе, а не по потоку
                    recordThinking(ctx.session, String(ev.delta), null, ev);
                    ctx.emit({ type: 'thinking', text: String(ev.delta) });
                    return;
                }
                if (name === 'tool.completed' || name === 'tool.failed') {
                    const step = steps.find((s) => !s.done && s.name === ev.tool_name) || steps.find((s) => !s.done);
                    if (step) {
                        step.done = true;
                        step.failed = name === 'tool.failed';
                        // вывода в событии нет — пока только факт; текст дойдёт из расшифровки
                        setMessageToolResult.run(ev.preview ? clip(String(ev.preview)) : null, step.failed ? 1 : 0, null, ctx.session, step.position);
                        appendRaw(ctx.session, step.position, ev);
                    }
                    return;
                }
                if (name === 'assistant.completed') { finalText = ev.content || ''; return; }
                // ход Hermes кончается одним из трёх событий (terminal_run_status в
                // его api_server_runs.py): completed, failed (оборван лимитом шагов
                // или ошибкой) и cancelled (остановлен). Расшифровку и расход несут
                // все три — раньше разбирался только первый, и у оборванного хода
                // пропадали вывод инструментов и токены
                if (HERMES_TERMINAL_EVENTS.has(name)) {
                    ctx.meta.resultRaws.push(ev);
                    if (name !== 'run.completed') {
                        const why = ev.turn_exit_reason ? `: ${ev.turn_exit_reason}` : '';
                        const text = `Hermes завершил ход со статусом ${name.slice(4)}${why}`;
                        // в базу — после пересборки хода: она стирает строки потока
                        // и пишет ход заново по истории Hermes, где этой пометки нет
                        terminalNotices.push({ name: `hermes.${name}`, text, ev });
                        ctx.emit({ type: 'notice', name: `hermes.${name}`, text });
                    }
                    const usage = ev.usage || {};
                    // автоповтор — это ещё один запрос в том же ходе: расход складываем,
                    // а не перезаписываем последним
                    ctx.meta.usage.inputTokens += usage.input_tokens || 0;
                    ctx.meta.usage.outputTokens += usage.output_tokens || 0;
                    // модель Hermes выбирает сам — узнаём её из runtime-метаданных ответа,
                    // чтобы окно контекста (contextWindowFor) считалось по реальной модели,
                    // а не оставалось неизвестным всю сессию
                    if (!ctx.meta.model && ev.runtime?.model) ctx.meta.model = ev.runtime.model;
                    let toolIndex = 0;
                    for (const m of ev.messages || []) {
                        if (m.role === 'tool') {
                            const step = steps[toolIndex++];
                            if (!step) continue;
                            const output = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
                            setMessageToolResult.run(clip(output), step.failed ? 1 : 0, null, ctx.session, step.position);
                            appendRaw(ctx.session, step.position, m);
                        } else if (m.role === 'assistant') {
                            // размышление модели идёт своим полем, а не текстом ответа:
                            // мост достаёт его из потока Claude и отдаёт как
                            // reasoning_content (claude-bridge/server.py). Пишем строкой
                            // роли thinking — лента показывает её курсивом рядом с шагами
                            const reasoning = m.reasoning_content || m.reasoning || '';
                            // уже записанное по потоку не дублируем
                            if (typeof reasoning === 'string' && reasoning.trim() && !liveThinking) {
                                recordThinking(ctx.session, reasoning, null, m);
                                ctx.emit({ type: 'thinking', text: reasoning });
                            }
                            if (typeof m.content === 'string' && m.content.trim()) texts.push(m.content);
                        }
                    }
                    // у askClaude (askHermes её замена, DOCS/decisions/029) заполнение окна
                    // считается и шлётся отсюда же, событием result — здесь его аналог
                    // run.completed. Без этого датчик контекста в шапке чата навсегда
                    // застревал на значении первого хода (или на «—», пока хода не было)
                    const window = contextWindowFor(ctx.meta.model);
                    const percent = Math.min(100, Math.round((usage.input_tokens || 0) / window * 100));
                    if (ctx.session) setSessionContext.run(percent, window, ctx.session);
                    ctx.emit({ type: 'context', percent, window, used: usage.input_tokens || 0 });
                    return;
                }
                if (name === 'error') { failure = ev.message || 'Hermes run failed'; return; }
                // событие, под которое ветки нет, всё равно оставляет след — тот же
                // принцип, что у стрима CLI (DOCS/decisions/012). Мимо идут только
                // заведомо пустые для ленты: их содержимое уже лежит в других строках
                if (name === 'tool.progress' && ev.tool_name === '_thinking') return; // пустое размышление
                if (!HERMES_SILENT_EVENTS.has(name)) recordTopLevelEvent(ctx.session, { ...ev, type: `hermes:${name}` });
            };

            await hermesRequest(`${base}/api/sessions/${encodeURIComponent(hermesId)}/chat/stream`, {
                body: { message },
                timeoutMs: HERMES_ASK_TIMEOUT_MS,
                onSpawn: (fakeChild) => { ctx.run.child = fakeChild; },
                onEvent,
            });

            if (failure) return { failure };
            // тексты между вызовами — своими строками, как у Claude; итог — последний
            if (!texts.length && finalText) texts.push(finalText);
            return { texts };
        };

        // вызов инструмента, который модель написала текстом (мост его не
        // разобрал), — не ответ: в ленту и в телеграм он ушёл бы сырым JSON, а в
        // пересказ следующего хода — примером, который модель повторит. Раньше
        // единственный такой ответ сразу обрывал ход; теперь просим Hermes
        // переоформить вызов в той же сессии, ограниченное число раз — вторая,
        // внешняя линия защиты поверх коррекции внутри самого моста
        // (MAX_CORRECTIONS в claude-bridge/cli_backend.py)
        const sentText = handoff + prompt;
        let message = sentText;
        let texts = [];
        let hadRawCalls = false;
        let failure = null;
        // остановка человеком или обрыв связи: пересборку всё равно делаем — иначе
        // следующее открытие сессии дотянуло бы этот ход из истории Hermes вторым
        // экземпляром поверх записанных по потоку строк
        let thrown = null;
        try {
            for (let attempt = 0; attempt <= MAX_RAW_TOOL_CALL_RETRIES; attempt++) {
                const result = await runOnce(message);
                if (result.failure) { failure = result.failure; break; }
                const rawCalls = result.texts.filter(isRawToolCall);
                hadRawCalls = rawCalls.length > 0;
                texts = result.texts.filter((t) => !isRawToolCall(t));
                if (texts.length || !hadRawCalls || attempt === MAX_RAW_TOOL_CALL_RETRIES) break;
                message = RAW_TOOL_CALL_RETRY_NUDGE;
                // поправка ушла модели от имени сервера — человек должен это видеть,
                // на всех страницах сразу, поэтому и в базу
                const nudgeNotice = `Сервер попросил модель переоформить вызов инструмента: ${message}`;
                recordNotice(ctx.session, 'server.retry-nudge', nudgeNotice, null);
                ctx.emit({ type: 'notice', name: 'server.retry-nudge', text: nudgeNotice });
            }
        } catch (err) {
            thrown = err;
        } finally {
            if (childPoll) clearInterval(childPoll);
            pollStopped = true;
            if (pollInFlight) await pollInFlight;
        }

        // Ход целиком — по истории Hermes: тексты между вызовами на своих местах,
        // размышления, пометки моста, автоповторы, сжатие контекста, шаги
        // помощников. Всё, что человек ещё не видел вживую, показываем сейчас.
        // Не удалось (Hermes недоступен) — остаются строки, записанные по потоку.
        const rebuilt = await hermesHistory.rebuild(ctx.session, hermesId, base, {
            fromPosition: ctx.userPosition + 1,
            sentText,
            nudgeText: RAW_TOOL_CALL_RETRY_NUDGE,
            model: ctx.meta.model,
            liveToolCount,
            liveThoughts,
        });
        if (rebuilt) {
            if (rebuilt.children.length) stampHermesAttempts(ctx.session, hermesId);
            for (const entry of rebuilt.entries) {
                if (entry.kind === 'notice' && entry.name !== 'server.retry-nudge') emitHermesEntry(ctx, entry, false);
                if (entry.kind === 'thinking' && !liveThinking && !rebuilt.partial) emitHermesEntry(ctx, entry, false);
            }
            for (const entry of rebuilt.children) {
                if (!shownChild.has(entry.hermesMessageId)) emitHermesEntry(ctx, entry, true);
            }
        }

        for (const n of terminalNotices) recordNotice(ctx.session, n.name, n.text, null, n.ev);

        if (thrown) throw thrown;
        if (failure) return ctx.fail(failure);
        const answers = rebuilt && !rebuilt.partial ? rebuilt.entries.filter((e) => e.kind === 'assistant') : [];
        if (answers.length) {
            // тексты между вызовами уже на своих местах в базе — вживую их ещё не было
            for (const entry of answers) ctx.emit({ type: 'text', text: entry.text });
            const last = answers[answers.length - 1];
            ctx.answer = last.text;
            ctx.assistantPosition = last.position;
            return;
        }
        if (!texts.length) {
            return ctx.fail(hadRawCalls
                ? 'Hermes ended the turn with a tool call written as text instead of executing it — retry the request'
                : 'Hermes returned an empty answer');
        }
        for (const [i, text] of texts.entries()) {
            const position = recordAssistantText(ctx.session, text, ctx.meta.model || 'hermes', null, null);
            if (i === texts.length - 1) { ctx.answer = text; ctx.assistantPosition = position; }
            ctx.emit({ type: 'text', text });
        }
    });
}

// как часто смотреть шаги помощников, пока идёт delegate_task
const HERMES_CHILD_POLL_MS = 3000;

// строка истории Hermes → событие потока для открытой ленты. Шаги помощника
// подписаны «↳», чтобы в плоской ленте чата было видно, чьи они
function emitHermesEntry(ctx, entry, fromChild) {
    const mark = fromChild ? '↳ ' : '';
    if (entry.kind === 'tool') ctx.emit({ type: 'tool', name: `${mark}${entry.name}`, detail: hermesToolDetail(entry.args) });
    else if (entry.kind === 'thinking') ctx.emit({ type: 'thinking', text: `${mark}${entry.text}` });
    else if (entry.kind === 'notice') ctx.emit({ type: 'notice', name: `${mark}${entry.name}`, text: entry.text });
    else if (entry.kind === 'assistant' && fromChild) ctx.emit({ type: 'notice', name: `${mark}subagent`, text: entry.text });
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

// копия базы перед необратимой правкой схемы. Нужна потому, что ALTER TABLE в
// SQLite не откатывается, а в этом файле лежит вся история работы: вернуться к
// прежнему состоянию можно только из копии. Копируем по метке — имени колонки,
// которой в старой базе ещё нет: как только она появилась, копия больше не
// делается, поэтому каждый следующий запуск ничего не копирует
function backupBeforeSchemaChange(marker) {
    let columns;
    try {
        columns = db.prepare('PRAGMA table_info(messages)').all().map((c) => c.name);
    } catch {
        return; // таблицы ещё нет — база свежая, копировать нечего
    }
    if (!columns.length || columns.includes(marker)) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dir = path.join(ROOT, DATA_DIR, 'backups');
    try {
        fs.mkdirSync(dir, { recursive: true });
        // -wal и -shm копируются вместе с базой: в режиме WAL часть уже
        // записанного лежит в журнале, и копия одного .db окажется старее самой базы
        for (const suffix of ['', '-wal', '-shm']) {
            const from = `${DB_FILE}${suffix}`;
            if (fs.existsSync(from)) fs.copyFileSync(from, path.join(dir, `sessions-${stamp}.db${suffix}`));
        }
        console.log(`База сессий скопирована перед изменением схемы: ${DATA_DIR}/backups/sessions-${stamp}.db`);
    } catch (e) {
        // не смогли скопировать — говорим и не трогаем схему: потерять историю
        // молча хуже, чем не получить новые поля
        console.error(`Не удалось скопировать базу перед изменением схемы: ${e.message}`);
        throw e;
    }
}

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

    -- строки, которые заменила пересборка хода по истории Hermes
    -- (DOCS/decisions/039 и 040). Журнал обязан только дописываться: разбор
    -- истории даёт правильный порядок, но вместе с ним пропадало то, что мы
    -- видели своими глазами во время хода. Теперь замещённое переезжает сюда
    -- целиком, а не исчезает. replaced_at в ключе потому, что одну и ту же
    -- позицию может заместить не одна пересборка
    CREATE TABLE IF NOT EXISTS replaced_messages (
        session_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        replaced_at TEXT NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY (session_id, position, replaced_at)
    );

    -- остаток удалённого оркестратора Hermes (DOCS/decisions/007, отменено 015):
    -- в них никто не пишет, а выглядят как журнал запусков. Настоящий журнал
    -- вызовов инструментов ведёт сам Hermes — см. SYSTEM/core/hermes-tool-runs.js
    DROP TABLE IF EXISTS hermes_tasks;
    DROP TABLE IF EXISTS hermes_runs;
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
    // ---- Event Schema (DOCS/decisions/040) ----
    // общий формат событий: по нему фильтруют ленту и строят сводки, поэтому
    // каждое из этих полей — своя колонка, а не ключ в extra_meta. Разделение
    // с уже имеющимися полями: role — «как рисовать» (его читают Chat, Feed и
    // Flow), event_type — «что произошло» по протоколу; tool_name — имя
    // инструмента, source — кто прислал строку. Заполняет одно место — stampEvent
    ['source', 'TEXT'],
    ['actor', 'TEXT'],
    ['event_type', 'TEXT'],
    // id подзадачи и попытки внутри неё. Рождает их оркестратор, а не мы
    // (DOCS/decisions/040: «завести» читается как «отразить»): сегодня
    // единственный настоящий источник — дочерние сессии помощников Hermes,
    // у строк вне графа задач поля пустые до этапа 9
    ['task_id', 'TEXT'],
    ['attempt_id', 'TEXT'],
    ['provider', 'TEXT'],
    // исходное событие целиком. Колонка заводится здесь, чтобы схема менялась
    // один раз, а заполняется на следующем шаге (этап 2 плана)
    ['raw', 'TEXT'],
]) {
    // ALTER TABLE в SQLite не отменяется, а база — единственное место, где
    // живёт история работы. Поэтому перед первым добавлением полей Event Schema
    // делаем копию: условие срабатывает ровно один раз, дальше колонка уже есть
    if (col === 'source') backupBeforeSchemaChange('source');
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
    hermes: {
        targets: () => HERMES_TARGETS,
        detect: () => detectHermesInstalls(),
        version: (target) => detectHermesInstalls().then((installs) => installs.find((i) => i.id === target.id)?.version || 'agent API'),
        // модель Hermes выбирает сам (свой конфиг) — на клиенте выбирать нечего
        models: null,
        activate: (target) => { activeHermesTarget = target; },
        connected: () => Boolean(activeHermesTarget),
        ask: askHermes,
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
const setMessageOrigin = db.prepare('UPDATE messages SET source = ?, actor = ?, event_type = ?, provider = ? WHERE session_id = ? AND position = ?');
const setMessageTaskIds = db.prepare('UPDATE messages SET task_id = ?, attempt_id = ? WHERE session_id = ? AND position = ?');
const setMessageRaw = db.prepare('UPDATE messages SET raw = ? WHERE session_id = ? AND position = ?');
const getMessageRaw = db.prepare('SELECT raw FROM messages WHERE session_id = ? AND position = ?');

const touchSession = db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?');
const setSessionThumb = db.prepare('UPDATE sessions SET thumb = ? WHERE id = ?');
const setSessionContext = db.prepare('UPDATE sessions SET context_percent = ?, context_window = ? WHERE id = ?');
const setSessionInfo = db.prepare('UPDATE sessions SET session_info = ? WHERE id = ?');
const setSessionRateLimit = db.prepare('UPDATE sessions SET rate_limit = ? WHERE id = ?');
// курсор дотягивания истории Hermes (syncHermesHistory): докуда переписка его
// сессии уже перенесена к нам. У сессий старше этого механизма отметок нет —
// там порогом служит время последней нашей записи
// Строки помощников (hermesChildSession) в курсор сессии не входят: id у
// Hermes сквозные, и помощник, досчитавший позже, сдвинул бы курсор родителя
// дальше его собственных ещё не перенесённых сообщений
const hermesSyncCursor = db.prepare(`
    SELECT MAX(CAST(json_extract(extra_meta, '$.hermesMessageId') AS INTEGER)) AS id
    FROM messages WHERE session_id = ? AND json_extract(extra_meta, '$.hermesChildSession') IS NULL
`);
const hermesChildCursor = db.prepare(`
    SELECT MAX(CAST(json_extract(extra_meta, '$.hermesMessageId') AS INTEGER)) AS id
    FROM messages WHERE session_id = ? AND json_extract(extra_meta, '$.hermesChildSession') = ?
`);
// есть ли у сессии Hermes наша связь — в том числе у удалённой у нас сессии
const hasCliSessionLink = db.prepare('SELECT 1 AS yes FROM session_cli WHERE cli_session_id = ? LIMIT 1');
// пересборка хода Hermes: строки хода, записанные по потоку, уходят целиком
const deleteMessagesFrom = db.prepare('DELETE FROM messages WHERE session_id = ? AND position >= ?');
// то, что пересборка собирается заместить, — забираем целиком до удаления
const selectMessagesFrom = db.prepare('SELECT * FROM messages WHERE session_id = ? AND position >= ? ORDER BY position');
const archiveMessage = db.prepare('INSERT OR REPLACE INTO replaced_messages (session_id, position, replaced_at, payload) VALUES (?, ?, ?, ?)');
const deleteArchiveBySession = db.prepare('DELETE FROM replaced_messages WHERE session_id = ?');
const countArchive = db.prepare('SELECT COUNT(*) AS n FROM replaced_messages WHERE session_id = ?');

// пересборка хода по истории Hermes меняет разобранный слой, но не имеет права
// стирать наблюдение: то, что пришло потоком, мы видели своими глазами, а
// история может оказаться короче (сжатие контекста) или лечь иначе. Поэтому
// замещаемые строки переезжают в архив целиком, включая их сырое событие,
// и только потом удаляются из ленты (DOCS/decisions/040)
function archiveAndDeleteFrom(sessionId, fromPosition) {
    const rows = selectMessagesFrom.all(sessionId, fromPosition);
    if (rows.length) {
        const at = new Date().toISOString();
        for (const row of rows) archiveMessage.run(sessionId, row.position, at, JSON.stringify(row));
    }
    deleteMessagesFrom.run(sessionId, fromPosition);
    return rows.length;
}
const setMessageCreatedAt = db.prepare('UPDATE messages SET created_at = ? WHERE session_id = ? AND position = ?');
const lastMessageTime = db.prepare('SELECT MAX(created_at) AS at FROM messages WHERE session_id = ?');

const getSessionMeta = db.prepare('SELECT context_percent AS contextPercent, context_window AS contextWindow, session_info AS sessionInfo, rate_limit AS rateLimit, target, thumb FROM sessions WHERE id = ?');

const getSessionTitle = db.prepare('SELECT title FROM sessions WHERE id = ?');

// чем сессия шла в прошлый раз: ход, начатый не из браузера (ответ в Telegram),
// берёт модель, effort и режим оттуда — своих настроек у такого хода нет
const getLastTurnParams = db.prepare(`
    SELECT model, effort, mode FROM messages
    WHERE session_id = ? AND role = 'user' ORDER BY position DESC LIMIT 1
`);

const listSessions = db.prepare(`
    SELECT s.id, s.title, s.updated_at AS updatedAt, s.thumb AS thumb,
           s.rowid AS createdOrder,
           (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id AND m.role NOT IN ('tool', 'thinking', 'hook', 'system', 'unknown', 'top_level')) AS messageCount
    FROM sessions s
    ORDER BY s.updated_at DESC
`);

const listMessages = db.prepare(`
    SELECT position, role, text, created_at AS createdAt, model, effort,
           input_tokens AS inputTokens, output_tokens AS outputTokens,
           cache_read_tokens AS cacheReadTokens, cache_creation_tokens AS cacheCreationTokens,
           cost_usd AS costUsd, duration_ms AS durationMs,
           tool_name AS toolName, tool_input AS toolInput, tool_result AS toolResult, tool_error AS toolError,
           tool_result_images AS toolResultImages,
           tool_use_id AS toolUseId, parent_tool_use_id AS parentToolUseId, stop_reason AS stopReason,
           mode, input_sent AS inputSent, result_meta AS resultMeta, extra_meta AS extraMeta,
           source, actor, event_type AS eventType, task_id AS taskId, attempt_id AS attemptId, provider, raw
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

// правка собственной реплики на графе Flow (см. DOCS/decisions/018): роль проверяем
// отдельным запросом, потому что менять разрешено только строку пользователя
const getMessageRole = db.prepare('SELECT role FROM messages WHERE session_id = ? AND position = ?');
const setMessageText = db.prepare('UPDATE messages SET text = ? WHERE session_id = ? AND position = ?');

// потолок на tool_input/tool_result/thinking: без лимита один Bash с гигантским
// выводом раздул бы .sessions.db, но значение выбрано так, чтобы обычные ответы
// инструментов не резались вовсе
const DETAIL_CLIP_LEN = 50000;
function clip(text) {
    if (typeof text !== 'string') return text;
    return text.length > DETAIL_CLIP_LEN ? text.slice(0, DETAIL_CLIP_LEN) + '…' : text;
}

// у сырого события своя граница, и она выше: смысл raw в том, чтобы к событию
// можно было вернуться, когда наш разбор окажется неполным, а обрезка по общей
// границе как раз и лишила бы нас этой возможности. Совсем без границы нельзя:
// один ответ с большим файлом иначе кладёт в базу десятки мегабайт. Обрезанное
// помечаем явно, чтобы позже не принять усечённое событие за целое
const RAW_CLIP_LEN = 400000;
function clipRaw(value) {
    let text;
    try {
        text = typeof value === 'string' ? value : JSON.stringify(value);
    } catch {
        return null; // циклическая ссылка в событии — лучше без raw, чем упавший ход
    }
    if (typeof text !== 'string') return null;
    if (text.length <= RAW_CLIP_LEN) return text;
    return JSON.stringify({ rawTruncated: true, originalLength: text.length, head: text.slice(0, RAW_CLIP_LEN) });
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
    // архив замещённых строк — часть истории этих же сессий: очистка списка
    // не должна оставлять от них хвост, который уже не с чем сопоставить
    // и связи с сессиями CLI: по уцелевшей связи удалённая сессия заново
    // втягивалась из истории Hermes — строками без записи в sessions
    db.exec('DELETE FROM messages; DELETE FROM sessions; DELETE FROM replaced_messages; DELETE FROM session_cli;');
}

const deleteMessagesBySession = db.prepare('DELETE FROM messages WHERE session_id = ?');
const deleteSessionById = db.prepare('DELETE FROM sessions WHERE id = ?');
const deleteCliLinksBySession = db.prepare('DELETE FROM session_cli WHERE session_id = ?');

function deleteSession(id) {
    deleteMessagesBySession.run(id);
    deleteArchiveBySession.run(id);
    deleteSessionById.run(id);
    // см. resetSessions: без этого открытие удалённой сессии по id возвращало её строки
    deleteCliLinksBySession.run(id);
}

// ---------- запись сообщений из чата ----------

// вопрос записываем сразу, как CLI сообщил id: сессия появляется в списке
// в начале работы, а не после ответа. Возвращает позицию строки — вызывающий
// код дописывает сюда же mode/input_sent (см. askClaude)
// ---------- Event Schema: кто прислал строку и что это было ----------
// Одно место на все виды записи (DOCS/decisions/040): если заполнять поля
// в каждой функции отдельно, они разойдутся при первой же правке.
//
// source и provider выводятся из цели сессии: id окружения начинается с имени
// коннектора (agentNameByTarget), а сама цель и есть провайдер — wsl/windows
// у прямого CLI. Старые строки остаются пустыми намеренно: пусто значит
// «не знаем», а не «claude», и дозаполнять их задним числом мы не стали.
function originForSession(sessionId) {
    const target = getSessionTarget.get(sessionId)?.target || null;
    return { source: target ? agentNameByTarget(target) : null, provider: target };
}

// eventType — что произошло по протоколу, рядом с role, а не вместо неё:
// role говорит интерфейсу, как рисовать строку, и её читают Chat, Feed и Flow.
// Неизвестный вид события пишется как есть и не отбрасывается (DOCS/decisions/012).
function stampEvent(sessionId, position, eventType, actor, origin) {
    const { source, provider } = origin || originForSession(sessionId);
    setMessageOrigin.run(source || null, actor || null, eventType || null, provider || null, sessionId, position);
}

// исходное событие рядом с разобранным (DOCS/decisions/040, этап 2 плана).
// Нужно затем, что разбор всегда отстаёт от источника: новый вид события у
// новой модели попадёт в готовые колонки не целиком, и без raw утраченное уже
// не вернуть. Пишется у строк всех ролей, а не только у неразобранных
function stampRaw(sessionId, position, raw) {
    if (raw === undefined || raw === null || position === null || position === undefined) return;
    const text = clipRaw(raw);
    if (text) setMessageRaw.run(text, sessionId, position);
}

// второе исходное событие той же строки: шаг инструмента собирается из вызова
// и результата, хук — из запуска и ответа, итоговая реплика — из текста и
// итога хода. Затирать первое нельзя, поэтому строка получает оба:
// { rawEvents: [первое, второе, …] }. Ключ нарочно не похож на поля источников,
// чтобы склейку нельзя было спутать с самим событием
function appendRaw(sessionId, position, raw) {
    if (raw === undefined || raw === null || position === null || position === undefined) return;
    const prev = getMessageRaw.get(sessionId, position)?.raw;
    if (!prev) return stampRaw(sessionId, position, raw);
    let parsed;
    try {
        parsed = JSON.parse(prev);
    } catch {
        parsed = prev; // raw был строкой, а не JSON — кладём как есть
    }
    const events = Array.isArray(parsed?.rawEvents) ? parsed.rawEvents : [parsed];
    stampRaw(sessionId, position, { rawEvents: [...events, raw] });
}

// id подзадачи и попытки приходят от оркестратора — своих не выдумываем.
// Пока графа задач нет, зовётся только оттуда, где источник настоящий
// Номер попытки на строках помощника: task_id у них — дочерняя сессия Hermes,
// а какая это по счёту попытка той же цели, знает журнал его поручений
// (SYSTEM/core/hermes-tasks.js). Пишем `номер:id поручения` — номер для глаз,
// id — чтобы найти запись у Hermes. Источник один, поэтому попытку видят сразу
// Sessions, Feed и Flow: все три читают поле из базы
const setAttemptByTask = db.prepare('UPDATE messages SET attempt_id = ? WHERE session_id = ? AND task_id = ? AND attempt_id IS NOT ?');
const hasUnstampedTask = db.prepare('SELECT 1 FROM messages WHERE session_id = ? AND task_id IS NOT NULL AND attempt_id IS NULL LIMIT 1');
function stampHermesAttempts(sessionId, hermesId) {
    // журнал читается с копии базы Hermes — не трогаем его, пока нечего помечать
    if (!hasUnstampedTask.get(sessionId)) return;
    try {
        for (const d of hermesTasks.readDelegations({ parent: hermesId })) {
            if (!d.childSession) continue;
            const value = `${d.attempt}:${d.delegationId}`;
            setAttemptByTask.run(value, sessionId, d.childSession, value);
        }
    } catch (err) {
        // журнал поручений — чужая база: её отсутствие или смена схемы не должны ронять ход
        console.error(`hermes attempts unavailable for ${sessionId}: ${err.message}`);
    }
}

function stampTask(sessionId, position, taskId, attemptId) {
    if (!taskId && !attemptId) return;
    setMessageTaskIds.run(taskId || null, attemptId || null, sessionId, position);
}

function startExchange(sessionId, question, target, model, effort) {
    upsertSession.run(sessionId, extractTitle(question, 300), new Date().toISOString(), target || null);
    const position = countMessages.get(sessionId).n;
    upsertMessage.run(sessionId, position, 'user', question, new Date().toISOString(), model || null, effort || null);
    // вопрос задал человек — источник не зависит от того, каким CLI пойдёт ход
    stampEvent(sessionId, position, 'text', 'human', { source: 'user', provider: target || null });
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
function recordStep(sessionId, text, toolName, toolInput, toolUseId, parentToolUseId, caller, raw) {
    const position = countMessages.get(sessionId).n;
    upsertMessage.run(sessionId, position, 'tool', text, new Date().toISOString(), null, null);
    setMessageToolCall.run(toolName || null, toolInput !== undefined ? clip(JSON.stringify(toolInput)) : null, sessionId, position);
    if (toolUseId || parentToolUseId) setMessageToolIds.run(toolUseId || null, parentToolUseId || null, sessionId, position);
    // caller — {"type":"direct"} у обычного вызова, отличает прямой вызов
    // от вызова изнутри субагента; не кладём в toolInput — Flow читает
    // tool_input как есть (sessionFacts в PROJECTS/Flow/flow.js разбирает его
    // как JSON вызова), и обёртка сломала бы вывод
    if (caller) setMessageExtraMeta.run(JSON.stringify({ caller }), sessionId, position);
    stampEvent(sessionId, position, 'tool.call', parentToolUseId ? 'subagent' : 'tool');
    stampRaw(sessionId, position, raw);
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
    // хук — не модель и не инструмент модели: его запустила сама среда CLI
    stampEvent(sessionId, position, 'hook.run', 'tool');
    stampRaw(sessionId, position, event);
    return position;
}

function recordHookResponse(sessionId, position, event) {
    const text = clip([
        event.stdout || null,
        event.output && event.output !== event.stdout ? event.output : null,
        event.stderr ? `[stderr]\n${event.stderr}` : null,
    ].filter(Boolean).join('\n\n'));
    setMessageToolResult.run(text || null, event.exit_code ? 1 : 0, null, sessionId, position);
    appendRaw(sessionId, position, event);
}

// рассуждения модели (блоки thinking) — отдельной строкой в той же таблице, рядом с шагами
// Возвращает позицию строки — дотягивание истории (syncHermesHistory) ставит
// на неё отметку о происхождении, как и на остальные добранные строки
function recordThinking(sessionId, text, signature, raw) {
    const position = countMessages.get(sessionId).n;
    upsertMessage.run(sessionId, position, 'thinking', clip(text), new Date().toISOString(), null, null);
    // signature (600-2348 символов) — крипто-подпись блока для API, не читаемый
    // текст; храним факт и длину, не саму строку
    if (signature) setMessageExtraMeta.run(JSON.stringify({ signaturePresent: true, signatureLength: signature.length }), sessionId, position);
    stampEvent(sessionId, position, 'thinking', 'model');
    stampRaw(sessionId, position, raw);
    return position;
}

// текстовый кусок ответа — своя строка на каждое событие 'text' (за один ход
// модель может выдать текст несколько раз подряд, чередуя с вызовами
// инструментов); parentToolUseId — как у recordStep, отличает текст субагента
// (Task) от текста верхнего уровня. Возвращаем позицию — finishExchange
// дописывает на неё usage/stopReason/mode, а не вставляет ещё одну строку
function recordAssistantText(sessionId, text, model, effort, parentToolUseId, raw) {
    const position = countMessages.get(sessionId).n;
    upsertMessage.run(sessionId, position, 'assistant', text, new Date().toISOString(), model || null, effort || null);
    if (parentToolUseId) setMessageToolIds.run(null, parentToolUseId, sessionId, position);
    stampEvent(sessionId, position, 'text', parentToolUseId ? 'subagent' : 'model');
    stampRaw(sessionId, position, raw);
    return position;
}

// событие хода, которое не слова человека и не ответ модели: сервер сам
// переспросил модель, мост поправил её вызов, Hermes сжал контекст, помощнику
// поставлена задача. Роль system — как у неразобранных системных событий CLI;
// name — откуда пометка (tool_name), text — что произошло, словами
function recordNotice(sessionId, name, text, parentToolUseId, raw) {
    const position = countMessages.get(sessionId).n;
    upsertMessage.run(sessionId, position, 'system', clip(text), new Date().toISOString(), null, null);
    setMessageToolCall.run(name || null, clip(JSON.stringify({ notice: name, text })), sessionId, position);
    if (parentToolUseId) setMessageToolIds.run(null, parentToolUseId, sessionId, position);
    // у пометки источник виден по её имени и не совпадает с целью сессии:
    // ход ведёт Hermes, а поправил вызов мост или наш же сервер
    const origin = noticeOrigin(name, sessionId);
    stampEvent(sessionId, position, 'notice', origin.actor, origin);
    stampRaw(sessionId, position, raw);
    return position;
}

// откуда пришла пометка хода. Имена задаются на месте вызова recordNotice
// (claude-bridge, server.retry-nudge, hermes.compaction — DOCS/decisions/039);
// незнакомое имя не выдумываем, а берём источником саму сессию
function noticeOrigin(name, sessionId) {
    const prefix = String(name || '').split('.')[0];
    if (prefix === 'claude-bridge') return { source: 'bridge', provider: null, actor: 'tool' };
    if (prefix === 'server') return { source: 'server', provider: null, actor: 'server' };
    if (prefix === 'hermes') return { ...originForSession(sessionId), source: 'hermes', actor: 'orchestrator' };
    return { ...originForSession(sessionId), actor: null };
}

// перехватчик для частей ответа с типом, который сервер явно не разбирает:
// WebSearch/WebFetch идут обычным tool_use, но CLI может прислать и что-то ещё
// (см. DOCS/decisions/012)
function recordUnknownPart(sessionId, part, parentToolUseId) {
    const position = countMessages.get(sessionId).n;
    upsertMessage.run(sessionId, position, 'unknown', part.type || 'unknown', new Date().toISOString(), null, null);
    setMessageToolCall.run(part.type || null, clip(JSON.stringify(part)), sessionId, position);
    if (parentToolUseId) setMessageToolIds.run(null, parentToolUseId, sessionId, position);
    // вид события пишется как есть: завтрашний тип у новой модели должен
    // попасть в ленту без правки сервера (DOCS/decisions/012)
    stampEvent(sessionId, position, part.type || 'unknown', parentToolUseId ? 'subagent' : null);
    stampRaw(sessionId, position, part);
    return position;
}

// перехватчик для system-подтипов, которые сервер явно не разбирает (init/
// hook_started/hook_response/thinking_tokens — см. HANDLED_SYSTEM_SUBTYPES);
// такие подтипы реально приходят, например permission_denied
function recordSystemEvent(sessionId, event) {
    const position = countMessages.get(sessionId).n;
    upsertMessage.run(sessionId, position, 'system', event.subtype || 'system', new Date().toISOString(), null, null);
    setMessageToolCall.run(event.subtype || null, clip(JSON.stringify(event)), sessionId, position);
    stampEvent(sessionId, position, event.subtype || 'system', null);
    stampRaw(sessionId, position, event);
    return position;
}

// последний уровень перехвата: верхнеуровневый event.type, для которого нет
// ни одной ветки в onLine (см. HANDLED_TOP_LEVEL_TYPES и DOCS/decisions/012)
function recordTopLevelEvent(sessionId, event) {
    const position = countMessages.get(sessionId).n;
    upsertMessage.run(sessionId, position, 'top_level', event.type || 'unknown', new Date().toISOString(), null, null);
    setMessageToolCall.run(event.type || null, clip(JSON.stringify(event)), sessionId, position);
    stampEvent(sessionId, position, event.type || 'unknown', null);
    stampRaw(sessionId, position, event);
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
        // строка рождается здесь, мимо recordAssistantText, — без этого она
        // осталась бы единственной без источника и вида события. Текст ошибки
        // хода — тоже реплика модели по форме, её отличает stop_reason
        stampEvent(sessionId, position, 'text', 'model');
    }
    for (const raw of meta.resultRaws || []) appendRaw(sessionId, position, raw);
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

// ход, начатый не из браузера — сейчас это ответ человека в Telegram.
// Исполнителя и параметры берём из самой сессии, поток событий никуда не пишем:
// подключённые страницы всё равно получат его через broadcast внутри runTurn,
// а человеку в Telegram уйдёт готовый ответ из notifyTurnFinished
async function askOutsideBrowser({ sessionId, text }) {
    if (!getSessionTitle.get(sessionId)) throw new Error('Session not found');
    if (stopping) throw new Error(RESTART_ERROR);

    const name = agentNameByTarget(getSessionMeta.get(sessionId)?.target);
    const adapter = AGENTS[name];
    if (!adapter.connected()) throw new Error(`${name} is not connected — open Settings and connect it`);

    const last = getLastTurnParams.get(sessionId) || {};
    // отказ до старта хода (не подключён, пустой запрос) в базу не попадёт и
    // обратно сам не уедет — такой возвращаем ошибкой. Всё, что случилось уже
    // внутри хода, дописано в сессию и уйдёт в Telegram обычным путём
    let started = false;
    let failure = null;
    const hints = await turnJudgment.pickDecisionHints(text).catch(() => null);
    await adapter.ask(
        { prompt: text, sessionId, model: last.model || undefined, effort: last.effort || undefined, mode: last.mode || undefined, hints },
        (event) => {
            if (event.type === 'session') started = true;
            if (event.type === 'error') failure = event.error;
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
const { notifyTurnFinished } = telegram.init({ setEnvValue, ask: askOutsideBrowser, db });

const featureRoutes = {
    ...graph.createRoutes(),
    ...require('./PROJECTS/Flow/flow-server.js').createRoutes({ db }),
    ...require('./PROJECTS/Chat/pages-server.js').createRoutes({ db, root: ROOT }),
    ...require('./PROJECTS/Chat/chat-server.js').createRoutes({
        sessions: sessionSummaries,
        usage: (id) => sumSessionUsage.get(id),
        activeStartedAt: activeRunStartedAt,
    }),
    ...require('./PROJECTS/Home/home-server.js').createRoutes({
        sessions: sessionSummaries,
        activeCount: () => activeRuns.size,
    }),
    ...require('./PROJECTS/Karandash/karandash-server.js').createRoutes({ setEnvValue }),
    ...telegram.createRoutes(),
    ...require('./SYSTEM/toolbar-icons-server.js').createRoutes({ db }),
    ...branchPreview.createRoutes({ root: ROOT }),
    ...hermesTasks.createRoutes({ sendJson, readJson }),
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
            // мост Hermes (у сторожа) переключается на тот же claude, что выбран здесь
            if (agent === 'claude' && process.send) process.send({ claudeTarget: target.id }, () => {});
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
            // сессию Hermes могли продолжить мимо нас (его дашборд, его API,
            // задание по расписанию) — перед показом добираем такие ходы,
            // иначе лента обрывается на последнем нашем
            await syncHermesHistory(id);
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
                // сколько строк этой сессии заместила пересборка хода по истории
                // Hermes: сами строки лежат в replaced_messages и никуда не
                // делись, а число здесь — чтобы это было видно в ленте, а не
                // только в базе (DOCS/decisions/040)
                replacedCount: countArchive.get(id)?.n ?? 0,
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
