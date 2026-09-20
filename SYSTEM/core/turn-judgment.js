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
    // работа сделана, хоть и не оформлена отчётом. Планка высокая: этот вопрос
    // ловит остаток после двух предыдущих, и ошибиться в сторону «отправить»
    // здесь значит вернуть ровно тот поток реплик, от которого уходили
    workDone: 0.8,
    // записку дописываем в контекст, когда «читать надо» вероятнее, чем «не
    // надо». Планка ровно половина, и это не лень: цена ошибки несимметрична —
    // лишняя подсказка стоит двух строк в запросе, а пропущенная записка стоит
    // работы, сделанной против решения проекта, и последующей переделки.
    // Мерено на наших же запросах: при 0.7 отсекались верные попадания (022 на
    // «разбей файл на модули» давала 0.56 при тощем описании записки)
    decisionHint: 0.5,
    // что человек прислал в Telegram. Высоко, потому что ошибка дорога в обе
    // стороны: принять поручение за болтовню значит его не выполнить, а
    // «стоп» внутри задания принять за команду — оборвать чужую работу.
    // Не дотянули — считаем поручением, то есть как мост вёл себя всегда
    inboxIntent: 0.8,
};

// сколько символов текста хода отдаём на суждение: доке важен не объём, а то,
// чтобы в state попало только относящееся к вопросу
const TEXT_LIMIT = 4000;
const PROMPT_LIMIT = 2000;
// у jev-1.13 на запрос 64 тысячи токенов, и на state вместе с самым длинным
// вопросом — 32 тысячи (страница Models). Описания записок едут именно в
// вопросе и растут вместе с папкой: полсотни записок это около тысячи токенов,
// но папка пополняется каждую неделю, и молча упереться в предел нельзя.
// Считаем грубо — три знака на токен, — и режем список, оставляя свежие:
// в них решения, которые ещё действуют
const CRITERIA_BUDGET_CHARS = 60000;

// ---------- суждение о законченном ходе ----------

const TURN_QUESTIONS = {
    // отдельный узкий вопрос, а не «оцени ход целиком»: широкий вопрос спрятал бы
    // несколько суждений за одним числом (антипаттерн из «how to build»)
    // вопрос написан ровно про то, что нужно правилу отправки: закрыт ли
    // запрос этой репликой. Первая редакция спрашивала про «законченный
    // отчёт о работе», и модель честно, буквально отвечала «нет» на полный
    // ответ на вопрос в Chat — работы-то не было. Буквальность модели доку
    // называет первой её слабостью: условие пишут целиком, а не намёком
    final_report: {
        type: 'noul',
        instructions: {
            question: 'Does `turn.answer` deliver everything `turn.request` asked for, so that nothing is left for the assistant to continue?',
            focus: 'A request can ask for work to be done or for a question to be answered; both count.',
        },
        criteria: {
            true: {
                what: 'The reply delivers the asked-for result in full: the work is reported as done, or the question is answered.',
                examples: [
                    'Готово: правка внесена, проверка пройдена, вот что изменилось.',
                    'Потому что сторож остаётся жить после завершения сессии и держит папку проекта.',
                ],
            },
            false: {
                what: 'The reply is a step along the way: a plan, a progress note, an intermediate finding, or a question back.',
                not_for: 'A complete answer that happens to be short.',
                examples: [
                    'Сейчас посмотрю файлы и вернусь.',
                    'Нашёл причину, приступаю к правке.',
                ],
            },
        },
    },
    // отдельный вопрос, а не оттенок предыдущего: «сделал, но живьём не
    // проверил» — это конец работы, который владелец обязан увидеть, а как
    // «законченный отчёт» он читается лишь наполовину (0.33 на нашем замере).
    // Доку такое велит разбирать ещё одним атомарным вопросом и складывать в
    // коде, а не двигать порог у чужого вопроса
    work_done: {
        type: 'noul',
        instructions: 'Does `turn.answer` report work that was actually carried out, rather than work that is planned or still under way?',
        criteria: {
            true: {
                what: 'Something was changed, written, fixed or found out, and the reply says so.',
                examples: ['Правку внёс, но живьём не проверял.', 'Сделал, вот результат.'],
            },
            false: {
                what: 'The reply announces an intention, asks something, or describes work still in progress.',
                examples: ['Сейчас посмотрю и вернусь.', 'Приступаю к правке.'],
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
    // уровни описывают положение дел, а не степень: «умеренно важно» доку
    // прямо называет плохим уровнем. Одна ось на вопрос — здесь это «сколько
    // работы осталось на человеке», и ничего кроме
    needs_attention: {
        type: 'score',
        instructions: {
            question: 'How much of the task in `turn.request` is left for the person to finish or check?',
            focus: 'Judge what `turn.answer` leaves undone, not how well it is written.',
        },
        criteria: [
            {
                what: 'The turn did the whole task and said what it checked. Nothing is left over.',
                examples: ['Правка внесена, проверка пройдена, вот результат.'],
            },
            {
                what: 'The turn did the task but left part of it unchecked, assumed or postponed.',
                examples: ['Сделал, но живьём не проверил.', 'Сделал основное, остальное отложил.'],
            },
            {
                what: 'The task is not done: the turn failed, stopped on an obstacle, or waits for a decision.',
                examples: ['Не получилось, упёрся в ошибку.', 'Нужно решить, каким путём идти.'],
            },
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
    const workDone = typesafe.noul(res.answers, 'work_done');
    const awaitsHuman = typesafe.noul(res.answers, 'awaits_human');
    const workKind = typesafe.choice(res.answers, 'work_kind');
    const attention = typesafe.score(res.answers, 'needs_attention');

    return {
        model: res.model || typesafe.MODEL,
        finalReport,
        workDone,
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
    // работа сделана, но отчётом не оформлена — «правку внёс, проверить не
    // успел». Для сессии это всё равно конец, и знать о нём владелец обязан
    if ((judgment.workDone ?? 0) >= THRESHOLDS.workDone) return { send: true, reason: 'work-done' };
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
async function pickDecisionHints(request) {
    if (!typesafe.isEnabled()) return null;
    const text = String(request || '').trim();
    if (text.length < 20) return null; // «привет» и «продолжай» подсказки не требуют

    const items = fitToBudget(readDecisions());
    if (!items.length) return null;
    const state = { request: text.slice(0, PROMPT_LIMIT) };

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

// ---------- что человек прислал в Telegram ----------

// Мост принимал любое сообщение за поручение и запускал настоящий ход — на
// «стоп», «что там», «спасибо» тоже. Это деньги владельца и занятая очередь.
// Один выбор из четырёх разводит это раз и навсегда (DOCS/decisions/054).
const INBOX_QUESTION = {
    intent: {
        type: 'choice',
        instructions: {
            question: 'What does `message` want from the assistant that is working on this project?',
            focus: 'The person is replying in a messenger to a report about finished work.',
        },
        criteria: {
            task: {
                what: 'Work to do or a question to answer: something the assistant must go and act on.',
                examples: ['Почини ленту во Flow', 'А почему сервер нельзя поднимать из сессии?', 'Продолжай'],
            },
            stop: {
                what: 'A demand to stop what is running right now.',
                not_for: 'Asking to stop doing something in the future, which is work.',
                examples: ['Стоп', 'Отмена', 'Прекрати'],
            },
            status: {
                what: 'A question about what is happening right now, asking for no new work.',
                examples: ['Что там?', 'Идёт ещё?', 'Статус'],
            },
            nothing: {
                what: 'An acknowledgement or a remark that needs no action at all.',
                examples: ['Спасибо', 'Ок', 'Понял', 'Получил'],
            },
        },
    },
};

// Выбор применяем только уверенный: ошибиться здесь значит либо не выполнить
// поручение, либо оборвать чужую работу на слове «стоп» внутри задания.
// Неуверенный ответ трактуем как поручение — прежнее поведение моста
async function classifyInbox(text) {
    if (!typesafe.isEnabled()) return { intent: 'task', confidence: null };
    const message = String(text || '').trim();
    if (!message) return { intent: 'nothing', confidence: null };

    const res = await typesafe.systemOne({ message: message.slice(0, PROMPT_LIMIT) }, INBOX_QUESTION);
    const pick = typesafe.choice(res?.answers, 'intent');
    if (!pick || (pick.confidence ?? 0) < THRESHOLDS.inboxIntent) return { intent: 'task', confidence: pick?.confidence ?? null };
    return { intent: pick.value, confidence: pick.confidence };
}

module.exports = { judgeTurn, shouldNotify, pickDecisionHints, hintPreamble, classifyInbox, THRESHOLDS, TURN_QUESTIONS };
