// Суждение о причине поломки хода: по нему решается, передавать ли работу
// следующему исполнителю, и какими словами писать письмо.
// Вынесено из turn-judgment.js, когда тот перерос норму в 400 строк
// (DOCS/decisions/022): turn-judgment.js по-прежнему отдаёт всё это наружу,
// вызывающим ничего менять не нужно. Транспорт — typesafe.js, пороги — judgment-config.js.
// Каждая функция возвращает null, когда ключа нет или сервис не ответил.

const typesafe = require('./typesafe.js');
const { THRESHOLDS, PROMPT_LIMIT } = require('./judgment-config.js');

// ---------- почему сломался ход ----------

// Причину раньше угадывала таблица шаблонов: незнакомая формулировка ошибки
// превращалась в «агент сообщил об ошибке», а работа после ЛЮБОЙ ошибки уходила
// следующему агенту — в том числе когда виновато само поручение и платный
// повтор ничего не исправит. Один выбор отвечает на оба вопроса: что написать
// человеку и есть ли смысл менять исполнителя (DOCS/decisions/065)
const FAILURE_QUESTION = {
    reason: {
        type: 'choice',
        instructions: {
            question: 'Why did the coding agent fail, judging by `error`?',
            focus: '`error` is the raw error text from a command-line AI agent or from its model provider.',
        },
        criteria: {
            limit: { what: 'Rate limit, quota, credits or billing: the account cannot make more requests now.', examples: ['429 Too Many Requests', 'insufficient credits', 'You have hit your usage limit'] },
            no_model: { what: 'The requested model does not exist or is not available to this account.', examples: ['is not a valid model ID', 'model not found', 'No endpoints found for this model'] },
            auth: { what: 'The provider rejected the credentials: missing, invalid or expired key or login.', examples: ['401 Unauthorized', 'invalid api key', 'Please run /login'] },
            not_connected: { what: 'The agent program itself is not connected, not installed or failed to start.', examples: ['pi is not connected', 'spawn ENOENT', 'command not found'] },
            network: { what: 'The connection failed or timed out before an answer arrived.', examples: ['ETIMEDOUT', 'fetch failed', 'socket hang up'] },
            provider: { what: 'The model provider broke off or failed on its side while answering.', examples: ['Provider finish_reason: error', '503 overloaded', 'Internal server error'] },
            agent_fault: {
                what: 'The agent or its model misbehaved: malformed tool calls, an empty answer, a step limit, a crash of the agent program.',
                examples: ['The model produced invalid tool call JSON three times', 'max turns reached', 'agent exited with code 1', 'empty response from model'],
            },
            task: {
                what: 'The request itself cannot be served by any agent as it is: too long for the context, refused content, malformed input.',
                not_for: 'Provider outages and limits, which another agent would not hit.',
                examples: ['prompt is too long', 'context length exceeded', 'content policy violation', 'invalid request: messages must not be empty'],
            },
            gone: { what: 'The thing to continue no longer exists: the session was deleted, the server is restarting, the person stopped the run.', examples: ['Session not found', 'Server is restarting', 'Stopped by the user'] },
        },
    },
};

// менять ли исполнителя: да, когда следующий агент со своим поставщиком и своим
// счётом может не упереться в то же самое
const FAILURE_HANDOVER = { limit: true, no_model: true, auth: true, not_connected: true, network: true, provider: true, agent_fault: true, task: false, gone: false };

// последние суждения по тексту ошибки: письмо об ошибке пишется синхронно
// (telegram-letters-server.js) и берёт причину отсюда, второго запроса не делая
const failureCache = new Map();
const FAILURE_CACHE_MAX = 50;

// { reason, handover, confidence } либо null — суждения нет, решает таблица шаблонов
async function classifyFailure(errorText) {
    const text = String(errorText || '').trim();
    if (!text || !typesafe.isEnabled()) return null;
    if (failureCache.has(text)) return failureCache.get(text);
    const res = await typesafe.systemOne({ error: text.slice(0, PROMPT_LIMIT) }, FAILURE_QUESTION);
    const pick = typesafe.choice(res?.answers, 'reason');
    const verdict = pick && (pick.confidence ?? 0) >= THRESHOLDS.failureReason
        ? { reason: pick.value, handover: FAILURE_HANDOVER[pick.value] !== false, confidence: pick.confidence }
        : null;
    // запоминаем и «не уверен»: повторный вопрос о той же ошибке ответа не изменит
    failureCache.set(text, verdict);
    if (failureCache.size > FAILURE_CACHE_MAX) failureCache.delete(failureCache.keys().next().value);
    return verdict;
}

// уже вынесенное суждение, без сети
function knownFailure(errorText) {
    return failureCache.get(String(errorText || '').trim()) || null;
}

module.exports = { classifyFailure, knownFailure };
