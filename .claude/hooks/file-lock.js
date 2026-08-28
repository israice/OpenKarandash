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

    const req = http.request({
        hostname: '127.0.0.1',
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
                if (parsed.ok) allow();
                else deny(parsed.reason || 'файл сейчас редактирует другая сессия');
            } catch {
                allow();
            }
        });
    });

    req.on('timeout', () => req.destroy());
    req.on('error', () => allow()); // сервер недоступен/упал посреди ответа — пропускаем
    req.write(body);
    req.end();
}

main();
