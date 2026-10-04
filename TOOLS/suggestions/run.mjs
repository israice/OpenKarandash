// Сводка по тому, что подкладывалось в запросы агента: записки DOCS/decisions
// и приёмы из памяти работника, с оценками из result_meta хода. Только чтение
// базы — служебный инструмент для перемера порогов (DOCS/decisions/089).
//
//   node TOOLS/suggestions/run.mjs        сводка
//   node TOOLS/suggestions/run.mjs 50     сводка и последние 50 ходов подробно
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.join(import.meta.dirname, '..', '..'));
const DETAIL = Number(process.argv[2] || 0);

// SESSIONS_DB — путь к другой базе. Нужен, чтобы прогнать сводку на копии:
// живую базу не трогают, а проверить, что поле разбора читается, иначе нечем
// (та же осторожность, что в памяти работника про копию миграций).
const db = new DatabaseSync(process.env.SESSIONS_DB || path.join(ROOT, 'DATA', '.sessions.db'));
// Поле result_meta лежит в строке ОТВЕТА агента, а не в строке запроса. Фильтр
// по роли 'user' молча отсекал все ходы, и свода с v0.0.124 показывала ноль при
// заполненной базе. Роль не фильтруем вовсе — ищем по самому полю.
const rows = db.prepare(`
    SELECT session_id, position, created_at, result_meta
    FROM messages
    WHERE result_meta LIKE '%"suggestions"%'
    ORDER BY created_at DESC
`).all();

// Текст запроса хода — ближайшая строка роли user перед этой позицией: свой
// текст у строки ответа это ответ агента, а в сводке нужен вопрос человека
function requestBefore(sessionId, position) {
    return db.prepare(`
        SELECT text FROM messages
        WHERE session_id = ? AND role = 'user' AND position < ?
        ORDER BY position DESC LIMIT 1
    `).get(sessionId, position)?.text || '';
}

const notes = new Map();   // заголовок → список оценок
const skills = new Map();  // заголовок → список оценок
// отчёт разведки: что уехало в запрос, сколько весил и что о нём подумало
// суждение (DOCS/decisions/092). Показан здесь потому, что это единственное
// место, где видно, едет ли отчёт в настоящих ходах, а не только в прогонах
const homework = [];
const turns = [];

for (const row of rows) {
    let meta = null;
    try { meta = JSON.parse(row.result_meta || 'null'); } catch { continue; }
    const sug = meta?.suggestions;
    if (!sug) continue;
    for (const n of sug.notes || []) {
        if (!notes.has(n.title)) notes.set(n.title, []);
        notes.get(n.title).push({ noul: n.noul, confidence: n.confidence });
    }
    if (sug.skill) {
        const key = sug.skill.title;
        if (!skills.has(key)) skills.set(key, []);
        skills.get(key).push({ match: sug.skill.match });
    }
    if (sug.homework) homework.push(sug.homework);
    turns.push({ session: row.session_id, at: String(row.created_at || '').slice(0, 10), request: String(requestBefore(row.session_id, row.position) || '').replace(/\s+/g, ' ').slice(0, 80), sug });
}

if (!turns.length) {
    console.log('В базе нет ходов с пометкой suggestions.');
    console.log('Поле появилось в v0.0.124; перезапустите сервер и сделайте несколько ходов.');
    console.log('Отчёта разведки в этих ходах тоже нет: он едет в запрос с v0.0.135, а первые ходы после него ещё не проходили.');
    process.exit(0);
}

const stat = (values) => {
    const nums = values.filter((v) => typeof v === 'number');
    if (!nums.length) return '—';
    const avg = nums.reduce((a, b) => a + b, 0) / nums.length;
    return `${avg.toFixed(2)} (${Math.min(...nums).toFixed(2)}–${Math.max(...nums).toFixed(2)})`;
};

console.log(`ходов с подсказками: ${turns.length} из ${db.prepare("SELECT count(*) n FROM messages WHERE role='user'").get().n} запросов\n`);

console.log('записки DOCS/decisions — заголовок | раз | средняя оценка | диапазон');
for (const [title, list] of [...notes].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${list.length}× ${stat(list.map((x) => x.noul)).padEnd(20)} ${title.slice(0, 60)}`);
}
console.log('\nприёмы из памяти работника — заголовок | раз | средняя оценка | диапазон');
for (const [title, list] of [...skills].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${list.length}× ${stat(list.map((x) => x.match)).padEnd(20)} ${title.slice(0, 60)}`);
}

// доля ходов, где что-то было подложено, и среднее число подсказок на ход
const withNotes = turns.filter((t) => t.sug.notes?.length).length;
const withSkill = turns.filter((t) => t.sug.skill).length;
console.log(`\nсо записками: ${withNotes} (${Math.round((withNotes / turns.length) * 100)}%), с приёмом: ${withSkill} (${Math.round((withSkill / turns.length) * 100)}%)`);
console.log(`подсказок на ход в среднем: ${(turns.reduce((a, t) => a + (t.sug.notes?.length || 0), 0) / turns.length).toFixed(2)}`);

// отчёт разведки: объём, суждение «работа в проекте» и сколько раз ехала
// карта вместо полного отчёта (продолжение сессии)
if (homework.length) {
    const reused = homework.filter((h) => h.reused).length;
    const kinds = new Map();
    for (const h of homework) kinds.set(h.kind || '—', (kinds.get(h.kind || '—') || 0) + 1);
    console.log('\nотчёт разведки — ходов | средний объём | суждение «работа в проекте» | карта вместо отчёта');
    console.log(`  ${homework.length}×  ${stat(homework.map((h) => h.sent ?? h.chars)).padEnd(20)} ${stat(homework.map((h) => h.work)).padEnd(20)} ${reused}×`);
    console.log(`  по типам задачи: ${[...kinds].map(([k, n]) => `${k} ${n}`).join(', ')}`);
} else {
    console.log('\nотчёт разведки: ни разу — сервер ещё не подкладывал его в запрос (поле появилось в v0.0.135).');
}

if (DETAIL > 0) {
    console.log(`\n--- последние ${DETAIL} ходов ---`);
    for (const t of turns.slice(0, DETAIL)) {
        const list = (t.sug.notes || []).map((n) => `${n.title.slice(0, 34)} ${n.noul?.toFixed(2)}`).join('; ');
        console.log(`[${t.session} ${t.at}] ${t.request}`);
        if (list) console.log(`   записки: ${list}`);
        if (t.sug.skill) console.log(`   приём:   ${t.sug.skill.title.slice(0, 60)} ${t.sug.skill.match?.toFixed(2)}`);
        if (t.sug.homework) {
            const h = t.sug.homework;
            const what = h.reused ? 'карта' : 'отчёт';
            console.log(`   разведка: ${what}, ${h.files} файлов, в запрос ушло ${h.sent ?? h.chars} симв.${h.work === null ? '' : `, суждение ${h.work.toFixed(2)}`}`);
        }
    }
}