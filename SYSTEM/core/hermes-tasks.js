// Состояние подзадач Hermes — чтением его собственных хранилищ. Своего графа
// задач пульт не заводит (DOCS/decisions/040, урок 038): подзадача, статус,
// попытки, исполнитель и итог у Hermes уже записаны, в двух местах —
//
//   hermes-home/state.db, async_delegations — поручения помощникам (delegate_task):
//       цель, состояние, итог по каждой, время; дочерняя сессия помощника лежит
//       рядом в sessions (parent_session_id). Этим путём работа идёт сегодня;
//   hermes-home/kanban.db — доска: tasks, task_runs (попытки: профиль, статус,
//       исход, сводка, ошибка), task_links (родитель — потомок), task_events.
//
// Что здесь считается, а не читается: номер попытки поручения. Hermes его не
// хранит — повторное поручение той же цели из той же сессии у него просто ещё
// одна запись. Номер — порядковый среди записей с той же целью, по времени.
// DOCS/decisions/050.
//
// Запуск из терминала:
//   node SYSTEM/core/hermes-tasks.js [--session <id сессии Hermes>] [--board] [--json]
//
// Базы читаем с копии — как hermes-tool-runs.js: WAL через 9p/drvfs под пишущим
// контейнером даёт «disk I/O error».

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..', '..');
const HOME = path.join(ROOT, 'hermes-home');

function withCopy(dbFile, read) {
    if (!fs.existsSync(dbFile)) return null;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-tasks-'));
    try {
        for (const suffix of ['', '-wal', '-shm']) {
            if (fs.existsSync(dbFile + suffix)) fs.copyFileSync(dbFile + suffix, path.join(dir, 'copy.db' + suffix));
        }
        const db = new DatabaseSync(path.join(dir, 'copy.db'));
        try { return read(db); } finally { db.close(); }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

const parse = (text) => { try { return JSON.parse(text); } catch { return null; } };
const iso = (seconds) => (seconds ? new Date(seconds * 1000).toISOString() : null);
const hasTable = (db, name) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));

// Поручения помощникам. parent — id сессии Hermes, из которой поручали; без него — все
function readDelegations({ parent } = {}, dbFile = path.join(HOME, 'state.db')) {
    return withCopy(dbFile, (db) => {
        if (!hasTable(db, 'async_delegations')) return [];
        const rows = db.prepare(`
            SELECT delegation_id, parent_session_id, state, dispatched_at, completed_at, task_json, result_json
            FROM async_delegations ${parent ? 'WHERE parent_session_id = ?' : ''}
            ORDER BY dispatched_at`).all(...(parent ? [parent] : []));
        const children = db.prepare(`
            SELECT id, parent_session_id, started_at FROM sessions
            WHERE parent_session_id IS NOT NULL ORDER BY started_at`).all();
        const seen = new Map(); // родитель + цель -> сколько раз уже поручали
        const out = rows.map((r) => {
            const task = parse(r.task_json) || {};
            const result = (parse(r.result_json)?.results || [])[0] || {};
            const goal = task.goal || (task.goals || [])[0] || '';
            const key = `${r.parent_session_id}\n${goal}`;
            const attempt = (seen.get(key) || 0) + 1;
            seen.set(key, attempt);
            // дочерняя сессия — та, что началась, пока поручение выполнялось:
            // прямой ссылки между ними Hermes не хранит
            const child = children.find((c) => c.parent_session_id === r.parent_session_id
                && c.started_at >= r.dispatched_at - 1 && (!r.completed_at || c.started_at <= r.completed_at));
            return {
                delegationId: r.delegation_id,
                parentSession: r.parent_session_id,
                childSession: child?.id || null,
                goal,
                state: r.state,
                status: result.status || null,
                exitReason: result.exit_reason || null,
                summary: result.summary || null,
                model: result.model || task.model || null,
                costUsd: result.cost_usd ?? null,
                durationSeconds: result.duration_seconds ?? null,
                dispatchedAt: iso(r.dispatched_at),
                completedAt: iso(r.completed_at),
                attempt,
                key,
            };
        });
        for (const d of out) { d.attempts = seen.get(d.key); delete d.key; }
        return out;
    }) || [];
}

// Доска Hermes: задача, её попытки (task_runs) и связи родитель — потомок
function readBoard(dbFile = path.join(HOME, 'kanban.db')) {
    return withCopy(dbFile, (db) => {
        if (!hasTable(db, 'tasks')) return [];
        const runs = db.prepare('SELECT task_id, profile, status, outcome, summary, error, started_at, ended_at FROM task_runs ORDER BY id').all();
        const links = hasTable(db, 'task_links') ? db.prepare('SELECT parent_id, child_id FROM task_links').all() : [];
        return db.prepare('SELECT id, title, assignee, status, branch_name, created_at, completed_at, result, consecutive_failures FROM tasks ORDER BY created_at').all()
            .map((t) => ({
                taskId: t.id,
                title: t.title,
                assignee: t.assignee,
                status: t.status,
                branch: t.branch_name || null,
                result: t.result || null,
                failuresInRow: t.consecutive_failures || 0,
                createdAt: iso(t.created_at),
                completedAt: iso(t.completed_at),
                parents: links.filter((l) => l.child_id === t.id).map((l) => l.parent_id),
                attempts: runs.filter((r) => r.task_id === t.id).map((r, i) => ({
                    attempt: i + 1, profile: r.profile, status: r.status, outcome: r.outcome,
                    summary: r.summary || null, error: r.error || null, startedAt: iso(r.started_at), endedAt: iso(r.ended_at),
                })),
            }));
    }) || [];
}

// Снимок «что сейчас в работе» Hermes ведёт сам — gateway_state.json; для
// восстановления после падения своего снимка не заводим, отдаём его
function readSnapshot(file = path.join(HOME, 'gateway_state.json')) {
    const state = parse(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
    if (!state) return null;
    return {
        gatewayState: state.gateway_state ?? null,
        updatedAt: state.updated_at ?? null,
        activeAgents: state.active_agents ?? null,
        activeWork: state.active_work ?? null,
        servedProfiles: state.served_profiles ?? null,
        exitReason: state.exit_reason ?? null,
    };
}

// маршрут — только чтение; как и весь API пульта, принимает POST с JSON:
// { session: <id сессии Hermes> } — без него поручения по всем сессиям
function createRoutes({ sendJson, readJson }) {
    return {
        '/api/hermes/tasks': async (req, res) => {
            const parent = (await readJson(req)).session || undefined;
            sendJson(res, { ok: true, delegations: readDelegations({ parent }), board: readBoard(), snapshot: readSnapshot() });
        },
    };
}

module.exports = { readDelegations, readBoard, readSnapshot, createRoutes };

if (require.main === module) {
    const argv = process.argv.slice(2);
    const at = argv.indexOf('--session');
    const data = argv.includes('--board') ? readBoard() : readDelegations({ parent: at >= 0 ? argv[at + 1] : undefined });
    if (argv.includes('--json')) console.log(JSON.stringify(data, null, 2));
    else if (argv.includes('--board')) {
        for (const t of data) {
            console.log(`${t.taskId}  ${t.status.padEnd(9)}  ${t.assignee || '-'}  ${t.title}`);
            for (const a of t.attempts) console.log(`    попытка ${a.attempt}: ${a.profile} — ${a.outcome || a.status}${a.error ? ` (${a.error})` : ''}`);
        }
    } else {
        for (const d of data) console.log(`${d.dispatchedAt}  ${d.delegationId}  попытка ${d.attempt}/${d.attempts}  ${d.state}/${d.status}  помощник ${d.childSession || '?'}  ${d.goal.slice(0, 70)}`);
        if (!data.length) console.log('поручений не найдено');
    }
}
