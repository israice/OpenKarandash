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
// Разбор по индексам, а не по значениям: смешивать тут нельзя — фильтр по
// значению съедал первый позиционный аргумент, и `run.mjs 12 --vs <время>`
// молча превращался в «нет сессий» вместо сравнения
const vsIdx = argv.indexOf('--vs');
const vsAt = vsIdx >= 0 ? argv[vsIdx + 1] : null;
const pairIdx = argv.indexOf('--pair');
const PAIR = pairIdx >= 0 ? [argv[pairIdx + 1], argv[pairIdx + 2]].filter(Boolean) : null;
const taken = new Set([vsIdx, vsIdx + 1, pairIdx, pairIdx + 1, pairIdx + 2].filter((i) => i >= 0));
const plain = argv.filter((a, i) => !taken.has(i) && a !== '--turns');
const COUNT = Number.isFinite(Number(plain[0])) && Number(plain[0]) > 0 ? Number(plain[0]) : 8;
const ONLY = plain[1] || null;
// --turns: разбор по ходам, а не по сессиям. Нужен там, где сравнивают ходы одной
// сессии между собой — например, первый ход с отчётом и продолжение с картой:
// в сводке по сессиям они слиты, и разница не видна
const TURNS = argv.includes('--turns');

// waste-kinds.js — CommonJS, как весь серверный код проекта
const require = createRequire(import.meta.url);
const { KINDS, SESSION_KIND, classify, hardCount } = require('../../SYSTEM/core/waste-kinds.js');

// SESSIONS_DB — путь к другой базе (по умолчанию живая, только на чтение)
const db = new DatabaseSync(process.env.SESSIONS_DB || path.join(ROOT, 'DATA', '.sessions.db'), { readOnly: true });

// одна строка — один шаг инструмента: ровно то, из чего складывается ход.
// got_report отвечает на вопрос «уехал ли в ход отчёт разведки»: без него виды
// про домашнюю работу будут требовать от агента того, что сервер уже сделал
const rows = db.prepare(`
    SELECT session_id, position, tool_name, tool_input, tool_error, created_at,
           EXISTS (
               SELECT 1 FROM messages u
               WHERE u.session_id = messages.session_id
                 AND u.result_meta LIKE '%"homework":%'
           ) AS got_report,
           (SELECT COUNT(*) FROM messages u
             WHERE u.session_id = messages.session_id AND u.role = 'user') AS turns
    FROM messages
    WHERE role = 'tool'
    ORDER BY created_at DESC
`).all();

// Сессии отбираются по наличию шагов инструмента, а не по префиксу id. Префикс
// менялся при переезде корпуса на другого агента (pi вместо opencode), и
// фильтр по нему молча обнулял весь замер: новых сессий ещё нет, а старые
// выпадали из вида. Исключается ровно одно — старый корпус другого агента,
// который к проекту не относится и в правилах не упоминается
const FOREIGN = /^hermes-/;

const bySession = new Map();
for (const row of rows) {
    const id = row.session_id || '';
    if (!id || FOREIGN.test(id)) continue;
    if (!bySession.has(id)) bySession.set(id, []);
    bySession.get(id).push(row);
}

const all = [...bySession.entries()];
const chosen = ONLY ? all.filter(([id]) => id === ONLY) : all.slice(0, COUNT);

if (!chosen.length) {
    console.log('Нет сессий со шагами инструмента — или неверный идентификатор.');
    process.exit(0);
}

// разбор сессии в числа: сколько шагов, сколько лишних, сколько жёстких, по видам.
// turns обязателен рядом с шагами: сессии разной длины сравнимы только по шагам
// на ход, а «шагов за сессию» мерит ещё и число ходов, то есть длину работы
function measure(id, steps) {
    // отчёт разведки в запросе снимает виды про домашнюю работу: скрипт при
    // таком ходе запускать не нужно, и требовать этого — требовать лишнего
    const found = classify(steps, { reportAttached: steps.some((row) => row.got_report) });
    return {
        id,
        steps: steps.length,
        turns: Math.max(Number(steps[0]?.turns) || 0, 1),
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
// и совсем неверным: на окне из шестнадцати сессий инструмент так напечатал
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
    const out = { sessions: list.length, steps: 0, turns: 0, waste: 0, hard: 0, kinds: new Map() };
    for (const s of list) {
        out.steps += s.steps;
        out.turns += s.turns;
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
// шаги на ход — единственная величина, которой сравниваются сессии разной длины
const perTurn = (t) => (t.turns ? Math.round((t.steps / t.turns) * 10) / 10 : 0);
const whatOf = (id) => (id === SESSION_KIND.id ? SESSION_KIND : KINDS.find((k) => k.id === id))?.what || '';

function printList(list) {
    console.log('сессия                       ходов  шагов  жёстких  всего  доля  на ход');
    for (const s of list) {
        const hardShare = Math.round((s.hard / Math.max(s.steps, 1)) * 100);
        console.log(`  ${s.id.padEnd(28)} ${String(s.turns).padStart(4)}  ${String(s.steps).padStart(6)}  ${String(s.hard).padStart(7)}  ${String(s.waste).padStart(5)}  ${String(hardShare).padStart(4)}%  ${String((s.steps / s.turns).toFixed(1)).padStart(5)}  ${fmtLocal(s.at)}`);
    }
}

// строка «было → стало»: одна на оба сравнения (окно по времени и две сессии),
// иначе разъезжаются и формат стрелок, и правило знака
function line(name, a, b) {
    // дельта округляется: 24.4 − 28.8 иначе печатается как -4.400000000000002,
    // и строка выглядит сломанной, хотя всё посчитано верно
    const delta = Math.round((b - a) * 10) / 10;
    const mark = delta === 0 ? '  =  ' : delta < 0 ? ' ▼ ' : ' ▲ ';
    console.log(`  ${name.padEnd(24)} ${String(a).padStart(5)} → ${String(b).padStart(5)}${mark}${delta === 0 ? '' : String(delta)}`);
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
        console.log(`  ${'величина'.padEnd(24)} ${'было'.padStart(5)}   стало`);
        line('сессий', was.sessions, now.sessions);
        line('ходов', was.turns, now.turns);
        line('шагов всего', was.steps, now.steps);
        line('шагов на ход', perTurn(was), perTurn(now));
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

// ---- две конкретные сессии ----
//
// Форма появилась после первого живого хода с отчётом: окно по времени берёт
// разные задачи, а доказательством правки служит одна и та же задача, сделанная
// до и после. Сравнение идёт по видам, а не только итогом — по виду и видно,
// что именно перестало повторяться
if (PAIR?.length === 2) {
    const found = PAIR.map((id) => bySession.has(id) ? bySession.get(id) : null);
    if (found.some((steps) => !steps)) {
        console.log(`Не найдены сессии: ${PAIR.filter((_, i) => !found[i]).join(', ')}`);
    } else {
        const was = measure(PAIR[0], found[0]);
        const now = measure(PAIR[1], found[1]);
        const wasTotals = totalsOf([was]);
        const nowTotals = totalsOf([now]);
        console.log(`было:  ${PAIR[0]} (${fmtLocal(was.at)})`);
        console.log(`стало: ${PAIR[1]} (${fmtLocal(now.at)})\n`);
        console.log(`  ${'величина'.padEnd(24)} ${'было'.padStart(5)}   стало`);
        line('ходов', wasTotals.turns, nowTotals.turns);
        line('шагов всего', wasTotals.steps, nowTotals.steps);
        line('шагов на ход', perTurn(wasTotals), perTurn(nowTotals));
        line('лишних шагов', wasTotals.waste, nowTotals.waste);
        line('жёстких лишних', wasTotals.hard, nowTotals.hard);
        line('доля жёстких, %', pctNum(wasTotals.hard, wasTotals.steps), pctNum(nowTotals.hard, nowTotals.steps));
        console.log('\n  по видам (было → стало):');
        const ids = [...new Set([...wasTotals.kinds.keys(), ...nowTotals.kinds.keys()])];
        for (const id of ids.sort((a, b) => (wasTotals.kinds.get(b) || 0) - (wasTotals.kinds.get(a) || 0))) {
            line(id, wasTotals.kinds.get(id) || 0, nowTotals.kinds.get(id) || 0);
        }
        console.log('');
    }
}

// ---- разбор по ходам ----
//
// Сессия может содержать несколько ходов, и сводка по ней их сливает: первый ход
// с отчётом и продолжение с картой в одной строке. Здесь виден каждый ход
// отдельно вместе с тем, уехал ли в него отчёт и сколько символов он занял
if (TURNS) {
    const userRows = db.prepare(`
        SELECT session_id, position, text FROM messages WHERE role = 'user'
    `).all();
    const reportRows = db.prepare(`
        SELECT session_id, position, result_meta FROM messages WHERE result_meta LIKE '%"homework":%'
    `).all();

    console.log('сессия                       ход  шагов  жёстких  всего  отчёт в запрос');
    let sumSteps = 0;
    let sumHard = 0;
    let withReport = 0;
    let totalTurns = 0;
    for (const [id, steps] of chosen) {
        const marks = userRows.filter((row) => row.session_id === id).sort((a, b) => a.position - b.position);
        for (const [index, mark] of marks.entries()) {
            const from = mark.position;
            const to = marks[index + 1]?.position ?? Number.POSITIVE_INFINITY;
            const inTurn = steps.filter((s) => s.position > from && s.position < to);
            if (!inTurn.length) continue;
            const meta = reportRows.find((row) => row.session_id === id && row.position > from && row.position < to);
            let sent = null;
            if (meta) {
                try { sent = JSON.parse(meta.result_meta)?.suggestions?.homework?.sent ?? null; } catch { sent = null; }
            }
            const found = classify(inTurn, { reportAttached: Boolean(meta) });
            const waste = [...found.values()].reduce((n, p) => n + p.length, 0);
            sumSteps += inTurn.length;
            sumHard += hardCount(found);
            totalTurns += 1;
            if (meta) withReport += 1;
            console.log(`  ${id.padEnd(28)} ${String(index + 1).padStart(2)}  ${String(inTurn.length).padStart(5)}  ${String(hardCount(found)).padStart(7)}  ${String(waste).padStart(5)}  ${sent ? `${sent} симв.` : '—'}`);
            console.log(`      ${String(mark.text || '').replace(/\s+/g, ' ').slice(0, 78)}`);
        }
    }
    console.log(`\nходов с шагами: ${totalTurns}, из них с отчётом: ${withReport}`);
    console.log(`шагов всего ${sumSteps}, на ход ${totalTurns ? (sumSteps / totalTurns).toFixed(1) : '—'}, жёстких ${sumHard}`);
    db.close();
    process.exit(0);
}

const all2 = totalsOf(sessions);
console.log(`всего: сессий ${all2.sessions}, ходов ${all2.turns}, шагов ${all2.steps}, на ход ${perTurn(all2)}`);
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
