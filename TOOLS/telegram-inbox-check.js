// Обход решений маршрута лички (записка 132) на фейковых обновлениях, без сети.
// Запускается вручную: node _scratch/telegram-inbox-check.js — в git не идёт.
const createInbox = require('../PROJECTS/Settings/telegram-inbox-server.js');
const letters = require('../PROJECTS/Settings/telegram-letters-server.js');

const CHAT = 111;

async function main() {
    // --- фейковая база ---
    const bind = new Map();   // `${chatId}:${messageId}` -> sessionId
    const order = [];         // порядок появления (для lastSessionOfChat)
    function unbind(sessionId) {
        for (const [key, sid] of [...bind]) if (sid === sessionId) { bind.delete(key); const i = order.indexOf(key); if (i >= 0) order.splice(i, 1); }
    }
    const db = {
        sessionByReply: { get: (chatId, messageId) => bind.has(`${chatId}:${messageId}`) ? { sessionId: bind.get(`${chatId}:${messageId}`) } : null },
        lastSessionOfChat: { get: (chatId) => { for (let i = order.length - 1; i >= 0; i--) { const [c] = order[i].split(':'); if (c === chatId) return { sessionId: bind.get(order[i]) }; } return null; } },
        forgetSession: { run: (sid) => unbind(sid) },
        readChatState: { get: () => null },
        saveChatState: { run: () => {} },
        remember: (chatId, messageId, sessionId) => {
            const key = `${chatId}:${messageId}`;
            const prev = order.indexOf(key);
            if (prev >= 0) order.splice(prev, 1);
            bind.set(key, sessionId); order.push(key);
        },
    };

    // --- фейки ядра и общения ---
    const sent = [];
    const startNewCalls = [];
    const asks = [];
    const stopped = [];
    const running = new Set();
    const deps = {
        startNew: async ({ text, mode, likeSessionId, note, onSession }) => {
            startNewCalls.push({ text, mode, likeSessionId });
            onSession(`new-${startNewCalls.length}`);
            note('📝 Заголовок готов.');
        },
        ask: async ({ sessionId, text, mode }) => { asks.push({ sessionId, text, mode }); },
        stop: async (sessionId) => { stopped.push(sessionId); return running.delete(sessionId)? true : false; },
        status: () => ({ running: 0, titles: [] }),
        isRunning: (id) => running.has(id),
        sessionExists: () => true,
    };
    async function send(chatId, text) { sent.push({ chatId, text }); return { message_id: sent.length + 1 }; }

    // stub классификатора: intent каждого тестового текста задан явно
    const intents = {};
    const turnJudgment = { classifyInbox: async (text) => ({ ...(intents[text] || { intent: 'task', kind: 'build', kindWords: 'сделать новое', kindConfidence: 0.9 }), confidence: 0.9 }) };

    const keyboard = { pressedButton: () => null, pressButton: () => '', inlineKeyboardFor: () => ({}), moveInline: () => {}, isBottomInline: () => false, BUTTONS: [] };
    const polls = { handleReply: async () => false, handleOptionAdded: async () => {} };

    const inbox = createInbox({ callApi: async () => ({}), send, db, getUsers: () => [String(CHAT)], keyboard, letters, turnJudgment, sleep: async () => {}, deps });
    inbox.setPolls(polls);

    function update(text, replyTo = null) {
        const message = { chat: { id: CHAT }, text, message_id: 7777 };
        if (replyTo) message.reply_to_message = { message_id: replyTo };
        return inbox.handleUpdate({ message });
    }
    let failures = 0;
    function check(name, ok, detail = '') {
        console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ` — ${detail}`}`);
        if (!ok) failures += 1;
    }

    // 1. Поручение без reply, работ ещё нет — новая работа
    await update('Почини ленту');
    check('поручение без reply заводит новую работу', startNewCalls.length === 1 && asks.length === 0 && startNewCalls[0].text === 'Почини ленту',
        JSON.stringify({ startNewCalls, asks }));
    check('личка привязана к новой работе', db.lastSessionOfChat.get(String(CHAT))?.sessionId === 'new-1');

    // 2. «стоп» без reply при идущей работе — останавливает, работу не заводит
    running.add('new-1');
    intents['Стоп'] = { intent: 'stop', confidence: 0.95 };
    await update('Стоп');
    check('стоп без reply останавливает идущую работу', stopped.includes('new-1'), JSON.stringify(stopped));
    check('стоп без reply не заводит работу', startNewCalls.length === 1 && stopped.length === 1 && asks.length === 0);
    check('стоп без reply отвечает письмом', (sent.at(-1)?.text || '').includes('Остановил'));

    // 3. «ок» без reply — служебный ответ, рук не поднимает
    intents['Ок'] = { intent: 'nothing', confidence: 0.95 };
    await update('Ок');
    check('«ок» без reply — «👌», без ходов и работ', sent.at(-1)?.text === '👌' && startNewCalls.length === 1 && asks.length === 0);

    // 4. reply на письмо сессии — ход в ту же сессию
    db.remember(String(CHAT), 5, 'old-1');
    await update('Продолжай', 5);
    check('reply уходит ходом в адресованную сессию', asks.length === 1 && asks[0].sessionId === 'old-1', JSON.stringify(asks));

    // 5. reply «стоп» на письмо сессии — служебное слово той же сессии
    await update('Стоп', 5);
    check('reply «стоп» останавливает адресованную сессию', stopped.includes('old-1'), JSON.stringify(stopped));

    // 6. письмо вдогонку идущему ходу — в неё же, без новой работы
    running.add('old-1');
    await update('Доделай до конца');
    check('вдогонку — в идущую работу, без новой', startNewCalls.length === 1 && asks.length === 1 && (sent.at(-1)?.text || '').includes('ещё выполняется'),
        JSON.stringify({ startNewCalls, asks, last: sent.at(-1) }));

    // 7. работа кончилась — такое же сообщение без reply заводит новую
    running.clear();
    intents['Доделай до конца'] = { intent: 'task', kind: 'proceed', kindWords: 'продолжить начатую работу', confidence: 0.9 };
    await update('Доделай до конца');
    check('работа кончилась — поручение без reply заводит новую', startNewCalls.length === 2 && startNewCalls[1].text === 'Доделай до конца', JSON.stringify(startNewCalls));
    check('новая берёт прошлую как образец (like)', startNewCalls[1].likeSessionId === 'old-1');

    // 8. «что там» без reply без работ — статусное письмо, ничего не стартует
    intents['Что там?'] = { intent: 'status', confidence: 0.95 };
    running.clear();
    await update('Что там?');
    check('«что там» без reply — статус без ходов и работ', (sent.at(-1)?.text || '').includes('ничего не выполняется') && startNewCalls.length === 2 && asks.length === 1,
        JSON.stringify({ startNewCalls, asks, last: sent.at(-1) }));

    // 9. чужой чат ничего не получает
    const before = sent.length;
    await inbox.handleUpdate({ message: { chat: { id: 999 }, text: 'Почини', message_id: 1 } });
    check('сообщение не из списка отбрасывается молча', sent.length === before && startNewCalls.length === 2);

    // 10. reply на письмо забытой сессии — новая работа, а не наугад в последнюю
    running.clear();
    db.forgetSession.run('old-1');
    await update('Начни заново', 5);
    check('reply на забытое письмо — новая работа', startNewCalls.length === 3 && asks.length === 1, JSON.stringify({ startNewCalls, asks }));

    console.log(failures ? `\nFAILURES: ${failures}` : '\nALL PASS');
    process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
