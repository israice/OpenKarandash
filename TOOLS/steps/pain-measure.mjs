// Замер боли для шага «напоминание о приёме» (кайдзен 072, п.1): только чтение.
// какая доля успешных ходов последних 30 дней закончилась записью приёма?
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync(process.env.SESSIONS_DB || 'DATA/.sessions.db', { readOnly: true });
const tables = db.prepare("select name from sqlite_master where type='table'").all();
console.log(tables.map((x) => x.name).join(','));

function cols(t) {
    return db.prepare(`pragma table_info(${t})`).all().map((c) => c.name).join(',');
}
for (const { name } of tables) {
    const n = db.prepare(`select count(*) n from ${name}`).get().n;
    console.log(`${name}=${n} [${cols(name)}]`);
}

const m = tables.find((x) => x.name.includes('message'));
if (!m) {
    console.log('NO_MESSAGES_TABLE');
    process.exit(0);
}
const info = db.prepare(`pragma table_info(${m.name})`).all();
const has = (f) => info.some((c) => c.name === f);
if (!has('created_at') || !has('result_meta')) {
    console.log('COLS:' + info.map((c) => c.name).join(','));
    process.exit(0);
}
const month = db.prepare(`select count(*) n from ${m.name} where created_at >= datetime('now', '-30 days')`).get().n;
const ok = db.prepare(`select count(*) n from ${m.name} where created_at >= datetime('now', '-30 days') and substr(coalesce(result_meta,''),1,1)='{'`).get().n;
const withSkill = db.prepare(`select count(*) n from ${m.name} where created_at >= datetime('now', '-30 days') and result_meta like '%"skill":%'`).get().n;
const withSkillTitle = db.prepare(`select count(*) n from ${m.name} where created_at >= datetime('now', '-30 days') and result_meta like '%"skill":{"title":%'`).get().n;
const ninety = db.prepare(`select count(*) n from ${m.name} where created_at >= datetime('now', '-90 days')`).get().n;
console.log('turns30=' + month, 'todos30=' + ok, 'metaSkill30=' + withSkill, 'metaSkillTitle30=' + withSkillTitle, 'turns90=' + ninety);

const byRole = db.prepare(`select role, count(*) n from ${m.name} where created_at >= datetime('now','-30 days') group by role`).all();
console.log('BY_ROLE ' + JSON.stringify(byRole));
const byEvent = db.prepare(`select event_type, count(*) n from ${m.name} where created_at >= datetime('now','-30 days') group by event_type`).all();
console.log('BY_EVENT ' + JSON.stringify(byEvent));
console.log('SESSIONS ' + db.prepare(`select count(distinct session_id) n from ${m.name} where created_at >= datetime('now','-30 days')`).get().n);
const metaRows = db.prepare(`select count(*) n from ${m.name} where created_at >= datetime('now','-30 days') and result_meta is not null and result_meta != ''`).get().n;
console.log('META_ROWS30=' + metaRows);
