// Суждения о работе агента и её следах: какие реплики старой переписки нужны
// новому агенту, подтверждён ли приём для памяти работника, по делу ли дифф ветки.
// Вынесено из turn-judgment.js, когда тот перерос норму в 400 строк
// (DOCS/decisions/022): turn-judgment.js по-прежнему отдаёт всё это наружу,
// вызывающим ничего менять не нужно. Транспорт — typesafe.js, пороги — judgment-config.js.
// Каждая функция возвращает null, когда ключа нет или сервис не ответил.

const typesafe = require('./typesafe.js');
const { THRESHOLDS, PROMPT_LIMIT } = require('./judgment-config.js');

// ---------- что из старой переписки нужно новому агенту ----------

const TURNS_MAX = 40;        // сколько реплик середины отдаём на суждение
const TURN_EXCERPT = 500;
const TURN_RELEVANT = 0.6;

// Индексы реплик (по возрастанию), без которых новый агент не поймёт текущий
// запрос: принятые решения, ограничения, названные файлы. Не больше limit штук;
// суждения нет — пустой список
async function pickRelevantTurns(request, turns, limit) {
    const text = String(request || '').trim();
    if (!typesafe.isEnabled() || !text || !Array.isArray(turns) || !turns.length) return [];
    // берём ближайшие к концу: они вероятнее относятся к текущему делу
    const offset = Math.max(0, turns.length - TURNS_MAX);
    const state = { request: text.slice(0, PROMPT_LIMIT), turns: {} };
    const questions = {};
    turns.slice(offset).forEach((turn, i) => {
        const id = `t${i}`;
        state.turns[id] = String(turn || '').replace(/\s+/g, ' ').trim().slice(0, TURN_EXCERPT);
        questions[id] = {
            type: 'noul',
            instructions: `Would an assistant who has not seen the conversation need \`turns.${id}\` to carry out \`request\` correctly?`,
            criteria: {
                true: { what: 'It states a decision, a constraint, a preference, a named file or place, or a result that the request builds on.' },
                false: { what: 'It is about another matter, is small talk, or only repeats what the request itself says.' },
            },
        };
    });
    const res = await typesafe.systemOne(state, questions);
    if (!res?.answers) return [];
    return Object.keys(questions)
        .map((id, i) => ({ index: offset + i, relevance: typesafe.noul(res.answers, id) ?? 0 }))
        .filter((t) => t.relevance >= TURN_RELEVANT)
        .sort((a, b) => b.relevance - a.relevance)
        .slice(0, limit)
        .map((t) => t.index)
        .sort((a, b) => a - b);
}

// ---------- запись приёма в память работника ----------

const SKILL_PROVEN = 0.6;
const SKILL_SAME = 0.5;

// В память работника идёт только проверенный приём (DOCS/decisions/035), а
// держалось это на честности пишущего агента. Два суждения: подтверждён ли приём
// настоящей проверкой и не записан ли он уже. { ok, reason } либо null — суждения
// нет, решает правило, как раньше
async function judgeSkill({ title, how, proof }, existingTitles) {
    if (!typesafe.isEnabled()) return null;
    const titles = (existingTitles || []).slice(-40);
    const questions = {
        proven: {
            type: 'noul',
            instructions: 'Does `skill.proof` describe a concrete check that was actually carried out and showed that the technique in `skill.how` works?',
            criteria: {
                true: { what: 'It names what was run or observed and what the result was.', examples: ['Прогнал пробный ход на живом сервере: письмо ушло за 339 мс', 'npm run check упал до правки и прошёл после'] },
                false: { what: 'It is empty, a guess, a belief, or a plan to check later.', examples: ['не указано', 'должно работать', 'наверное, помогает', 'проверю позже'] },
            },
        },
    };
    if (titles.length) {
        const criteria = { new: { what: 'None of the listed techniques is the same as this one.' } };
        titles.forEach((t, i) => { criteria[`s${i}`] = { what: `It is the same technique as the already recorded "${String(t).slice(0, 120)}".` }; });
        questions.same = { type: 'choice', instructions: 'Is the technique in `skill` already recorded under another title?', criteria };
    }
    const res = await typesafe.systemOne({ skill: { title: String(title || '').slice(0, 200), how: String(how || '').slice(0, 1500), proof: String(proof || '').slice(0, 800) } }, questions);
    if (!res?.answers) return null;
    const proven = typesafe.noul(res.answers, 'proven');
    if (proven !== null && proven < SKILL_PROVEN) return { ok: false, reason: 'unproven', proven };
    const same = typesafe.choice(res.answers, 'same');
    if (same && same.value !== 'new' && (same.confidence ?? 0) >= SKILL_SAME) return { ok: false, reason: 'duplicate', of: titles[Number(same.value.slice(1))] };
    return { ok: true, proven };
}

// ---------- ветка исполнителя: по делу ли дифф ----------

const DIFF_LIMIT = 12000;

// Подсказка рецензенту перед разбором ветки (SYSTEM/branch-gate.mjs): делает ли
// дифф то, о чём просило поручение, и нет ли в нём правок, которых не просили.
// Ветку по этому числу не отклоняют — судья ошибается, а рецензент читает код;
// цель — показать, куда смотреть в первую очередь. Суждения нет — null
async function judgeBranch({ task, diff, files }) {
    const request = String(task || '').trim();
    const patch = String(diff || '').trim();
    if (!typesafe.isEnabled() || !request || !patch) return null;
    const state = {
        task: request.slice(0, PROMPT_LIMIT),
        changed_files: (files || []).slice(0, 60).join('\n'),
        diff: patch.slice(0, DIFF_LIMIT),
        diff_truncated: patch.length > DIFF_LIMIT,
    };
    const res = await typesafe.systemOne(state, {
        on_task: {
            type: 'noul',
            instructions: 'Does `diff` carry out what `task` asks for?',
            criteria: {
                true: { what: 'The changes are the ones the task calls for.' },
                false: { what: 'The changes do not do what the task asks, or only a small part of it.' },
            },
        },
        off_task: {
            type: 'noul',
            instructions: 'Does `diff` contain changes that `task` did not ask for?',
            criteria: {
                true: { what: 'Files or behaviour unrelated to the task are changed, or extra features are added.', not_for: 'Small edits that the task needs (a version line, a note about the change).' },
                false: { what: 'Every change serves the task.' },
            },
        },
    });
    if (!res?.answers) return null;
    const onTask = typesafe.noul(res.answers, 'on_task');
    const offTask = typesafe.noul(res.answers, 'off_task');
    if (onTask === null && offTask === null) return null;
    return { onTask, offTask, flagged: (offTask ?? 0) >= THRESHOLDS.branchOffTask, truncated: patch.length > DIFF_LIMIT };
}

module.exports = { pickRelevantTurns, judgeSkill, judgeBranch };
