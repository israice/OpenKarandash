// PreToolUse-хук: перед Edit/Write/NotebookEdit спрашивает dev-сервер (server.js),
// не занят ли файл другой активной сессией из панели Sessions. Любая нестыковка —
// сервер не запущен, порт неизвестен, таймаут — молча пропускаем: лучше редкий
// незамеченный конфликт, чем полностью сломанный Edit из-за упавшего хука.
// Регистрация — .claude/settings.json, ключ hooks.PreToolUse.
const fs = require('fs');
const path = require('path');
const http = require('http');

const WRITE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);
const REQUEST_TIMEOUT_MS = 90_000; // чуть больше LOCK_CHECK_TIMEOUT_MS на сервере (85с)
const CONNECT_TIMEOUT_MS = 2_000; // столько ждём само соединение: если адрес не тот,
// надо узнать это быстро и попробовать следующий, а не висеть все 90 секунд

// под WSL сервер живёт на стороне Windows: 127.0.0.1 — это loopback самой виртуалки.
// хост доступен по адресу шлюза по умолчанию; берём его из /proc/net/route, где
// Gateway лежит шестнадцатеричным задом наперёд. При networkingMode=mirrored работает
// и 127.0.0.1 — поэтому его пробуем первым, а этот адрес идёт запасным
function wslHostIp() {
    try {
        if (!/microsoft/i.test(fs.readFileSync('/proc/version', 'utf8'))) return null;
        for (const line of fs.readFileSync('/proc/net/route', 'utf8').split('\n').slice(1)) {
            const [, destination, gateway] = line.split(/\s+/);
            if (destination !== '00000000' || !gateway) continue;
            return gateway.match(/../g).reverse().map((byte) => parseInt(byte, 16)).join('.');
        }
    } catch { /* не Linux или /proc недоступен — значит и не WSL */ }
    return null;
}

// null — по этому адресу сервера нет (или ответил не он): решает следующий адрес
function askServer(host, port, body) {
    return new Promise((resolve) => {
        const req = http.request({
            hostname: host,
            port,
            path: '/api/claude/lock-check',
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
            timeout: REQUEST_TIMEOUT_MS,
        }, (res) => {
            let raw = '';
            res.on('data', (chunk) => { raw += chunk; });
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(raw);
                    resolve(parsed.ok ? { ok: true } : { ok: false, reason: parsed.reason });
                } catch {
                    resolve(null); // 403 или мусор вместо JSON — отвечал не наш сервер
                }
            });
        });

        req.on('socket', (socket) => {
            const guard = setTimeout(() => req.destroy(), CONNECT_TIMEOUT_MS);
            socket.on('connect', () => clearTimeout(guard));
            socket.on('close', () => clearTimeout(guard));
        });
        req.on('timeout', () => req.destroy());
        req.on('error', () => resolve(null)); // сервер недоступен/упал посреди ответа
        req.write(body);
        req.end();
    });
}

function allow() {
    console.log(JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' },
    }));
    process.exit(0);
}

function deny(reason) {
    console.log(JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
    }));
    process.exit(0);
}

function readStdin() {
    return new Promise((resolve) => {
        let data = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (chunk) => { data += chunk; });
        process.stdin.on('end', () => resolve(data));
        process.stdin.on('error', () => resolve(data));
    });
}

async function main() {
    let input;
    try {
        input = JSON.parse(await readStdin());
    } catch {
        return allow(); // не разобрали вход — не наша забота
    }

    const filePath = input.tool_input?.file_path;
    if (!WRITE_TOOLS.has(input.tool_name) || !filePath) return allow();

    const cwd = input.cwd || process.cwd();
    let port;
    try {
        // порт живёт в .env: сервер поднимается строго на нём и другого не выбирает
        port = fs.readFileSync(path.join(cwd, '.env'), 'utf8').match(/^\s*PORT\s*=\s*(\d+)/m)?.[1];
    } catch {
        return allow(); // .env нет — сервер ни разу не запускался, блокировать нечем
    }
    if (!port) return allow();

    const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
    const body = JSON.stringify({ file: resolved, sessionId: input.session_id || null });

    for (const host of ['127.0.0.1', wslHostIp()]) {
        if (!host) continue;
        const verdict = await askServer(host, port, body);
        if (!verdict) continue;
        return verdict.ok ? allow() : deny(verdict.reason || 'файл сейчас редактирует другая сессия');
    }

    allow(); // сервера нет ни по одному адресу — блокировать нечем
}

main();
