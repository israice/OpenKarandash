import { open, call } from './mcp-client.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

await open();
const here = path.dirname(fileURLToPath(import.meta.url));

const mk = await call('execute_code', { code: `
const board = penpotUtils.findShape((s) => s.name === 'Kit', penpot.root);
const bad = penpot.createBoard();
board.appendChild(bad);
bad.name = 'LINT PROBE';
bad.resize(200, 80);
penpotUtils.setParentXY(bad, 60, 1000);
bad.fills = [{ fillColor: '#20242C', fillOpacity: 1 }];
const over = penpot.createText('Текст заметно длиннее, чем хозяин, и поэтому вылезет');
over.name = 'LINT PROBE text';
over.fontFamily = 'Inter';
over.fontSize = 12;
over.fills = [{ fillColor: '#EEF2F8', fillOpacity: 1 }];
over.growType = 'auto-width';
bad.appendChild(over);
const a = penpot.createBoard();
a.name = 'LINT PROBE a';
a.resize(120, 40);
penpotUtils.setParentXY(a, 60, 1090);
a.fills = [{ fillColor: '#2F4A75', fillOpacity: 1 }];
const b = penpot.createBoard();
b.name = 'LINT PROBE b';
b.resize(120, 40);
penpotUtils.setParentXY(b, 100, 1110);
b.fills = [{ fillColor: '#E8B45C', fillOpacity: 1 }];
board.appendChild(a);
board.appendChild(b);
return 1;` });

// Тот же обход, что в lint.js, но с отчётом: сколько чего найдено.
const probe = await call('execute_code', { code: `
const board = penpotUtils.findShape((s) => s.name === 'Kit', penpot.root);
await board.waitForLayoutUpdate();
const visible = (s) => s.visible && !s.hidden && s.opacity > 0;
const all = penpotUtils.findShapes((x) => x !== board && x.parent && visible(x), board);
const texts = penpotUtils.findShapes((x) => x.type === 'text' && visible(x), board);
for (const t of texts) await t.waitForLayoutUpdate();
const t = penpotUtils.findShape((x) => x.name === 'LINT PROBE text', penpot.root);
return {
  all: all.length,
  texts: texts.length,
  tFound: !!t,
  tDims: t ? [t.width, t.height, t.textBounds?.width] : null,
  tParent: t?.parent?.name,
  parentDims: t?.parent ? [t.parent.width, t.parent.height] : null,
  visible: t ? visible(t) : null,
};` });
console.log('создание:', JSON.stringify(mk.text).slice(0, 120));
console.log('обход:', probe.text);

const lint = await call('execute_code', { code: fs.readFileSync(path.join(here, 'lint.js'), 'utf8') });
console.log('lint:', lint.text);

await call('execute_code', { code: `
for (const n of ['LINT PROBE', 'LINT PROBE a', 'LINT PROBE b']) {
  const s = penpotUtils.findShape((x) => x.name === n, penpot.root);
  if (s) s.remove();
}
return 1;` });