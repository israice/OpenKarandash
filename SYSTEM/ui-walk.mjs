// Прогон живого интерфейса: все вкладки и страницы кнопки «+», ошибки консоли,
// пустые панели. Ловит то, чего не видит статический анализ (`npm run check`):
// упавший обработчик, обращение к ненаписанному имени внутри функции, вкладку,
// которая открылась пустой (DOCS/decisions/034 — повод, 048 — сам прогон).
//
// Работает на сервере, который поднял пользователь (DOCS/decisions/002), через
// тот же отдельный безголовый Edge, что и SYSTEM/live-check.mjs: сервер отвечает
// только локальным запросам, поэтому скрипт запускается node на Windows.
//
// Запуск одной командой: `npm run ui` (из WSL уходит в powershell сам).
// Код выхода 1 — есть ошибки консоли или пустая вкладка.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// из WSL сервер недоступен (403) — перезапускаем себя node на стороне Windows
if (process.platform === 'linux') {
    const win = spawnSync('wslpath', ['-w', fileURLToPath(import.meta.url)], { encoding: 'utf8' }).stdout.trim();
    const run = spawnSync('powershell.exe', ['-NoProfile', '-Command', `node "${win}" ${process.argv.slice(2).join(' ')}`], { stdio: 'inherit', timeout: 300000 });
    process.exit(run.status ?? 1);
}

const PORT = 9333;
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function appUrl() {
    let port = '3001';
    try {
        const env = fs.readFileSync(path.join(HERE, '..', '.env'), 'utf8');
        port = env.match(/^PORT=(\d+)/m)?.[1] || port;
    } catch {}
    return `http://127.0.0.1:${port}/`;
}

async function cdp(pathname, method = 'GET') {
    return (await fetch(`http://127.0.0.1:${PORT}${pathname}`, { method })).json();
}

async function ensureBrowser() {
    try { return await cdp('/json/version'); } catch {}
    spawn(EDGE, ['--headless=new', `--remote-debugging-port=${PORT}`, '--user-data-dir=C:\\Users\\Public\\okcheck\\profile',
        '--window-size=1600,1000', '--no-first-run', 'about:blank'], { detached: true, stdio: 'ignore' }).unref();
    for (let i = 0; i < 40; i++) { await sleep(250); try { return await cdp('/json/version'); } catch {} }
    throw new Error('edge did not start');
}

const URL_APP = appUrl();
await ensureBrowser();
// своя вкладка на прогон: чужие проверки (live-check) свою страницу не теряют
const page = await cdp(`/json/new?${URL_APP}`, 'PUT');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));

let id = 0;
const waits = new Map();
// ошибки копятся здесь, а разбираются по вкладкам: что пришло, пока вкладка открыта, — её
let errors = [];
ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waits.has(m.id)) { waits.get(m.id)(m); waits.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        errors.push(`${d.exception?.description || d.text} (${(d.url || '').replace(URL_APP, '')}:${d.lineNumber})`.slice(0, 300));
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        errors.push(`console.error: ${m.params.args.map((a) => a.value ?? a.description ?? '').join(' ')}`.slice(0, 300));
    }
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
        errors.push(`${m.params.entry.text} ${(m.params.entry.url || '').replace(URL_APP, '')}`.slice(0, 300));
    }
});
const send = (method, params = {}) => new Promise((r) => { const i = ++id; waits.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (body) => {
    const res = await send('Runtime.evaluate', { expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true });
    if (res.result?.exceptionDetails) throw new Error(res.result.exceptionDetails.exception?.description || 'evaluate failed');
    return res.result?.result?.value;
};
const takeErrors = () => { const got = errors; errors = []; return got; };

await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');
// грузим заново уже с включённым сбором — ошибки самой загрузки тоже наши
await send('Page.reload', { ignoreCache: true });
await sleep(4000);

const report = [{ tab: '(загрузка страницы)', ok: true, errors: takeErrors() }];

// что считать содержимым: видимые элементы внутри показанного <main>
const MEASURE = `
    const view = VIEW;
    if (!view) return { found: false };
    const shown = [...view.querySelectorAll('*')].filter((el) => el.offsetParent !== null);
    return { found: true, hidden: view.hidden, elements: shown.length, text: view.innerText.trim().length };`;

// самопроверка сбора: `npm run ui -- --selftest` роняет в странице исключение —
// прогон обязан его показать и выйти с кодом 1. Молчащий сборщик хуже отсутствующего
if (process.argv.includes('--selftest')) {
    await evaluate(`setTimeout(() => { throw new Error('ui-walk selftest'); }, 0);`);
    await sleep(500);
}

const tabs = await evaluate('return Object.keys(App.VIEWS);');
for (const name of tabs) {
    await evaluate(`MissionTabs.show(${JSON.stringify(name)});`);
    await sleep(1500);
    const m = await evaluate(MEASURE.replace('VIEW', `App.VIEWS[${JSON.stringify(name)}]`));
    report.push({ tab: name, ...m, errors: takeErrors() });
}

// страницы кнопки «+»: их кнопки в тулбаре помечены data-page
const pages = await evaluate(`return [...document.querySelectorAll('.toolbar [data-page]')].map((b) => ({ id: b.dataset.page, title: b.title, hiddenButton: b.hidden }));`);
for (const p of pages) {
    await evaluate(`document.querySelector('[data-page=${JSON.stringify(p.id)}]').click();`);
    await sleep(2500); // модуль страницы грузится при первом открытии
    const m = await evaluate(MEASURE.replace('VIEW', `document.getElementById(${JSON.stringify(p.id)})`));
    report.push({ tab: `+ ${p.title}`, ...m, errors: takeErrors() });
}

// окно настроек — не вкладка, но тоже целый раздел со своей разметкой
await evaluate(`document.getElementById('settingsButton')?.click();`);
await sleep(1500);
const settings = await evaluate(`
    const modal = ['settingsModal', 'settingsMenu'].map((id) => document.getElementById(id)).find((el) => el && !el.hidden);
    return modal ? { found: true, hidden: false, elements: modal.querySelectorAll('*').length, text: modal.innerText.trim().length } : { found: false };`);
report.push({ tab: 'Settings (окно)', ...settings, errors: takeErrors() });

// ответ у close текстовый, не JSON
await fetch(`http://127.0.0.1:${PORT}/json/close/${page.id}`).catch(() => {});
ws.close();

let failed = false;
console.log(`Прогон интерфейса ${URL_APP}\n`);
for (const row of report) {
    const empty = row.found === false || row.hidden === true || (row.elements === 0 && row.text === 0); // заготовка «Hello World» — текст прямо в <main>, без элементов
    const bad = empty || row.errors.length > 0;
    if (bad) failed = true;
    const size = row.elements === undefined ? '' : ` — элементов ${row.elements}, текста ${row.text}`;
    const why = row.found === false ? ' — НЕ НАЙДЕНА' : row.hidden ? ' — НЕ ПОКАЗАНА' : row.elements === 0 && row.text === 0 ? ' — ПУСТАЯ' : '';
    console.log(`${bad ? 'FAIL' : ' ok '}  ${row.tab}${size}${why}`);
    for (const err of row.errors) console.log(`        ${err}`);
}
console.log(failed ? '\nЕсть замечания.' : '\nЗамечаний нет.');
process.exit(failed ? 1 : 0);
