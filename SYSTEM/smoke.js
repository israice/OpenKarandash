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

function request(port, urlPath, { method = 'GET', host = '127.0.0.1', json, raw } = {}) {
    return new Promise((resolve, reject) => {
        const payload = raw !== undefined ? raw : (json === undefined ? null : JSON.stringify(json));
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

// свои vault, поисковый индекс и база сессий: смоук не должен ни читать, ни портить
// рабочие (AGENTS.md обещает, что .sessions.db он не трогает). Лежат внутри DATA —
// эту папку не обходят ни карта, ни сторож файлов, значит прогон не попадёт в индекс
// рабочего сервера. Живой сервер держит свой .index.db-shm, и вторая копия на тех же
// файлах падает с «disk I/O error» — из-за этого смоук нельзя было прогнать, пока
// сервер работает (см. DOCS/decisions/001)
const SMOKE_DATA_DIR = 'DATA/smoke';

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
            env: { ...process.env, PORT: String(port), NO_RELOAD: '1', DATA_DIR: SMOKE_DATA_DIR },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        server = child;

        let out = '';
        // не уложился в срок: процесс жив, но нам не отвечает — гасим, иначе он останется висеть
        // 60 с, а не 10: перед сообщением о старте сервер синхронно собирает
        // vault и поисковый индекс — на большом проекте это десятки секунд
        const timer = setTimeout(() => {
            stopServer();
            reject(new Error(`сервер не сообщил о старте за 60 с:\n${out}`));
        }, 60_000);

        const onData = (chunk) => {
            out += chunk;
            if (out.includes('Server started')) {
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

// ---------- проверки, которым сервер не нужен ----------

// Живая перезагрузка под NO_RELOAD=1 не работает, а ошибиться в ней дорого:
// точечное событие вместо перезагрузки на неподходящей правке = страница со старым
// кодом, о которой никто не узнает. Проверяем само правило, без HTTP
check('правка выбирает верное событие живой перезагрузки', async () => {
    const { reloadEvents } = require(path.join(ROOT, 'SYSTEM/core/reload.js'));
    const at = (...parts) => path.join(ROOT, ...parts);
    const cases = [
        [[at('PROJECTS', 'Home', 'home-observation.eta')], ['fragment:home-observation']],
        [[at('PROJECTS', 'Flow', 'flow.css')], ['css:PROJECTS/Flow/flow.css']],
        [[at('SYSTEM', 'app.js')], ['reload']],
        // страница кнопки «+» пересобирается одна, соседние вкладки не трогаются
        [[at('PROJECTS', 'Feed', 'page.js')], ['page:Feed']],
        [[at('PROJECTS', 'Feed', 'page.css')], ['css:PROJECTS/Feed/page.css']],
        // page.js бывает только у этих страниц, но правило не должно ловить
        // файл глубже в папке раздела — там границы уже неизвестны
        [[at('PROJECTS', 'Graph', 'vendor', 'page.js')], ['reload']],
        // пачка правок: точечные события покрывают её, только если в ней нет ничего лишнего
        [[at('PROJECTS', 'Chat', 'chat-sessions.eta'), at('PROJECTS', 'Flow', 'flow.css')],
            ['fragment:chat-sessions', 'css:PROJECTS/Flow/flow.css']],
        [[at('PROJECTS', 'Chat', 'chat-sessions.eta'), at('SYSTEM', 'app.js')], ['reload']],
        [null, ['reload']], // файл удалили — границы правки неизвестны
    ];
    for (const [files, expected] of cases) {
        const actual = reloadEvents(ROOT, files);
        if (actual.join('|') !== expected.join('|')) {
            throw new Error(`${files ? files.join(', ') : 'удаление'}: ожидалось ${expected.join('|')}, получено ${actual.join('|')}`);
        }
    }
});

// Инлайновый <style> в index.html ломает сразу два правила: у стилей компонента
// снова становится два места жительства, и правка стиля тянет перезагрузку всей
// страницы вместо подмены одного <link>
check('index.html не держит стили внутри себя', async () => {
    const html = fs.readFileSync(path.join(ROOT, 'SYSTEM/index.html'), 'utf8');
    if (/<style[\s>]/.test(html)) throw new Error('в index.html снова появился <style>');

    // путь в href пишется от корня проекта: страница отдаётся по «/», и по этому же
    // пути живая перезагрузка ищет <link>, чтобы подменить его без перезагрузки
    for (const [, href] of html.matchAll(/<link[^>]+href="([^"]+)"/g)) {
        if (!fs.existsSync(path.join(ROOT, href.split('/').join(path.sep)))) {
            throw new Error(`нет файла стилей ${href}`);
        }
    }
});

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

check('GET фрагмента работает — htmx тянет его именно так', async (port) => {
    // панели стоят с hx-get; если фрагменты снова начнут требовать POST,
    // в браузере они молча превратятся в 405, а смоук с POST этого не заметит
    for (const urlPath of ['/api/fragment/home-observation', '/api/fragment/chat-sessions']) {
        const res = await request(port, urlPath);
        equal(res.status, 200, `код ответа ${urlPath}`);
        equal(res.headers['content-type'], 'text/html; charset=utf-8', `Content-Type ${urlPath}`);
    }
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

check('POST /api/fragment/home-observation отдаёт HTML панели', async (port) => {
    const res = await request(port, '/api/fragment/home-observation', { method: 'POST' });
    equal(res.status, 200, 'код ответа');
    equal(res.headers['content-type'], 'text/html; charset=utf-8', 'Content-Type');
    // htmx раскладывает ответ по id: без hx-swap-oob панель молча перестанет обновляться
    for (const id of ['obsStats', 'obsRunningList', 'obsRecentList', 'totalCount', 'activeCount']) {
        if (!res.body.includes(`id="${id}" hx-swap-oob="true"`)) {
            throw new Error(`во фрагменте нет oob-куска ${id}: ${res.body.slice(0, 200)}`);
        }
    }
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
    const res = await request(port, '/api/file/write', { method: 'POST', json: { path: `${SMOKE_DATA_DIR}/vault/Project/server.js.md`, text: 'нельзя' } });
    equal(res.status, 200, 'код ответа');
    const parsed = JSON.parse(res.body);
    if (parsed.ok) throw new Error('заметка vault оказалась перезаписываемой');
    // отказ должен быть по делу: внутренняя ошибка тоже приходит как ok:false и раньше проходила проверку
    if (!/vault/i.test(parsed.error)) throw new Error(`отказ не по делу: ${parsed.error}`);
});

// кнопка «+» тулбара (SYSTEM/new-button.js) должна заводить настоящую папку
// в PROJECTS/, а не только запись в базе — иначе раздел не попадёт в общий
// список карточек (PROJECTS/Book/book-tab.js). В папке два файла: README.md
// для карточки и page.js с содержимым страницы — без него открытая страница
// останется пустой, грузить нечего (SYSTEM/new-button.js). Удаление страницы
// должно убирать эту папку целиком, а не оставлять мусор на диске
check('POST /api/pages/create заводит папку в PROJECTS/, delete её убирает', async (port) => {
    const title = `Смоук ${Date.now()}`;
    const res = await request(port, '/api/pages/create', { method: 'POST', json: { title } });
    equal(res.status, 200, 'код ответа');
    const parsed = JSON.parse(res.body);
    if (!parsed.ok || !parsed.folder) throw new Error(`неожиданный ответ: ${res.body.slice(0, 200)}`);
    const dir = path.join(ROOT, 'PROJECTS', parsed.folder);
    try {
        if (!fs.existsSync(path.join(dir, 'README.md'))) throw new Error(`README.md не создан в ${dir}`);
        const pageJs = path.join(dir, 'page.js');
        if (!fs.existsSync(pageJs)) throw new Error(`page.js не создан в ${dir}`);
        if (!/export default function build\(/.test(fs.readFileSync(pageJs, 'utf8'))) {
            throw new Error('page.js не отдаёт модуль с build(page) — new-button.js его не откроет');
        }
        // page.css заводится всегда, даже пустым: <link> на него ставится сразу,
        // и правка стилей подменяется на лету вместо перезагрузки интерфейса
        if (!fs.existsSync(path.join(dir, 'page.css'))) throw new Error(`page.css не создан в ${dir}`);
        await request(port, '/api/pages/delete', { method: 'POST', json: { id: parsed.id } });
        if (fs.existsSync(dir)) throw new Error(`папка ${dir} пережила удаление страницы`);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true }); // подстраховка, если проверка упала раньше удаления
    }
});

// переименование строки меню (SYSTEM/toolbar-menu.js) должно обновлять запись
// в базе, первую строку README.md (иначе открытая карточка покажет старое имя)
// и саму папку: папка — дом страницы целиком, и страница «Feed» в папке
// «Page 6» — ровно то, из-за чего её содержимое разъезжалось по проекту
check('POST /api/pages/rename обновляет title, README.md и имя папки', async (port) => {
    const title = `Смоук ${Date.now()}`;
    const created = JSON.parse((await request(port, '/api/pages/create', { method: 'POST', json: { title } })).body);
    let dir = path.join(ROOT, 'PROJECTS', created.folder);
    try {
        const newTitle = `${title} переименован`;
        const res = await request(port, '/api/pages/rename', { method: 'POST', json: { id: created.id, title: newTitle } });
        equal(res.status, 200, 'код ответа');
        const parsed = JSON.parse(res.body);
        if (!parsed.ok) throw new Error(`неожиданный ответ: ${res.body.slice(0, 200)}`);
        equal(parsed.folder, newTitle, 'папка в ответе');
        if (fs.existsSync(dir)) throw new Error(`старая папка ${dir} осталась на диске`);
        dir = path.join(ROOT, 'PROJECTS', parsed.folder);
        for (const file of ['page.js', 'page.css']) {
            if (!fs.existsSync(path.join(dir, file))) throw new Error(`${file} не переехал в ${dir}`);
        }
        const readme = fs.readFileSync(path.join(dir, 'README.md'), 'utf8');
        if (!readme.startsWith(`# ${newTitle}`)) throw new Error(`README.md не обновлён: ${readme.slice(0, 80)}`);
        const list = JSON.parse((await request(port, '/api/pages', { method: 'POST' })).body);
        const page = list.pages.find((p) => p.id === created.id);
        if (!page || page.title !== newTitle) throw new Error(`title в базе не обновлён: ${JSON.stringify(page)}`);
        if (page.folder !== parsed.folder) throw new Error(`folder в базе не обновлён: ${JSON.stringify(page)}`);
    } finally {
        await request(port, '/api/pages/delete', { method: 'POST', json: { id: created.id } });
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// detect не требует сети и не должен падать даже без установленного бинарника —
// он лишь пробует запустить CLI и молча отфильтровывает неудачные попытки
// (Promise.allSettled). connect/ask здесь не проверяем: они требуют настоящего
// бинарника opencode, которого может не быть на машине, где гоняется смоук
// маршруты Karandash живут в его же папке (PROJECTS/Karandash/karandash-server.js).
// Сам снимок экрана в смоуке не делаем — он лезет к железу; проверяем, что маршрут
// вообще подключён и проверяет вход, а не молчит 404-м
check('POST /api/screenshot/screen отклоняет неверный номер монитора', async (port) => {
    const res = await request(port, '/api/screenshot/screen', { method: 'POST', json: { index: -1 } });
    equal(res.status, 200, 'код ответа');
    const parsed = JSON.parse(res.body);
    if (parsed.ok || !/screen index/i.test(parsed.error)) throw new Error(`неожиданный ответ: ${res.body.slice(0, 200)}`);
});

check('POST /api/flow/state/set сохраняет, /api/flow/state отдаёт', async (port) => {
    const key = `smoke-${Date.now()}`;
    const saved = await request(port, '/api/flow/state/set', { method: 'POST', json: { key, value: { n: 7 } } });
    equal(saved.status, 200, 'код ответа set');
    if (!JSON.parse(saved.body).ok) throw new Error(`не сохранилось: ${saved.body}`);

    const res = await request(port, '/api/flow/state', { method: 'POST' });
    const parsed = JSON.parse(res.body);
    if (parsed.state?.[key]?.n !== 7) throw new Error(`значение не вернулось: ${res.body.slice(0, 200)}`);
});

check('POST /api/flow/state/set без key отвечает ошибкой', async (port) => {
    const res = await request(port, '/api/flow/state/set', { method: 'POST', json: { value: 1 } });
    if (JSON.parse(res.body).ok) throw new Error(`пустой key приняли: ${res.body}`);
});

check('POST /api/toolbar/icons/set сохраняет, /api/toolbar/icons отдаёт', async (port) => {
    const buttonId = `smoke-${Date.now()}`;
    const saved = await request(port, '/api/toolbar/icons/set', { method: 'POST', json: { buttonId, icon: 'star' } });
    equal(saved.status, 200, 'код ответа set');
    if (!JSON.parse(saved.body).ok) throw new Error(`не сохранилось: ${saved.body}`);

    const res = await request(port, '/api/toolbar/icons', { method: 'POST' });
    const parsed = JSON.parse(res.body);
    if (parsed.icons?.[buttonId] !== 'star') throw new Error(`иконка не вернулась: ${res.body.slice(0, 200)}`);
});

check('POST /api/toolbar/icons/set без buttonId отвечает ошибкой', async (port) => {
    const res = await request(port, '/api/toolbar/icons/set', { method: 'POST', json: { icon: 'star' } });
    if (JSON.parse(res.body).ok) throw new Error(`пустой buttonId приняли: ${res.body}`);
});

check('POST /api/toolbar/names/set сохраняет, /api/toolbar/names отдаёт', async (port) => {
    const buttonId = `smoke-${Date.now()}`;
    const saved = await request(port, '/api/toolbar/names/set', { method: 'POST', json: { buttonId, name: 'Моя кнопка' } });
    equal(saved.status, 200, 'код ответа set');
    if (!JSON.parse(saved.body).ok) throw new Error(`не сохранилось: ${saved.body}`);

    const res = await request(port, '/api/toolbar/names', { method: 'POST' });
    const parsed = JSON.parse(res.body);
    if (parsed.names?.[buttonId] !== 'Моя кнопка') throw new Error(`название не вернулось: ${res.body.slice(0, 200)}`);
});

check('POST /api/toolbar/names/set без name отвечает ошибкой', async (port) => {
    const res = await request(port, '/api/toolbar/names/set', { method: 'POST', json: { buttonId: 'x' } });
    if (JSON.parse(res.body).ok) throw new Error(`пустое name приняли: ${res.body}`);
});

check('POST /api/agent/detect не падает без бинарника', async (port) => {
    const res = await request(port, '/api/agent/detect', { method: 'POST', json: { agent: 'opencode' } });
    equal(res.status, 200, 'код ответа');
    const parsed = JSON.parse(res.body);
    if (!Array.isArray(parsed.installs)) throw new Error(`неожиданный ответ: ${res.body.slice(0, 200)}`);
});

check('POST /api/agent/detect с чужим именем — понятная ошибка', async (port) => {
    const res = await request(port, '/api/agent/detect', { method: 'POST', json: { agent: 'нет-такого' } });
    const parsed = JSON.parse(res.body);
    if (parsed.ok !== false || !/Unknown agent/.test(parsed.error || '')) {
        throw new Error(`ожидалась ошибка про агента: ${res.body}`);
    }
});

check('падение обработчика отдаётся кодом 500, а не 200', async (port) => {
    // тело не JSON — readJson бросит, дальше сработает общий catch
    const res = await request(port, '/api/agent/detect', { method: 'POST', raw: 'не json' });
    equal(res.status, 500, 'код ответа');
    if (JSON.parse(res.body).ok !== false) throw new Error(`ожидался ok:false: ${res.body}`);
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
    // папка прогона одноразовая: прошлые данные не должны влиять на проверки
    fs.rmSync(path.join(ROOT, SMOKE_DATA_DIR), { recursive: true, force: true });
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
