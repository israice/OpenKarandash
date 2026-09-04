// Серверная половина вкладки Kanban: в проект встроен beads-web — npm-пакет
// `beads-kanban-ui`, готовая доска Beads. Внутри пакета лежит Rust-бинарь со
// вшитым Next.js-интерфейсом; своей доски мы не рисуем, вкладка показывает его.
//
// Клиентская половина — PROJECTS/Kanban/kanban.js.
//
// Модуль делает две вещи:
//
// 1. Держит бинарь живым: поднимает по первому заходу на вкладку Kanban (не при
//    старте сервера — иначе второй слушающий процесс заводился бы всегда, даже
//    если доску не открывали), гасит вместе с собой и регистрирует в нём папку
//    проекта. Порт — BEADS_PORT из .env, `0` выключает доску совсем (так делает
//    смоук). Браузер бинарь не открывает: это делает только команда
//    `bead-kanban` из пакета, а её мы не зовём — запускаем сам бинарь.
// 2. Отдаёт его через наш порт. Это не украшение: пока кадр смотрел на
//    localhost:3008, он был чужого origin, и Karandash не мог заглянуть внутрь —
//    подсвечивал доску одним прямоугольником на весь экран. С нашего порта его
//    документ доступен, и карандаш указывает на кнопки и карточки самого beads.
//
// Подробности — DOCS/decisions/021.

const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');
const { sendJson } = require('../../SYSTEM/core/http.js');

const HEALTH_TIMEOUT_MS = 20_000;  // столько ждём, пока бинарь поднимется
const HEALTH_INTERVAL_MS = 300;

// адрес, по которому доска видна снаружи: кадр вкладки смотрит сюда
const MOUNT = '/kanban-ui';

// собственные разделы API beads-web — собраны из его же бандла (`"/api/...` в
// _next/static/chunks). С нашими не пересекаются: у нас agent/sessions/fragment/
// obsidian/search/file/pages/screenshot/flow/toolbar/kanban, у него — эти.
// Список явный, а не «всё неизвестное ему»: чужой раздел не должен молча
// перехватывать наш маршрут, если тот однажды опечатается
const BEADS_API = new Set([
    'agents', 'bd', 'beads', 'fs', 'git', 'health',
    'memory', 'projects', 'project-tags', 'tags', 'watch',
]);

function binaryPath(root) {
    const name = process.platform === 'win32' ? 'beads-server.exe' : 'beads-server';
    return path.join(root, 'node_modules', 'beads-kanban-ui', 'bin', name);
}

function createRoutes({ root }) {
    const port = Number(process.env.BEADS_PORT ?? 3008);
    const base = `http://127.0.0.1:${port}`;
    const state = { running: false, error: null, projectId: null };

    async function health() {
        try {
            const res = await fetch(`${base}/api/health`);
            return res.ok;
        } catch {
            return false; // никто не слушает — это не ошибка, а «ещё не поднялся»
        }
    }

    async function waitForHealth() {
        const deadline = Date.now() + HEALTH_TIMEOUT_MS;
        while (Date.now() < deadline) {
            if (await health()) return true;
            await new Promise((resolve) => setTimeout(resolve, HEALTH_INTERVAL_MS));
        }
        return false;
    }

    // папка проекта в списке beads-web: путь только со слэшами — обратные
    // косые он не принимает. Повторный запуск ничего не дублирует.
    // id проекта запоминаем в state.projectId: он у нас всего один, и кадр
    // сразу открывает его — без лишнего клика по списку проектов
    async function registerProject() {
        const projectPath = root.replace(/\\/g, '/');
        try {
            const list = await (await fetch(`${base}/api/projects`)).json();
            const existing = Array.isArray(list) && list.find((item) => item.path === projectPath);
            if (existing) {
                state.projectId = existing.id;
                return;
            }
            const created = await (await fetch(`${base}/api/projects`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: path.basename(root), path: projectPath }),
            })).json();
            state.projectId = created?.id ?? null;
        } catch (err) {
            console.error('beads-web: не удалось зарегистрировать проект:', err.message);
        }
    }

    async function start() {
        if (!port) return; // BEADS_PORT=0 — доска выключена (смоук, headless-прогон)
        state.error = null; // прошлая неудача не должна висеть вечно: пробуем заново

        // на порту уже кто-то есть: пользователь поднял `bead-kanban` руками или
        // это тот же бинарь, переживший перезапуск сервера. Второй не заводим
        if (await health()) {
            state.running = true;
            await registerProject();
            return;
        }

        const bin = binaryPath(root);
        if (!fs.existsSync(bin)) {
            state.error = 'beads-web не установлен: выполните npm install';
            return;
        }

        const child = spawn(bin, [], {
            windowsHide: true,
            stdio: 'ignore',
            env: { ...process.env, PORT: String(port) },
        });
        child.on('error', (err) => { state.error = `beads-web не запустился: ${err.message}`; });
        // бинарь не должен пережить наш сервер: иначе после перезапуска он
        // занимает порт, а в диспетчере задач его никто не ищет
        const kill = () => { try { child.kill(); } catch { /* уже мёртв */ } };
        process.on('exit', kill);
        child.unref();

        if (await waitForHealth()) {
            state.running = true;
            await registerProject();
        } else if (!state.error) {
            state.error = `beads-web не ответил на порту ${port} за ${HEALTH_TIMEOUT_MS / 1000} с`;
        }
    }

    // Доска поднимается по первому заходу на вкладку, а не при старте сервера.
    // Иначе `node server.js` заводил в системе второй слушающий процесс всегда —
    // даже если Kanban в этот раз не открывали ни разу. Параллельные запросы
    // ждут один и тот же запуск, а не плодят по бинарю на каждый
    let starting = null;

    function ensureStarted() {
        if (!starting) starting = start().finally(() => { starting = null; });
        return starting;
    }

    // ---------- отдача beads-web через наш порт ----------

    // Что из адресов принадлежит доске. Три группы, и все три обязательны:
    // разметку он отдаёт по MOUNT, статику просит от корня (`/_next/...`),
    // свой API зовёт тоже от корня и абсолютными путями — под префиксом он не живёт
    function owns(urlPath) {
        if (!port || !state.running) return false;
        if (urlPath === MOUNT || urlPath.startsWith(MOUNT + '/')) return true;
        if (urlPath.startsWith('/_next/')) return true;
        if (urlPath.startsWith('/api/')) return BEADS_API.has(urlPath.split('/')[2]);
        return false;
    }

    // Его собственная навигация (клик по проекту) меняет адрес кадра на путь вида
    // `/project/<id>` — уже нашего origin. Такие адреса тоже его, но перечислить их
    // заранее нельзя: маршруты знает только он. Поэтому добираем их по остаточному
    // признаку — GET за путём без расширения, которого у нас на диске нет.
    // Файлы (`/no-such-file.txt`) и наш `/api/*` под это правило не попадают
    function ownsFallback(req, urlPath) {
        if (!port || !state.running) return false;
        if (req.method !== 'GET') return false;
        if (urlPath.startsWith('/api/')) return false;
        return !path.extname(urlPath);
    }

    function proxy(req, res, urlPath) {
        // MOUNT — только наш внешний адрес: внутри у доски это её корень
        const inner = urlPath === MOUNT || urlPath.startsWith(MOUNT + '/')
            ? (urlPath.slice(MOUNT.length) || '/')
            : urlPath;
        const search = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';

        const upstream = http.request({
            host: '127.0.0.1',
            port,
            path: inner + search,
            method: req.method,
            headers: { ...req.headers, host: `127.0.0.1:${port}` },
        }, (up) => {
            res.writeHead(up.statusCode, up.headers);
            up.pipe(res); // потоком: у доски есть длинные ответы (слежение за файлами)
        });

        upstream.on('error', (err) => {
            if (res.headersSent) { res.end(); return; }
            res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end(`502 beads-web недоступен: ${err.message}`);
        });

        req.pipe(upstream);
    }

    return {
        routes: {
            // клиент спрашивает, куда смотреть. Живость перепроверяем каждый раз:
            // бинарь мог упасть уже после старта
            '/api/kanban/status': async (req, res) => {
                if (!port) {
                    sendJson(res, { ok: false, error: 'BEADS_PORT=0 — доска выключена в .env' });
                    return;
                }
                // не отвечает — значит либо ещё не поднимали, либо упал: пробуем
                // поднять прямо сейчас. Это единственное место, где он заводится
                state.running = await health();
                if (!state.running) await ensureStarted();
                if (!state.running) {
                    sendJson(res, { ok: false, error: state.error || `beads-web не отвечает на порту ${port}` });
                    return;
                }
                // адрес нашего же origin: только так кадр остаётся доступен Karandash.
                // проект у нас один — открываем его сразу, минуя список проектов
                const path = state.projectId ? `/project/${state.projectId}` : '/';
                sendJson(res, { ok: true, url: MOUNT + path });
            },
        },
        owns,
        ownsFallback,
        proxy,
    };
}

module.exports = { createRoutes };
