// Накрывает ли отчёт разведки то место, которое сессия правила на самом деле.
// Только чтение DATA/.sessions.db и сбор отчёта кодом, ничего не пишет.
//
//   node TOOLS/steps/quality.mjs            все сессии pi-windows
//   node TOOLS/steps/quality.mjs 10         последние десять
//
// Зачем отдельный инструмент, если есть run.mjs. run.mjs считает, сколько шагов
// ушло впустую; здесь другое: правит ли отчёт свою работу. Пока отчёт не
// называет файл, который ход правит, весь остальной механизм (DOCS/decisions/
// 092) работает вхолостую — и узнать об этом можно только таким замером.
//
// Метрика: первый изменённый файл **внутри проекта**. Всё, что правилось после,
// — открытия по ходу (второе место, где живёт тот же класс), и их отчёт назвать
// не может по определению; на такой счёт замера отчёт занижается вчетверо.
// Одноразовые скрипты проверки (DATA/live, _scratch, temp) и файлы, которых в
// проекте не было до работы (probe-*, tmp-*), во вход не идут по той же причине:
// их не мог назвать никакой отчёт.
//
// Замер на пятнадцати сессиях 2026-10-04: вход в задачу отчёт назвал в 11.
import path from 'node:path';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.join(import.meta.dirname, '..', '..'));
const COUNT = Number(process.argv[2] || 0);

const require = createRequire(import.meta.url);
const { collect } = require('../../TOOLS/homework/collect.js');

// SESSIONS_DB — путь к другой базе (по умолчанию живая, только на чтение)
const db = new DatabaseSync(process.env.SESSIONS_DB || path.join(ROOT, 'DATA', '.sessions.db'), { readOnly: true });

const norm = (p) => String(p || '').replace(/\\/g, '/').toLowerCase();
const base = (p) => norm(p).split('/').pop();
const ROOT_NORM = `${norm(ROOT)}/`;

// файлы работы сессии: только проектные, без одноразовых скриптов и записей
// (записи кода правит человек, а не ход)
function editedIn(sessionId) {
    const rows = db.prepare(`
        SELECT tool_name, tool_input FROM messages WHERE session_id = ? AND role = 'tool'
    `).all(sessionId);
    const out = [];
    for (const row of rows) {
        if (!/^(write|edit|multiedit|patch)$/.test(row.tool_name || '')) continue;
        let fp = '';
        try { fp = JSON.parse(row.tool_input || '{}').filePath || ''; } catch { continue; }
        const file = norm(fp);
        if (!file.startsWith(ROOT_NORM)) continue;
        if (/\/data\/live\/|_scratch|\.md$|probe-|tmp-/.test(file)) continue;
        out.push(file);
    }
    return out;
}

// имена файлов, названные отчётом: заголовки секций надёжнее, чем любое
// совпадение по регулярке, потому что это ровно то, что видит агент
function namedIn(report) {
    const out = new Set();
    for (const line of String(report || '').split('\n')) {
        const m = line.match(/^## Файл \.?(\S+)/);
        if (m) out.add(base(m[1]));
    }
    return out;
}

const sessions = db.prepare(`
    SELECT session_id, MAX(created_at) at FROM messages
    WHERE role = 'tool' AND session_id LIKE 'pi-windows-%'
    GROUP BY session_id ORDER BY at DESC
`).all().slice(0, COUNT || undefined);

let checked = 0;
let hit = 0;
const misses = [];

for (const s of sessions) {
    const request = db.prepare(`
        SELECT text FROM messages WHERE session_id = ? AND role = 'user' ORDER BY position LIMIT 1
    `).get(s.session_id)?.text || '';
    if (!request.trim()) continue;
    const edited = editedIn(s.session_id);
    if (!edited.length) continue;
    const built = collect(request);
    if (!built.code.length || !built.files.length) continue;

    checked += 1;
    const entry = base(edited[0]);
    const named = namedIn(built.report);
    if (named.has(entry)) {
        hit += 1;
        continue;
    }
    misses.push(`${s.session_id} — вход ${entry}, отчёт назвал ${named.size} файлов, сессия правила ${new Set(edited.map(base)).size}`);
}

console.log(`сессий с отчётом и правкой: ${checked}`);
console.log(`вход в задачу отчёт назвал: ${hit} из ${checked}${checked ? ` (${Math.round((hit / checked) * 100)}%)` : ''}\n`);
for (const line of misses) console.log(`  нет: ${line}`);
if (!misses.length) console.log('  все совпали');

db.close();
