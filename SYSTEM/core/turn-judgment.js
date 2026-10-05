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

const typesafe = require('./typesafe.js');
const { THRESHOLDS, TEXT_LIMIT, PROMPT_LIMIT } = require('./judgment-config.js');

// остальные суждения живут рядом и отдаются наружу отсюда, как раньше:
//   decision-hints.js    — подбор записок DOCS/decisions к запросу
//   inbox-judgment.js    — сообщение из Telegram и ответ на опрос
//   failure-judgment.js  — причина поломки хода
//   work-judgment.js     — переписка для нового агента, приём для памяти, дифф ветки
const { pickDecisionHints: pickHints, hintPreamble } = require('./decision-hints.js');

// Подбор записок с порогом уверенности из одного места. Порог живёт в
// judgment-config.js, а этот файл decision-hints.js не может импортировать сам:
// тот требует его, и цикл замкнулся бы. Поэтому гард подставляет обёртка —
// вызывающие (/api/agent/ask и телеграм-мост) знают только её (DOCS/decisions/089)
function pickDecisionHints(request) {
    return pickHints(request, THRESHOLDS.hintConfidence);
}
const { classifyInbox, matchPollReply } = require('./inbox-judgment.js');
const { classifyFailure, knownFailure } = require('./failure-judgment.js');
const { pickRelevantTurns, judgeSkill, judgeBranch } = require('./work-judgment.js');


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
    // Судим только язык отчёта: утверждает ли он, что что-то проверено. Сам
    // факт держит код — он знает, сделал ли ход хоть один шаг инструментом.
    // Это приём «verify and escalate» из документации, и делить обязанности
    // так важно: модель плохо считает и плохо сверяет длинные списки, зато
    // хорошо понимает, что написано. А «проверил» без единого шага — это
    // противоречие, которое видно без всякой модели
    claims_verified: {
        type: 'noul',
        instructions: 'Does `turn.answer` state that something was checked, tested, run or verified during this turn?',
        criteria: {
            true: {
                what: 'It reports a check that was carried out: tests run, a page opened, output looked at.',
                examples: ['Проверку прогнал, ошибок нет.', 'Открыл страницу — всё на месте.'],
            },
            false: {
                what: 'It reports no check, or says outright that something was not checked.',
                not_for: 'A claim that a check was done earlier, by someone else, or will be done later.',
                examples: ['Правку внёс, живьём не проверял.', 'Вот как это устроено.'],
            },
        },
    },
    // правило проекта: итоговый ответ — отчёт руководителю, без имён файлов и
    // функций. Модель судит язык, а форму (сколько абзацев, есть ли список)
    // считает код в judgeTurn: считать модель не умеет, а здесь и не надо
    plain_language: {
        type: 'noul',
        instructions: 'Is `turn.answer` written in plain language for a non-programmer, without file names, function names, code identifiers or programmer jargon?',
        criteria: {
            true: {
                what: 'It says in ordinary words what was done and what changes for the person.',
                examples: ['Теперь письмо в Telegram уходит сразу, а не через минуту.', 'Проверил на живом сервере: всё работает, ошибок нет.'],
            },
            false: {
                what: 'It names files, functions, line numbers or uses words like commit, refactoring, endpoint.',
                not_for: 'A short plain answer that merely mentions a product feature by its name.',
                examples: ['Правка в server.js, функция runTurn, строка 1104.', 'Сделал рефакторинг и закоммитил.'],
            },
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

// сколько абзацев в ответе и есть ли в нём список: правило «три абзаца, без
// списков» проверяется кодом, а не моделью
function reportShape(text) {
    const paragraphs = String(text || '').split(/\n\s*\n/).filter((p) => p.trim()).length;
    const bulleted = /^\s*(?:[-*•]|\d+[.)])\s+\S/m.test(String(text || ''));
    return { paragraphs, bulleted };
}

// ход уже записан в базу и отдан в ленту, когда нас зовут, поэтому лишние
// ~200 мс здесь никого не задерживают
async function judgeTurn({ request, answer, errorText, stopReason, toolSteps }) {
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
    const claimsVerified = typesafe.noul(res.answers, 'claims_verified');
    const plainLanguage = typesafe.noul(res.answers, 'plain_language');
    const awaitsHuman = typesafe.noul(res.answers, 'awaits_human');
    const workKind = typesafe.choice(res.answers, 'work_kind');
    const attention = typesafe.score(res.answers, 'needs_attention');

    return {
        model: res.model || typesafe.MODEL,
        finalReport,
        workDone,
        claimsVerified,
        plainLanguage,
        // форма отчёта — факт, а не суждение: считает код. Абзацы — куски текста,
        // разделённые пустой строкой; список — строки, начинающиеся с «-», «*» или «1.»
        reportShape: reportShape(text),
        toolSteps: toolSteps ?? null,
        // жёсткое противоречие, а не оттенок: отчёт говорит «проверено», а ход
        // не сделал ни одного шага инструментом — значит, проверять было нечем.
        // Факт берём у кода, утверждение — у модели, и совпасть они обязаны
        unverifiedClaim: Boolean(
            toolSteps === 0 && (claimsVerified ?? 0) >= THRESHOLDS.claimsVerified,
        ),
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

module.exports = { judgeBranch, judgeSkill, matchPollReply, pickRelevantTurns, classifyFailure, knownFailure, judgeTurn, shouldNotify, pickDecisionHints, hintPreamble, classifyInbox, THRESHOLDS, TURN_QUESTIONS };
