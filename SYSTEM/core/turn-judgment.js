// Вопросы к TypeSafe и пороги — одним местом (совет самой документации:
// константы вопросов и порогов держать там, где их можно прочитать и
// подправить, не разбираясь в коде вокруг). Транспорт — SYSTEM/core/typesafe.js,
// зачем это всё — DOCS/decisions/051.
//
// Два разных суждения:
//   judgeTurn()         — о законченном ходе: это итоговый отчёт или середина
//                         работы, ждут ли человека, какого рода работа, насколько
//                         нужно вмешательство. Пишется в result_meta хода и по
//                         нему же решается, уходить ли письму в Telegram.
//   pickDecisionHints() — о новом запросе: какая записка DOCS/decisions объясняет,
//                         почему в проекте сделано так, и потому обязана попасть
//                         агенту в контекст ещё до того, как он начнёт.
//
// Обе возвращают null, когда ключа нет или сервис не ответил: суждение —
// необязательная добавка, ход без него работает ровно как раньше.

const fs = require('fs');
const path = require('path');
const typesafe = require('./typesafe.js');

const ROOT = path.join(__dirname, '..', '..');
const DECISIONS_DIR = path.join(ROOT, 'DOCS', 'decisions');

// ---------- пороги ----------
//
// Все три оценены на нашем же материале и подвинуть их можно прямо здесь.
// Смысл каждого — в комментарии рядом, а не в голове у того, кто их ставил.
const THRESHOLDS = {
    // ход считаем законченным отчётом с этой вероятности и выше. Планка выше
    // половины: промолчать о середине работы дешевле, чем засыпать владельца
    finalReport: 0.6,
    // ход встал и ждёт человека — письмо нужно даже если это не отчёт: по этому
    // же письму человек отвечает обратно в сессию через телеграм-мост
    awaitsHuman: 0.5,
    // записку дописываем в контекст, когда «читать надо» вероятнее, чем «не
    // надо». Планка ровно половина, и это не лень: цена ошибки несимметрична —
    // лишняя подсказка стоит двух строк в запросе, а пропущенная записка стоит
    // работы, сделанной против решения проекта, и последующей переделки.
    // Мерено на наших же запросах: при 0.7 отсекались верные попадания (022 на
    // «разбей файл на модули» давала 0.56 при тощем описании записки)
    decisionHint: 0.5,
};

// сколько символов текста хода отдаём на суждение: доке важен не объём, а то,
// чтобы в state попало только относящееся к вопросу
const TEXT_LIMIT = 4000;
const PROMPT_LIMIT = 2000;

// ---------- суждение о законченном ходе ----------

const TURN_QUESTIONS = {
    // отдельный узкий вопрос, а не «оцени ход целиком»: широкий вопрос спрятал бы
    // несколько суждений за одним числом (антипаттерн из «how to build»)
    final_report: {
        type: 'noul',
        instructions: {
            question: 'Is `turn.answer` a finished report that closes the task in `turn.request`?',
            focus: 'Judge the reply itself, not whether the work was good.',
        },
        criteria: {
            true: {
                what: 'The reply states the task is done and summarises the outcome.',
                examples: [
                    'Готово: правка внесена, проверка пройдена, вот что изменилось.',
                    'Задача закрыта, осталось только принять решение по следующему шагу.',
                ],
            },
            false: {
                what: 'The reply is a step along the way: a plan, a progress note, a question, an intermediate finding.',
                not_for: 'A finished report that happens to be short.',
                examples: [
                    'Сейчас посмотрю файлы и вернусь.',
                    'Нашёл причину, приступаю к правке.',
                ],
            },
        },
    },
    awaits_human: {
        type: 'noul',
        instructions: 'Does `turn.answer` stop and wait for a decision, an answer or an approval from the person?',
        criteria: {
            true: { what: 'It asks a question or offers options and cannot continue without a reply.' },
            false: { what: 'It reports or continues on its own; nothing is being asked of the person.' },
        },
    },
    work_kind: {
        type: 'choice',
        instructions: 'What kind of work does `turn.answer` describe?',
        criteria: {
            code: { what: 'Source files were written or changed.' },
            docs: { what: 'Documentation, notes or descriptions were written or changed.', not_for: 'Source files.' },
            analysis: { what: 'Reading, searching, diagnosis or review with no change made.' },
            conversation: { what: 'An answer to a question, an explanation or a discussion.' },
            failure: { what: 'The turn ended in an error or was interrupted before doing the work.' },
        },
    },
    needs_attention: {
        type: 'score',
        instructions: 'How much does this turn need the person to step in?',
        criteria: [
            { what: 'Nothing to do — the turn did what was asked and said so.' },
            { what: 'Worth a glance — something was assumed, skipped or left unverified.' },
            { what: 'Must be looked at — the turn failed, got blocked, or asks for a decision.' },
        ],
    },
};

// ход уже записан в базу и отдан в ленту, когда нас зовут, поэтому лишние
// ~200 мс здесь никого не задерживают
async function judgeTurn({ request, answer, errorText, stopReason }) {
    if (!typesafe.isEnabled()) return null;
    const text = String(answer || errorText || '').trim();
    if (!text) return null;

    const state = {
        turn: {
            request: String(request || '').slice(0, PROMPT_LIMIT),
            answer: text.slice(0, TEXT_LIMIT),
            // отдельным полем, а не намёком в тексте: обрыв и ошибка видны коду
            // точно, и гадать про них модели незачем
            ended_with_error: Boolean(errorText),
            stop_reason: stopReason || null,
        },
    };

    const res = await typesafe.systemOne(state, TURN_QUESTIONS);
    if (!res || !res.answers) return null;

    const finalReport = typesafe.noul(res.answers, 'final_report');
    const awaitsHuman = typesafe.noul(res.answers, 'awaits_human');
    const workKind = typesafe.choice(res.answers, 'work_kind');
    const attention = typesafe.score(res.answers, 'needs_attention');

    return {
        model: res.model || typesafe.MODEL,
        finalReport,
        awaitsHuman,
        workKind: workKind?.value || null,
        workKindConfidence: workKind?.confidence ?? null,
        needsAttention: attention?.value ?? null,
        needsAttentionConfidence: attention?.confidence ?? null,
        usage: res.usage || null,
    };
}

// Решение о письме — детерминированное правило поверх чисел, а не ещё один
// вопрос модели: политика должна быть видна в коде и меняться без запроса.
// Ошибка хода уходит всегда: для сессии это конец, и знать о нём человек обязан
function shouldNotify(judgment, { errorText }) {
    if (errorText) return { send: true, reason: 'error' };
    if (!judgment) return { send: true, reason: 'no-judgment' };
    if ((judgment.awaitsHuman ?? 0) >= THRESHOLDS.awaitsHuman) return { send: true, reason: 'awaits-human' };
    if ((judgment.finalReport ?? 0) >= THRESHOLDS.finalReport) return { send: true, reason: 'final-report' };
    return { send: false, reason: 'intermediate' };
}

// ---------- подбор записки DOCS/decisions ----------

// заголовок и первый абзац каждой записки: из них получаются criteria выбора.
// Читаем один раз и перечитываем, когда папка изменилась, — записок полсотни,
// и гонять диск на каждом ходе незачем
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
        // первые абзацы после заголовка «## Решение» — в них суть записки.
        // Одного абзаца не хватало: по нему вторая ступень не могла отличить
        // «записка про эту работу» от «записка про соседнюю тему» и отвечала
        // около половины, то есть ничего
        const start = lines.findIndex((line) => line.startsWith('## '));
        const body = lines.slice(start + 1)
            .filter((line) => line.trim().length > 40 && !line.startsWith('#'))
            .slice(0, 3)
            .join(' ');
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
async function pickDecisionHints(request) {
    if (!typesafe.isEnabled()) return null;
    const text = String(request || '').trim();
    if (text.length < 20) return null; // «привет» и «продолжай» подсказки не требуют

    const items = readDecisions();
    if (!items.length) return null;
    const state = { request: text.slice(0, PROMPT_LIMIT) };

    // ступень 1: сужаем список
    const criteria = { [NO_MATCH]: { what: 'No note here explains this request; the code is enough.' } };
    for (const item of items) criteria[item.id] = { what: item.title, context: item.summary };

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

    const picked = shortlist
        .map((item) => ({ ...item, noul: typesafe.noul(second.answers, item.id) ?? 0 }))
        .filter((item) => item.noul >= THRESHOLDS.decisionHint)
        .sort((a, b) => b.noul - a.noul)
        .slice(0, MAX_HINTS);
    return picked.length ? picked : null;
}

// то, что дописывается к запросу агента. Отдельной функцией, чтобы текст
// подсказки был виден в одном месте, а не собирался по кускам в server.js
function hintPreamble(hints) {
    if (!hints || !hints.length) return '';
    const list = hints.map((hint) => `${hint.file} — «${hint.title}»`).join('; ');
    return `[OpenKarandash] Перед этой работой прочитай: ${list}. `
        + 'Записки объясняют, почему в проекте сделано так; идти против них нельзя, не переписав саму записку.\n\n';
}

module.exports = { judgeTurn, shouldNotify, pickDecisionHints, hintPreamble, THRESHOLDS, TURN_QUESTIONS };
