// Рисует дизайн CLI-дропдауна в Penpot через MCP: execute_code в живом плагине.
//
//   node TOOLS/penpot-mcp/design/build.mjs            — пересобрать дизайн
//   node TOOLS/penpot-mcp/design/build.mjs --preview  — и положить PNG рядом
//
// Каждый шаг — отдельный файл, helpers.js подставляется в начало каждого: шаг
// самодостаточен, порядок сборки можно менять. Всё идемпотентно — доска и токены
// создаются, если их ещё нет, содержимое пересобирается заново.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, call } from './mcp-client.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (file) => fs.readFileSync(path.join(here, file), 'utf8');
// theme.json — единственный источник палитры и типографики, helpers.js —
// общие помощники. Оба подставляются в начало каждого шага: значения не
// дублируются по файлам, и правка темы не требует обхода шагов. THEME идёт
// первым — helpers обращается к нему на этапе объявления.
const helpers = `const THEME = ${read('theme.json')};\n${read('helpers.js')}`;

const server = await open();
const results = {};

for (const file of ['tokens.js', 'components.js', 'header.js', 'panel.js', 'states.js', 'apply-tokens.js']) {
    const { text } = await call('execute_code', { code: `${helpers}\n\n${read(file)}` });
    if (/Error|error:/i.test(text) && text.includes('Tool execution failed')) throw new Error(`${file}: ${text}`);
    results[file] = text;
}

// Проверка вёрстки: дешёвый и полный способ поймать наезды, которые на
// скриншоте видны не всегда. Идёт после сборки, а не вместо скриншота.
if (process.argv.includes('--check')) {
    const { text } = await call('execute_code', { code: read('lint.js') });
    results.lint = text;
    // Ответ execute_code — JSON-строка с JSON внутри, поэтому режем по краям.
    const payload = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    if (payload.result?.total > 0) {
        for (const p of payload.result.problems) console.error(`lint ${p.kind}: ${p.where} — ${p.detail}`);
        throw new Error(`lint: ${payload.result.total} проблем (${JSON.stringify(payload.result.byKind)})`);
    }
    console.log('lint: чисто');
}

if (process.argv.includes('--preview')) {
    // Превью снимаем из браузера (shot.mjs), а не через export_shape: экспорт
    // рисуется без шрифтов и текст выходит засечным.
    const { execFileSync } = await import('node:child_process');
    results.preview = execFileSync('node', [path.join(here, 'shot.mjs'), path.join(here, 'preview.png'), 'CLI dropdown'], { encoding: 'utf8' }).trim();
}

console.log(JSON.stringify({ server, ...results }, null, 1));