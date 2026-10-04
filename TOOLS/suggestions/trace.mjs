// Где теряется запрос при подборе записок DOCS/decisions. Разбор по ступеням:
// показывает не «какая записка приехала», а на какой отсечке запрос исчез.
//
//   node TOOLS/suggestions/trace.mjs      # последние 12 сессий
//   node TOOLS/suggestions/trace.mjs 24   # последние двадцать четыре
//
// Зачем он: молчание подбора неотличимо от «подсказки не нужны», пока не видно
// ступени. Документация TypeSafe советует ровно это — смотреть, на каком узле
// чаще всего теряются запросы (cookbook «hierarchical classification», раздел
// про observability). Ничего не пишет, к базе не ходит: только сбор ответа.
import path from 'node:path';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.join(import.meta.dirname, '..', '..'));
const LIMIT = Number(process.argv[2] || 12);

const require = createRequire(import.meta.url);
const { traceDecisionHints } = require('../../SYSTEM/core/decision-hints.js');
const { THRESHOLDS } = require('../../SYSTEM/core/judgment-config.js');

// SESSIONS_DB — путь к другой базе (по умолчанию живая, только на чтение)
const db = new DatabaseSync(process.env.SESSIONS_DB || path.join(ROOT, 'DATA', '.sessions.db'), { readOnly: true });
const sessions = db.prepare(`
    SELECT session_id FROM messages WHERE role = 'tool'
    GROUP BY session_id ORDER BY MAX(created_at) DESC LIMIT ?
`).all(LIMIT);

const short = (id) => id.replace(/^\d+-/, '').slice(0, 30);
const verdicts = new Map();
const bump = (key) => verdicts.set(key, (verdicts.get(key) || 0) + 1);

if (!sessions.length) {
    console.log('В базе нет сессий со шагами инструмента.');
    process.exit(0);
}

for (const s of sessions) {
    const request = db.prepare(`
        SELECT text FROM messages WHERE session_id = ? AND role = 'user' ORDER BY position LIMIT 1
    `).get(s.session_id)?.text || '';
    if (!request.trim()) continue;

    const t = await traceDecisionHints(request, THRESHOLDS.hintConfidence);
    if (!t) { bump('суждения нет (нет ключа или сеть)'); continue; }

    // вердикт группируем по смыслу, а не по тексту с числами: иначе в сводке
    // окажется семь разных строк одного и того же исхода
    const kind = t.reason.startsWith('подобрано')
        ? 'подобрана записка'
        : t.reason.startsWith('уверенность') ? 'отсек гард уверенности первого выбора'
            : t.reason.startsWith('второй запрос') ? 'отсек порог второй ступени'
                : t.reason.includes('ничего не подходит') ? 'первый выбор: «ничего не подходит»'
                    : t.reason.includes('кандидатов нет') ? 'первый выбор: кандидатов нет'
                        : t.reason;
    bump(kind);

    const top = t.top[0] ? `${short(t.top[0].id)} ${t.top[0].p.toFixed(2)}` : '—';
    console.log(`${s.session_id.padEnd(30)} none=${fmt(t.none)} conf=${fmt(t.confidence)} → ${kind}`);
    console.log(`   запрос: ${request.replace(/\s+/g, ' ').slice(0, 78)}`);
    console.log(`   первый выбор: ${top}`);
    if (t.stage2.length) {
        console.log(`   второй запрос: ${t.stage2.map((x) => `${short(x.id)}=${x.noul === null ? '—' : x.noul.toFixed(2)}`).join('  ')}`);
    }
}

function fmt(v) {
    return typeof v === 'number' ? v.toFixed(2) : '—';
}

console.log(`\n--- где теряются запросы (${sessions.length} сессий) ---`);
for (const [reason, n] of [...verdicts].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(3)}× ${reason}`);

db.close();
