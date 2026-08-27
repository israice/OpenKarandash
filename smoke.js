// Смоук-проверка HTTP-уровня: поднимает server.js на свободном порту, дёргает основные
// маршруты и сверяет коды ответов. Нужна как страховка при разборе index.html на модули —
// автоматических проверок в проекте больше нет. Зависимостей не требует.
//
// Запуск: node smoke.js   (ненулевой код возврата = что-то сломалось)
//
// Базу .sessions.db трогает только на чтение: /api/sessions/reset здесь не вызывается,
// иначе прогон смоука стирал бы историю сессий пользователя.
const http = require('http');
const net = require('net');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = __dirname;
const PORT_FILE = path.join(ROOT, '.server-port');

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

// ---------- вспомогательное ----------

function freePort() {
    return new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.on('error', reject);
        probe.listen(0, '127.0.0.1', () => {
            const { port } = probe.address();
            probe.close(() => resolve(port));
        });
    });
}

function request(port, urlPath, { method = 'GET', host = '127.0.0.1', json } = {}) {
    return new Promise((resolve, reject) => {
        const payload = json === undefined ? null : JSON.stringify(json);
        const headers = payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {};
        const req = http.request({ host, port, path: urlPath, method, headers, timeout: 5000 }, (res) => {
            let body = '';
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
        });
        req.on('timeout', () => req.destroy(new Error('таймаут запроса')));
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

// адрес машины в локальной сети — по нему сервер обязан отвечать 403
function lanAddress() {
    for (const list of Object.values(os.networkInterfaces())) {
        for (const iface of list || []) {
            if (iface.family === 'IPv4' && !iface.internal) return iface.address;
        }
    }
    return null;
}

function startServer(port) {
    return new Promise((resolve, reject) => {
        // NO_RELOAD=1 — без слежения за файлами и без процесса-сторожа: смоуку нужен
        // обычный сервер, а не самоперезапускающийся
        const child = spawn(process.execPath, ['server.js'], {
            cwd: ROOT,
            env: { ...process.env, PORT: String(port), NO_RELOAD: '1' },
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        let out = '';
        const onData = (chunk) => {
            out += chunk;
            if (out.includes('Сервер запущен')) resolve(child);
        };
        child.stdout.on('data', onData);
        child.stderr.on('data', onData);
        child.on('exit', (code) => reject(new Error(`сервер не поднялся (код ${code}):\n${out}`)));
        setTimeout(() => reject(new Error(`сервер не сообщил о старте за 10 с:\n${out}`)), 10_000);
    });
}

const equal = (actual, expected, what) => {
    if (actual !== expected) throw new Error(`${what}: ожидалось ${expected}, получено ${actual}`);
};

// ---------- сами проверки ----------

check('/ отдаёт страницу', async (port) => {
    const res = await request(port, '/');
    equal(res.status, 200, 'код ответа');
    equal(res.headers['content-type'], 'text/html; charset=utf-8', 'Content-Type');
    if (!res.body.includes('</html>')) throw new Error('в ответе нет закрывающего </html>');
});

check('несуществующий файл — 404', async (port) => {
    const res = await request(port, '/no-such-file.txt');
    equal(res.status, 404, 'код ответа');
});

check('выход за пределы каталога — 403', async (port) => {
    // %2F вместо / — иначе http-клиент нормализует путь ещё до отправки
    const res = await request(port, '/..%2Fserver.js');
    equal(res.status, 403, 'код ответа');
});

check('GET к /api — 405', async (port) => {
    const res = await request(port, '/api/sessions');
    equal(res.status, 405, 'код ответа');
});

check('POST /api/sessions отвечает списком', async (port) => {
    const res = await request(port, '/api/sessions', { method: 'POST' });
    equal(res.status, 200, 'код ответа');
    const parsed = JSON.parse(res.body);
    if (!parsed.ok || !Array.isArray(parsed.sessions)) throw new Error(`неожиданный ответ: ${res.body}`);
});

check('POST /api/obsidian/graph отдаёт карту', async (port) => {
    const res = await request(port, '/api/obsidian/graph', { method: 'POST' });
    equal(res.status, 200, 'код ответа');
    const parsed = JSON.parse(res.body);
    if (!parsed.ok || !parsed.notes.length) throw new Error(`карта пуста: ${res.body.slice(0, 200)}`);
    // узлы с типом появляются только когда карта собралась целиком
    if (!parsed.notes.some((note) => note.kind === 'file')) throw new Error('в карте нет узлов-файлов');
});

check('POST /api/search ищет по индексу', async (port) => {
    const res = await request(port, '/api/search', { method: 'POST', json: { q: 'reload' } });
    equal(res.status, 200, 'код ответа');
    const parsed = JSON.parse(res.body);
    if (!parsed.ok || !Array.isArray(parsed.hits)) throw new Error(`неожиданный ответ: ${res.body.slice(0, 200)}`);
});

// сырой ввод с точками и кавычками роняет FTS5, если его не экранировать
check('поиск переживает спецсимволы', async (port) => {
    const res = await request(port, '/api/search', { method: 'POST', json: { q: 'server.js "граф' } });
    equal(res.status, 200, 'код ответа');
    const parsed = JSON.parse(res.body);
    if (!parsed.ok) throw new Error(`поиск упал: ${res.body.slice(0, 200)}`);
});

check('POST /api/file/read отдаёт содержимое', async (port) => {
    const res = await request(port, '/api/file/read', { method: 'POST', json: { path: 'smoke.js' } });
    equal(res.status, 200, 'код ответа');
    const parsed = JSON.parse(res.body);
    if (!parsed.ok || !parsed.text.includes('Смоук-проверка')) throw new Error(`неожиданный ответ: ${res.body.slice(0, 200)}`);
});

// путь приходит от клиента: подъём по каталогам не должен выпускать за пределы проекта
check('чтение за пределами проекта отклоняется', async (port) => {
    const res = await request(port, '/api/file/read', { method: 'POST', json: { path: '../../../Windows/win.ini' } });
    equal(res.status, 200, 'код ответа');
    const parsed = JSON.parse(res.body);
    if (parsed.ok) throw new Error('файл за пределами проекта прочитался');
});

// заметки vault пересобираются сервером — правка в них потерялась бы
check('запись в заметку vault отклоняется', async (port) => {
    const res = await request(port, '/api/file/write', { method: 'POST', json: { path: 'vault/Проект/server.js.md', text: 'нельзя' } });
    equal(res.status, 200, 'код ответа');
    const parsed = JSON.parse(res.body);
    if (parsed.ok) throw new Error('заметка vault оказалась перезаписываемой');
});

check('неизвестный /api — 404', async (port) => {
    const res = await request(port, '/api/no-such-route', { method: 'POST' });
    equal(res.status, 404, 'код ответа');
});

check('запрос не с localhost — 403', async (port) => {
    const lan = lanAddress();
    if (!lan) return 'пропущено: у машины нет адреса в локальной сети';
    const res = await request(port, '/', { host: lan });
    equal(res.status, 403, 'код ответа');
});

// ---------- прогон ----------

async function main() {
    // сервер пишет .server-port при старте; вернём файл как был, иначе PreToolUse-хук
    // file-lock.js после смоука будет стучаться на порт, которого уже нет
    const savedPort = fs.existsSync(PORT_FILE) ? fs.readFileSync(PORT_FILE, 'utf8') : null;

    const port = await freePort();
    const server = await startServer(port);

    let failed = 0;
    try {
        for (const { name, fn } of checks) {
            try {
                const note = await fn(port);
                console.log(note ? `~ ${name} — ${note}` : `+ ${name}`);
            } catch (err) {
                failed++;
                console.log(`- ${name}\n    ${err.message}`);
            }
        }
    } finally {
        server.kill();
        if (savedPort === null) fs.rmSync(PORT_FILE, { force: true });
        else fs.writeFileSync(PORT_FILE, savedPort);
    }

    console.log(failed ? `\nПровалено проверок: ${failed} из ${checks.length}` : `\nВсе проверки пройдены (${checks.length})`);
    process.exit(failed ? 1 : 0);
}

main().catch((err) => {
    console.error(`Смоук не отработал: ${err.message}`);
    process.exit(1);
});
