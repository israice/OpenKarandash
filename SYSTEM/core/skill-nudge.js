// Досмотр хода после окончания: закрепился ли в нём проверенный приём,
// который стоит дописать в память работника (DOCS/decisions/035). Это
// серверная половина петли «записал сам» — до неё запись приёма держалась
// только на памяти агента и была ручным шагом: замер 2026-10-23 показал
// 108 ответов за 30 дней и ноль автоматических напоминаний.
//
// Один дешёвый вопрос jev по готовым полям хода — те же state, что и в
// judgeTurn (turn-judgment.js). Ответ не генерирует запись сам: он только
// решает, достойна ли работа напоминания, а формулировку судит judgeSkill
// на входе /api/flow/profile/memory/add — Непроверенное в память не пишут
// и там, и здесь. Сбой суждения — не сбой хода: null, и ход идёт как шёл.
//
// Гейты — до запроса, каждый с фактом от кода: ход дошёл до конца работы
// (суждение judgeTurn), сделал хоть один шаг инструментом, профиль памяти
// известен и ответ непустой.

const typesafe = require('./typesafe.js');
const { THRESHOLDS, PROMPT_LIMIT, TEXT_LIMIT } = require('./judgment-config.js');
const { profileFor, skillsOf } = require('./skill-hints.js');

// ход стоит напоминания, только если он довёл работу до конца: суждение
// judgeTurn уже посчитало обе вероятности, второй раз спрашивать модель
// об этом — платить дважды за один вопрос
function worthReviewing(judgment) {
    if (!judgment) return false;
    return (judgment.finalReport ?? 0) >= THRESHOLDS.finalReport
        || (judgment.workDone ?? 0) >= THRESHOLDS.workDone;
}

// { noul, profile } — в памяти стоит искать запись, либо null
async function reviewTurn({ request, answer, judgment, agent, profile }) {
    if (!typesafe.isEnabled() || !worthReviewing(judgment)) return null;
    const name = profileFor(agent, profile);
    const text = String(answer || '').trim();
    // короткий ответ — это «ok», «сделал»: закрепиться в нём нечему
    if (!name || text.length < 40) return null;

    const state = {
        turn: {
            request: String(request || '').slice(0, PROMPT_LIMIT),
            answer: text.slice(0, TEXT_LIMIT),
        },
        // уже записанные приёмы: без них совет гонит дубли, а дубль судится
        // только позже, на входе /add, — и напоминание пропало бы зря
        already_recorded: skillsOf(name).map((s) => s.title).slice(-20),
    };
    const res = await typesafe.systemOne(state, {
        record_skill: {
            type: 'noul',
            instructions: 'While doing `turn.request`, did the agent arrive at a specific verified technique — a concrete procedure that later tasks in the same situation would repeat — that is worth one new entry in the profile skill memory?',
            criteria: {
                true: {
                    what: 'The turn worked out a concrete repeatable procedure (commands, steps, a pitfall with the fix) and it is not in `already_recorded`.',
                    examples: ['Правку клиентского стиля проверять только после перезагрузки страницы в проверочном браузере'],
                },
                false: {
                    what: 'Routine editing, reading, a report, or a technique covered by the general rules of the project or by `already_recorded`.',
                    not_for: 'A one-off fix that no later task would repeat.',
                },
            },
        },
    });
    if (!res || !res.answers) return null;
    const noul = typesafe.noul(res.answers, 'record_skill');
    if (noul === null || noul < THRESHOLDS.skillNudge) return null;
    return { noul, profile: name };
}

// что пишется в result_meta хода — тем же manner, что skillTrace (089);
// порог позже перемеряется по этим числам на живых ходах
function nudgeTrace(verdict) {
    if (!verdict) return null;
    return { noul: verdict.noul, profile: verdict.profile };
}

// напоминание агенту одним куском: в run-turn уходят только его текст и след,
// формулировка — выработка модуля, а не места вызова
function nudgeNotice(verdict) {
    if (!verdict) return null;
    return {
        trace: { noul: verdict.noul, profile: verdict.profile },
        notice: `В ходе, похоже, закрепился проверенный приём — запиши его в память работника `
            + `(${verdict.profile}, /api/flow/profile/memory/add, четыре поля из DOCS/decisions/035)`,
    };
}

// вход для run-turn: судим завершённый ход, при совпадении — пометка в ленту
// и след в result_meta. Отказ суждения ход не трогает
async function maybeNudge({ ctx, meta, prompt, judgment, agent, profile }) {
    const verdict = await reviewTurn({ request: prompt, answer: ctx.answer, judgment, agent, profile }).catch(() => null);
    if (!verdict) return;
    meta.resultMeta = { ...(meta.resultMeta || {}), skillNudge: { noul: verdict.noul, profile: verdict.profile } };
    ctx.notice('server.skill-nudge', nudgeNotice(verdict).notice);
}

module.exports = { reviewTurn, nudgeTrace, nudgeNotice, maybeNudge, worthReviewing };
