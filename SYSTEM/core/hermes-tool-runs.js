// Журнал запусков инструментов Hermes — одно место на вопрос «какой инструмент
// когда запускался». Своей таблицы у нас нет и не заводим: каждый вызов с
// аргументами, результатом, временем и id сессии уже пишет сам Hermes в
// hermes-home/state.db. Копия в нашей базе дала бы второй, отстающий источник
// (DOCS/decisions/038).
//
// Запуск из терминала:
//   node SYSTEM/core/hermes-tool-runs.js [--session <id>] [--tool <имя>] [--since 2026-09-01] [--limit 50] [--json]
//
// Базу читаем с копии: state.db живёт в WAL, а через 9p/drvfs прямое чтение
// под пишущим контейнером даёт «disk I/O error». Копируем три файла разом.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { callsById } = require('./hermes-history.js');

const ROOT = path.resolve(__dirname, '..', '..');
const STATE_DB = path.join(ROOT, 'hermes-home', 'state.db');

function snapshot(dbFile) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-state-'));
    for (const suffix of ['', '-wal', '-shm']) {
        if (fs.existsSync(dbFile + suffix)) fs.copyFileSync(dbFile + suffix, path.join(dir, 'state.db' + suffix));
    }
    return dir;
}

// ошибкой считаем то, что сам инструмент так пометил в своём JSON-ответе
function failed(content) {
    try {
        const parsed = JSON.parse(content);
        return parsed?.success === false || Boolean(parsed?.error);
    } catch {
        return false;
    }
}

// opts: session, tool, since (дата/время ISO), limit. Возвращает новые сверху
function readToolRuns(opts = {}, dbFile = STATE_DB) {
    if (!fs.existsSync(dbFile)) return [];
    const dir = snapshot(dbFile);
    try {
        const db = new DatabaseSync(path.join(dir, 'state.db'));
        const where = ["t.role = 'tool'"];
        const params = [];
        if (opts.session) { where.push('t.session_id = ?'); params.push(opts.session); }
        if (opts.tool) { where.push('t.tool_name = ?'); params.push(opts.tool); }
        if (opts.since) { where.push('t.timestamp >= ?'); params.push(Date.parse(opts.since) / 1000); }
        params.push(Number(opts.limit) || 50);
        const rows = db.prepare(`
            SELECT t.id, t.session_id, t.tool_name, t.tool_call_id, t.timestamp, t.content,
                   s.title, s.source,
                   (SELECT a.tool_calls FROM messages a
                     WHERE a.session_id = t.session_id AND a.id < t.id AND a.role = 'assistant'
                       AND a.tool_calls LIKE '%' || t.tool_call_id || '%'
                     ORDER BY a.id DESC LIMIT 1) AS tool_calls
            FROM messages t LEFT JOIN sessions s ON s.id = t.session_id
            WHERE ${where.join(' AND ')}
            ORDER BY t.id DESC LIMIT ?`).all(...params);
        db.close();
        return rows.map((r) => {
            const call = callsById({ tool_calls: r.tool_calls }).get(String(r.tool_call_id)) || {};
            return {
                at: new Date(r.timestamp * 1000).toISOString(),
                session: r.session_id,
                title: r.title,
                source: r.source,
                tool: r.tool_name || call.name || 'tool',
                args: call.args ?? null,
                ok: !failed(r.content || ''),
                result: r.content || '',
            };
        });
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

module.exports = { readToolRuns };

if (require.main === module) {
    const argv = process.argv.slice(2);
    const opt = (name) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : undefined; };
    const runs = readToolRuns({ session: opt('session'), tool: opt('tool'), since: opt('since'), limit: opt('limit') });
    if (argv.includes('--json')) {
        console.log(JSON.stringify(runs, null, 2));
    } else {
        if (!runs.length) console.log('запусков не найдено (нет hermes-home/state.db или фильтр пуст)');
        for (const r of runs.reverse()) {
            const args = r.args == null ? '' : (typeof r.args === 'string' ? r.args : JSON.stringify(r.args));
            console.log(`${r.at}  ${r.ok ? 'ok ' : 'ERR'}  ${r.tool.padEnd(14)}  ${r.session}  ${args.slice(0, 120)}`);
        }
    }
}
