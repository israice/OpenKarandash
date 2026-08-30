// Смоук-проверка HTTP-уровня: поднимает server.js на свободном порту, дёргает основные
// маршруты и сверяет коды ответов. Нужна как страховка при разборе index.html на модули —
// автоматических проверок в проекте больше нет. Зависимостей не требует.
//
// Запуск: node SYSTEM/smoke.js   (ненулевой код возврата = что-то сломалось)
//
// Базу .sessions.db трогает только на чтение: /api/sessions/reset здесь не вызывается,
// иначе прогон смоука стирал бы историю сессий пользователя.
const http = require('http');
const net = require('net');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..'); // сервер запускается из корня проекта, а смоук лежит в SYSTEM

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

// поднятый смоуком сервер не должен пережить смоук ни при каком исходе: осиротевший
// процесс держит cwd проекта (папку потом не переименовать) и занимает .sessions.db.
// поэтому ссылка на него лежит здесь, а гасим её и из finally, и по сигналам, и на выходе
let server = null;
const stopServer = () => {
    if (!server) return;
    server.kill();
    server = null;
};

process.on('exit', stopServer);
// Ctrl+C и остановка снаружи не проходят через finally — уносим сервер вручную
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
    process.on(signal, () => {
        stopServer();
        process.exit(1);
    });
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
        server = child;

        let out = '';
        // не уложился в срок: процесс жив, но нам не отвечает — гасим, иначе он останется висеть
        const timer = setTimeout(() => {
            stopServer();
            reject(new Error(`сервер не сообщил о старте за 10 с:\n${out}`));
        }, 10_000);

        const onData = (chunk) => {
            out += chunk;
            if (out.includes('Сервер запущен')) {
                clearTimeout(timer);
                resolve(child);
            }
        };
        child.stdout.on('data', onData);
        child.stderr.on('data', onData);
        child.on('exit', (code) => {
            clearTimeout(timer);
            server = null; // уже мёртв, добивать нечего
            reject(new Error(`сервер не поднялся (код ${code}):\n${out}`));
        });
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
    const res = await request(port, '/api/file/read', { method: 'POST', json: { path: 'SYSTEM/smoke.js' } });
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
    const res = await request(port, '/api/file/write', { method: 'POST', json: { path: 'DATA/vault/Проект/server.js.md', text: 'нельзя' } });
    equal(res.status, 200, 'код ответа');
    const parsed = JSON.parse(res.body);
    if (parsed.ok) throw new Error('заметка vault оказалась перезаписываемой');
    // отказ должен быть по делу: внутренняя ошибка тоже приходит как ok:false и раньше проходила проверку
    if (!parsed.error.includes('vault')) throw new Error(`отказ не по делу: ${parsed.error}`);
});

// кнопка «+» тулбара (SYSTEM/new-button.js) должна заводить настоящую папку
// в PROJECTS/, а не только запись в базе — иначе раздел не попадёт в общий
// список карточек (PROJECTS/Projects/projects-tab.js); удаление страницы должно
// убирать эту папку целиком, а не оставлять мусор на диске
check('POST /api/pages/create заводит папку в PROJECTS/, delete её убирает', async (port) => {
    const title = `Смоук ${Date.now()}`;
    const res = await request(port, '/api/pages/create', { method: 'POST', json: { title } });
    equal(res.status, 200, 'код ответа');
    const parsed = JSON.parse(res.body);
    if (!parsed.ok || !parsed.folder) throw new Error(`неожиданный ответ: ${res.body.slice(0, 200)}`);
    const dir = path.join(ROOT, 'PROJECTS', parsed.folder);
    try {
        if (!fs.existsSync(path.join(dir, 'README.md'))) throw new Error(`README.md не создан в ${dir}`);
        await request(port, '/api/pages/delete', { method: 'POST', json: { id: parsed.id } });
        if (fs.existsSync(dir)) throw new Error(`папка ${dir} пережила удаление страницы`);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true }); // подстраховка, если проверка упала раньше удаления
    }
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
    // порт для прогона берём свободный и передаём через окружение: .env — настройка
    // рабочего сервера, смоук её не трогает
    const port = await freePort();
    await startServer(port); // ссылку держит stopServer — гасить сервер только через него

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
        stopServer();
    }

    console.log(failed ? `\nПровалено проверок: ${failed} из ${checks.length}` : `\nВсе проверки пройдены (${checks.length})`);
    process.exit(failed ? 1 : 0);
}

main().catch((err) => {
    console.error(`Смоук не отработал: ${err.message}`);
    process.exit(1);
});
