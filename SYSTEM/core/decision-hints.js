// Подбор записки DOCS/decisions к новому запросу: какая записка объясняет,
// почему в проекте сделано так, и потому обязана попасть агенту в контекст
// ещё до того, как он начнёт. Вынесено из turn-judgment.js, когда тот перерос
// норму в 400 строк (DOCS/decisions/022); turn-judgment.js по-прежнему отдаёт
// pickDecisionHints и hintPreamble наружу, так что вызывающим ничего менять не нужно.
//
// Возвращает null, когда ключа нет или сервис не ответил: подсказка —
// необязательная добавка, ход без неё работает ровно как раньше.

const fs = require('fs');
const path = require('path');
const typesafe = require('./typesafe.js');

const ROOT = path.join(__dirname, '..', '..');
const DECISIONS_DIR = path.join(ROOT, 'DOCS', 'decisions');

// записку дописываем в контекст, когда «читать надо» вероятнее, чем «не
// надо». Планка ровно половина, и это не лень: цена ошибки несимметрична —
// лишняя подсказка стоит двух строк в запросе, а пропущенная записка стоит
// работы, сделанной против решения проекта, и последующей переделки.
// Мерено на наших же запросах: при 0.7 отсекались верные попадания (022 на
// «разбей файл на модули» давала 0.56 при тощем описании записки)
const DECISION_HINT = 0.5;

// сколько символов запроса отдаём на суждение (то же число, что PROMPT_LIMIT
// в turn-judgment.js)
const REQUEST_LIMIT = 2000;
// у jev-1.13 на запрос 64 тысячи токенов, и на state вместе с самым длинным
// вопросом — 32 тысячи (страница Models). Описания записок едут именно в
// вопросе и растут вместе с папкой: полсотни записок это около тысячи токенов,
// но папка пополняется каждую неделю, и молча упереться в предел нельзя.
// Считаем грубо — три знака на токен, — и режем список, оставляя свежие:
// в них решения, которые ещё действуют
const CRITERIA_BUDGET_CHARS = 60000;

// ---------- подбор записки DOCS/decisions ----------

// заголовок и первый абзац каждой записки: из них получаются criteria выбора.
// Читаем один раз и перечитываем, когда папка изменилась, — записок полсотни,
// и гонять диск на каждом ходе незачем
// Заголовок раздела с самим решением. Раньше подбор брал первый «## » в записке
// как есть — и у части записок он назывался «Проблема» или «Что было», так что
// модели уходило описание проблемы, а решение оставалось за кадром: у 039 на
// решение шло 5 абзацев, у 079 — десять, и таких записок 18 из 66. Подсказка
// нужна ради правила, поэтому ищем раздел с решением, а он есть не у всех.
//
// Границы слова тут не пишем: в JavaScript \w — это только латиница, поэтому
// \b после кириллицы не срабатывает и условие молча не проходит никогда
const DECISION_HEADING = /^##\s*(решение|что решили|что выбрали|приняли|правило)/i;

// сколько абзацев решения уходит в описание. Число прежнее, но теперь это
// действительно абзацы: текст записок обёрнут по ширине, и «три строки» —
// меньше одного абзаца, то есть обещание не выдерживалось
const PARAGRAPHS = 3;

// Абзацы от заданной строки: блоки между пустыми строками, длиной больше 40
// символов и без заголовков. Раньше фильтр брал строки по одной, и таблица
// попадала в описание тремя обрезанными строками — половина таблицы читалась
// как правило
function readParagraphs(lines, from) {
    const blocks = [];
    let current = [];
    const flush = () => {
        const text = current.join(' ').replace(/\s+/g, ' ').trim();
        if (text.length > 40 && !text.startsWith('#')) blocks.push(text);
        current = [];
    };
    for (const line of lines.slice(from + 1)) {
        if (line.trim()) current.push(line.trim());
        else flush();
    }
    flush();
    return blocks;
}

let decisionsCache = { key: '', items: [] };

function readDecisions() {
    let files;
    try {
        files = fs.readdirSync(DECISIONS_DIR).filter((name) => /^\d+-.*\.md$/.test(name)).sort();
    } catch {
        return [];
    }
    const key = files.join('|');
    if (key === decisionsCache.key) return decisionsCache.items;

    const items = [];
    for (const name of files) {
        let text;
        try {
            text = fs.readFileSync(path.join(DECISIONS_DIR, name), 'utf8');
        } catch {
            continue;
        }
        const lines = text.split(/\r?\n/);
        const title = (lines.find((line) => line.startsWith('# ')) || name).replace(/^#\s*/, '').trim();
        // Сначала ищем раздел с решением, и только если его нет — первый заголовок
        // (from === -1 при отсутствии заголовков даёт lines.slice(0), то есть всю
        // записку: прежнее поведение для заметок без «## »)
        const decisionAt = lines.findIndex((line) => DECISION_HEADING.test(line));
        const from = decisionAt !== -1
            ? decisionAt
            : lines.findIndex((line) => line.startsWith('## '));
        const body = readParagraphs(lines, from).slice(0, PARAGRAPHS).join(' ');
        items.push({
            id: name.replace(/\.md$/, ''),
            file: `DOCS/decisions/${name}`,
            title,
            // короткая строка идёт в criteria первой ступени (полсотни записок
            // в одном запросе), длинная — во вторую, где кандидатов единицы
            summary: body.trim().replace(/[`*]/g, '').slice(0, 240),
            detail: body.trim().replace(/[`*]/g, '').slice(0, 700),
        });
    }
    decisionsCache = { key, items };
    return items;
}

// Choice берёт до 255 вариантов, но раньше упрётся предел контекста, и доке
// важнее другое: большой state и большой вопрос, набитые не относящимся к
// делу, роняют точность («Large state full of irrelevant detail»). Поэтому
// список записок режется сверху, а не отдаётся целиком, сколько бы их ни было
function fitToBudget(items) {
    const fitted = [];
    let size = 0;
    for (const item of [...items].reverse()) { // с самых свежих
        size += item.title.length + item.summary.length;
        if (size > CRITERIA_BUDGET_CHARS || fitted.length >= 254) break;
        fitted.push(item);
    }
    return fitted.reverse();
}

// Вариант «ничего не подходит» обязателен: доке важно, чтобы у модели был
// выход, иначе она выберет ближайшее и выдаст ложную подсказку
const NO_MATCH = 'none';
// сколько записок Choice передаёт на вторую ступень и сколько попадёт агенту
const SHORTLIST = 4;
const MAX_HINTS = 2;

// Подбор идёт в два захода — так советует cookbook «hierarchical classification»,
// и на нашем материале это видно: к запросу «завести новую пометку в ленте»
// одинаково относятся сразу несколько записок, и один Choice размазывает
// вероятность между ними, не дотягивая до порога ни одной. Поэтому Choice
// только сужает полсотни записок до нескольких, а решает по каждой отдельный
// Noul — они независимы, считаются в одном запросе параллельно и не мешают
// друг другу, как мешали бы варианты одного выбора.
//
// gateHint — минимальная уверенность первого выбора, ниже которой подсказки не
// берём вовсе. Приходит снаружи: judgment-config.js сам требует этот файл, и
// собственный импорт порогов здесь замкнул бы цикл (DOCS/decisions/089).
async function pickDecisionHints(request, gateHint) {
    if (!typesafe.isEnabled()) return null;
    const text = String(request || '').trim();
    if (text.length < 20) return null; // «привет» и «продолжай» подсказки не требуют

    const items = fitToBudget(readDecisions());
    if (!items.length) return null;
    const state = { request: text.slice(0, REQUEST_LIMIT) };

    // ступень 1: сужаем список
    // ключи строго из документированного набора Choice — what / not_for /
    // examples («Advanced: structure»). Свой ключ рядом с ними модель читает
    // как попало, а заголовок и первый абзац записки — это одно описание,
    // поэтому они и идут одним what
    const criteria = { [NO_MATCH]: { what: 'No note here explains this request; the code is enough.' } };
    for (const item of items) criteria[item.id] = { what: `${item.title}. ${item.summary}` };

    const first = await typesafe.systemOne(state, {
        decision_note: {
            type: 'choice',
            instructions: {
                question: 'Which project decision note is most relevant to `request`?',
                focus: 'These notes record why the project is built the way it is.',
            },
            criteria,
        },
    });
    const probabilities = first?.answers?.decision_note?.probabilities;
    if (!probabilities) return null;

    const shortlist = Object.entries(probabilities)
        .filter(([id, p]) => id !== NO_MATCH && p > 0)
        .sort((a, b) => b[1] - a[1])
        .slice(0, SHORTLIST)
        .map(([id]) => items.find((one) => one.id === id))
        .filter(Boolean);
    // «ничего не подходит» увереннее любого кандидата — второй заход не нужен
    if (!shortlist.length || (probabilities[NO_MATCH] ?? 0) >= shortlist.reduce((max, one) => Math.max(max, probabilities[one.id]), 0)) {
        return null;
    }

    // ступень 2: по вопросу на каждого кандидата, все в одном запросе
    const questions = {};
    const notes = {};
    for (const item of shortlist) {
        notes[item.id] = { title: item.title, summary: item.detail };
        questions[item.id] = {
            type: 'noul',
            instructions: `Must the note \`notes.${item.id}\` be read before doing \`request\`?`,
            criteria: {
                true: { what: 'Doing the request without this note would produce work that contradicts it.' },
                false: {
                    what: 'The note is on a neighbouring topic, or the request does not touch what it decides.',
                    not_for: 'A note that genuinely constrains the request.',
                },
            },
        };
    }

    const second = await typesafe.systemOne({ ...state, notes }, questions);
    if (!second?.answers) return null;

    // отсекаем ещё и по уверенности первого запроса: noul-вопрос отвечает «обязана
    // ли записка», и на запросе вроде «удалить карточку провайдера» он уверенно
    // отвечает «да» сразу трём запискам про место. Уверенность Choice говорит, насколько
    // выбор вообще однозначен, и шум отсекает (замер в DOCS/decisions/089).
    // Порог приходит параметром, а не из judgment-config.js: тот сам требует этот
    // файл, и импорт отсюда замкнул бы цикл (см. комментарий в judgment-config)
    const gate = Number(gateHint) > 0 ? Number(gateHint) : 0;
    const confidence = first.answers.decision_note?.confidence ?? 1;
    const picked = confidence >= gate
        ? shortlist
            .map((item) => ({ ...item, noul: typesafe.noul(second.answers, item.id) ?? 0, confidence }))
            .filter((item) => item.noul >= DECISION_HINT)
            .sort((a, b) => b.noul - a.noul)
            .slice(0, MAX_HINTS)
        : [];
    // что получилось — возвращаем как раньше (файл и заголовок), но с оценками
    // рядом: их кладёт вызывающий в result_meta хода, чтобы пороги можно было
    // перемерить на живых данных, а не по памяти (DOCS/decisions/089)
    return picked.length ? picked : null;
}

// Разбор подбора по ступеням — для замера, а не для поведения: показывает, на
// какой ступени запрос потерялся. Документация TypeSafe прямо советует смотреть
// именно на это («identify which nodes your misclassifications occur most in»),
// а без разбора молчание записок неотличимо от «подсказки не нужны».
// Поведения не меняет: та же логика и тот же порядок отсечек.
async function traceDecisionHints(request, gateHint) {
    if (!typesafe.isEnabled()) return null;
    const text = String(request || '').trim();
    if (text.length < 20) return { reason: 'слишком короткий запрос', none: null, top: [], stage2: [] };
    const items = fitToBudget(readDecisions());
    if (!items.length) return { reason: 'нет записок', none: null, top: [], stage2: [] };

    const criteria = { [NO_MATCH]: { what: 'No note here explains this request; the code is enough.' } };
    for (const item of items) criteria[item.id] = { what: `${item.title}. ${item.summary}` };
    const first = await typesafe.systemOne({ request: text.slice(0, REQUEST_LIMIT) }, {
        decision_note: {
            type: 'choice',
            instructions: {
                question: 'Which project decision note is most relevant to `request`?',
                focus: 'These notes record why the project is built the way it is.',
            },
            criteria,
        },
    });
    const probabilities = first?.answers?.decision_note?.probabilities;
    if (!probabilities) return { reason: 'нет ответа', none: null, top: [], stage2: [] };

    const confidence = first.answers.decision_note?.confidence ?? 1;
    const top = Object.entries(probabilities)
        .filter(([id]) => id !== NO_MATCH)
        .sort((a, b) => b[1] - a[1])
        .slice(0, SHORTLIST)
        .map(([id, p]) => ({ id, p, title: items.find((one) => one.id === id)?.title || id }));
    const none = probabilities[NO_MATCH] ?? 0;
    const shortlist = top
        .filter((one) => one.p > 0)
        .map((one) => items.find((i) => i.id === one.id))
        .filter(Boolean);

    let stage2 = [];
    if (!shortlist.length || none >= shortlist.reduce((max, one) => Math.max(max, probabilities[one.id]), 0)) {
        return { reason: shortlist.length ? '«ничего не подходит» увереннее кандидатов' : 'кандидатов нет вовсе', none, confidence, top, stage2 };
    }

    const notes = {};
    const questions = {};
    for (const item of shortlist) {
        notes[item.id] = { title: item.title, summary: item.detail };
        questions[item.id] = {
            type: 'noul',
            instructions: `Must the note \`notes.${item.id}\` be read before doing \`request\`?`,
            criteria: {
                true: { what: 'Doing the request without this note would produce work that contradicts it.' },
                false: {
                    what: 'The note is on a neighbouring topic, or the request does not touch what it decides.',
                    not_for: 'A note that genuinely constrains the request.',
                },
            },
        };
    }
    const second = await typesafe.systemOne({ request: text.slice(0, REQUEST_LIMIT), notes }, questions);
    stage2 = shortlist.map((item) => ({
        id: item.id,
        title: item.title,
        noul: typesafe.noul(second?.answers, item.id),
    }));
    // вердикт считается по тем же правилам, что и в самом подборе: иначе разбор
    // врал бы и на запросах, где записка была подобрана (замер 2026-10-04)
    const gate = Number(gateHint) > 0 ? Number(gateHint) : 0.6;
    const passed = stage2.filter((one) => (one.noul ?? 0) >= DECISION_HINT);
    const best = stage2.reduce((max, one) => Math.max(max, one.noul ?? 0), 0);
    let reason;
    if (passed.length && confidence >= gate) reason = `подобрано ${passed.length}`;
    else if (confidence < gate) reason = `уверенность первого выбора ${confidence.toFixed(2)} ниже гарда ${gate}`;
    else reason = `второй запрос не дал оценки ≥ ${DECISION_HINT} (лучшая ${best.toFixed(2)})`;
    return { reason, none, confidence, top, stage2 };
}

// то, что дописывается к запросу агента. Отдельной функцией, чтобы текст
// подсказки был виден в одном месте, а не собирался по кускам в server.js
function hintPreamble(hints) {
    if (!hints || !hints.length) return '';
    const list = hints.map((hint) => `${hint.file} — «${hint.title}»`).join('; ');
    return `[OpenKarandash] Перед этой работой прочитай: ${list}. `
        + 'Записки объясняют, почему в проекте сделано так; идти против них нельзя, не переписав саму записку.\n\n';
}

// что из подбора пишется в result_meta хода: заголовок, оценка и уверенность.
// Заголовок, а не путь к файлу: путь и так есть в самой подсказке, а читать
// через год будут именно заголовки — что подсовывалось и с какой оценкой
const HINT_FIELDS = ['title', 'noul', 'confidence'];

module.exports = { pickDecisionHints, hintPreamble, traceDecisionHints, DECISION_HINT, HINT_FIELDS };
