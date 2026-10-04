// .env, платформа и журнал выключений — всё, что сервер решает до первого
// запроса. Отдельный модуль, потому что это три разных вопроса, которые
// server.js раньше закрывал сам: где лежат настройки, под чем запущен процесс и
// почему он выключился (DOCS/decisions/022 — один файл, одна тема).
const fs = require('fs');
const path = require('path');

// корень проекта на два уровня выше: модуль лежит в SYSTEM/core
const ROOT = path.join(__dirname, '..', '..');

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
# from zero) — can also be changed from Settings in the interface
SCREENSHOT_SCREEN=0
# Host dependencies checked/installed by the watchdog (git, python); 0 turns it off
HOST_DEPS=1
# When an agent fails mid-work (provider error, limit, missing model) the next connected agent takes the work over; 0 turns it off
AGENT_FALLBACK=1

# Telegram bridge: the bot token and the ids of the users allowed to talk to it
# (comma separated). Both are filled from Settings in the interface
# TELEGRAM_BOT_TOKEN=
# TELEGRAM_USER_IDS=

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

module.exports = { loadEnv, setEnvValue, detectRuntimePlatform, logExit, ENV_FILE };