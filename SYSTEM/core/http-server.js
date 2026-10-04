// Приём запросов: кому отвечаем, как разбираем адрес и что отдаём, когда это не
// API. Один модуль на весь путь запроса — до маршрутов он один и тот же, а
// разносить его по файлам значит собирать его обратно в каждом из них
// (DOCS/decisions/022).
const fs = require('fs');
const http = require('http');
const path = require('path');
const { renderPage } = require('./version.js');

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

// сервер запускает локальный CLI, поэтому обслуживаем только запросы с этой машины
function isLocalRequest(req) {
    const address = req.socket.remoteAddress || '';
    return address === '127.0.0.1'
        || address === '::1'
        || address === '::ffff:127.0.0.1'
        || address.startsWith('127.');
}

// createServer({ root, liveReload, reload, api, branch }):
//   reload — живая перезагрузка (канал /__reload и скрипт страницы)
//   api    — обработчик /api/* (core/api.js)
//   branch — предпросмотр ветки (core/branch-preview.js)
function createServer({ root, liveReload, reload, api, branch }) {
    return http.createServer((req, res) => {
        if (!isLocalRequest(req)) {
            res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('403 Forbidden: the server only answers local requests');
            return;
        }

        // Адрес приходит из сети, а значит может быть битым: у HTTP/1.0-запросов
        // заголовка Host нет (тогда `http://undefined` — не база URL и new URL
        // бросает ERR_INVALID_URL), а `%zz` в пути роняет decodeURIComponent с
        // URIError. Раньше обе ошибки летели из обработчика запроса в
        // uncaughtException, который гасит процесс, — и один кривой запрос
        // (например, от прокси или расширения браузера) ронял всю страницу,
        // причём насмерть: сторож после падения ждал правки серверных файлов.
        // Теперь это ответ 400, а сервер продолжает жить
        let urlPath;
        try {
            const host = req.headers.host || 'localhost';
            urlPath = decodeURIComponent(new URL(req.url, `http://${host}`).pathname);
        } catch {
            res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('400 Bad Request: cannot parse the request URL');
            return;
        }

        if (liveReload && urlPath === '/__reload') {
            reload.connect(req, res);
            return;
        }

        if (urlPath.startsWith('/api/')) {
            api(req, res, urlPath);
            return;
        }

        // ветка исполнителя живьём: тот же клиент, но прочитанный из её рабочей копии.
        // API сюда не попадает (оно выше и абсолютное), поэтому лента и база общие.
        // Отдаёт модуль целиком — тогда эту развилку можно проверить настоящими
        // запросами, не поднимая сервера (DOCS/decisions/042)
        if (branch.handle(res, urlPath, { root, mime: MIME, renderHtml: renderPage })) return;

        // страница лежит в SYSTEM, но отдаётся по «/»: адреса в браузере от этого не зависят
        const filePath = path.join(root, urlPath === '/' ? 'SYSTEM/index.html' : urlPath);

        // не выпускаем запросы за пределы каталога проекта
        if (!filePath.startsWith(root + path.sep)) {
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
                ? Buffer.from(renderPage(data.toString('utf8'), liveReload ? reload.snippet : ''), 'utf8')
                : data;

            res.writeHead(200, {
                'Content-Type': MIME[ext] || 'application/octet-stream',
                'Cache-Control': 'no-store',
            });
            res.end(body);
        });
    });
}

module.exports = { createServer, MIME, isLocalRequest };