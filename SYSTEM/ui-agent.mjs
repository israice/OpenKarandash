// Jev-агент над живым интерфейсом: ходит по пульту целью на человеческом языке,
// сам выбирая действие и элемент, — как jev-ultrafast, только решениями заведует
// наш TypeSafe System One (SYSTEM/core/typesafe.js), а браузер — безголовый Edge
// через тот же CDP, что в ui-walk.mjs и live-check.mjs (DOCS/decisions/114).
//
// На каждом ходу: один снапшот видимых контролов → один запрос Jev с двумя
// вопросами (операция и таргет; текстовую модель не зовём — текст берём из
// `--text`) → проверка страницы → выполнение. DONE считается успехом только
// при независимой проверке (`--expect`), как у jev-ultrafast.
//
// Запуск: npm run ui-agent -- --goal "..." --expect "..." [--text "LABEL=VALUE"]...
// Код выхода: 0 — цель достигнута, 4 — не подтверждено, 1 — ошибки консоли.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const typesafe = require('./core/typesafe.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));

if (process.platform !== 'win32') {
    console.error('Jev-прогон возможен только на Windows: сервер отвечает локальным запросам, а браузер ищется по путям Windows.');
    process.exit(3);
}

const PORT = 9333;
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function arg(name) {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : null;
}
function args(name) {
    const out = [];
    for (let i = 0; i < process.argv.length; i++) if (process.argv[i] === `--${name}`) out.push(process.argv[i + 1]);
    return out;
}

const GOAL = arg('goal');
const EXPECT = arg('expect');
const MAX_TICKS = Number(arg('max-ticks') || 20);
const URL_APP = arg('url') || (() => {
    let port = '3001';
    try { port = fs.readFileSync(path.join(HERE, '..', '.env'), 'utf8').match(/^PORT=(\d+)/m)?.[1] || port; } catch {}
    return `http://127.0.0.1:${port}/`;
})();
// вручную заданные ответы на поля: "Подпись=значение", подпись ищется без учёта регистра
const TEXTS = args('text').map((s) => {
    const i = s.indexOf('=');
    return { label: s.slice(0, i).trim().toLowerCase(), value: s.slice(i + 1) };
});
// без них TYPE_TEXT некуда взять текст — сразу честно, а не падать на первом же вводе
if (!GOAL) { console.error('Нужен --goal "..."'); process.exit(2); }
if (!typesafe.isEnabled()) { console.error('Нет ключа TypeSafe — Jev недоступен.'); process.exit(2); }

// клики с такими подписями никогда не выполняем, даже если Jev их выбрал
const REFUSED = /send|submit|pay|buy|checkout|delete|publish|отправ|удал|плат|куп/i;

async function cdp(pathname, method = 'GET') {
    return (await fetch(`http://127.0.0.1:${PORT}${pathname}`, { method })).json();
}
async function ensureBrowser() {
    try { return await cdp('/json/version'); } catch {}
    spawn(EDGE, ['--headless=new', `--remote-debugging-port=${PORT}`, '--user-data-dir=C:\\Users\\Public\\okcheck\\profile',
        '--window-size=1600,1000', '--no-first-run', 'about:blank'], { detached: true, stdio: 'ignore' }).unref();
    for (let i = 0; i < 40; i++) { await sleep(250); try { return await cdp('/json/version'); } catch {} }
    throw new Error('edge did not start');
}

await ensureBrowser();
const page = await cdp(`/json/new?${URL_APP}`, 'PUT');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));

let id = 0;
const waits = new Map();
let errors = [];
ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waits.has(m.id)) { waits.get(m.id)(m); waits.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        errors.push(`${d.exception?.description || d.text}`.slice(0, 300));
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        errors.push(`console.error: ${m.params.args.map((a) => a.value ?? a.description ?? '').join(' ')}`.slice(0, 300));
    }
});
const send = (method, params = {}) => new Promise((r) => { const i = ++id; waits.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (body) => {
    const res = await send('Runtime.evaluate', { expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true });
    if (res.result?.exceptionDetails) throw new Error(res.result.exceptionDetails.exception?.description || 'evaluate failed');
    return res.result?.result?.value;
};
const takeErrors = () => { const got = errors; errors = []; return got; };

await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');
await send('Page.reload', { ignoreCache: true });
await sleep(4000);

// снимок: видимые контролы получают data-jev-i, чтобы таргет брался из узла,
// а не из перепридуманного селектора — модель не выдаёт селекторы вовсе
const SNAPSHOT = `
    if (!document.body) return { pending: true };
    const els = [...document.querySelectorAll('a,button,input:not([type=hidden]),select,textarea,[role=button],[data-page]')];
    const out = [];
    for (const el of els) {
        if (el.offsetParent === null && !el.getClientRects().length) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width < 4 || rect.height < 4) continue;
        const label = (el.innerText || el.value || el.title || el.placeholder || el.getAttribute('aria-label') || el.name || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
        if (!label && !el.matches('input,select,textarea')) continue;
        el.dataset.jevI = String(out.length);
        out.push({ i: out.length, tag: el.tagName.toLowerCase(), label, value: (el.value || '').slice(0, 60), type: el.type || '' });
        if (out.length >= 60) break;
    }
    return { title: document.title, url: location.href, controls: out, hidden: getComputedStyle(document.body).visibility === 'hidden', text: (document.body.innerText || document.body.textContent || '').replace(/\\s+/g, ' ').slice(0, 2000) };`;

const OPS = ['CLICK', 'TYPE_TEXT', 'SELECT', 'SCROLL_UP', 'SCROLL_DOWN', 'DONE', 'BLOCKED'];
const RECENT = [];
const actions = [];
const consoleErrors = [];
let done = null;
// страница может ещё грузиться (тело не появилось) — это не ход, поэтому ждём
// и не тратим на ожидание лимит ходов
let waited = 0;
let blockedCount = 0;

// Перед первым решением ждём, пока страница перестанет меняться: пульт дорисовывает
// верхнюю панель после первого кадра, и на раннем снимке нужной кнопки ещё нет —
// модель честно отвечает BLOCKED. Без этого ожидания прогон падал в BLOCKED на
// первом же ходу (проверено: 14 контролов вместо 23, blocked 0.95)
async function waitStable() {
    let prev = null;
    for (let i = 0; i < 24; i++) {
        const snap = await evaluate(SNAPSHOT);
        if (!snap || snap.pending) { await sleep(400); continue; }
        const mark = `${snap.controls.length}:${snap.text.length}`;
        if (mark === prev) return snap;
        prev = mark;
        await sleep(400);
    }
    return null;
}
const stable = await waitStable();
if (!stable) process.stderr.write('[wait] страница не устоялась, начинаем как есть\n');

for (let tick = 0; tick < MAX_TICKS && !done; tick++) {
    process.stderr.write(`[tick ${tick}] снимок…\n`);
    const snap = await evaluate(SNAPSHOT);
    if (snap?.pending) {
        if (++waited > 40) { done = { status: 'blocked', why: 'page_not_ready' }; break; }
        process.stderr.write('[tick] страница ещё грузится, ждём…\n');
        await sleep(500);
        continue;
    }
    if (!snap || !snap.controls.length) { done = { status: 'blocked', why: 'no_controls' }; break; }
    const criteriaFor = (c) => ({ what: `#${c.i} <${c.tag}${c.type ? ` type=${c.type}` : ''}>${c.label ? ` "${c.label}"` : ''}${c.value ? ` = "${c.value}"` : ''}` });
    const questions = {
        operation: {
            type: 'choice',
            instructions: {
                question: 'Which single operation best advances `goal` from the current page? Choose DONE only when the text from `expect` is already visible on the page, BLOCKED when the goal cannot be reached here.',
                focus: 'Only operations that fit the visible `controls` are useful.',
            },
            criteria: Object.fromEntries(OPS.map((op) => [op.toLowerCase(), { what: op }])),
        },
        target: {
            type: 'choice',
            instructions: {
                question: 'Which control should the operation act on? Choose `none` when the operation is scroll, DONE or BLOCKED.',
                focus: 'Pick the control from `controls` that matches the page region most relevant to `goal`.',
            },
            criteria: Object.fromEntries(snap.controls.map((c) => [`e${c.i}`, criteriaFor(c)]).concat([['none', { what: 'none' }]])),
        },
    };
    const res = await typesafe.systemOne({ goal: GOAL, expect: EXPECT || '', page: { title: snap.title, url: snap.url.replace(URL_APP, '/'), text: snap.text }, controls: snap.controls, recent: RECENT.slice(-8) }, questions);
    process.stderr.write(`[tick ${tick}] контролов: ${snap.controls.length}, решение: ${res ? 'есть' : 'НЕТ'}\n`);
    // JEV_DEBUG=1 показывает снимок и вероятности целиком — когда решает не то,
    // смотреть тут, а не угадывать
    if (process.env.JEV_DEBUG) {
        process.stderr.write(`[tick ${tick}] страница: ${snap.title} ${snap.url.replace(URL_APP, '/')} | текст ${snap.text.length} симв.\n`);
        for (const c of snap.controls) process.stderr.write(`        #${c.i} <${c.tag}> ${c.label}\n`);
        process.stderr.write(`[tick ${tick}] вероятности: ${JSON.stringify(res?.answers?.operation?.probabilities)}\n`);
    }
    const op = typesafe.choice(res?.answers, 'operation')?.value?.toUpperCase();
    const tgt = typesafe.choice(res?.answers, 'target')?.value;
    if (!op) { RECENT.push('model: no answer'); continue; }
    const target = tgt && tgt.startsWith('e') ? snap.controls.find((c) => `e${c.i}` === tgt) : null;
    const needsTarget = op === 'CLICK' || op === 'TYPE_TEXT' || op === 'SELECT';
    if (needsTarget && !target) { RECENT.push(`${op}: no valid target`); actions.push({ tick, op, invalid: true }); continue; }

    // опасные клики не выполняем, даже если их выбрала модель (jev-browser-use)
    if (op === 'CLICK' && REFUSED.test(target.label)) {
        done = { status: 'blocked', why: `refused click: ${target.label}` };
        actions.push({ tick, op, target: target.label, refused: true });
        break;
    }

    let note = '';
    if (op === 'CLICK') note = await evaluate(`
        const el = document.querySelector('[data-jev-i="${target.i}"]');
        if (!el) return 'gone';
        // сначала в видимую часть, и только потом перекрытие: hit-test точки вне
        // экрана бессмысленен и раньше рубил живые кнопки (проверено на пульте)
        el.scrollIntoView({ block: 'center' });
        const r = el.getBoundingClientRect();
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        if (cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight) return 'off_screen';
        // при скрытом body hit-test бессмысленен: элемент виден проверке, но не
        // виден пользователю. Так прячет пульт, пока не завершился бут, и клики
        // при этом работают — проверять нечего, роняем только настоящее перекрытие
        const top = getComputedStyle(document.body).visibility === 'hidden'
            ? null : document.elementFromPoint(cx, cy);
        if (top && top !== el && !el.contains(top)) return 'covered by ' + top.tagName;
        el.click(); return 'clicked';`);
    else if (op === 'TYPE_TEXT') {
        const hit = TEXTS.find((t) => target.label.toLowerCase().includes(t.label));
        note = hit
            ? await evaluate(`
                const el = document.querySelector('[data-jev-i="${target.i}"]');
                if (!el) return 'gone';
                el.focus(); el.value = ${JSON.stringify(hit.value)};
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true })); return 'typed';`)
            : 'no --text for field "' + target.label + '"';
    } else if (op === 'SELECT') note = await evaluate(`
        const el = document.querySelector('[data-jev-i="${target.i}"]');
        if (!el || el.tagName !== 'SELECT') return 'not a select';
        const other = [...el.options].find((o) => !o.selected);
        if (other) { el.value = other.value; el.dispatchEvent(new Event('change', { bubbles: true })); } return 'selected';`);
    else if (op === 'SCROLL_DOWN') note = await evaluate(`window.scrollBy(0, 600); return 'scrolled';`);
    else if (op === 'SCROLL_UP') note = await evaluate(`window.scrollBy(0, -600); return 'scrolled';`);
    else if (op === 'DONE') {
        const ok = EXPECT
            ? await evaluate(`return (document.title + location.href + (document.body.innerText || document.body.textContent || '')).toLowerCase().includes(${JSON.stringify(EXPECT.toLowerCase())});`)
            : actions.some((a) => !a.invalid && !a.refused);
        done = { status: ok ? 'done' : 'not_verified' };
    } else if (op === 'BLOCKED') {
        // BLOCKED — не приговор сразу: страница могла ещё дорисовываться (операция
        // WAIT у jev-ultrafast). Три попытки с паузой, и только потом считаем,
        // что цели здесь нет вовсе
        if (++blockedCount <= 3) {
            RECENT.push(`BLOCKED (не сдаёмся, ждём ${blockedCount}/3)`);
            await sleep(1500);
            continue;
        }
        done = { status: 'blocked', why: 'model said BLOCKED' };
    }

    const line = `${op}${target ? ` #${target.i} "${target.label}"` : ''} → ${note || (done?.status ?? 'ok')}`;
    RECENT.push(line);
    actions.push({ tick, op, target: target?.label, note: note || '' });
    const errs = takeErrors();
    if (errs.length) { consoleErrors.push(...errs); console.error(`[tick ${tick}] ${errs.join(' | ')}`); }
    if (!done) await sleep(1200);
}
if (!done) done = { status: 'max_ticks' };

const verify = EXPECT
    ? await evaluate(`return (document.title + location.href + (document.body.innerText || document.body.textContent || '')).toLowerCase().includes(${JSON.stringify(EXPECT.toLowerCase())});`).catch(() => false)
    : true;
await fetch(`http://127.0.0.1:${PORT}/json/close/${page.id}`).catch(() => {});
ws.close();

console.log(`\nЦель: ${GOAL}`);
console.log(`Адрес: ${URL_APP}`);
for (const a of actions) console.log(`  [${a.tick}] ${a.op}${a.target ? ` # "${a.target}"` : ''}${a.note ? ` — ${a.note}` : ''}${a.refused ? ' (отказ)' : ''}`);
console.log(`Итог: ${done.status}${done.why ? ` (${done.why})` : ''}${EXPECT ? `, --expect «${EXPECT}» ${verify ? 'найден' : 'НЕ найден'}` : ''}`);
for (const err of consoleErrors) console.log(`        ${err}`);

// ошибки консоли — код 1 (как в ui-walk), неподтверждённая цель — 4: она важнее,
// прогон не прошёл даже при чистой консоли
let code = consoleErrors.length ? 1 : 0;
if (done.status !== 'done' || (EXPECT && !verify)) code = 4;
process.exit(code);
