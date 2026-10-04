// Запуск и остановка процессов CLI: единственное место в проекте, где процесс
// физически создаётся. Коннекторы (SYSTEM/cli/opencode.js) сюда ходят и больше ни
// к чему не прикасаются: их контракт — (Promise, onLine, onSpawn с .kill()).
//
// exec-bridge: удалённый spawn, когда сам server.js в контейнере. Пока сервер
// работает на голом хосте, ничего не меняется — spawn() остаётся локальным.
// EXEC_MODE=remote включает пилот из DOCS/decisions/037: тот же вызов уходит
// HTTP-запросом к exec-bridge (exec-bridge/server.py, живёт на хосте) с тем же
// внешним контрактом, и коннектор не знает, локальный это spawn или поход через
// мост.
const http = require('http');
const { spawn } = require('child_process');

// Кнопка Stop гасила только тот процесс, который мы породили сами, и этого мало:
// на Windows потомки убитого процесса сигнала не получают и живут дальше. Поэтому
// гасим всё дерево taskkill /T. (У коннектора была ещё WSL-цель, где процесс жил
// в отдельном PID-namespace и его надо было гасить изнутри виртуалки — цели нет.)
function killTree(child) {
    if (process.platform === 'win32' && child.pid) {
        // /T — вместе с потомками, /F — принудительно: сигналов на Windows нет
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
            .on('error', () => {}); // процесс мог завершиться сам, пока мы собирались
    }
    child.kill();
}

const EXEC_MODE = process.env.EXEC_MODE || null;
const EXEC_BRIDGE_URL = (process.env.EXEC_BRIDGE_URL || 'http://host.docker.internal:8789').replace(/\/+$/, '');
const EXEC_BRIDGE_TOKEN = process.env.EXEC_BRIDGE_TOKEN || '';

function execBridgeHeaders() {
    return EXEC_BRIDGE_TOKEN ? { Authorization: `Bearer ${EXEC_BRIDGE_TOKEN}` } : {};
}

function execViaBridge(cmd, args, { timeoutMs, onLine, onSpawn } = {}) {
    return new Promise((resolve, reject) => {
        const url = new URL(`${EXEC_BRIDGE_URL}/exec`);
        const payload = JSON.stringify({ cmd, args, timeoutMs });
        const req = http.request({
            hostname: url.hostname,
            port: url.port || 80,
            path: url.pathname,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...execBridgeHeaders() },
        });

        // мост сам применяет timeoutMs к процессу — это лишь страховка на случай,
        // если сам HTTP-запрос к мосту повиснет (сеть недоступна, мост завис)
        if (timeoutMs) {
            req.setTimeout(timeoutMs + 30_000, () => {
                req.destroy(new Error(`exec-bridge did not respond within ${Math.round(timeoutMs / 1000)}s (+30s grace)`));
            });
        }

        // тот же контракт onSpawn(child)/child.kill(), что и у локального spawn —
        // Stop (killTree) не знает и не должен знать, что цель удалённая
        const fakeChild = {
            __stoppedByUser: false,
            __runId: null,
            kill() {
                this.__stoppedByUser = true;
                if (!this.__runId) { req.destroy(new Error('Stopped by the user')); return; } // мост ещё не ответил started
                const killUrl = new URL(`${EXEC_BRIDGE_URL}/exec/${this.__runId}/kill`);
                http.request({ hostname: killUrl.hostname, port: killUrl.port || 80, path: killUrl.pathname, method: 'POST', headers: execBridgeHeaders() })
                    .on('error', () => {}) // мост мог уже погасить процесс сам — обычная гонка со Stop
                    .end();
            },
        };
        onSpawn?.(fakeChild);

        let stdout = '';
        let finished = false;
        const done = (err, value) => {
            if (finished) return;
            finished = true;
            err ? reject(err) : resolve(value);
        };

        req.on('error', (err) => {
            done(fakeChild.__stoppedByUser ? new Error('Stopped by the user') : new Error(`exec-bridge unreachable: ${err.message}`));
        });

        req.on('response', (res) => {
            if (res.statusCode >= 400) {
                let body = '';
                res.on('data', (c) => { body += c; });
                res.on('end', () => done(new Error(body.trim() || `exec-bridge returned ${res.statusCode}`)));
                return;
            }
            // NDJSON: одна строка — одно событие (started/line/done), см. exec-bridge/README.md
            let tail = '';
            res.on('data', (chunk) => {
                tail += chunk;
                let cut;
                while ((cut = tail.indexOf('\n')) !== -1) {
                    const raw = tail.slice(0, cut);
                    tail = tail.slice(cut + 1);
                    if (!raw.trim()) continue;
                    let event;
                    try { event = JSON.parse(raw); } catch { continue; }
                    if (event.type === 'started') fakeChild.__runId = event.runId;
                    else if (event.type === 'line') onLine ? onLine(event.text) : (stdout += event.text + '\n');
                    else if (event.type === 'done') {
                        if (event.timedOut) return done(new Error(`Timed out (${Math.round((timeoutMs || 0) / 1000)}s)`));
                        if (event.code === 0) return done(null, stdout);
                        done(new Error(fakeChild.__stoppedByUser ? 'Stopped by the user' : ((event.stderr || '').trim() || `CLI exited with code ${event.code}`)));
                    }
                }
            });
            res.on('end', () => done(new Error('exec-bridge closed the connection before finishing')));
        });

        req.end(payload);
    });
}

// run(cmd, args, { timeoutMs, onLine, onSpawn }) — обе ветви (локальная и мост)
// отдают одно и то же: stdout строкой, если onLine не задан, и по одной строке
// в onLine, если задан. Таймаут и Stop — тоже одни и те же
function run(cmd, args, { timeoutMs, onLine, onSpawn } = {}) {
    if (EXEC_MODE === 'remote') return execViaBridge(cmd, args, { timeoutMs, onLine, onSpawn });

    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, { windowsHide: true });
        onSpawn?.(child);

        let stdout = '';
        let stderr = '';
        let finished = false;

        const timer = setTimeout(() => {
            finished = true;
            killTree(child);
            reject(new Error(`Timed out (${Math.round(timeoutMs / 1000)}s)`));
        }, timeoutMs);

        const done = (err, value) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            err ? reject(err) : resolve(value);
        };

        child.on('error', (err) => {
            done(new Error(err.code === 'ENOENT' ? `${cmd} not found` : err.message));
        });

        let tail = '';
        child.stdout.on('data', (chunk) => {
            if (!onLine) {
                stdout += chunk;
                return;
            }
            tail += chunk;
            const lines = tail.split('\n');
            tail = lines.pop();
            for (const line of lines) {
                if (line.trim()) onLine(line);
            }
        });
        child.stderr.on('data', (chunk) => { stderr += String(chunk); });

        child.on('close', (code) => {
            // CLI шлёт ошибку хода событием type:'error' внутри NDJSON, а не
            // ненулевым кодом выхода (проверено вживую) — код нужен только для
            // случаев, когда сам процесс не смог стартовать/упал вне протокола
            if (code === 0) done(null, stdout);
            else done(new Error(child.__stoppedByUser ? 'Stopped by the user' : (stderr.trim() || `CLI exited with code ${code}`)));
        });

        child.stdin.on('error', () => {});
        child.stdin.end(); // CLI не читает stdin — промпт уже в аргументах
    });
}

module.exports = { run, killTree };