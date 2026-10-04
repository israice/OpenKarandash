// Хранилище телеграм-моста: все таблицы и подготовленные запросы общей базы.
//
// Вынесено отдельно от telegram-server.js, потому что мост и так длиннее нормы
// (DOCS/decisions/022), а по существу это ровно один слой — SQL. Связи «наше
// сообщение в этом чате → сессия», «кому уже показаны кнопки», «позиция очереди
// Telegram» и «состояние лички» живут в базе, а не в памяти процесса: сторож
// перезапускает сервер на каждой правке серверного файла, и в памяти они
// терялись бы вместе с процессом.
//
// Модуль ничего не знает про Telegram как таковой: он только готовит запросы и
// хранит их. create(database) возвращает готовый набор.

module.exports = function create(database) {
    // сколько наших сообщений помним для ответа reply
    const MESSAGE_MEMORY = 500;
    const SENT_MEMORY = 100; // сколько последних уведомлений храним для вкладки

    let insertSent = null;
    let listSent = null;
    let trimSent = null;
    let rememberReply = null;
    let sessionByReply = null;
    let lastSessionOfChat = null;
    let saveChatState = null;
    let readChatState = null;
    let trimReplies = null;
    let forgetSession = null;
    let saveOffset = null;
    let readOffset = null;
    let saveKeyboard = null;
    let readKeyboard = null;
    let saveInline = null;
    let readInline = null;
    let dropInline = null;

    // история исходящих уведомлений для вкладки Telegram (#telegramMessages):
    // что мост отправил и когда. Раньше жила в памяти процесса (простой массив) —
    // каждая правка *-server.js перезапускает сервер, и последнее уведомление
    // пропадало из вкладки, хотя человек уже прочитал его в самом Telegram.
    // Поэтому это таблица в общей базе (db передаётся через init), как и sessions/messages
    database.exec(`
        CREATE TABLE IF NOT EXISTS telegram_sent (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            head TEXT NOT NULL,
            body TEXT NOT NULL,
            at TEXT NOT NULL
        );
    `);
    insertSent = database.prepare('INSERT INTO telegram_sent (session_id, head, body, at) VALUES (?, ?, ?, ?)');
    // самые новые первыми — так лимит LIMIT ? сразу берёт нужный хвост;
    // порядок для отображения (старые сверху) восстанавливает route .reverse()
    listSent = database.prepare('SELECT session_id AS sessionId, head, body, at FROM telegram_sent ORDER BY id DESC LIMIT ?');
    trimSent = database.prepare(`
        DELETE FROM telegram_sent WHERE id NOT IN (
            SELECT id FROM telegram_sent ORDER BY id DESC LIMIT ?
        )
    `);

    // «наше сообщение в этом чате → сессия». Переживает перезапуск сервера,
    // потому что сообщение в Telegram его переживает тоже
    database.exec(`
        CREATE TABLE IF NOT EXISTS telegram_replies (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            chat_id TEXT NOT NULL,
            message_id INTEGER NOT NULL,
            session_id TEXT NOT NULL,
            at TEXT NOT NULL,
            UNIQUE (chat_id, message_id)
        );
    `);
    rememberReply = database.prepare(
        'INSERT INTO telegram_replies (chat_id, message_id, session_id, at) VALUES (?, ?, ?, ?)'
        + ' ON CONFLICT(chat_id, message_id) DO UPDATE SET session_id = excluded.session_id, at = excluded.at',
    );
    sessionByReply = database.prepare('SELECT session_id AS sessionId FROM telegram_replies WHERE chat_id = ? AND message_id = ?');
    // сообщение без reply идёт в последнюю сессию, о которой мы писали этому чату
    lastSessionOfChat = database.prepare('SELECT session_id AS sessionId FROM telegram_replies WHERE chat_id = ? ORDER BY id DESC LIMIT 1');

    // позиция очереди Telegram. Она тоже пережила не один перезапуск в памяти —
    // и не пережила: сторож гасит сервер на каждой правке серверного файла, а
    // новый процесс начинал с «узнать хвост», то есть выбрасывал всё, что
    // человек прислал за эти секунды. Его ответ пропадал молча
    database.exec('CREATE TABLE IF NOT EXISTS telegram_offset (id INTEGER PRIMARY KEY CHECK (id = 1), value INTEGER NOT NULL, at TEXT NOT NULL);');
    saveOffset = database.prepare('INSERT INTO telegram_offset (id, value, at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value, at = excluded.at');
    readOffset = database.prepare('SELECT value, at FROM telegram_offset WHERE id = 1');
    forgetSession = database.prepare('DELETE FROM telegram_replies WHERE session_id = ?');

    // кому какой набор кнопок уже показан (см. KEYBOARD_VERSION)
    // состояние лички: fresh = 1 — человек нажал END, следующее сообщение
    // начинает новую работу. В базе, а не в памяти: сторож перезапускает сервер
    // на каждой правке, и нажатие не должно теряться
    database.exec("CREATE TABLE IF NOT EXISTS telegram_chat_state (chat_id TEXT PRIMARY KEY, mode TEXT NOT NULL DEFAULT 'action', fresh INTEGER NOT NULL DEFAULT 0, at TEXT NOT NULL);");
    saveChatState = database.prepare('INSERT INTO telegram_chat_state (chat_id, mode, fresh, at) VALUES (?, ?, ?, ?) ON CONFLICT(chat_id) DO UPDATE SET mode = excluded.mode, fresh = excluded.fresh, at = excluded.at');
    readChatState = database.prepare('SELECT mode, fresh FROM telegram_chat_state WHERE chat_id = ?');
    database.exec('CREATE TABLE IF NOT EXISTS telegram_keyboard (chat_id TEXT PRIMARY KEY, version INTEGER NOT NULL, at TEXT NOT NULL);');
    saveKeyboard = database.prepare('INSERT INTO telegram_keyboard (chat_id, version, at) VALUES (?, ?, ?) ON CONFLICT(chat_id) DO UPDATE SET version = excluded.version, at = excluded.at');
    readKeyboard = database.prepare('SELECT version FROM telegram_keyboard WHERE chat_id = ?');

    // какое сообщение чата сейчас нижнее со встроенными кнопками. В базе, а не в
    // памяти: сторож перезапускает сервер на каждой правке, и забытое нижнее
    // письмо навсегда оставляло бы кнопки на старом сообщении
    database.exec('CREATE TABLE IF NOT EXISTS telegram_inline (chat_id TEXT PRIMARY KEY, message_id INTEGER NOT NULL);');
    saveInline = database.prepare('INSERT INTO telegram_inline (chat_id, message_id) VALUES (?, ?) ON CONFLICT(chat_id) DO UPDATE SET message_id = excluded.message_id');
    readInline = database.prepare('SELECT message_id AS messageId FROM telegram_inline WHERE chat_id = ?');
    dropInline = database.prepare('DELETE FROM telegram_inline WHERE chat_id = ?');
    trimReplies = database.prepare(`
        DELETE FROM telegram_replies WHERE id NOT IN (
            SELECT id FROM telegram_replies ORDER BY id DESC LIMIT ?
        )
    `);

    // Какое наше сообщение относилось к какой сессии: ответ (reply) в Telegram
    // возвращает человека ровно в ту сессию, чей результат он прочитал. Ключ —
    // «чат + сообщение», потому что id сообщений в Telegram свои у каждого чата:
    // по одному числу ответы двух людей попадали бы в чужие сессии.
    function remember(chatId, messageId, sessionId) {
        rememberReply.run(String(chatId), Number(messageId), sessionId, new Date().toISOString());
        trimReplies.run(MESSAGE_MEMORY); // старое подчищаем сразу, как и у истории выше
    }

    function rememberSent(sessionId, head, body) {
        insertSent.run(sessionId, head, body, new Date().toISOString());
        trimSent.run(SENT_MEMORY); // старое подчищаем сразу, а не отдельным заданием
    }

    return {
        MESSAGE_MEMORY,
        SENT_MEMORY,
        insertSent, listSent, trimSent,
        rememberReply, sessionByReply, lastSessionOfChat, forgetSession,
        saveChatState, readChatState,
        saveOffset, readOffset,
        saveKeyboard, readKeyboard,
        saveInline, readInline, dropInline,
        remember, rememberSent,
    };
};