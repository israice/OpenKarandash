const { DECISION_HINT } = require('./decision-hints.js');

const THRESHOLDS = {
    finalReport: 0.6,
    awaitsHuman: 0.5,
    workDone: 0.8,
    decisionHint: DECISION_HINT,
    hintConfidence: 0.5,
    inboxIntent: 0.8,
    inboxKind: 0.6,
    failureReason: 0.7,
    attentionShown: 1.5,
    claimsVerified: 0.8,
    plainLanguage: 0.5,
    branchOffTask: 0.5,
    skillGeneral: 0.5,
    skillMatch: 0.5,
    homeworkWork: 0.4,
    stepOffTask: 0.6,
    stepDestructive: 0.6,
    skillNudge: 0.75,
};

const TEXT_LIMIT = 4000;
const PROMPT_LIMIT = 2000;

module.exports = { THRESHOLDS, TEXT_LIMIT, PROMPT_LIMIT };
