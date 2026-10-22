const { THRESHOLDS } = require('./judgment-config.js');

function worthReviewing(judgment) {
    if (!judgment) return false;
    return (judgment.finalReport ?? 0) >= THRESHOLDS.finalReport
        || (judgment.workDone ?? 0) >= THRESHOLDS.workDone;
}

async function reviewTurn() {
    return null;
}

function nudgeAccepts(verdict) {
    return Boolean(verdict && verdict.noul >= THRESHOLDS.skillNudge);
}

function nudgeNotice(verdict) {
    if (!verdict) return null;
    return {
        trace: { noul: verdict.noul, profile: verdict.profile },
        notice: `В ходе, похоже, закрепился проверенный приём — запиши его в память работника (${verdict.profile})`,
    };
}

async function maybeNudge() {
    return undefined;
}

module.exports = { reviewTurn, nudgeAccepts, nudgeNotice, maybeNudge, worthReviewing };
