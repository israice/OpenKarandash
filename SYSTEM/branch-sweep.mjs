// Уборка веток исполнителей. Ветка на подзадачу — принятый механизм приёмки
// (DOCS/decisions/040), а непринятые ветки сами не исчезают: без уборки через
// месяц их сотни, и `/api/branches` с предпросмотром тонут в мёртвых.
//
//   npm run branches                      — только список, ничего не трогает
//   npm run branches -- --prune-merged    — снять влитые в main
//   npm run branches -- --prune-stale 14  — снять непринятые без коммитов 14+ дней
//
// Никогда не трогает: main, текущую ветку, копию с незакоммиченными правками
// и ветку без рабочей копии (её завёл человек, а не исполнитель). DOCS/decisions/049.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const pruneMerged = args.includes('--prune-merged');
const staleAt = args.indexOf('--prune-stale');
const staleDays = staleAt >= 0 ? Number(args[staleAt + 1]) : null;
if (staleAt >= 0 && !(staleDays > 0)) { console.error('--prune-stale ждёт число дней, например 14'); process.exit(2); }

const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tryGit = (cwd, ...a) => { try { return git(cwd, ...a); } catch { return null; } };

const mainTip = git(ROOT, 'rev-parse', 'main');
const rows = [];
let current = null;
for (const line of git(ROOT, 'worktree', 'list', '--porcelain').split('\n')) {
    if (line.startsWith('worktree ')) current = { dir: line.slice(9) };
    if (line.startsWith('branch refs/heads/') && current) rows.push({ ...current, branch: line.slice(18) });
}

const DAY = 24 * 3600 * 1000;
const report = [];
for (const row of rows) {
    if (row.branch === 'main' || path.resolve(row.dir) === path.resolve(ROOT)) continue;
    const alive = fs.existsSync(row.dir);
    const tip = git(ROOT, 'rev-parse', row.branch);
    const ahead = Number(git(ROOT, 'rev-list', '--count', `main..${row.branch}`));
    const ageDays = Math.floor((Date.now() - Number(git(ROOT, 'log', '-1', '--format=%ct', row.branch)) * 1000) / DAY);
    const dirty = alive ? Boolean(tryGit(row.dir, 'status', '--porcelain')) : false;
    // «влита» — всё её есть в main, и это не только что заведённая пустая ветка:
    // у той вершина совпадает с main, и снимать её из-под исполнителя нельзя
    const merged = ahead === 0 && tip !== mainTip;
    let action = 'оставить';
    if (dirty) action = 'оставить (незакоммиченные правки)';
    else if (merged && pruneMerged) action = 'СНЯТЬ (влита)';
    else if (!merged && ahead > 0 && staleDays && ageDays >= staleDays) action = `СНЯТЬ (не принята, ${ageDays} дн. без коммитов)`;
    report.push({ ...row, alive, ahead, ageDays, dirty, merged, action });
}

console.log('ветка | впереди main | дней без коммитов | состояние | действие');
for (const r of report) {
    const state = [r.merged ? 'влита' : r.ahead ? 'не принята' : 'пустая', r.dirty ? 'есть правки' : null, r.alive ? null : 'копии нет на диске'].filter(Boolean).join(', ');
    console.log(`${r.branch} | ${r.ahead} | ${r.ageDays} | ${state} | ${r.action}`);
}

for (const r of report.filter((x) => x.action.startsWith('СНЯТЬ'))) {
    // без --force: git сам откажется снять копию с правками — вторая страховка
    if (r.alive) git(ROOT, 'worktree', 'remove', r.dir);
    else git(ROOT, 'worktree', 'prune');
    git(ROOT, 'branch', '-D', r.branch);
    console.log(`снята: ${r.branch}`);
}
if (!pruneMerged && !staleDays) console.log('\nЭто только список. Снять влитые: --prune-merged; непринятые старше N дней: --prune-stale N');
