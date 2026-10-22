// Без внешнего классификатора входящие сообщения считаются поручениями,
// как в исходном fallback-поведении.
const INBOX_QUESTION = {};

async function classifyInbox() {
    return { intent: 'task', confidence: null };
}

async function matchPollReply() {
    return null;
}

module.exports = { classifyInbox, matchPollReply, INBOX_QUESTION };
