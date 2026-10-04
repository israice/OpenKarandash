// Из чего состояли ходы: сколько шагов инструмента ушло впустую и по какой
// причине. Только чтение DATA/.sessions.db, служебный инструмент для перемера
// правил и подсказок (DOCS/agents/измерения.md, DOCS/decisions/072).
//
//   node TOOLS/steps/run.mjs                          сводка по последним 8 сессиям
//   node TOOLS/steps/run.mjs 20                       по последним 20 сессиям
//   node TOOLS/steps/run.mjs 8 pi-windows-mutwv071         одна сессия подробно
//   node TOOLS/steps/run.mjs 16 --vs 2026-10-04T16:00  «было → стало»
//
// Последняя форма — та, ради которой инструмент и нужен: окно сессий делится
// надвое по времени правки, и печатаются обе половины рядом. Правка работает
// не потому, что так вышло, а потому что вторая половина стала меньше.
//
// Виды лишних шагов берутся из SYSTEM/core/waste-kinds.js — тем же списком,
// по которому агенту едет подсказка (homework-hint.js). Списка два быть не
// должно: предупреждать о том, что потом не меряется, бессмысленно.
import path from 'node:path';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.join(import.meta.dirname, '..', '..'));
const argv = process.argv.slice(2);
const vsAt = argv.indexOf('--vs') >= 0 ? argv[argv.indexOf('--vs') + 1] : null;
const plain = argv.filter((a) => a !== '--vs' && a !== vsAt);
const COUNT = Number(plain[0] || 8);
const ONLY = plain[1] || null;

// waste-kinds.js — CommonJS, как весь серверный код проекта
const require = createRequire(import.meta.url);
const { KINDS, SESSION_KIND, classify, hardCount } = require('../../SYSTEM/core/waste-kinds.js');

// SESSIONS_DB — путь к другой базе (по умолчанию живая, только на чтение)
const db = new DatabaseSync(process.env.SESSIONS_DB || path.join(ROOT, 'DATA', '.sessions.db'), { readOnly: true });

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
    if (!id.startsWith('pi-')) continue;
    if (!bySession.has(id)) bySession.set(id, []);
    bySession.get(id).push(row);
}

const all = [...bySession.entries()];
const chosen = ONLY ? all.filter(([id]) => id === ONLY) : all.slice(0, COUNT);

if (!chosen.length) {
    console.log('Нет сессий pi в базе — или неверный идентификатор.');
    process.exit(0);
}

// разбор сессии в числа: сколько шагов, сколько лишних, сколько жёстких, по видам
function measure(id, steps) {
    const found = classify(steps);
    return {
        id,
        steps: steps.length,
        waste: [...found.values()].reduce((n, p) => n + p.length, 0),
        hard: hardCount(found),
        at: String(steps[steps.length - 1]?.created_at || ''),
        found,
    };
}

const sessions = chosen.map(([id, steps]) => measure(id, steps));
sessions.sort((a, b) => (a.at < b.at ? -1 : 1));

// Время в базе записано в UTC, а `--vs` человек читает с экрана инструмента.
// Если печатать UTC, а отметку понимать как местное, сравнение получается правдоподобным
// и completely неверным: на окне из шестнадцати сессий инструмент так напечатал
// «лишних 442 → 73» на пустой правой половине. Поэтому печатаем местное время —
// скопированное с экрана отметку инструмент понимает однозначно.
function fmtLocal(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso).slice(5, 16);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// половины окна: свежие сессии против тех, что были до отметки времени.
// Отметку проверяет вызывающий — неразбираемое время должно давать понятную
// строку, а не стек ошибки посреди сводки
function split(list, cut) {
    const before = list.filter((s) => new Date(s.at).getTime() < cut);
    const after = list.filter((s) => new Date(s.at).getTime() >= cut);
    return { before, after };
}

function totalsOf(list) {
    const out = { sessions: list.length, steps: 0, waste: 0, hard: 0, kinds: new Map() };
    for (const s of list) {
        out.steps += s.steps;
        out.waste += s.waste;
        out.hard += s.hard;
        for (const [kind, positions] of s.found) {
            if (!out.kinds.has(kind)) out.kinds.set(kind, 0);
            out.kinds.set(kind, out.kinds.get(kind) + positions.length);
        }
    }
    return out;
}

const share = (n, steps) => (steps ? `${Math.round((n / steps) * 100)}%` : '—');
// доля числом, а не строкой: иначе строка сравнения получает строки и печатает
// «▲ NaN» рядом с числом, которое как раз и есть доказательство
const pctNum = (n, steps) => (steps ? Math.round((n / steps) * 100) : 0);
const whatOf = (id) => (id === SESSION_KIND.id ? SESSION_KIND : KINDS.find((k) => k.id === id))?.what || '';

function printList(list) {
    console.log('сессия                        шагов  жёстких  всего  доля');
    for (const s of list) {
        const hardShare = Math.round((s.hard / Math.max(s.steps, 1)) * 100);
        console.log(`  ${s.id.padEnd(28)} ${String(s.steps).padStart(5)}  ${String(s.hard).padStart(7)}  ${String(s.waste).padStart(5)}  ${String(hardShare).padStart(4)}%  ${fmtLocal(s.at)}`);
    }
}

// ---- «было → стало» ----
//
// Обе половины печатаются рядом и по видам, а не только итогом: правка обычно
// бьёт по одному виду, и по нему и видно, сработала она или нет
if (vsAt) {
    const cut = new Date(vsAt).getTime();
    const { before, after } = Number.isNaN(cut) ? { before: [], after: [] } : split(sessions, cut);
    const was = totalsOf(before);
    const now = totalsOf(after);
    if (Number.isNaN(cut)) {
        console.log(`--vs: «${vsAt}» не разбирается как время. Ожидается местное время в виде 2026-10-04T18:30.\n`);
    } else if (!was.sessions || !now.sessions) {
        console.log(`Одна из половин окна пуста (было ${was.sessions}, стало ${now.sessions}) — сравнивать нечего.`);
        console.log('Отметку --vs ставь по времени между старой и новой сессиями.\n');
    } else {
        console.log(`окно: до ${fmtLocal(vsAt)} (местное время) и после. Сессий: было ${was.sessions}, стало ${now.sessions}\n`);
        const line = (name, a, b) => {
            const delta = b - a;
            const mark = delta === 0 ? '  =  ' : delta < 0 ? ' ▼ ' : ' ▲ ';
            console.log(`  ${name.padEnd(26)} ${String(a).padStart(5)} → ${String(b).padStart(5)}${mark}${delta === 0 ? '' : String(delta)}`);
        };
        console.log(`  ${'величина'.padEnd(26)} ${'было'.padStart(5)}   стало`);
        line('шагов всего', was.steps, now.steps);
        line('лишних шагов', was.waste, now.waste);
        line('жёстких лишних', was.hard, now.hard);
        line('доля жёстких, %', pctNum(was.hard, was.steps), pctNum(now.hard, now.steps));
        console.log('\n  по видам (было → стало):');
        const ids = [...new Set([...was.kinds.keys(), ...now.kinds.keys()])];
        for (const id of ids.sort((a, b) => (now.kinds.get(b) || 0) - (now.kinds.get(a) || 0))) {
            line(id, was.kinds.get(id) || 0, now.kinds.get(id) || 0);
        }
        console.log('');
    }
}

const all2 = totalsOf(sessions);
console.log(`всего: сессий ${all2.sessions}, шагов ${all2.steps}`);
console.log(`лишних: ${all2.waste} (${share(all2.waste, all2.steps)}), жёстких: ${all2.hard} (${share(all2.hard, all2.steps)}), мягких: ${all2.waste - all2.hard}\n`);
printList(sessions);

console.log('\nвиды лишних шагов — раз | сессий | вид');
const withSessions = new Map();
for (const s of sessions) {
    for (const [kind] of s.found) withSessions.set(kind, (withSessions.get(kind) || 0) + 1);
}
for (const [id, count] of [...all2.kinds].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(4)}×  ${String(withSessions.get(id) || 0).padStart(3)}   ${id.padEnd(18)} ${whatOf(id)}`);
}

// «домашняя работа не запускалась» — факт за сессию, а не шаг, поэтому в
// сессии из одного шага его доля честно выходит больше 100%
if (all2.kinds.has(SESSION_KIND.id)) console.log('  (счёт за сессию, а не за шаг, поэтому в сессии из одного шага доля бывает больше 100%)');

if (ONLY) {
    console.log(`\n--- ${ONLY} ---`);
    for (const s of sessions) {
        for (const [kind, positions] of s.found) console.log(`  ${kind.padEnd(18)} шаги ${positions.join(', ')}`);
    }
}

db.close();
