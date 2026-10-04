// Воронка проверок ветки исполнителя: дешёвое — раньше дорогого.
//
//   1. машинная    — `npm run check` на рабочей копии ветки (SYSTEM/checks.js --root);
//   2. интерфейс   — если ветка трогает клиент: прогон `/branch/<ветка>/` (SYSTEM/ui-walk.mjs);
//   2а. подсказка jev — только если дано поручение (--task): по делу ли дифф и нет ли
//      правок, которых не просили. Ветку по ней не отклоняют, она лишь говорит
//      рецензенту, куда смотреть первым (turn-judgment.js, judgeBranch);
//   3. дешёвый рецензент, 4. дорогой — их зовёт владелец сессии, не этот скрипт:
//      решение о рецензенте принимает тот, кто ведёт работу (DOCS/decisions/049): скрипт только говорит,
//      дошла ли ветка до рецензента, и отдаёт ему список правок.
//
// Ветка, упавшая на шаге 1 или 2, до рецензента не доходит вовсе — в этом и
// экономия: модель не тратится на то, что ловит линтер. DOCS/decisions/049.
//
// Запуск: `npm run gate -- <ветка> [--task "поручение"] [--json]`. Код выхода: 0 — к рецензенту,
// 1 — на доработку, 2 — ветку нельзя проверить (нет копии, нет правок),
// 3 — интерфейс отсюда не проверить, повторить на хосте.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const asJson = args.includes('--json');
const taskAt = args.indexOf('--task');
const task = taskAt >= 0 ? String(args[taskAt + 1] || '').trim() : '';
const branch = args.find((a, i) => !a.startsWith('--') && i !== taskAt + 1);
const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim();

const result = { branch, stages: [], verdict: null, next: null, files: [] };
const finish = (code, verdict, next) => {
    result.verdict = verdict;
    result.next = next;
    if (asJson) console.log(JSON.stringify(result, null, 2));
    else {
        console.log(`Ветка ${branch}: правок в файлах — ${result.files.length}`);
        for (const s of result.stages) {
            console.log(`${s.hint ? 'подсказ' : s.ok === null ? 'пропуск' : s.ok ? '   ok  ' : ' FAIL  '} ${s.name}${s.note ? ` — ${s.note}` : ''}`);
            if (s.ok === false && s.output) console.log(s.output.split('\n').map((l) => `          ${l}`).join('\n'));
        }
        console.log(`\nИтог: ${verdict}. Дальше: ${next}`);
    }
    process.exit(code);
};

if (!branch) { console.error('Нужно имя ветки: npm run gate -- <ветка> [--task "поручение"] [--json]'); process.exit(2); }

// рабочая копия ветки — по самому git, как и предпросмотр (DOCS/decisions/042)
let worktree = null;
let current = null;
for (const line of git('worktree', 'list', '--porcelain').split('\n')) {
    if (line.startsWith('worktree ')) current = line.slice(9);
    if (line === `branch refs/heads/${branch}`) worktree = current;
}
if (!worktree || !fs.existsSync(worktree)) finish(2, 'ветку нельзя проверить', `рабочей копии ветки ${branch} нет — исполнитель должен работать в git worktree`);

result.files = git('diff', '--name-only', `main...${branch}`).split('\n').filter(Boolean);
if (!result.files.length) finish(2, 'ветку нельзя проверить', 'в ветке нет правок относительно main');

// 1. машинная. Проверяющий скрипт — из главной копии: ветка не должна уметь
// ослабить собственную проверку, переписав SYSTEM/checks.js
if (!fs.existsSync(path.join(worktree, 'eslint.config.mjs'))) {
    result.stages.push({ name: 'машинная проверка', ok: false, note: 'ветка старше проверок (нет eslint.config.mjs) — обновить от main' });
    finish(1, 'на доработку', 'исполнителю: влить main в ветку и повторить');
}
const check = spawnSync(process.execPath, [path.join(ROOT, 'SYSTEM', 'checks.js'), '--root', worktree], { encoding: 'utf8' });
result.stages.push({ name: 'машинная проверка', ok: check.status === 0, output: check.status === 0 ? undefined : (check.stdout + check.stderr).trim().slice(0, 4000) });
if (check.status !== 0) finish(1, 'на доработку', 'исполнителю: исправить найденное машинной проверкой — рецензента не звать');

// 2. интерфейс — только если ветка трогает то, что уходит в браузер. Серверную
// половину предпросмотр ветки не показывает (DOCS/decisions/042)
const isClient = (f) => /^(SYSTEM|PROJECTS)\//.test(f) && /\.(js|css|html|eta)$/.test(f)
    && !/-server\.js$/.test(f) && !f.startsWith('SYSTEM/core/') && !/^SYSTEM\/[\w-]+\.mjs$/.test(f) && f !== 'SYSTEM/checks.js';
const clientFiles = result.files.filter(isClient);
if (!clientFiles.length) {
    result.stages.push({ name: 'прогон интерфейса', ok: null, note: 'клиент не тронут' });
} else {
    let port = '3001';
    try { port = fs.readFileSync(path.join(ROOT, '.env'), 'utf8').match(/^PORT=(\d+)/m)?.[1] || port; } catch {}
    const url = `http://127.0.0.1:${port}/branch/${branch}/`;
    const walk = spawnSync(process.execPath, [path.join(ROOT, 'SYSTEM', 'ui-walk.mjs'), '--url', url], { encoding: 'utf8', timeout: 300000 });
    const out = (walk.stdout + walk.stderr).split('\n').filter((l) => !l.includes('Assertion failed')).join('\n').trim();
    // без доступа к браузеру и серверу шаг не пройден и не
    // провален: его обязан сделать тот, кто на хосте
    if (walk.status === 3) {
        result.stages.push({ name: 'прогон интерфейса', ok: null, note: 'отсюда недоступен — нужен хост' });
        finish(3, 'машинная пройдена, интерфейс не проверен', `повторить эту же команду на хосте: npm run gate -- ${branch}; рецензента пока не звать`);
    }
    result.stages.push({ name: 'прогон интерфейса', ok: walk.status === 0, note: `${clientFiles.length} клиентских файлов, ${url}`, output: walk.status === 0 ? undefined : out.slice(0, 4000) });
    if (walk.status !== 0) finish(1, 'на доработку', 'исполнителю: исправить ошибки интерфейса — рецензента не звать');
}

// 2а. подсказка jev рецензенту. Нет поручения, ключа или ответа — шага просто нет:
// ветка доходит до рецензента, как доходила. Отклонить по этому числу нельзя
let hint = '';
if (task) {
    let diff = '';
    try { diff = execFileSync('git', ['diff', `main...${branch}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); } catch {}
    const { createRequire } = await import('node:module');
    const judged = await createRequire(import.meta.url)('./core/turn-judgment.js').judgeBranch({ task, diff, files: result.files }).catch(() => null);
    if (judged) {
        const pct = (n) => (n === null ? '—' : `${Math.round(n * 100)}%`);
        result.stages.push({ name: 'jev: дифф по поручению', ok: true, hint: true, note: `по делу ${pct(judged.onTask)}, лишнего ${pct(judged.offTask)}${judged.truncated ? ' (дифф усечён)' : ''}` });
        if (judged.flagged) hint = 'jev видит в диффе правки, которых поручение не просило, — рецензенту смотреть их первыми; ';
    } else {
        result.stages.push({ name: 'jev: дифф по поручению', ok: null, note: 'суждения нет (нет ключа или ответа)' });
    }
}

const serverTouched = result.files.some((f) => f === 'server.js' || /-server\.js$/.test(f) || f.startsWith('SYSTEM/core/') || f.startsWith('SYSTEM/cli/'));
finish(0, 'прошла машинные проверки', `${hint}дешёвый рецензент; дорогой проверяющий — только если дешёвый принял${serverTouched ? '. Ветка меняет сервер: предпросмотр этого не показывает, рецензенту смотреть код' : ''}`);
