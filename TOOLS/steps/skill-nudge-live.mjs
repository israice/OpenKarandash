// Живая проверка досмотра на настоящем материале, без сервера (DOCS/decisions/002):
// прямой вызов модуля (072 п.3) — судим настоящий недавний ход из DATA/.sessions.db.
// Материал честен по составу, но приближён по сборке: ответ — последний текстовый
// дубль сессии, шаги — число tool.call той же сессии; точным замером это не считается.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';

const env = fs.readFileSync('.env', 'utf8');
process.env.TYPESAFE_API_KEY = env.match(/^TYPESAFE_API_KEY=(.*)$/m)[1].replace(/^["']|["']$/g, '');

const db = new DatabaseSync('DATA/.sessions.db', { readOnly: true });
const session = db.prepare(`
    select session_id, max(created_at) as at from messages
    where role = 'user' group by session_id order by at desc limit 1`).get();
if (!session) { console.log('NO_SESSIONS'); process.exit(1); }
const rows = db.prepare(`
    select position, role, coalesce(text, '') as text, event_type from messages
    where session_id = ? and coalesce(text, '') != ''
    order by position`).all(session.session_id);
// материал одного обмена: последний запрос пользователя и всё, что было после него —
// иначе судья видит ответ от предыдущего обмена (на замере это ломало вердикт)
const { judgeTurn } = require('../../SYSTEM/core/turn-judgment.js');
const { reviewTurn, worthReviewing } = require('../../SYSTEM/core/skill-nudge.js');

// материал одного обмена: последний запрос пользователя и всё, что было после него —
// иначе судья видит ответ от предыдущего обмена (на замере это ломало вердикт).
// Доведённым обмен ищем среди трёх последних: последний бывает промежуточным
const LAST = 3;
const userPositions = [...rows].reverse().filter((r) => r.role === 'user').map((r) => r.position).slice(0, LAST);
const starts = userPositions.reverse();
for (const start of starts) {
    const end = starts[starts.indexOf(start) + 1];
    const exchange = rows.filter((r) => r.position >= start && (end == null || r.position < end));
    const request = exchange.find((r) => r.role === 'user')?.text || '';
    const answer = exchange.filter((r) => r.role === 'assistant').map((r) => r.text).join('\n');
    const steps = exchange.filter((r) => r.event_type === 'tool.call').length;
    if (!request || !answer || !steps) continue;
    console.log('session=' + session.session_id, 'start=' + start, 'steps=' + steps,
        'requestLen=' + request.length, 'answerLen=' + answer.length);
    const judgment = await judgeTurn({ request, answer, errorText: null, stopReason: null, toolSteps: steps });
    console.log('judgeTurn finalReport=' + judgment.finalReport, 'workDone=' + judgment.workDone,
        'worthReviewing=' + worthReviewing(judgment));
    if (!worthReviewing(judgment)) continue;
    const nudge = await reviewTurn({ request, answer, judgment, agent: 'pi-windows', profile: '' });
    console.log('REVIEW ' + JSON.stringify(nudge));
    // вердикт получен (выше или ниже порога — обе стороны честно видны) — конец
    process.exit(nudge ? 0 : 2);
}
// доведённого обмена среди трёх последних не нашлось — досмотр честно молчит
console.log('NO_COMPLETED_TURN');
process.exit(2);
