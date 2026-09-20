// Живая проверка интерфейса на сервере, который поднял пользователь.
//
// Сервер из сессии агента не поднимают (DOCS/decisions/002), а свой запущенный
// сервер пользователя агенту виден: сервер живёт на Windows и отвечает только
// локальным запросам, поэтому из WSL (403) и из браузера внутри WSL его не
// достать. Этот скрипт запускается node на Windows, поднимает отдельный
// безголовый Edge со своим профилем (браузер пользователя не трогает), открывает
// пульт и выполняет в странице переданный JS.
//
// Запуск из WSL:
//   powershell.exe -NoProfile -Command "node <путь-к-проекту>\SYSTEM\live-check.mjs <файл.js> [снимок.png]"
// Файл — тело async-функции: `return` отдаёт результат JSON-ом в stdout.
// Первый вызов запускает Edge и может не вернуть управление powershell — тогда
// запускать в фоне и читать вывод из файла; следующие вызовы берут уже живой Edge.
// Погасить Edge по окончании (только его, по профилю):
//   Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*okcheck\profile*' } | % { Stop-Process -Id $_.ProcessId -Force }
// Строка «Assertion failed … async.c» в конце — node на Windows при выходе, не ошибка.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const PORT = 9333;
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function json(path, method = 'GET') {
    const r = await fetch(`http://127.0.0.1:${PORT}${path}`, { method });
    return r.json();
}
async function ensureBrowser() {
    try { return await json('/json/version'); } catch {}
    spawn(EDGE, ['--headless=new', `--remote-debugging-port=${PORT}`, '--user-data-dir=C:\\Users\\Public\\okcheck\\profile',
        '--window-size=1600,1000', '--no-first-run', 'about:blank'], { detached: true, stdio: 'ignore' }).unref();
    for (let i = 0; i < 40; i++) { await sleep(250); try { return await json('/json/version'); } catch {} }
    throw new Error('edge did not start');
}
// адрес пульта: порт из .env, как в SYSTEM/ui-walk.mjs (порт — только там, не хардкодом)
function appUrl() {
    let port = '3001';
    try {
        const env = fs.readFileSync(new URL('../.env', import.meta.url), 'utf8');
        port = env.match(/^PORT=(\d+)/m)?.[1] || port;
    } catch {}
    return `http://127.0.0.1:${port}`;
}
const APP = appUrl();
await ensureBrowser();
let pages = (await json('/json/list')).filter((t) => t.type === 'page');
let page = pages.find((p) => p.url.startsWith(APP));
if (!page) page = await json(`/json/new?${APP}/`, 'PUT');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0; const waits = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && waits.has(m.id)) { waits.get(m.id)(m); waits.delete(m.id); } });
const send = (method, params = {}) => new Promise((r) => { const i = ++id; waits.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
const expr = fs.readFileSync(process.argv[2], 'utf8');
const res = await send('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true });
console.log(JSON.stringify(res.result?.result?.value ?? res.result?.exceptionDetails ?? res, null, 2));
if (process.argv[3]) {
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(process.argv[3], Buffer.from(shot.result.data, 'base64'));
}
ws.close();
process.exit(0);
