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

function sendJson(res, payload, status = 200) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
    });
    res.end(body);
}

function sendHtml(res, html, status = 200) {
    const body = Buffer.from(html, 'utf8');
    res.writeHead(status, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': body.length,
        'Cache-Control': 'no-store',
    });
    res.end(body);
}

module.exports = { readJson, escapeHtml, sendJson, sendHtml };
