// Общие мелочи HTTP: чтение тела и три способа ответить. Вынесены из server.js,
// чтобы серверные половины фич (PROJECTS/*/**-server.js) не тянули за собой
// весь сервер ради sendJson.

// тело запроса с лимитом: без него один кривой клиент может съесть память
function readJson(req, limit = 100_000) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', (chunk) => {
            body += chunk;
            if (body.length > limit) {
                reject(new Error('Request too large'));
                req.destroy();
            }
        });
        req.on('end', () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            } catch {
                reject(new Error('Invalid JSON'));
            }
        });
        req.on('error', reject);
    });
}

// экранируем и одинарную кавычку, и не-строки (в server.js было text.replace,
// которое падало на числе) — вывод для HTML от этого только строже
function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, (ch) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
    ));
}

// Если заголовки уже ушли (поток хода NDJSON начат, а ошибка прилетела после),
// второй раз их писать нельзя: Node бросает ERR_HTTP_HEADERS_SENT, и падение
// внутри обработчика запроса убивает весь сервер — вкладка при этом видит
// «Failed to fetch», а не ошибку хода. Поэтому поздний ответ просто дописываем
// в уже открытый поток и закрываем его
function sendBody(res, body, status, contentType) {
    if (!res.headersSent && !res.writableEnded) {
        res.writeHead(status, {
            'Content-Type': contentType,
            'Content-Length': Buffer.byteLength(body),
            'Cache-Control': 'no-store',
        });
    }
    if (res.writableEnded) return;
    res.end(body);
}

function sendJson(res, payload, status = 200) {
    sendBody(res, JSON.stringify(payload), status, 'application/json; charset=utf-8');
}

function sendHtml(res, html, status = 200) {
    sendBody(res, Buffer.from(html, 'utf8'), status, 'text/html; charset=utf-8');
}

module.exports = { readJson, escapeHtml, sendJson, sendHtml };
