// Сводка одним запуском: что сейчас с ходами, с отчётом разведки и с сервером.
//
//   node TOOLS/steps/report.mjs
//   node TOOLS/steps/report.mjs --since 2026-10-04T19:00
//
// Четыре отдельных инструмента показывают четыре среза, и владельцу приходится
// помнить, какие запускать и в каком порядке. Здесь они сведены в один отчёт с
// одной командой; каждый срез остаётся проверяемым сам по себе, ни один не
// спрятан. Правило прежнее: молчание инструмента — не доказательство, поэтому
// каждая строка говорит, откуда взята и чего она не доказывает.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import net from 'node:net';

const ROOT = path.resolve(path.join(import.meta.dirname, '..', '..'));
const argv = process.argv.slice(2);
const sinceIdx = argv.indexOf('--since');
const SINCE = sinceIdx >= 0 ? argv[sinceIdx + 1] : null;

const require = createRequire(import.meta.url);
const { KINDS, SESSION_KIND, classify, hardCount } = require('../../SYSTEM/core/waste-kinds.js');

const db = new DatabaseSync(process.env.SESSIONS_DB || path.join(ROOT, 'DATA', '.sessions.db'), { readOnly: true });
const COUNT = 12;

// ---------- 1. сервер ----------

async function serverSection() {
    console.log('== сервер ==');
    const newest = [];
    const walk = (dir) => {
        for (const name of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
            if (name.isDirectory()) walk(path.join(dir, name.name));
            else if (name.name.endsWith('.js') || name.name.endsWith('.mjs')) {
                newest.push(path.join(dir, name.name));
            }
        }
    };
    walk('SYSTEM');
    const stamps = newest
        .map((file) => ({ file, mtime: fs.statSync(path.join(ROOT, file)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
    const newestFile = stamps[0];
    console.log(`  новейший серверный файл: ${newestFile.file} в ${new Date(newestFile.mtime).toLocaleTimeString('ru-RU')}`);

    const port = readPort();
    if (!port) {
        console.log('  порт из .env не прочитан — живость сервера не проверяется');
        return;
    }
    const alive = await portAlive(Number(port));
    console.log(`  порт ${port}: ${alive ? 'принимает соединения' : 'не отвечает'}`);
}

// Живость одним TCP-соединением: запросов серверу не шлём, проверяем только
// факт, что порт слушают. Процессы инструмент не смотрит — их видно только из
// PowerShell, и выдавать за проверенное то, чего не проверил, здесь не будем.
function portAlive(port, timeoutMs = 1500) {
    return new Promise((resolve) => {
        const socket = net.connect({ port, host: '127.0.0.1' });
        const done = (ok) => { socket.destroy(); resolve(ok); };
        socket.setTimeout(timeoutMs, () => done(false));
        socket.once('connect', () => done(true));
        socket.once('error', () => done(false));
    });
}

// ---------- 2. ходы ----------

function stepsSection() {
    console.log('\n== ходы ==');
    const rows = db.prepare(`
        SELECT session_id, position, tool_name, tool_input, tool_error, created_at,
               EXISTS (SELECT 1 FROM messages u WHERE u.session_id = messages.session_id
                       AND u.result_meta LIKE '%"homework":%') AS got_report,
               (SELECT COUNT(*) FROM messages u WHERE u.session_id = messages.session_id
                AND u.role = 'user') AS turns
        FROM messages WHERE role = 'tool' ORDER BY created_at DESC
    `).all();

    const bySession = new Map();
    for (const row of rows) {
        const id = row.session_id || '';
        if (!id || /^hermes-/.test(id)) continue;
        if (!bySession.has(id)) bySession.set(id, []);
        bySession.get(id).push(row);
    }
    const all = [...bySession.entries()];
    const chosen = all.slice(0, COUNT);

    const measure = (steps) => {
        const list = steps.slice().sort((a, b) => a.position - b.position);
        const found = classify(list, { reportAttached: list.some((row) => row.got_report) });
        return {
            steps: list.length,
            turns: Math.max(Number(list[0]?.turns) || 0, 1),
            waste: [...found.values()].reduce((n, p) => n + p.length, 0),
            hard: hardCount(found),
            found,
        };
    };

    const totals = { steps: 0, turns: 0, waste: 0, hard: 0, kinds: new Map() };
    for (const [, steps] of chosen) {
        const m = measure(steps);
        totals.steps += m.steps;
        totals.turns += m.turns;
        totals.waste += m.waste;
        totals.hard += m.hard;
        for (const [kind, positions] of m.found) totals.kinds.set(kind, (totals.kinds.get(kind) || 0) + positions.length);
    }
    const pct = (n) => `${Math.round((n / Math.max(totals.steps, 1)) * 100)}%`;
    console.log(`  окно: ${chosen.length} сессий, ${totals.turns} ходов, ${totals.steps} шагов`);
    console.log(`  шагов на ход: ${(totals.steps / Math.max(totals.turns, 1)).toFixed(1)}`);
    console.log(`  лишних: ${totals.waste} (${pct(totals.waste)}), жёстких: ${totals.hard} (${pct(totals.hard)})`);

    const cut = SINCE ? new Date(SINCE).getTime() : null;
    if (cut && !Number.isNaN(cut)) {
        const split = (list) => {
            const before = [];
            const after = [];
            for (const [id, steps] of list) {
                const newest = Math.max(...steps.map((s) => Date.parse(s.created_at) || 0));
                (newest < cut ? before : after).push([id, steps]);
            }
            return { before, after };
        };
        const { before, after } = split(chosen);
        const sum = (list) => list.reduce((acc, [, steps]) => {
            const m = measure(steps);
            acc.steps += m.steps; acc.turns += m.turns; acc.waste += m.waste; acc.hard += m.hard;
            return acc;
        }, { steps: 0, turns: 0, waste: 0, hard: 0 });
        const was = sum(before);
        const now = sum(after);
        if (!before.length || !after.length) {
            console.log(`\n  сравнение с ${SINCE}: одна из половин пуста — сравнивать нечего`);
        } else {
            const row = (name, a, b) => {
                const d = Math.round((b - a) * 10) / 10;
                console.log(`  ${name.padEnd(20)} ${String(a).padStart(5)} → ${String(b).padStart(5)}${d === 0 ? '  =  ' : d < 0 ? ' ▼ ' : ' ▲ '}${d === 0 ? '' : d}`);
            };
            console.log(`\n  было (до ${SINCE}) → стало:`);
            row('ходов', was.turns, now.turns);
            row('шагов всего', was.steps, now.steps);
            row('шагов на ход', (was.steps / was.turns).toFixed(1), (now.steps / now.turns).toFixed(1));
            row('лишних шагов', was.waste, now.waste);
            row('жёстких лишних', was.hard, now.hard);
        }
    }

    const top = [...totals.kinds].sort((a, b) => b[1] - a[1]).slice(0, 6);
    console.log('\n  виды лишних (шаги):');
    for (const [id, count] of top) {
        const kind = id === SESSION_KIND.id ? SESSION_KIND : KINDS.find((k) => k.id === id);
        console.log(`    ${String(count).padStart(4)}×  ${id.padEnd(18)} ${kind?.what || ''}${kind?.soft ? '  [мягкий]' : ''}`);
    }

    // Покрытие по исполнителям. После переезда корпуса на другого агента замер
    // молча сузился бы до старых сессий, и видно это только тут — по счёту
    // сессий и шагов каждого префикса рядом. Случай прошлого цикла ровно такой:
    // инструмент качества терял все сессии pi и никто этого не замечал
    const byAgent = new Map();
    for (const [id, steps] of chosen) {
        const agent = id.split('-').slice(0, 2).join('-');
        if (!byAgent.has(agent)) byAgent.set(agent, { sessions: 0, steps: 0 });
        const entry = byAgent.get(agent);
        entry.sessions += 1;
        entry.steps += steps.length;
    }
    console.log('\n  покрытие по исполнителям (окно):');
    for (const [agent, entry] of [...byAgent].sort((a, b) => b[1].steps - a[1].steps)) {
        console.log(`    ${agent.padEnd(20)} ${String(entry.sessions).padStart(3)} сессий, ${String(entry.steps).padStart(4)} шагов`);
    }
}

// ---------- 3. отчёт разведки ----------

function homeworkSection() {
    console.log('\n== отчёт разведки в ходах ==');
    const rows = db.prepare(`
        SELECT result_meta FROM messages
        WHERE result_meta LIKE '%"homework":%' AND result_meta NOT LIKE '%"homework":null%'
        ORDER BY created_at DESC
    `).all();
    if (!rows.length) {
        console.log('  ни разу: в базе нет ходов, получивших отчёт.');
        return;
    }
    const kinds = new Map();
    let chars = 0;
    let reused = 0;
    let work = 0;
    for (const row of rows) {
        const h = JSON.parse(row.result_meta)?.suggestions?.homework;
        if (!h) continue;
        chars += h.sent ?? h.chars ?? 0;
        if (h.reused) reused += 1;
        if (typeof h.work === 'number') work += h.work;
        kinds.set(h.kind || '—', (kinds.get(h.kind || '—') || 0) + 1);
    }
    console.log(`  ходов с отчётом: ${rows.length}, средний объём в запрос: ${Math.round(chars / rows.length)} симв.`);
    console.log(`  суждение «работа в проекте»: средняя ${(work / rows.length).toFixed(2)}`);
    console.log(`  карта вместо отчёта (продолжение сессии): ${reused}`);
    console.log(`  по типам задачи: ${[...kinds].map(([k, n]) => `${k} ${n}`).join(', ')}`);
    console.log('  чего эта сводка не доказывает: что ходы стали короче. Замер длины — в разделе выше.');
}

// ---------- 4. что реально ушло модели ----------
//
// Последнее непроверенное звено цепочки. Отчёт едет в `result_meta`, но там лежит
// то, что сервер решил подложить; `input_sent` — то, что действительно ушло в
// CLI. Пока эта строка пустая, «отчёт едет» доказано только прогонами, а не боем.
// Пустая она у ходов, случившихся до того, как коннектор начал её писать, — так
// что ноль здесь означает «нет таких ходов», а не «отчёт не доехал».
function sentSection() {
    console.log('\n== что реально ушло модели ==');
    const rows = db.prepare(`
        SELECT input_sent, text FROM messages
        WHERE role = 'user' AND input_sent IS NOT NULL AND input_sent <> ''
        ORDER BY created_at DESC LIMIT 40
    `).all();
    if (!rows.length) {
        console.log('  строк input_sent в базе нет — ни один ход не записал, что ушло в CLI.');
        console.log('  Это не значит, что преамбулы не ехали: она пишется в строке только');
        console.log('  с того момента, как коннектор начал её записывать.');
        return;
    }
    let withReport = 0;
    let withMap = 0;
    let share = 0;
    for (const row of rows) {
        const sent = String(row.input_sent);
        const marker = sent.indexOf('[OpenKarandash] Домашняя работа');
        const mapMarker = sent.indexOf('вот его карта');
        if (marker >= 0) withReport += 1;
        if (mapMarker >= 0) withMap += 1;
        if (marker >= 0 || mapMarker >= 0) {
            const cut = marker >= 0 ? marker : mapMarker;
            share += cut / Math.max(sent.length, 1);
        }
    }
    console.log(`  ходов с записью отправленного: ${rows.length}`);
    console.log(`  из них с отчётом разведки в тексте: ${withReport}, с картой: ${withMap}`);
    if (withReport + withMap) {
        console.log(`  доля преамбулы в отправленном тексте: средняя ${Math.round((share / (withReport + withMap)) * 100)}%`);
    }
    console.log('  это единственное место, где видно, что подсказки доехали до CLI, а не только помечены в result_meta.');
}

// ---------- 5. подбор записок ----------

function hintsSection() {
    console.log('\n== подбор записок и приёмов ==');
    const rows = db.prepare(`
        SELECT result_meta FROM messages WHERE result_meta LIKE '%"suggestions"%'
    `).all();
    if (!rows.length) {
        console.log('  ходов с пометкой suggestions в базе нет.');
        return;
    }
    let notes = 0;
    let skills = 0;
    for (const row of rows) {
        const sug = JSON.parse(row.result_meta)?.suggestions;
        if (!sug) continue;
        if (sug.notes?.length) notes += 1;
        if (sug.skill) skills += 1;
    }
    console.log(`  ходов с пометками: ${rows.length}; записки в ${notes}, приём в ${skills}`);
    console.log('  где теряются запросы при подборе — node TOOLS/suggestions/trace.mjs (ходит в TypeSafe, медленно)');
}
await serverSection();
stepsSection();
homeworkSection();
sentSection();
hintsSection();

function readPort() {
    try {
        const line = fs.readFileSync(path.join(ROOT, '.env'), 'utf8').match(/^PORT=(.*)$/m)?.[1];
        return line ? line.trim().replace(/^["']|["']$/g, '') : null;
    } catch {
        return null;
    }
}

db.close();
