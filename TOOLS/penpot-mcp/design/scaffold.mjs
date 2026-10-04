// Заготовка экрана: доска с шапкой, двумя колонками и сеткой. Из неё
// собирается любой следующий макет — не нужно заново придумывать раскладку,
// отступы и заголовки.
//
//   node TOOLS/penpot-mcp/design/scaffold.mjs "Экран настроек"
//   node TOOLS/penpot-mcp/design/scaffold.mjs "Модели" --x 2100 --y -40
//
// Дальше конкретный экран дорабатывается своим файлом-шагом: helpers.js уже
// даёт box/text/icon/logo и палитру из theme.json, компоненты берутся из
// библиотеки инстансами.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, call } from './mcp-client.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (file) => fs.readFileSync(path.join(here, file), 'utf8');
const helpers = `const THEME = ${read('theme.json')};\n${read('helpers.js')}`;

const argv = process.argv.slice(2);
const title = argv.find((a) => !a.startsWith('--')) || 'Новый экран';
const flag = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : fallback;
};

const code = `${helpers}

const TITLE = ${JSON.stringify(title)};
const X = ${flag('x', 3300)};
const Y = ${flag('y', -40)};

const old = penpotUtils.findShape((s) => s.name === TITLE, penpot.root);
if (old) old.remove();

const board = box(penpot.root, TITLE, X, Y, 1200, 800, { fill: C.canvas });
storage.design.scaffold = { id: board.id, name: TITLE, x: X, y: Y };

// Шапка макета: рубрика, заголовок, пояснение. Порядок и отступы — как на
// доске «CLI dropdown», чтобы рядом лежащие экраны читались одинаково.
const eyebrow = T('eyebrow');
text(board, 'Scaffold eyebrow', (THEME.screens?.[TITLE]?.eyebrow) || 'ЭКРАН', 64, 56, {
    ...eyebrow, color: C.accent,
});
text(board, 'Scaffold title', TITLE, 64, 78, { ...T('title'), color: C.text });
text(board, 'Scaffold hint', 'Что тут происходит и что видно на этом экране — одной строкой.', 64, 130, {
    ...T('body'), color: C.textDim, maxWidth: 620,
});

// Две колонки: слева сам экран, справа состояния и правила. Так же, как в
// готовом макете, — чтобы разбор шёл по одним и тем же рубрикам.
const LW = 460;
const col = box(board, 'Scaffold main', 64, 176, 812, 584, { fill: C.surface, radius: R('card'), stroke: C.hairline });
const side = box(board, 'Scaffold side', 916, 176, LW, 584, { fill: '#15181D', radius: R('card'), stroke: C.hairline });
text(col, 'Scaffold main hint', 'Экран', 24, 24, { ...T('section'), color: C.textMute });
text(side, 'Scaffold side hint', 'Состояния и правила', 24, 24, { ...T('section'), color: C.textMute });

penpot.viewport.zoomIntoView([board]);
await new Promise((r) => setTimeout(r, 1200));
return { board: board.id, name: TITLE };`;

await open();
const { text } = await call('execute_code', { code });
console.log(text);

// Тот же линтер, что и у сборки: заготовка должна быть чистой сразу.
const lint = await call('execute_code', { code: read('lint.js').replace("const boards = ['CLI dropdown', 'Kit'];", `const boards = [${JSON.stringify(title)}];`) });
const payload = JSON.parse(lint.text.slice(lint.text.indexOf('{'), lint.text.lastIndexOf('}') + 1));
if (payload.result?.total) {
    for (const p of payload.result.problems) console.error(`lint ${p.kind}: ${p.where} — ${p.detail}`);
    process.exitCode = 1;
} else {
    console.log('lint: чисто');
}