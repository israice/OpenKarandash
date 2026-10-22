const { THRESHOLDS } = require('./judgment-config.js');
const { pickDecisionHints, hintPreamble } = require('./decision-hints.js');
const { classifyInbox, matchPollReply } = require('./inbox-judgment.js');
const { classifyFailure, knownFailure } = require('./failure-judgment.js');
const { pickRelevantTurns, judgeSkill, judgeBranch } = require('./work-judgment.js');
const { judgeSteps } = require('./step-judgment.js');

const TURN_QUESTIONS = {};

function pickDecisionHintsForRequest(request) {
    return pickDecisionHints(request, THRESHOLDS.hintConfidence);
}

async function judgeTurn() {
    return null;
}

function shouldNotify(judgment, { errorText }) {
    if (errorText) return { send: true, reason: 'error' };
    if (!judgment) return { send: true, reason: 'no-judgment' };
    if ((judgment.awaitsHuman ?? 0) >= THRESHOLDS.awaitsHuman) return { send: true, reason: 'awaits-human' };
    if ((judgment.finalReport ?? 0) >= THRESHOLDS.finalReport) return { send: true, reason: 'final-report' };
    if ((judgment.workDone ?? 0) >= THRESHOLDS.workDone) return { send: true, reason: 'work-done' };
    return { send: false, reason: 'intermediate' };
}

module.exports = {
    judgeBranch,
    judgeSkill,
    judgeSteps,
    matchPollReply,
    pickRelevantTurns,
    classifyFailure,
    knownFailure,
    judgeTurn,
    shouldNotify,
    pickDecisionHints: pickDecisionHintsForRequest,
    hintPreamble,
    classifyInbox,
    THRESHOLDS,
    TURN_QUESTIONS,
};
