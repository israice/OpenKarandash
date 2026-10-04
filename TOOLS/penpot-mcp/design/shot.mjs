// Скриншот окна Penpot из безголового Edge — так дизайн видно настоящими
// шрифтами. export_shape для этого не годится: он рисует на экспортере, где
// шрифты не подставлены, и текст выходит засечным. Работает при запущенном
// TOOLS/penpot-mcp/connect.mjs (профиль C:\Users\Public\penpotmcp\profile,
// порт отладки 9444).
//
//   node TOOLS/penpot-mcp/design/shot.mjs                       → shot.png рядом
//   node TOOLS/penpot-mcp/design/shot.mjs <путь> [имя фигуры]   → свой путь и зум
//
// Второй аргумент — имя фигуры: скрипт через MCP зумит канвас на неё.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, call } from './mcp-client.mjs';

const DEBUG_PORT = process.env.PENPOT_DEBUG_PORT || 9444;
const here = path.dirname(fileURLToPath(import.meta.url));
const out = process.argv[2] || path.join(here, 'shot.png');
const shape = process.argv[3];

if (shape) {
    await open();
    await call('execute_code', {
        code: `const s = penpotUtils.findShape((x) => x.name === ${JSON.stringify(shape)}, penpot.root);`
            + `if (!s) throw new Error('нет фигуры ${shape}');`
            + 'penpot.viewport.zoomIntoView([s]);'
            + 'return { zoom: penpot.viewport.zoom };',
    });
    await new Promise((r) => setTimeout(r, 1500));
}

const targets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
const page = targets.filter((t) => t.type === 'page')[0];
if (!page) throw new Error(`нет вкладки Penpot на порту ${DEBUG_PORT}: запусти TOOLS/penpot-mcp/connect.mjs`);

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0;
const waits = new Map();
ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (waits.has(m.id)) { waits.get(m.id)(m); waits.delete(m.id); }
});
const send = (method, params = {}) => new Promise((r) => {
    const i = ++id;
    waits.set(i, r);
    ws.send(JSON.stringify({ id: i, method, params }));
});
await send('Page.enable');
const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
ws.close();
console.log(`saved ${out} ${fs.statSync(out).size} bytes`);
process.exit(0);