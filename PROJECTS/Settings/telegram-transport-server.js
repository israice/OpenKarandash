// Разговор с Bot API: отправка писем и длинный опрос обновлений.
//
// Вынесено отдельно от telegram-server.js (DOCS/decisions/022: мост был вдвое
// длиннее нормы). Здесь ровно два транспортных решения, и оба объяснены ниже:
// длинный опрос ходит своим соединением мимо общего пула fetch, а длинный
// таймаут уходит не в setTimeout, а в AbortSignal.
//
// Ключ бота сюда не зашит: он приходит функцией getToken(), потому что человек
// может сменить его прямо в окне настроек, и следующий запрос должен уйти уже с
// новым — без перезапуска сервера.

const https = require('https');

const API = 'https://api.telegram.org/bot';
const DEFAULT_TIMEOUT_MS = 15000;

// Длинный опрос ходит своим соединением, мимо общего пула fetch. В общем пуле
// отправка вставала в очередь за висящим getUpdates и уходила, только когда он
// возвращался: письмо либо опаздывало на десятки секунд, либо все три попытки
// send успевали истечь по таймауту — при исправном Telegram. Поймано замером:
// отправка проходила через 0,2 с после возврата 50-секундного опроса
const pollAgent = new https.Agent({ keepAlive: true, maxSockets: 1 });

module.exports = function createTransport(getToken) {
    function postOwnSocket(url, payload, signal) {
        return new Promise((resolve, reject) => {
            const body = JSON.stringify(payload || {});
            const req = https.request(url, {
                method: 'POST',
                agent: pollAgent,
                signal,
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
            }, (res) => {
                let text = '';
                res.setEncoding('utf8');
                res.on('data', (chunk) => { text += chunk; });
                res.on('end', () => {
                    let data = {};
                    try { data = JSON.parse(text); } catch { /* не JSON — разберёт зовущий по status */ }
                    resolve({ status: res.statusCode, data });
                });
                res.on('error', reject);
            });
            req.on('error', reject);
            req.end(body);
        });
    }

    async function callApi(method, payload, timeoutMs = DEFAULT_TIMEOUT_MS, extraSignal = null) {
        const token = getToken();
        if (!token) throw new Error('Telegram bot token is not set');
        // extraSignal — способ оборвать длинный опрос досрочно: по нему сменившийся
        // ключ отпускает getUpdates сразу, а не через минуту ожидания
        const timeout = AbortSignal.timeout(timeoutMs);
        if (method === 'getUpdates') {
            const signal = extraSignal ? AbortSignal.any([extraSignal, timeout]) : timeout;
            const { status, data } = await postOwnSocket(`${API}${token}/${method}`, payload, signal);
            if (!data.ok) throw new Error(data.description || `Telegram answered ${status}`);
            return data.result;
        }
        const res = await fetch(`${API}${token}/${method}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload || {}),
            signal: extraSignal ? AbortSignal.any([extraSignal, timeout]) : timeout,
        });
        const data = await res.json().catch(() => ({}));
        if (!data.ok) throw new Error(data.description || `Telegram answered ${res.status}`);
        return data.result;
    }

    return { callApi, postOwnSocket, API };
};