// Запуск сценария живой проверки одной командой (навык live-verify, см. SKILL.md рядом).
//
//   node .claude/skills/live-verify/run.mjs <сценарий> [ключ=значение ...] [--shot <снимок.png>] [--timeout <сек>]
//
// <сценарий> — имя файла из scenarios/ без расширения либо путь к своему файлу того же вида:
// в файле объявлена `async function scenario(P)`, P — параметры из командной строки (строки).
//
// Зачем обёртка, если есть SYSTEM/live-check.mjs: тот принимает только `<файл.js> [снимок.png]`,
// где файл — тело async-функции с `return`. Такой файл параметров не берёт, не разбирается ни
// `node --check`, ни eslint (`return` вне функции) и каждый раз писался заново. Здесь сценарий —
// обычная функция: обёртка дописывает к ней вызов с параметрами, кладёт готовое тело в
// DATA/live/ (виден node на Windows, не в git, не под сторожем файлов и не под eslint) и зовёт
// live-check.mjs через powershell. Сервер и стек она не запускает никогда.
//
// Код выхода: 0 — сценарий вернул результат без `ok: false`; 1 — `ok: false`, исключение в
// странице или таймаут; 2 — неверный вызов; 3 — отсюда не запустить (нет powershell/wslpath:
// контейнер Hermes и т. п.), как у SYSTEM/ui-walk.mjs.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const LIVE_CHECK = path.join(ROOT, 'SYSTEM', 'live-check.mjs');
const OUT_DIR = path.join(ROOT, 'DATA', 'live');
const DONE = '<<<live-verify:done>>>';

function usage(message) {
    if (message) console.error(message);
    const known = fs.readdirSync(path.join(HERE, 'scenarios')).filter((f) => f.endsWith('.js')).map((f) => f.slice(0, -3));
    console.error(`Вызов: node .claude/skills/live-verify/run.mjs <сценарий> [ключ=значение ...] [--shot <снимок.png>] [--timeout <сек>]\nСценарии: ${known.join(', ')}`);
    process.exit(2);
}

const args = process.argv.slice(2);
let scenarioArg = null;
let shotDest = null;
let timeoutSec = 300;
const params = {};
for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--shot') shotDest = args[++i];
    else if (arg === '--timeout') timeoutSec = Number(args[++i]) || timeoutSec;
    else if (!scenarioArg) scenarioArg = arg;
    else if (arg.includes('=')) params[arg.slice(0, arg.indexOf('='))] = arg.slice(arg.indexOf('=') + 1);
    else usage(`Непонятный аргумент: ${arg}`);
}
if (!scenarioArg) usage();

const bundled = path.join(HERE, 'scenarios', `${scenarioArg}.js`);
const scenarioFile = fs.existsSync(bundled) ? bundled : path.resolve(scenarioArg);
if (!fs.existsSync(scenarioFile)) usage(`Сценарий не найден: ${scenarioArg}`);
const source = fs.readFileSync(scenarioFile, 'utf8');
if (!/async function scenario\s*\(/.test(source)) usage(`В ${scenarioFile} нет «async function scenario(P)»`);

// адрес пульта — порт из .env, тем же способом, что SYSTEM/live-check.mjs и SYSTEM/ui-walk.mjs
function appUrl() {
    let port = '3001';
    try { port = fs.readFileSync(path.join(ROOT, '.env'), 'utf8').match(/^PORT=(\d+)/m)?.[1] || port; } catch {}
    return `http://127.0.0.1:${port}/`;
}

// тело для live-check.mjs. Вкладку он мог открыть секунду назад (скрипты пульта отложенные),
// а мог открыть и страницу ошибки — сервер не запущен. Ждём пульт; не дождались — говорим прямо
const body = `const __lvApp = ${JSON.stringify(appUrl())};
const __lvDown = 'Сам сервер не поднимай: так и скажи в отчёте (раздел «Сервер не отвечает» в SKILL.md).';
for (let i = 0; i < 60 && !(window.App && window.MissionTabs && document.readyState === 'complete'); i++) await new Promise((r) => setTimeout(r, 250));
if (!(window.App && window.MissionTabs)) {
    const at = location.href;
    // вкладка с ошибкой загрузки сама не оживёт: перезагружаем её, но уже после ответа —
    // иначе переход уничтожит контекст раньше, чем результат уйдёт в live-check
    setTimeout(() => location.replace(__lvApp), 500);
    return { ok: false, serverDown: true, error: 'Пульт не открылся (' + at + '). Похоже, сервер пользователя не запущен. ' + __lvDown + ' Если он точно запущен — повтори вызов: вкладка перезагружена.' };
}
// загруженный пульт ещё не значит живой сервер: вкладка проверочного Edge живёт между вызовами
// и остановку сервера переживает (страница сама не перезагружается, пока связь не вернётся) —
// сценарий, который только переключает вкладки, на такой странице «прошёл» бы. Поэтому сперва
// спрашиваем сам сервер. Полминуты запаса — на перезапуск сторожем после правки серверного
// файла: новый процесс не отвечает, пока пересобирает карту проекта
let __lvAlive = false;
let __lvWhy = '';
for (let i = 0; i < 10 && !__lvAlive; i++) {
    try {
        const res = await fetch('/api/agent/status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(5000) });
        __lvAlive = res.ok;
        __lvWhy = 'HTTP ' + res.status;
    } catch (e) { __lvWhy = String((e && e.message) || e); }
    if (!__lvAlive) await new Promise((r) => setTimeout(r, 3000));
}
if (!__lvAlive) return { ok: false, serverDown: true, error: 'Страница пульта открыта, но сервер пользователя не отвечает (' + __lvWhy + '). ' + __lvDown };
${source}
// исключение ловим сами: live-check.mjs на брошенную ошибку печатает просто «{}»
try { return await scenario(${JSON.stringify(params)}); } catch (e) { return { ok: false, error: String((e && e.stack) || e) }; }
`;
fs.mkdirSync(OUT_DIR, { recursive: true });
const name = path.basename(scenarioFile).replace(/\.[^.]+$/, '');
const bodyFile = path.join(OUT_DIR, `${name}.body.js`);
const shotFile = shotDest ? path.join(OUT_DIR, `${name}.png`) : null;
fs.writeFileSync(bodyFile, body);
if (shotFile) fs.rmSync(shotFile, { force: true });

let child;
if (process.platform === 'linux') {
    if (spawnSync('which', ['powershell.exe', 'wslpath']).status !== 0) {
        console.error('Живая проверка отсюда невозможна: нужен хост пользователя (WSL или Windows).');
        process.exit(3);
    }
    const win = (p) => spawnSync('wslpath', ['-w', p], { encoding: 'utf8' }).stdout.trim();
    const quote = (p) => `'${win(p).replace(/'/g, "''")}'`;
    const command = `node ${[LIVE_CHECK, bodyFile, shotFile].filter(Boolean).map(quote).join(' ')}; Write-Output '${DONE}'`;
    child = spawn('powershell.exe', ['-NoProfile', '-Command', command], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
} else {
    child = spawn(process.execPath, [LIVE_CHECK, bodyFile, shotFile].filter(Boolean), { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
}

// первый вызов поднимает Edge, и powershell после этого может не вернуть управление, хотя
// работа сделана. Поэтому конец определяем сами: по метке после node либо по целому JSON
// в выводе и тишине после него — и не ждём процесс, который уже ничего не напишет
let out = '';
let errOut = '';
let finished = false;
let quiet = null;
// «Assertion failed … async.c» — node на Windows при выходе, не ошибка (см. шапку live-check.mjs)
const clean = () => out.replace(/\r/g, '').split('\n').filter((l) => !l.includes('Assertion failed') && !l.includes(DONE)).join('\n').trim();
const parsed = () => { try { return JSON.parse(clean()); } catch { return undefined; } };

function finish(reason) {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    clearTimeout(quiet);
    try { child.kill(); } catch {}
    const text = clean();
    const result = parsed();
    if (text) console.log(text);
    const noise = errOut.replace(/\r/g, '').split('\n').filter((l) => l.trim() && !l.includes('Assertion failed')).join('\n');
    if (noise) console.error(noise);
    // связь с вкладкой оборвалась посреди сценария: node вышел, не дождавшись ответа страницы
    if (errOut.includes('unsettled top-level await')) {
        console.error('\nСвязь с вкладкой оборвалась посреди сценария: скорее всего, Edge погасил параллельный агент, закончив свою проверку. Запусти ещё раз.');
    }
    if (reason === 'timeout') console.error(`\nСценарий не ответил за ${timeoutSec} с (--timeout <сек>, если ход долгий).`);
    if (shotFile && fs.existsSync(shotFile)) {
        if (path.resolve(shotDest) !== shotFile) fs.copyFileSync(shotFile, path.resolve(shotDest));
        console.error(`Снимок: ${path.resolve(shotDest)}`);
    }
    // синтаксическую ошибку в сценарии live-check печатает как exceptionDetails: { exceptionId, text, ... }
    // а сбой самого протокола (страница ушла из-под сценария) — как { id, error }
    const failed = reason === 'timeout' || result === undefined || result?.ok === false || result?.exceptionId !== undefined || result?.error !== undefined;
    process.exit(failed ? 1 : 0);
}

const timer = setTimeout(() => finish('timeout'), timeoutSec * 1000);
const onData = (chunk) => {
    out += chunk;
    clearTimeout(quiet);
    if (out.includes(DONE)) { finish('done'); return; }
    // снимок пишется после JSON — даём ему время, прежде чем считать работу законченной
    if (parsed() !== undefined) quiet = setTimeout(() => finish('quiet'), shotFile ? 8000 : 4000);
};
child.stdout.setEncoding('utf8').on('data', onData);
child.stderr.setEncoding('utf8').on('data', (chunk) => { errOut += chunk; });
child.on('close', () => finish('close'));
