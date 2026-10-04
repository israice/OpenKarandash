// Из чего состояли ходы: сколько шагов инструмента ушло впустую и по какой
// причине. Только чтение DATA/.sessions.db, служебный инструмент для перемера
// правил и подсказок (DOCS/agents/измерения.md, DOCS/decisions/072).
//
//   node TOOLS/steps/run.mjs            сводка по последним 8 сессиям
//   node TOOLS/steps/run.mjs 20         по последним 20 сессиям
//   node TOOLS/steps/run.mjs 8 opencode-windows-mutwv071   одна сессия подробно
//
// Виды лишних шагов берутся из SYSTEM/core/waste-kinds.js — тем же списком,
// по которому агенту едет подсказка (waste-hints.js). Списка два быть не
// должно: предупреждать о том, что потом не меряется, бессмысленно.
//
// Каждая лишняя строка — один ход основной модели. Цена шага измеряется не
// здесь: её видно в той же базе по duration_ms и токенам хода, а здесь сам
// факт — шаг, который ничего не дал.
import path from 'node:path';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.join(import.meta.dirname, '..', '..'));
const COUNT = Number(process.argv[2] || 8);
const ONLY = process.argv[3] || null;

// waste-kinds.js — CommonJS, как весь серверный код проекта
const require = createRequire(import.meta.url);
const { KINDS, SESSION_KIND, classify, hardCount } = require('../../SYSTEM/core/waste-kinds.js');

const db = new DatabaseSync(path.join(ROOT, 'DATA', '.sessions.db'), { readOnly: true });

// одна строка — один шаг инструмента: ровно то, из чего складывается ход
const rows = db.prepare(`
    SELECT session_id, position, tool_name, tool_input, tool_error, created_at
    FROM messages
    WHERE role = 'tool'
    ORDER BY created_at DESC
`).all();

const bySession = new Map();
for (const row of rows) {
    const id = row.session_id || '';
    if (!id.startsWith('opencode-')) continue;
    if (!bySession.has(id)) bySession.set(id, []);
    bySession.get(id).push(row);
}

const all = [...bySession.entries()];
const chosen = ONLY ? all.filter(([id]) => id === ONLY) : all.slice(0, COUNT);

if (!chosen.length) {
    console.log('Нет сессий opencode в базе — или неверный идентификатор.');
    process.exit(0);
}

const totals = new Map();
const perSession = [];
let sumSteps = 0;
let sumHard = 0;
let sumWaste = 0;

for (const [id, steps] of chosen) {
    const found = classify(steps);
    const waste = [...found.values()].reduce((n, p) => n + p.length, 0);
    const last = steps[steps.length - 1];
    perSession.push({
        id, steps: steps.length, waste, hard: hardCount(found),
        at: String(last?.created_at || '').slice(5, 16), found,
    });
    sumSteps += steps.length;
    sumWaste += waste;
    sumHard += hardCount(found);
    for (const [kind, positions] of found) {
        if (!totals.has(kind)) totals.set(kind, { count: 0, sessions: 0 });
        totals.get(kind).count += positions.length;
        totals.get(kind).sessions += 1;
    }
}

perSession.sort((a, b) => (a.at < b.at ? 1 : -1));

const pct = (n) => `${Math.round((n / Math.max(sumSteps, 1)) * 100)}%`;
console.log(`сессий: ${chosen.length}, шагов: ${sumSteps}`);
console.log(`лишних: ${sumWaste} (${pct(sumWaste)}), жёстких: ${sumHard} (${pct(sumHard)}), мягких: ${sumWaste - sumHard}\n`);
console.log('сессия                        шагов  жёстких  всего  доля');
for (const s of perSession) {
    const share = Math.round((s.hard / Math.max(s.steps, 1)) * 100);
    console.log(`  ${s.id.padEnd(28)} ${String(s.steps).padStart(5)}  ${String(s.hard).padStart(7)}  ${String(s.waste).padStart(5)}  ${String(share).padStart(4)}%  ${s.at}`);
}

const whatOf = (id) => (id === SESSION_KIND.id ? SESSION_KIND : KINDS.find((k) => k.id === id))?.what || '';
console.log('\nвиды лишних шагов — раз | сессий | вид');
for (const [id, t] of [...totals].sort((a, b) => b[1].count - a[1].count)) {
    console.log(`  ${String(t.count).padStart(4)}×  ${String(t.sessions).padStart(3)}   ${id.padEnd(18)} ${whatOf(id)}`);
}

if (ONLY) {
    console.log(`\n--- ${ONLY} ---`);
    for (const s of perSession) {
        for (const [kind, positions] of s.found) console.log(`  ${kind.padEnd(18)} шаги ${positions.join(', ')}`);
    }
}

db.close();
