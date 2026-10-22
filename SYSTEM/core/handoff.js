// Продолжение сессии другим CLI: пересказ истории из нашей базы.
//
// Продолжать сессию можно только тем id, который выдал этот же CLI: история
// запусков у каждого своя (~/.claude/projects/<путь>), и путь к проекту у Windows
// и WSL разный. Своей записи нет — CLI начнёт свою сессию, а контекст получит
// пересказом последних ходов.
const skillHints = require('./skill-hints.js');
const homeworkHint = require('./homework-hint.js');

function create({ getCliSession, listMessages, clip, turnJudgment, planPreamble }) {
    const RESUME_MESSAGES = 12;

    // Пересказ для агента, у которого своей истории нет. Раньше — просто последние
    // RESUME_MESSAGES реплик: в длинной работе (а работа из Telegram тянется днями)
    // из пересказа выпадало само поручение и решения, принятые в начале. Теперь
    // всегда едут первое поручение человека и свежий хвост, а из середины —
    // только доступные локальные реплики
    const RESUME_TAIL = 8;
    const RESUME_PICKED = 4;

    async function handoffPreamble(sessionId, prompt) {
        const all = listMessages.all(sessionId)
            .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.text?.trim());
        let history = all.slice(-RESUME_MESSAGES);
        if (all.length > RESUME_MESSAGES) {
            const tail = all.slice(-RESUME_TAIL);
            const middle = all.slice(1, -RESUME_TAIL);
            const picked = await turnJudgment.pickRelevantTurns(prompt, middle.map((m) => m.text), RESUME_PICKED).catch(() => []);
            history = [all[0], ...picked.map((index) => middle[index]), ...tail];
        }
        if (!history.length) return '';

        const lines = history.map((m) => `${m.role === 'user' ? 'Human' : 'Assistant'}: ${clip(m.text.trim())}`);
        return [
            'This continues a conversation that was held by a different CLI, so you have no history of your own.',
            'Below are the latest turns so you have the context. Answer the last message from the human,',
            'in the same language they used.',
            '',
            ...lines,
            '',
            '--- continuation ---',
            '',
        ].join('\n');
    }

    //     hints — подобранные записки DOCS/decisions, skill — приём из памяти
    //     работника (skill-hints.js), homework — отчёт собранной домашней работы
    //     (homework-hint.js). Все три едут тем же каналом, что и пересказ
    //     истории: это не вопрос человека, а служебная преамбула, поэтому в тексте
    //     строки сессии её быть не должно — зато она попадает в «Sent to model»
    //     там, где коннектор его пишет
    async function resumeAndHandoff(sessionId, targetId, hints, skill, homework, plan, prompt) {
        const resumeId = sessionId ? getCliSession.get(sessionId, targetId)?.id : null;
        const history = sessionId && !resumeId ? await handoffPreamble(sessionId, prompt) : '';
        // ход начат из Telegram: агент первой строкой говорит, как понял
        // поручение, и пульт сразу пересылает её человеку (DOCS/decisions/063)
        const head = turnJudgment.hintPreamble(hints) + skillHints.skillPreamble(skill)
            + homeworkHint.homeworkPreamble(homework);
        return { resumeId, handoff: head + history + (plan ? planPreamble() : '') };
    }

    return { handoffPreamble, resumeAndHandoff };
}

module.exports = { create };
