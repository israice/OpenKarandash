// Содержимое одной сессии по её id — темой, а не пересказом.
//
//   node TOOLS/sessions/read.mjs kilocode-local-muuqh9z5
//   node TOOLS/sessions/read.mjs kilocode --last 2
//   node TOOLS/sessions/read.mjs "второе выпадающее"
//
// Зачем он, если есть база: id сессии сам по себе ничего не значит вне
// интерфейса. Скопированный из панели Sessions указатель — это адрес, и адрес
// обязан открываться одной командой, иначе получатель идёт искать, где эти
// сессии лежат (DOCS/decisions/099).
//
// Только чтение DATA/.sessions.db, как у остальных инструментов замера
// (TOOLS/steps, TOOLS/suggestions). SESSIONS_DB — путь к другой базе.
//
// Код выхода: 0 — сессия найдена; 1 — не найдена (печатаются последние сессии,
// чтобы искать не пришлось); 2 — неверный вызов.
import path from 'node:path';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.join(import.meta.dirname, '..', '..'));

const USAGE = [
    'Вызов: node TOOLS/sessions/read.mjs <id | префикс id | часть заголовка> [--last <N>]',
];

const argv = process.argv.slice(2);
const lastIdx = argv.indexOf('--last');
const LAST = lastIdx >= 0 ? Math.max(1, Number(argv[lastIdx + 1]) || 1) : null;
// индексы берём только когда флаг действительно есть: indexOf вернул -1, и
// «-1 и 0» после фильтра оставляли в занятых первый аргумент — запрос съедался
// и скрипт печатал справку вместо сессии (та же ошибка, что была в разборе
// аргументов TOOLS/steps/run.mjs, DOCS/decisions/092)
const taken = new Set(lastIdx >= 0 ? [lastIdx, lastIdx + 1] : []);
const query = argv.filter((a, i) => !taken.has(i) && !a.startsWith('--')).join(' ').trim();
if (!query) {
    console.error(USAGE.join('\n'));
    process.exit(2);
}

// настолько длинный ответ сценарий уже не читает, а обрезанный ответ вводит
// в заблуждение так же, как отсутствие ответа, — поэтому режем явно и говорим
const LIMIT = { human: 6000, answer: 6000, step: 200 };

function clip(text, max) {
    const value = String(text ?? '');
    if (value.length <= max) return value;
    return `${value.slice(0, max)}\n…(обрезано, всего ${value.length} символов)`;
}

const db = new DatabaseSync(process.env.SESSIONS_DB || path.join(ROOT, 'DATA', '.sessions.db'), { readOnly: true });

const sessions = db.prepare('SELECT id, title, updated_at AS updatedAt FROM sessions ORDER BY updated_at DESC').all();

// три способа назвать сессию, все по порядку точности: полный id, уникальный
// префикс, часть заголовка. Имя, которое человек видит в панели, — это и есть
// заголовок, поэтому третий способ покрывает «название сессии» буквально
function find() {
    const exact = sessions.filter((s) => s.id === query);
    if (exact.length) return exact[0];
    const byPrefix = sessions.filter((s) => s.id.startsWith(query));
    if (byPrefix.length) return byPrefix[0];
    const needle = query.toLowerCase();
    const byTitle = sessions.filter((s) => String(s.title || '').toLowerCase().includes(needle));
    return byTitle[0] || null;
}

const found = find();
if (!found) {
    console.error(`Сессия «${query}» в базе не найдена. Ближайшие по времени:`);
    for (const s of sessions.slice(0, 8)) console.error(`  ${s.id}  ${String(s.title || '').slice(0, 70)}`);
    process.exit(1);
}

// наш id и id внутри CLI — разные вещи: продолжить сессию можно только вторым
// (SYSTEM/core/handoff.js), поэтому в отчёте они стоят рядом и подписаны
const cliLinks = db.prepare('SELECT target, cli_session_id AS id FROM session_cli WHERE session_id = ?').all(found.id);
const usage = db.prepare(`
    SELECT COALESCE(SUM(input_tokens), 0) AS inputTokens,
           COALESCE(SUM(output_tokens), 0) AS outputTokens,
           COALESCE(SUM(cache_read_tokens), 0) AS cacheReadTokens,
           COALESCE(SUM(cost_usd), 0) AS costUsd,
           COALESCE(SUM(duration_ms), 0) AS durationMs
    FROM messages WHERE session_id = ?
`).get(found.id);

const all = db.prepare('SELECT position, role, text, tool_name AS toolName, tool_input AS toolInput, model FROM messages WHERE session_id = ? ORDER BY position').all(found.id);
const turns = all.filter((m) => m.role === 'user').length;
const thoughts = all.filter((m) => m.role === 'thinking').length;

const out = [];
out.push(`# Сессия ${found.id}`);
out.push(`Заголовок: ${found.title || '—'}`);
out.push(`Обновлена: ${found.updatedAt || '—'}`);
out.push(`Ходов: ${turns}, строк в ленте: ${all.length}${thoughts ? `, мыслей: ${thoughts} (текстом не печатаются)` : ''}`);
out.push(`Токены: вход ${usage.inputTokens} + кэш ${usage.cacheReadTokens}, выход ${usage.outputTokens}, $${Number(usage.costUsd).toFixed(4)}, время ${Math.round(usage.durationMs / 1000)} с`);
out.push(`id внутри CLI: ${cliLinks.length ? cliLinks.map((l) => `${l.target} → ${l.id}`).join(', ') : 'нет — сессию нельзя продолжить тем же CLI'}`);
out.push('');

// ходы отделённые пустой строкой, иначе в выводе не видно, где кончился один
// и начался другой, а печатается именно по ходам
const visible = LAST ? all.slice(-LAST * 12) : all;
let turn = 0;
for (const m of visible) {
    if (m.role === 'user') {
        turn += 1;
        out.push(`## Ход ${turn}${m.model ? ` (${m.model})` : ''}`);
        out.push(clip(m.text, LIMIT.human));
    } else if (m.role === 'assistant') {
        out.push(`### Ответ`);
        out.push(clip(m.text, LIMIT.answer));
    } else if (m.role === 'tool') {
        const input = String(m.toolInput || '').replace(/\s+/g, ' ').slice(0, LIMIT.step);
        out.push(`- шаг ${m.toolName || '?'}${input ? `: ${input}` : ''}`);
    }
}
if (LAST && visible.length < all.length) out.push(`\n…(показаны последние ${LAST} ходов из ${turns})`);

console.log(out.join('\n'));
