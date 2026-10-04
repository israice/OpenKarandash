// Подключает плагин Penpot к MCP-серверу без участия человека.
//
// Обычно это делается руками: открыть файл, Plugins → Penpot MCP Plugin →
// «Connect to MCP server». Агент, который рисует макет через MCP, кликать не
// умеет, а без подключённого плагина сервер отвечает «No Penpot plugin
// instances are currently connected» — операции над макетом выполняет не
// сервер, а JS-рантайм плагина в браузере.
//
// Поэтому скрипт поднимает отдельный безголовый Edge со своим профилем
// (C:\Users\Public\penpotmcp\profile — профиль владельца не трогаем, как и в
// SYSTEM/live-check.mjs), входит под сервисным аккаунтом из .env, открывает
// нужный файл и нажимает Connect. Браузер остаётся жить: пока вкладка открыта,
// плагин на связи и MCP работает.
//
// Запуск из корня проекта:
//   node TOOLS/penpot-mcp/connect.mjs            — безголовый Edge, Connect жмём сами
//   node TOOLS/penpot-mcp/connect.mjs --headful  — обычное окно, если Connect надо дожать руками
// Адрес файла и параметры — из .env (PENPOT_URL, PENPOT_FILE_ID, PENPOT_TEAM_ID,
// PENPOT_PAGE_ID); учётные данные — PENPOT_EMAIL и PENPOT_PASSWORD.
//
// Что нужно снаружи: запущенный стек Penpot (docker compose -f
// deploy/penpot/docker-compose.yaml up -d) и MCP-сервер в одноимённом режиме —
// без него плагин требует userToken, который есть только у того, кто сам
// сгенерировал ключ в Integrations.
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const DEBUG_PORT = 9444;
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PROFILE = 'C:\\Users\\Public\\penpotmcp\\profile';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function env() {
    const out = {};
    try {
        // строку обрезаем: файл дописывали и по LF, и по CRLF, а в последней
        // строке без trim остаётся \r, из-за чего ключ не подходил под шаблон
        for (const line of fs.readFileSync(new URL('../../.env', import.meta.url), 'utf8').split('\n')) {
            const m = line.trim().match(/^([A-Z0-9_]+)=(.*)$/);
            if (m) out[m[1]] = m[2].trim();
        }
    } catch {}
    return out;
}

const ENV = env();
const PENPOT = ENV.PENPOT_URL || 'http://localhost:9001';
const FILE_URL = `${PENPOT}/#/workspace?team-id=${ENV.PENPOT_TEAM_ID}&file-id=${ENV.PENPOT_FILE_ID}`
    + `&page-id=${ENV.PENPOT_PAGE_ID}&layout=layout`;

const cdp = async (path, method = 'GET') => (await fetch(`http://127.0.0.1:${DEBUG_PORT}${path}`, { method })).json();

// Браузер один и долгоживущий: подняли — он остаётся держать плагин на связи
async function ensureBrowser() {
    try { return await cdp('/json/version'); } catch {}
    const headful = process.argv.includes('--headful');
    spawn(EDGE, [...(headful ? [] : ['--headless=new']), `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${PROFILE}`,
        '--window-size=1600,1000', '--no-first-run', '--no-default-browser-check', 'about:blank'],
    { detached: true, stdio: 'ignore' }).unref();
    for (let i = 0; i < 60; i++) { await sleep(250); try { return await cdp('/json/version'); } catch {} }
    throw new Error('edge did not start');
}

const target = (await ensureBrowser(), (await cdp('/json/list')).filter((t) => t.type === 'page')[0]);
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0; const waits = new Map(); const contexts = new Map();
ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waits.has(m.id)) { waits.get(m.id)(m); waits.delete(m.id); return; }
    if (m.method === 'Runtime.executionContextCreated') contexts.set(m.params.context.auxData?.frameId, m.params.context.id);
});
const send = (method, params = {}) => new Promise((r) => { const i = ++id; waits.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expression, ctx) => (await send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true, ...(ctx ? { contextId: ctx } : {}),
})).result?.result?.value;

const mouse = (type, x, y) => send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: 1 });
const click = async (x, y) => { await mouse('mouseMoved', x, y); await mouse('mousePressed', x, y); await mouse('mouseReleased', x, y); await sleep(900); };
const escape = async () => {
    for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(500);
};

// Меню Penpot открывается только настоящими событиями мыши: на синтетику
// не реагирует, а Runtime.evaluate с click() до пункта меню не доходит.
const boxOf = (expression) => evaluate(`(() => { const n = ${expression}; if (!n) return null; const r = n.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
const byText = (re) => boxOf(`[...document.querySelectorAll('button, [role="menuitem"], li')].find((n) => ${re}.test((n.innerText || '').replace(/\\s+/g, ' ').trim()))`);

await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url: PENPOT });
await sleep(7000);

// Вход: на странице логина заполняем форму. Сеттер значения нужен потому, что
// поля Penpot слушают input, а не change, и присваивание .value молча игнорируется.
const onLogin = await evaluate(`!!document.getElementById('email')`);
if (onLogin) {
    await evaluate(`(() => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        const fill = (id, value) => { const el = document.getElementById(id); setter.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
        fill('email', ${JSON.stringify(ENV.PENPOT_EMAIL || '')});
        fill('password', ${JSON.stringify(ENV.PENPOT_PASSWORD || '')});
        [...document.querySelectorAll('button')].find((b) => /continue/i.test(b.innerText))?.click();
        return 1;
    })()`);
    await sleep(7000);
}

await send('Page.navigate', { url: FILE_URL });
await sleep(9000);

// Plugins → Penpot MCP Plugin: пункт появляется после наведения на «Plugins»
await escape();
let pluginItem = null;
for (let attempt = 0; attempt < 3 && !pluginItem; attempt++) {
    const main = await boxOf(`document.querySelector('[aria-label="Main menu"]')`);
    if (main) await click(main.x, main.y);
    const plugins = await byText('/^Plugins$/i');
    if (plugins) {
        await mouse('mouseMoved', plugins.x, plugins.y);
        await sleep(1500);
        pluginItem = await byText('/^Penpot MCP Plugin$/i');
    }
    if (!pluginItem) await escape();
}
if (!pluginItem) throw new Error('в меню нет пункта Penpot MCP Plugin');
await click(pluginItem.x, pluginItem.y);
await sleep(6000);

// Плагин живёт в отдельном фрейме того же происхождения — Connect жмём из его
// контекста, кликом по настоящим координатам он не берётся
const tree = await send('Page.getFrameTree');
const frames = [];
(function walk(node) { frames.push({ id: node.frame.id, url: node.frame.url }); (node.childFrames || []).forEach(walk); })(tree.result.frameTree);
const pluginFrame = frames.find((f) => /\/plugins\/mcp\//.test(f.url));
if (!pluginFrame) throw new Error(`плагин не открылся (кадры: ${frames.map((f) => f.url).join(', ')})`);
if (!contexts.get(pluginFrame.id)) throw new Error('плагин не загрузился');

// Connect жмём из изолированного мира кадра: обработчик кнопки в этом билде
// Penpot 2.18 не ловит ни click() из контекста страницы, ни синтетические
// события CDP по координатам — ловит только dispatchEvent из отдельного
// execution context. После клика плагин сам берёт относительный путь /mcp/ws
// на origin Penpot (его проксирует штатный mcp-locations.conf фронтенда), так
// что ни адрес, ни токен передавать не нужно.
const world = await send('Page.createIsolatedWorld', { frameId: pluginFrame.id, worldName: 'connect', grantUniveralAccess: true });
const pluginCtx = world.result.executionContextId;
const button = await send('Runtime.evaluate', { contextId: pluginCtx, expression: "document.getElementById('connect-btn')", returnByValue: false });
if (!button.result?.result?.objectId) throw new Error('в плагине нет кнопки Connect');
await send('Runtime.callFunctionOn', {
    objectId: button.result.result.objectId,
    functionDeclaration: 'function () { this.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window })); return 1; }',
    returnByValue: true,
});
await sleep(5000);

const status = await evaluate(`document.body.innerText.replace(/\\s+/g, ' ').trim()`, pluginCtx);
console.log(JSON.stringify({ file: FILE_URL, status: status.slice(0, 200) }, null, 1));
ws.close();
process.exit(status.includes('onnected to MCP') || status.includes('Connected') ? 0 : 1);