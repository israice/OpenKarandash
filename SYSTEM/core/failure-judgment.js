// Локальная таблица известных причин ошибки. Внешний сервис суждений удалён;
// неизвестные ошибки обрабатываются штатным fallback вызывающего кода.
const failureCache = new Map();

async function classifyFailure() {
    return null;
}

function knownFailure(errorText) {
    return failureCache.get(String(errorText || '').trim()) || null;
}

module.exports = { classifyFailure, knownFailure };
