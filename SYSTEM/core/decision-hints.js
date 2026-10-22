// Подсказки по решениям отключены вместе с внешним сервисом суждений.
const DECISION_HINT = 0.5;
const HINT_FIELDS = ['title', 'noul', 'confidence'];

async function pickDecisionHints() {
    return null;
}

async function traceDecisionHints() {
    return null;
}

function hintPreamble(hints) {
    if (!hints || !hints.length) return '';
    const list = hints.map((hint) => `${hint.file} — «${hint.title}»`).join('; ');
    return `[OpenKarandash] Перед этой работой прочитай: ${list}. `
        + 'Записки объясняют, почему в проекте сделано так; идти против них нельзя, не переписав саму записку.\n\n';
}

module.exports = { pickDecisionHints, hintPreamble, traceDecisionHints, DECISION_HINT, HINT_FIELDS };
