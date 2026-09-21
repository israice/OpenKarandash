// Мост до Chrome на хосте: даёт jev-ultrafast из контейнера Hermes управлять
// настоящим Chrome на Windows (DOCS/decisions/069). Запускается вручную на
// стороне Windows: node PROJECTS/Browser/chrome-bridge.js
//
// Зачем прокси, а не просто открытый порт Chrome: Chrome слушает отладку только
// на 127.0.0.1 (из контейнера не достать) и отвечает только на запросы с Host
// localhost/IP. К тому же отладочный порт — это полный контроль над браузером
// (куки, вход в аккаунты), поэтому наружу он выходит только по секретному
// префиксу пути: http://хост:порт/<токен>/json/version. Без токена — 404.
// Токен лежит в .env (CHROME_BRIDGE_TOKEN), при первом запуске создаётся сам.
//
// Без зависимостей — как и остальные мосты проекта.

const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const ENV_FILE = path.join(ROOT, '.env');

// настройки: окружение сильнее .env
function readEnvFile() {
    const out = {};
    let text = '';
    try {
        text = fs.readFileSync(ENV_FILE, 'utf8');
    } catch {
        return out;
    }
    for (const line of text.split(/\r?\n/)) {
        const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
        if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
    return out;
}

const fileEnv = readEnvFile();
const setting = (key, fallback) => process.env[key] || fileEnv[key] || fallback;

const BRIDGE_PORT = Number(setting('CHROME_BRIDGE_PORT', '9223'));
const CDP_PORT = Number(setting('CHROME_CDP_PORT', '9222'));

// токена нет — заводим и дописываем в .env: контейнер читает тот же файл
function ensureToken() {
    const existing = setting('CHROME_BRIDGE_TOKEN', '');
    if (existing) return existing;
    const token = crypto.randomBytes(24).toString('hex');
    let prefix = '';
    try {
        const cur = fs.readFileSync(ENV_FILE, 'utf8');
        if (cur && !cur.endsWith('\n')) prefix = '\n';
    } catch {
        // .env ещё нет — создастся ниже
    }
    fs.appendFileSync(ENV_FILE, `${prefix}CHROME_BRIDGE_TOKEN=${token}\n`);
    console.log('[chrome-bridge] создан CHROME_BRIDGE_TOKEN в .env');
    return token;
}

const TOKEN = ensureToken();

function tokenOk(segment) {
    const a = Buffer.from(segment);
    const b = Buffer.from(TOKEN);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// «/<токен>/дальше» -> «/дальше»; чужой или пустой токен -> null
function unwrap(url) {
    const m = /^\/([^/?]+)(\/[^]*)?$/.exec(url || '');
    if (!m || !tokenOk(m[1])) return null;
    return m[2] || '/';
}

const upstreamHost = () => `127.0.0.1:${CDP_PORT}`;

const server = http.createServer((req, res) => {
    const rest = unwrap(req.url);
    if (rest === null) {
        res.writeHead(404);
        res.end();
        return;
    }
    const headers = { ...req.headers, host: upstreamHost() };
    delete headers['accept-encoding']; // ответ правим как текст, сжатым он не годится
    delete headers.origin;
    const up = http.request({ host: '127.0.0.1', port: CDP_PORT, path: rest, method: req.method, headers }, (ur) => {
        const chunks = [];
        ur.on('data', (c) => chunks.push(c));
        ur.on('end', () => {
            let body = Buffer.concat(chunks);
            // Chrome пишет в ответе свой адрес (ws://127.0.0.1:9222/...), а клиенту нужен
            // наш, с токеном: иначе следующее соединение пойдёт мимо моста
            if (/json/.test(ur.headers['content-type'] || '')) {
                const self = `ws://${req.headers.host}/${TOKEN}`;
                body = Buffer.from(body.toString('utf8').replace(/ws:\/\/(127\.0\.0\.1|localhost):\d+/g, self));
            }
            const outHeaders = { ...ur.headers, 'content-length': body.length };
            delete outHeaders['transfer-encoding'];
            res.writeHead(ur.statusCode || 502, outHeaders);
            res.end(body);
        });
    });
    up.on('error', (e) => {
        res.writeHead(502);
        res.end(`Chrome не отвечает на порту ${CDP_PORT}: ${e.message}`);
    });
    req.pipe(up);
});

// WebSocket: переписываем только строку запроса и Host, дальше гоним байты как есть
server.on('upgrade', (req, socket, head) => {
    const rest = unwrap(req.url);
    if (rest === null) {
        socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
        return;
    }
    const up = net.connect(CDP_PORT, '127.0.0.1', () => {
        const lines = [`${req.method} ${rest} HTTP/1.1`];
        for (let i = 0; i < req.rawHeaders.length; i += 2) {
            if (/^(host|origin)$/i.test(req.rawHeaders[i])) continue; // Origin Chrome не пускает
            lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
        }
        lines.push(`Host: ${upstreamHost()}`);
        up.write(`${lines.join('\r\n')}\r\n\r\n`);
        if (head && head.length) up.write(head);
        up.pipe(socket);
        socket.pipe(up);
    });
    const close = () => {
        up.destroy();
        socket.destroy();
    };
    up.on('error', close);
    socket.on('error', close);
    up.on('close', close);
    socket.on('close', close);
});

// ---------- Chrome ----------

function cdpUp() {
    return new Promise((resolve) => {
        const r = http.get({ host: '127.0.0.1', port: CDP_PORT, path: '/json/version', timeout: 1500 }, (res) => {
            res.resume();
            resolve(res.statusCode === 200);
        });
        r.on('error', () => resolve(false));
        r.on('timeout', () => {
            r.destroy();
            resolve(false);
        });
    });
}

function findChrome() {
    const custom = setting('CHROME_PATH', '');
    if (custom) return custom;
    const bases = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean);
    for (const base of bases) {
        const exe = path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe');
        if (fs.existsSync(exe)) return exe;
    }
    return null;
}

// Chrome с отладкой на своём профиле: на профиле по умолчанию (с 136-й версии)
// он отладочный порт не открывает, поэтому свой каталог — DATA/chrome-profile.
// Войти в нужные аккаунты в нём нужно один раз, дальше профиль сохраняется
async function ensureChrome() {
    if (await cdpUp()) return 'Chrome уже слушает порт отладки';
    if (setting('CHROME_BRIDGE_NO_LAUNCH', '') === '1') return 'Chrome не запускаем (CHROME_BRIDGE_NO_LAUNCH=1)';
    const exe = findChrome();
    if (!exe) throw new Error('Chrome не найден: укажите путь в CHROME_PATH в .env');
    const profile = setting('CHROME_PROFILE_DIR', path.join(ROOT, 'DATA', 'chrome-profile'));
    spawn(exe, [`--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check'], {
        detached: true,
        stdio: 'ignore',
    }).unref();
    for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 500));
        if (await cdpUp()) return `Chrome запущен, профиль ${profile}`;
    }
    throw new Error(`Chrome не открыл порт ${CDP_PORT} за 20 секунд`);
}

ensureChrome()
    .then((msg) => {
        console.log(`[chrome-bridge] ${msg}`);
        server.listen(BRIDGE_PORT, () => console.log(`[chrome-bridge] слушает порт ${BRIDGE_PORT}, отладка Chrome на ${CDP_PORT}`));
    })
    .catch((e) => {
        console.error(`[chrome-bridge] ${e.message}`);
        process.exit(1);
    });
