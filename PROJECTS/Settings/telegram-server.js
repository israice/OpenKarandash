// Телеграм-мост, серверная половина Settings: ключ бота и список разрешённых
// id пользователей лежат в .env, последний ответ завершившейся сессии уходит
// человеку в личку, а его ответ на это сообщение возвращается в ту же сессию.
//
// Почему опрос (getUpdates), а не вебхук: вебхуку нужен публичный https-адрес,
// а сервер живёт на localhost — снаружи Telegram до него не достучится.
//
// Секрет наружу не отдаём: /api/telegram/state возвращает только маску ключа
// (последние четыре знака). Клиент присылает её обратно неизменной — значит,
// поле не трогали и ключ в .env остаётся прежним.

const { readJson, sendJson, sendHtml } = require('../../SYSTEM/core/http.js');
const { formatWhen } = require('../../SYSTEM/core/format.js');
const { Eta } = require('eta');
const turnJudgment = require('../../SYSTEM/core/turn-judgment.js');
const pollsModule = require('./telegram-polls-server.js');
const letters = require('./telegram-letters-server.js');

// свой экземпляр Eta со своей папкой шаблонов (см. «Серверные фрагменты» в
// AGENTS.md): cache:false — правка .eta подхватывается без перезапуска
const eta = new Eta({ views: __dirname, cache: false });
const TOKEN_KEY = 'TELEGRAM_BOT_TOKEN';
const USERS_KEY = 'TELEGRAM_USER_IDS';

const API = 'https://api.telegram.org/bot';
// poll_answer — голос в опросе-вопросе (telegram-polls-server.js); без явного списка
// Telegram присылал бы и то, что мосту не нужно
const ALLOWED_UPDATES = ['message', 'poll_answer', 'callback_query'];
const POLL_TIMEOUT_S = 50;      // длинный опрос: ответ приходит сразу, как только есть сообщение
const POLL_RETRY_MS = 5000;     // сеть отвалилась — не долбим Telegram в цикле
const CONFLICT_RETRY_MS = 2000; // пересменка: ключ отвоёвывается быстрее обычной ошибки
// Пересменка длится ровно столько, сколько у Telegram живёт опрос прошлого
// процесса: наш сторож гасит сервер на каждой правке *-server.js, а висевший
// getUpdates Telegram отпускает не в момент смерти процесса, а по своему
// таймауту — до POLL_TIMEOUT_S. Прежние 30 секунд были короче этого окна,
// и обычный перезапуск успевал обвинить человека в чужом боте
const CONFLICT_GRACE_MS = (POLL_TIMEOUT_S + 15) * 1000;
const CONFLICT_IDLE_MS = 60000; // дальше не тянем ключ на себя каждые две секунды
const RELEASE_TIMEOUT_MS = 3000; // отпускание опроса на выходе: перезапуск не ждёт недоступный Telegram
const MESSAGE_MEMORY = 500;     // сколько наших сообщений помним для ответа reply

// Кнопки под полем ввода (ReplyKeyboardMarkup), а не под сообщением: такая
// клавиатура видна человеку всё время, а не только у последнего письма, и за
// нажатие не нужно отчитываться answerCallbackQuery. Нажатие приходит обычным
// текстом кнопки — поэтому handleUpdate перехватывает эти слова раньше, чем
// они успеют стать поручением.
//
// Логика (решение владельца 2026-09-21): END закрывает разговор о текущей
// работе — следующее сообщение станет новой работой в пульте, а не ответом в
// старую. После END выбран режим ACTION: сообщение — это поручение. ASK и LOOP
// пока без логики
//
// Вид — то, что даёт Bot API кнопке клавиатуры: style заливает её цветом
// («primary» синий, «success» зелёный, «danger» красный, без поля — цвет
// приложения). Значок стоит обычным эмодзи в тексте: icon_custom_emoji_id
// работает только у владельца с Premium или именем с Fragment. Все четыре —
// одной строкой (решение владельца): клавиатура занимает один этаж экрана
const BUTTONS = [
    { label: 'ASK', text: '💬 ASK', style: 'primary' },
    { label: 'ACTION', text: '⚡ ACTION', style: 'success' },
    { label: 'LOOP', text: '🔁 LOOP' },
    { label: 'END', text: '⏹ END', style: 'danger' },
];
// Последняя выбранная кнопка режима (ASK/ACTION/LOOP) остаётся отмеченной,
// пока человек не выберет другую: Bot API не даёт кнопке рамки, поэтому метка —
// скобки вокруг текста (плюс цвет style, если он у кнопки есть). END не режим,
// он всегда возвращает ACTION. Выбор лежит в telegram_chat_state.mode
const MODE_LABELS = ['ASK', 'ACTION', 'LOOP'];
const MARK_RE = /^【(.*)】$/;
function keyboardFor(chatId) {
    let mode = 'action';
    try { mode = readChatState?.get(String(chatId))?.mode || 'action'; } catch { /* база ещё не готова — по умолчанию */ }
    return {
        keyboard: [BUTTONS.map(({ label, text, style }) => {
            const shown = label.toLowerCase() === mode ? `【${text}】` : text;
            return style ? { text: shown, style } : { text: shown };
        })],
        resize_keyboard: true,  // без этого одна строка кнопок растянута на высоту обычной клавиатуры
        is_persistent: true,    // не прячется после нажатия
        input_field_placeholder: 'Ответ агенту или кнопка ниже',
    };
}
// Те же кнопки встроенной клавиатурой — под каждым письмом бота. Она не прячется,
// пока набираешь текст, но привязана к сообщению; выбранная помечена так же — 【 】
function inlineKeyboardFor(chatId) {
    let mode = 'action';
    try { mode = readChatState?.get(String(chatId))?.mode || 'action'; } catch { /* по умолчанию */ }
    return {
        inline_keyboard: [BUTTONS.map(({ label, text, style }) => {
            const shown = label.toLowerCase() === mode ? `【${text}】` : text;
            const button = { text: shown, callback_data: `btn:${label}` };
            return style ? { ...button, style } : button;
        })],
    };
}
// нажатие приходит текстом кнопки вместе с эмодзи (и меткой выбора, если кнопка
// выбрана); голое слово, набранное руками, считаем тем же нажатием
function pressedButton(text) {
    const raw = String(text || '').trim();
    const value = raw.replace(MARK_RE, '$1').trim();
    return BUTTONS.find((b) => b.text === value || b.label === value.toUpperCase()) || null;
}
// клавиатуру Telegram показывает только вместе с сообщением. Чтобы человек
// увидел её сразу, а не с ближайшим отчётом, шлём одно письмо — и помним, кому
// какой набор уже показан: перезапуск сервера не должен слать его заново.
// Сменился набор кнопок — поднять номер
const KEYBOARD_VERSION = 4;

// вид ключа бота: «<цифры>:<буквенный хвост>». Проверяем до сети, чтобы очевидная
// опечатка не превращалась в загадочный отказ Telegram
const TOKEN_RE = /^\d{5,}:[A-Za-z0-9_-]{20,}$/;
const USER_RE = /^-?\d+$/;

let deps = { setEnvValue: () => {}, ask: null, db: null, stop: null, status: null, sessionExists: () => true, isRunning: () => false };
// интерактивные вопросы опросом Telegram — отдельный модуль (telegram-polls-server.js);
// заводится в init, когда есть база
let polls = null;

let token = '';
let users = [];        // кому шлём и от кого принимаем — остальные для бота не существуют
let botName = null;    // имя из getMe: им же подтверждается, что ключ рабочий
let lastError = null;
// ошибка отправки живёт отдельно от ошибки опроса. Они мешали друг другу:
// длинный опрос успешно возвращается раз в полминуты и обнулял общее поле,
// поэтому не дошедшее до человека уведомление не оставляло следа нигде
let sendError = null;
// null — «хвост ещё не знаем»: пока он не выяснен, накопившееся за простой не
// разгребаем. Раньше хвост узнавался отдельным запросом до цикла, и его провал
// (а первый запрос после перезапуска как раз и упирается в Conflict) молча
// оставлял offset = 0 — то есть весь бэклог старых сообщений, каждое из
// которых запускало настоящий ход. Теперь этот запрос — такая же итерация
// цикла, с общей обработкой ошибок и повтором
let offset = null;

// Опрос всегда ровно один: у Telegram на бота может висеть только один
// getUpdates, второй обрывает первый ошибкой Conflict. Поэтому ключ опрос не
// добавляет, а заменяет — каждый запуск получает свой номер поколения, и цикл
// со старым номером выходит, чем бы ни кончился его запрос. Флага мало: он
// снова становится «включено» к моменту, когда висящий запрос вернётся, и
// прошлый цикл оживает вторым опросом
let pollRun = 0;
let pollAbort = null;   // висящий запрос: его гасим, а не ждём его конца

// Conflict от Telegram означает: этот же ключ опрашивает кто-то ещё. При
// перезапуске сервера это норма и длится секунды — новый процесс перебивает
// опрос старого, — поэтому первые CONFLICT_GRACE_MS про драку молчим и быстро
// возвращаемся за своим опросом. Если она не кончается, дело не в нас: где-то
// живёт второй бот с тем же ключом, и красная строка должна говорить именно
// это, а не пересказывать Telegram.
//
// Затянувшуюся драку не продолжаем: каждый наш запрос обрывает чужой опрос, а
// чужой — наш, и сообщения достаются то одному, то другому. Победить нельзя —
// ключ у Telegram один на бота, — поэтому вместо перетяжки каждые две секунды
// переходим на редкую проверку раз в минуту: чужой экземпляр перестанем рвать,
// а если он исчезнет, мост поднимется сам, без захода в настройки
let conflictSince = null;
const CONFLICT_HINT = 'The same bot token is polled somewhere else — stop that instance or get a new token from @BotFather. Until then messages reach the bridge at random.';

// Какое наше сообщение относилось к какой сессии: ответ (reply) в Telegram
// возвращает человека ровно в ту сессию, чей результат он прочитал. Ключ —
// «чат + сообщение», потому что id сообщений в Telegram свои у каждого чата:
// по одному числу ответы двух людей попадали бы в чужие сессии.
//
// Связь лежит в базе, а не в памяти процесса. В памяти она уже стоила потерянных
// ответов: любая правка серверного файла перезапускает сервер, карта обнулялась,
// и следующий ответ человека получал «No session to continue yet» — хотя
// сообщение, на которое он отвечал, лежало у него в Telegram как ни в чём не
// бывало. Ровно эта же беда уже случилась с историей уведомлений выше и была
// вылечена так же — таблицей.

// история исходящих уведомлений для вкладки Telegram (#telegramMessages):
// что мост отправил и когда. Раньше жила в памяти процесса (простой массив) —
// каждая правка *-server.js перезапускает сервер, и последнее уведомление
// пропадало из вкладки, хотя человек уже прочитал его в самом Telegram.
// Поэтому это таблица в общей базе (db передаётся через init), как и sessions/messages
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

function initDb(database) {
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
}

function rememberSent(sessionId, head, body) {
    insertSent.run(sessionId, head, body, new Date().toISOString());
    trimSent.run(SENT_MEMORY); // старое подчищаем сразу, а не отдельным заданием
}

// ---------- разбор настроек ----------

function parseUsers(raw) {
    return String(raw || '')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean);
}

// маска ключа для интерфейса: сам ключ не покидает сервер
function maskToken(value) {
    if (!value) return '';
    return '•'.repeat(8) + value.slice(-4);
}

function state() {
    return {
        ok: true,
        tokenMask: maskToken(token),
        users: users.join(', '),
        bot: botName,
        connected: Boolean(token && botName),
        // в одну строку для окна настроек: что сломано — видно по тексту
        error: [sendError && `sending: ${sendError}`, lastError].filter(Boolean).join(' · ') || null,
        sendError,
    };
}

// ---------- разговор с Telegram ----------

// Длинный опрос ходит своим соединением, мимо общего пула fetch. В общем пуле
// отправка вставала в очередь за висящим getUpdates и уходила, только когда он
// возвращался: письмо либо опаздывало на десятки секунд, либо все три попытки
// send успевали истечь по таймауту — при исправном Telegram. Поймано замером:
// отправка проходила через 0,2 с после возврата 50-секундного опроса
const https = require('https');
const pollAgent = new https.Agent({ keepAlive: true, maxSockets: 1 });

function postOwnSocket(url, payload, signal) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify(payload || {});
        const req = https.request(url, {
            method: 'POST',
            agent: pollAgent,
            signal,
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        }, (res) => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { text += chunk; });
            res.on('end', () => {
                let data = {};
                try { data = JSON.parse(text); } catch { /* не JSON — разберёт зовущий по status */ }
                resolve({ status: res.statusCode, data });
            });
            res.on('error', reject);
        });
        req.on('error', reject);
        req.end(body);
    });
}

async function callApi(method, payload, timeoutMs = 15000, extraSignal = null) {
    if (!token) throw new Error('Telegram bot token is not set');
    // extraSignal — способ оборвать длинный опрос досрочно: по нему сменившийся
    // ключ отпускает getUpdates сразу, а не через минуту ожидания
    const timeout = AbortSignal.timeout(timeoutMs);
    if (method === 'getUpdates') {
        const signal = extraSignal ? AbortSignal.any([extraSignal, timeout]) : timeout;
        const { status, data } = await postOwnSocket(`${API}${token}/${method}`, payload, signal);
        if (!data.ok) throw new Error(data.description || `Telegram answered ${status}`);
        return data.result;
    }
    const res = await fetch(`${API}${token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload || {}),
        signal: extraSignal ? AbortSignal.any([extraSignal, timeout]) : timeout,
    });
    const data = await res.json().catch(() => ({}));
    if (!data.ok) throw new Error(data.description || `Telegram answered ${res.status}`);
    return data.result;
}

// Встроенные кнопки живут только под самым нижним письмом, отправленным в чат:
// стоит уйти новому сообщению (письму, опросу, ответу на кнопку), как кнопки
// прошлого снимаются. messageId = null — новое сообщение без встроенных кнопок.
// Нижнее сообщение помнится в базе (telegram_inline): сторож перезапускает
// сервер на каждой правке, и в памяти оно терялось бы вместе с процессом
function moveInline(chatId, messageId) {
    const key = String(chatId);
    let prev = null;
    try { prev = readInline?.get(key)?.messageId ?? null; } catch { /* база ещё не готова */ }
    try {
        if (messageId) saveInline?.run(key, Number(messageId)); else dropInline?.run(key);
    } catch { /* не записалось — кнопки снимутся со следующим письмом */ }
    if (prev && prev !== messageId) {
        callApi('editMessageReplyMarkup', { chat_id: chatId, message_id: prev, reply_markup: { inline_keyboard: [] } })
            .catch(() => {}); // письмо старое или уже без кнопок — не ошибка
    }
}
function isBottomInline(chatId, messageId) {
    try { return readInline?.get(String(chatId))?.messageId === messageId; } catch { return false; }
}

function remember(chatId, messageId, sessionId) {
    rememberReply.run(String(chatId), Number(messageId), sessionId, new Date().toISOString());
    trimReplies.run(MESSAGE_MEMORY); // старое подчищаем сразу, как и у истории выше
}

// Отправка с повторами. Без них один таймаут сети терял уведомление навсегда:
// ход закончен, в истории вкладки запись есть, а в личке у человека ничего —
// и он узнаёт об этом, только не дождавшись. Повторяем всё, кроме отказов
// самого Telegram (заблокировал бота, неверный чат): их повтор не исправит
const SEND_RETRY_DELAYS_MS = [1000, 4000];

async function send(chatId, text, replyMarkup, { keepInline = false } = {}) {
    for (let attempt = 0; ; attempt += 1) {
        try {
            const sent = await callApi('sendMessage', {
                chat_id: chatId,
                text,
                disable_web_page_preview: true,
                // встроенные кнопки — только у нижнего письма; обычная клавиатура
                // остаётся с прошлого показа (её шлёт showKeyboard)
                reply_markup: replyMarkup || inlineKeyboardFor(chatId),
            });
            // keepInline: сообщение с обычной клавиатурой (ответ на нажатие) не
            // должно снимать кнопки с нижнего письма — иначе после нажатия их нет нигде
            if (!(replyMarkup && keepInline)) moveInline(chatId, replyMarkup ? null : sent.message_id);
            return sent;
        } catch (err) {
            // «Telegram answered …» и текст его описания — это ответ сервиса,
            // а не сбой связи: сеть отработала, повторять нечего
            const answered = /Telegram answered|chat not found|bot was blocked|Forbidden/i.test(err.message);
            if (answered || attempt >= SEND_RETRY_DELAYS_MS.length) throw err;
            await sleep(SEND_RETRY_DELAYS_MS[attempt]);
        }
    }
}

// Показать кнопки тем, кто их ещё не видел. Без await у зовущего: это не
// должно ни задерживать подключение, ни ронять его
//
// Не ушло — пробуем позже сами: иначе человек увидел бы кнопки только с
// ближайшим отчётом, а письмо про них — после следующего перезапуска. Так уже
// было: сеть оборвала все три попытки send, хотя Telegram был исправен
const KEYBOARD_RETRY_MS = 60000;
const KEYBOARD_RETRIES = 5;
let keyboardTimer = null;

async function showKeyboard(attempt = 0) {
    clearTimeout(keyboardTimer);
    let failed = false;
    for (const chatId of users) {
        if ((readKeyboard.get(chatId)?.version ?? 0) >= KEYBOARD_VERSION) continue;
        try {
            await send(chatId, `⌨️ Кнопки пульта: ${BUTTONS.map((b) => b.text).join(' · ')}. ⏹ END — начать новую работу: следующее сообщение станет её поручением.`, keyboardFor(chatId));
            saveKeyboard.run(chatId, KEYBOARD_VERSION, new Date().toISOString());
        } catch (err) {
            failed = true;
            sendError = err.message;
            console.error('Telegram keyboard:', err.message);
        }
    }
    if (failed && attempt < KEYBOARD_RETRIES) {
        keyboardTimer = setTimeout(() => showKeyboard(attempt + 1), KEYBOARD_RETRY_MS);
        keyboardTimer.unref(); // таймер не должен держать уходящий процесс
    }
}

// ---------- отправка: последний ответ завершившейся сессии ----------

// Зовётся из runTurn (server.js) без await: телеграм не должен ни задерживать
// ход, ни ронять его своей ошибкой — поэтому внутри всё под try/catch
async function notifyTurnFinished({ sessionId, title, text, errorText, steps }) {
    if (!token || !users.length || (!text && !errorText)) return;
    // строку плана человек уже получил отдельным письмом в начале работы
    // (PLAN_PREAMBLE) — в итоговом письме она лишняя. Весь ответ из одной этой
    // строки оставляем, сняв только метку
    const original = text;
    text = String(text || '').replace(/^\s*\[PLAN\][^\n]*\n?/, '').trim() || String(original || '').replace(/^\s*\[PLAN\]\s*/, '');
    // сломавшийся ход — своё письмо: что случилось, что успето, что делать
    // дальше (telegram-letters-server.js). Блок [ASK] в оборванном ответе не
    // разбираем: вопрос из недописанного ответа задавать рано
    if (errorText) {
        await sendNotice({ sessionId, title, text, errorText, steps });
        return;
    }
    // ответ кончается блоком [ASK] — вопрос уходит опросом, остальное письмом
    const ask = pollsModule.parseAsk(text);
    if (ask) {
        if (ask.rest) await sendNotice({ sessionId, title, text: ask.rest });
        await polls.askPoll({ sessionId, ...ask, silenced: true }).catch((err) => {
            // опрос не ушёл — вопрос не должен пропасть: шлём его письмом, текстом
            console.error('Telegram ask block:', err.message);
            return sendNotice({ sessionId, title, text: `${ask.question}\n${ask.options.map((o) => `- ${o}`).join('\n')}` });
        });
        return;
    }
    // ход задал вопрос опросом через маршрут — опрос и есть письмо, второе не нужно
    if (polls.swallowsNotice(sessionId)) return;
    await sendNotice({ sessionId, title, text });
}

async function sendNotice({ sessionId, title, text, errorText, steps }) {
    const { head, body } = letters.turnLetter({ title, text, errorText, steps });
    const message = `${head}\n\n${body}`;
    // одна запись на ход, а не на получателя: адресатов может быть несколько,
    // а во вкладке Telegram это одно и то же уведомление
    rememberSent(sessionId, head, body);

    for (const chatId of users) {
        try {
            const result = await send(chatId, message);
            remember(chatId, result.message_id, sessionId);
            sendError = null;
        } catch (err) {
            // в своё поле, а не в общее с опросом: опрос успешен каждые полминуты
            // и затирал бы эту ошибку через секунды — провалившееся уведомление
            // выглядело бы отправленным, хотя в личку не дошло ничего
            sendError = err.message;
            console.error('Telegram sendMessage:', err.message);
        }
    }
}

// ---------- приём: ответ человека возвращается в ту же сессию ----------

// ход из Telegram идёт долго, а опрос его не ждёт — значит, на одну сессию
// может прилететь второе сообщение поверх незаконченного первого. Такие
// не запускаем: в сессии должен идти один ход за раз
const busySessions = new Set();

// Ответ, который мост даёт сам, не поднимая агента. Формулировки короткие:
// это личка, а не отчёт, и читают их с телефона
function answerWithoutTurn(intent, sessionId) {
    if (intent === 'stop') {
        const stopped = deps.stop ? deps.stop(sessionId) : false;
        return stopped ? '⏹ Остановил.' : '⏹ Останавливать нечего — эта работа уже закончена.';
    }
    if (intent === 'status') {
        const { running = 0, titles = [] } = (deps.status ? deps.status() : {});
        if (!running) return '💤 Сейчас ничего не выполняется.';
        return `⚙️ Выполняется: ${running}\n${titles.map((t) => `· ${String(t).slice(0, 80)}`).join('\n')}`;
    }
    return '👌';
}

// Последняя работа лички, которая ещё есть в пульте. Удалённые забываем молча:
// иначе сообщение без reply упиралось в «работа удалена», хотя человек писал
// не в неё, а просто в личку
function liveLastSession(chatId) {
    for (;;) {
        const sessionId = lastSessionOfChat.get(chatId)?.sessionId;
        if (!sessionId || deps.sessionExists(sessionId)) return sessionId || null;
        forgetSession.run(sessionId);
    }
}

// Первое письмо на поручение — сразу, до исполнителя: как jev понял, какого рода
// это дело (turn-judgment.js, вопрос kind). Исполнитель может быть слабой
// моделью и строки [PLAN] не дать вовсе, а человеку с телефона нужен знак, что
// его поняли верно, в первую же секунду (DOCS/decisions/064). Неуверенный или
// недоступный jev — общее «принял»: гадать вслух хуже, чем промолчать о виде
async function acknowledge(chatId, understood, sessionId) {
    const line = understood?.kindWords
        ? `🧭 Понял поручение как: ${understood.kindWords}. Приступаю.`
        : '🧭 Принял поручение, приступаю.';
    await send(chatId, line)
        .then((sent) => { if (sessionId) remember(chatId, sent.message_id, sessionId); })
        .catch(() => {});
}

function pressButton(chatId, button) {
    const now = new Date().toISOString();
    if (button.label === 'END') {
        saveChatState.run(chatId, 'action', 1, now);
        return 'Начинаем с новой сессии\n\n⚡ Выбран ACTION: напишите поручение — оно станет новой работой в пульте.';
    }
    if (button.label === 'ACTION') {
        const fresh = readChatState.get(chatId)?.fresh ? 1 : 0;
        saveChatState.run(chatId, 'action', fresh, now);
        return fresh
            ? '⚡ ACTION: напишите поручение — оно станет новой работой в пульте.'
            : '⚡ ACTION: сообщение уйдёт поручением в текущую работу. Новую работу начинает ⏹ END.';
    }
    if (MODE_LABELS.includes(button.label)) {
        // выбор запоминаем: кнопка остаётся отмеченной до выбора другой
        const fresh = readChatState.get(chatId)?.fresh ? 1 : 0;
        saveChatState.run(chatId, button.label.toLowerCase(), fresh, now);
    }
    return `${button.text} — выбрано. Пока эта кнопка ничего не меняет в работе.`;
}

// Первое сообщение после END: поручение заводит новую сессию в пульте
async function startNewSession(chatId, text, messageId) {
    const like = liveLastSession(chatId) || null;
    let created = null;
    try {
        await deps.startNew({
            text,
            likeSessionId: like,
            note: (line) => { send(chatId, line).then((sent) => { if (created) remember(chatId, sent.message_id, created); }).catch(() => {}); },
            // id приходит в начале хода: сразу снимаем «новую работу» и
            // привязываем личку к сессии — следующее сообщение пойдёт уже в неё,
            // а не заведёт ещё одну
            onSession: (sessionId) => {
                if (created) return;
                created = sessionId;
                busySessions.add(sessionId);
                saveChatState.run(chatId, 'action', 0, new Date().toISOString());
                // привязка сразу, по сообщению самого человека: письмо ниже
                // может задержаться, а следующее сообщение уже в пути
                remember(chatId, messageId, sessionId);
                send(chatId, '🆕 Новая работа начата. Ответ придёт сюда.')
                    .then((sent) => remember(chatId, sent.message_id, sessionId))
                    .catch(() => {});
            },
        });
    } catch (err) {
        // работа не завелась — «новая работа» остаётся включённой: человек
        // повторит поручение, и оно не уйдёт в старую сессию
        await send(chatId, `⚠️ Новую работу начать не удалось: ${letters.humanReason(err.message)}.\n\nПовторите поручение, когда причина устранена.\n\nТекст ошибки: ${String(err.message).slice(0, 300)}`).catch(() => {});
    } finally {
        if (created) busySessions.delete(created);
    }
}

// нажатие встроенной кнопки: те же действия, что у обычной, плюс перерисовка
// пометки на самом письме, под которым нажали
async function handleCallback(query) {
    const chatId = String(query.message?.chat?.id ?? query.from?.id ?? '');
    if (!users.includes(chatId)) return;
    const button = BUTTONS.find((b) => `btn:${b.label}` === query.data);
    if (!button) {
        await callApi('answerCallbackQuery', { callback_query_id: query.id }).catch(() => {});
        return;
    }
    const reply = pressButton(chatId, button);
    await callApi('answerCallbackQuery', { callback_query_id: query.id, text: reply.split('\n')[0].slice(0, 200) }).catch(() => {});
    if (query.message?.message_id) {
        await callApi('editMessageReplyMarkup', {
            chat_id: chatId,
            message_id: query.message.message_id,
            reply_markup: inlineKeyboardFor(chatId),
        }).catch(() => {}); // «не изменилась» — не ошибка
    }
    await send(chatId, reply, keyboardFor(chatId), { keepInline: true }).catch(() => {});
}

async function handleUpdate(update) {
    if (update.callback_query) { await handleCallback(update.callback_query); return; }
    const message = update.message;
    // человек дописал свой вариант в опрос — это ответ на вопрос, а не текст
    if (message?.poll_option_added) {
        await polls.handleOptionAdded(message);
        return;
    }
    if (!message || !message.text) return;

    const chatId = String(message.chat?.id ?? '');
    // чужим не отвечаем вовсе: бот виден всему миру, а по этому мосту можно
    // запускать агента в проекте — пускаем только перечисленные в .env id
    if (!users.includes(chatId)) return;

    // нажатие кнопки приходит её текстом: без перехвата слово «ASK» ушло бы
    // агенту настоящим поручением
    const button = pressedButton(message.text);
    if (button) {
        // ответ на нажатие несёт обычную клавиатуру: у неё метка выбора обновляется
        await send(chatId, pressButton(chatId, button), keyboardFor(chatId)).catch(() => {});
        return;
    }

    const replyTo = message.reply_to_message?.message_id;
    // текст ответом на сообщение с открытым опросом — свой вариант ответа
    if (await polls.handleReply(chatId, replyTo, message.text)) return;
    const repliedSession = replyTo && sessionByReply.get(chatId, Number(replyTo))?.sessionId;
    // после END сообщение начинает новую работу. Ответ reply на письмо старой
    // работы — по-прежнему в неё: человек сам назвал адресата
    if (!repliedSession && readChatState.get(chatId)?.fresh) {
        // после END сообщение — поручение без разбора «стоп / что там», но как
        // оно понято, человеку говорим так же
        const understood = await turnJudgment.classifyInbox(message.text).catch(() => null);
        await acknowledge(chatId, understood, null);
        await startNewSession(chatId, message.text, message.message_id);
        return;
    }
    const sessionId = repliedSession || liveLastSession(chatId);
    // отвечать некуда — значит, это поручение на новую работу, как после END
    if (!sessionId) {
        await acknowledge(chatId, await turnJudgment.classifyInbox(message.text).catch(() => null), null);
        await startNewSession(chatId, message.text, message.message_id);
        return;
    }

    // не всякое сообщение — поручение: «стоп», «что там» и «спасибо» раньше
    // запускали настоящий ход, то есть тратили деньги владельца и занимали
    // очередь. Неуверенный ответ означает поручение — как мост вёл себя всегда
    // (DOCS/decisions/054)
    const understood = await turnJudgment.classifyInbox(message.text).catch(() => ({ intent: 'task' }));
    const { intent } = understood;
    if (intent !== 'task') {
        await send(chatId, answerWithoutTurn(intent, sessionId)).catch(() => {});
        return;
    }
    // занятая работа поручение не примет — «приступаю» было бы неправдой
    if (!busySessions.has(sessionId) && !deps.isRunning(sessionId)) await acknowledge(chatId, understood, sessionId);

    await runInSession(chatId, sessionId, message.text);
}

// Сколько ответ на опрос ждёт, пока сессия освободится. Вопрос задают изнутри
// идущего хода, и человек успевает ответить раньше, чем ход закончится, —
// терять такой ответ нельзя, а второй ход поверх первого запускать тоже
const IDLE_WAIT_MS = 10 * 60 * 1000;
const IDLE_CHECK_MS = 2000;

// Слова человека уходят в сессию настоящим ходом. Общий путь и для обычного
// сообщения, и для ответа на опрос (telegram-polls-server.js)
async function runInSession(chatId, sessionId, text, { waitIdle = false } = {}) {
    if (waitIdle) {
        const deadline = Date.now() + IDLE_WAIT_MS;
        while ((busySessions.has(sessionId) || deps.isRunning(sessionId)) && Date.now() < deadline) await sleep(IDLE_CHECK_MS);
    }
    // busySessions знает только ходы, начатые отсюда; ход той же сессии из
    // браузера виден через deps.isRunning — второй поверх него не запускаем
    if (busySessions.has(sessionId) || deps.isRunning(sessionId)) {
        // ответ на опрос, не дождавшийся свободной сессии, называем дословно:
        // опрос уже закрыт, и без этого выбор человека пропал бы молча
        const note = waitIdle
            ? `⏳ Работа всё ещё выполняется, и ваш ответ «${text.slice(0, 300)}» агенту не передан. Ответьте на это письмо, когда она закончится, — ответ уйдёт в неё же.`
            : '⏳ Эта работа ещё выполняется — дождитесь её ответа. Остановить её можно словом «стоп».';
        await send(chatId, note).then((sent) => remember(chatId, sent.message_id, sessionId)).catch(() => {});
        return;
    }

    busySessions.add(sessionId);
    try {
        // ответ придёт сюда же сам: закончившийся ход снова позовёт notifyTurnFinished
        // note — что сервер хочет сказать человеку по дороге (заменил агента)
        // промежуточные письма привязываем к сессии: ответ reply на строку
        // плана («нет, я имел в виду другое») должен уйти в эту же работу
        await deps.ask({
            sessionId,
            text,
            note: (line) => { send(chatId, line).then((sent) => remember(chatId, sent.message_id, sessionId)).catch(() => {}); },
        });
    } catch (err) {
        // сессию могли удалить из пульта уже после того, как человек прочитал
        // её ответ, — «Session not found» в личке выглядит поломкой моста,
        // хотя мост исправен. Говорим, что случилось на самом деле
        // слова человека до агента не дошли — говорим какие и почему, и
        // привязываем это письмо к сессии: ответ на него уйдёт туда же
        let reply = letters.undeliveredLetter(text, err.message);
        if (/session not found/i.test(err.message)) {
            // и забываем её: иначе сообщение без reply снова и снова
            // отправлялось бы в ту же несуществующую сессию
            forgetSession.run(sessionId);
            reply = '🗑 Эта работа удалена из пульта — отвечать в неё больше некуда. Следующее сообщение уйдёт в предыдущую работу, а новую начните из пульта.';
        }
        await send(chatId, reply)
            .then((sent) => { if (!/session not found/i.test(err.message)) remember(chatId, sent.message_id, sessionId); })
            .catch(() => {});
    } finally {
        busySessions.delete(sessionId);
    }
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// Сколько простоя ещё считается перезапуском, а не «сервер лежал полдня».
// Внутри окна мост продолжает очередь с сохранённой позиции и разбирает всё,
// что человек прислал, пока процесс поднимался; за окном — по-прежнему
// выбрасывает хвост, иначе разом запустится ход на каждое старое сообщение
const RESUME_WINDOW_MS = 15 * 60 * 1000;

function resumeOffset() {
    const row = readOffset.get();
    if (!row) return null;
    const age = Date.now() - Date.parse(row.at);
    if (!Number.isFinite(age) || age > RESUME_WINDOW_MS) return null;
    return row.value;
}

async function pollLoop(myRun) {
    while (pollRun === myRun) {
        try {
            const startedAt = Date.now();
            pollAbort = new AbortController();
            // первый заход только узнаёт хвост очереди (offset: -1, без ожидания)
            if (offset === null) offset = resumeOffset();
            const skipping = offset === null;
            const updates = await callApi(
                'getUpdates',
                skipping
                    ? { offset: -1, timeout: 0, allowed_updates: ALLOWED_UPDATES }
                    : { offset, timeout: POLL_TIMEOUT_S, allowed_updates: ALLOWED_UPDATES },
                skipping ? 15000 : (POLL_TIMEOUT_S + 15) * 1000,
                pollAbort.signal,
            );
            if (pollRun !== myRun) return; // опрос сменили, пока запрос висел
            conflictSince = null;
            lastError = null;
            if (skipping) {
                offset = updates?.length ? updates[updates.length - 1].update_id + 1 : 0;
                saveOffset.run(offset, new Date().toISOString());
                continue;
            }
            for (const update of updates || []) {
                offset = update.update_id + 1;
                // позицию запоминаем до разбора: ход идёт часами, а перезапуск
                // может случиться в любую секунду — переразобрать одно и то же
                // сообщение хуже, чем потерять его
                saveOffset.run(offset, new Date().toISOString());
                // ход может идти часами — опрос его не ждёт, иначе следующие
                // сообщения человека молча копились бы до конца работы
                const handled = update.poll_answer ? polls.handlePollAnswer(update.poll_answer) : handleUpdate(update);
                handled.catch((err) => { lastError = err.message; });
            }
            // длинный опрос обязан висеть до POLL_TIMEOUT_S, но между нами и
            // Telegram бывает прокси, который отвечает пустотой сразу же —
            // без этой паузы цикл превратился бы в холостую молотилку
            if (Date.now() - startedAt < 1000) await sleep(1000);
        } catch (err) {
            if (pollRun !== myRun) return; // ключ сменили прямо во время запроса
            if (!/conflict/i.test(err.message)) {
                conflictSince = null;
                lastError = err.message;
                await sleep(POLL_RETRY_MS);
                continue;
            }
            if (conflictSince === null) conflictSince = Date.now();
            const handover = Date.now() - conflictSince < CONFLICT_GRACE_MS;
            lastError = handover ? null : CONFLICT_HINT;
            await sleep(handover ? CONFLICT_RETRY_MS : CONFLICT_IDLE_MS);
        }
    }
}

function stopPolling() {
    pollRun += 1;           // всё, что крутилось до этого, больше не наше
    pollAbort?.abort();
    pollAbort = null;
}

// накопившееся за время простоя не разгребаем: сессии тех сообщений давно
// закончились, а отвечать на позавчерашнее «ок» новым ходом — сюрприз.
// Сам пропуск делает первая итерация цикла (offset = null)
function startPolling() {
    stopPolling();
    offset = null;
    conflictSince = null; // новый опрос — новая пересменка, чужой счётчик ему не судья
    pollLoop(pollRun);
}

// ---------- подключение ----------

async function connect() {
    const me = await callApi('getMe');
    botName = me.username ? `@${me.username}` : me.first_name || 'bot';
    lastError = null;
    startPolling();
    showKeyboard();
}

function init(dependencies) {
    deps = { ...deps, ...dependencies };
    initDb(deps.db);
    polls = pollsModule.create({
        database: deps.db,
        callApi,
        users: () => users,
        runInSession,
        sessionExists: (id) => deps.sessionExists(id),
        remember,
        inlineKeyboardFor,
        moveInline,
        isBottomInline,
    });
    token = process.env[TOKEN_KEY] || '';
    users = parseUsers(process.env[USERS_KEY]);
    // ключ из .env уже есть — мост поднимается вместе с сервером, без захода
    // в Settings: иначе после перезапуска уведомления молча пропадали бы
    if (token) {
        connect().catch((err) => {
            lastError = err.message;
            console.error('Telegram getMe:', err.message);
        });
    }
    return { notifyTurnFinished, askPreamble, planPreamble, tell };
}

// короткая служебная строка всем людям из списка (сервер сменил исполнителя).
// Без await у зовущего и без исключений наружу: это не должно задерживать ход
function tell(text) {
    if (!token) return;
    for (const chatId of users) send(chatId, text).catch((err) => { sendError = err.message; });
}

// приставка про блок [ASK] нужна агенту, только когда опрос есть кому слать
// Приставка к поручению, пришедшему из Telegram: человек с телефона не видит
// работы агента, поэтому агент первой строкой говорит, как понял поручение, —
// пульт ловит строку вживую и пересылает (runTurn.planFeed в server.js).
// Написана как правило оформления: слабая модель принимала приставку за задание
const PLAN_PREAMBLE = '[OpenKarandash — обязательное правило начала ответа] '
    + 'Человек пишет с телефона и не видит твоей работы. СНАЧАЛА, до первого вызова любого инструмента, выведи текстом одну строку: '
    + '«[PLAN] » и одна-две короткие фразы на языке человека — как ты понял поручение и что сейчас сделаешь. '
    + 'Пульт сразу перешлёт её человеку, чтобы он убедился, что понят верно. Только после этой строки берись за инструменты и работай как обычно. '
    + 'Поручение человека — ниже.\n\n';
function planPreamble() {
    return PLAN_PREAMBLE;
}

function askPreamble() {
    return token && users.length ? pollsModule.ASK_PREAMBLE : '';
}

// ---------- маршруты ----------

function createRoutes() {
    return {
        ...polls.routes,
        '/api/telegram/state': async (req, res) => {
            sendJson(res, state());
        },

        // лента вкладки Telegram (#telegramMessages): те же сообщения, что
        // ушли человеку notifyTurnFinished'ом — последний ответ каждой
        // завершившейся сессии, самые свежие снизу
        '/api/fragment/telegram-messages': (req, res) => {
            // из базы приходят новые сверху (см. listSent) — переворачиваем
            // для отображения: старые сверху, самое свежее внизу, как в чате
            const list = listSent.all(SENT_MEMORY).reverse().map((m) => ({
                ...m,
                when: formatWhen(m.at),
            }));
            sendHtml(res, eta.render('telegram-messages', { messages: list }));
        },

        // сохранение автоматическое: клиент шлёт оба поля на каждую правку.
        // tokenMask вместо ключа означает «поле не трогали»
        '/api/telegram/save': async (req, res) => {
            const body = await readJson(req);

            const nextUsers = parseUsers(body.users);
            const badUser = nextUsers.find((id) => !USER_RE.test(id));
            if (badUser) {
                sendJson(res, { ...state(), ok: false, error: `Not a Telegram id: ${badUser}` });
                return;
            }

            const incoming = typeof body.token === 'string' ? body.token.trim() : null;
            const keepToken = incoming === null || incoming === maskToken(token);
            if (!keepToken && incoming && !TOKEN_RE.test(incoming)) {
                sendJson(res, { ...state(), ok: false, error: 'Token looks wrong — expected 123456789:AA...' });
                return;
            }

            users = nextUsers;
            deps.setEnvValue(USERS_KEY, users.join(','));
            // новому человеку в списке кнопки показываем сразу
            if (token && botName) showKeyboard();

            // ключ прежний, а моста нет — getMe не прошёл при старте (не было
            // сети). Пробуем ещё раз прямо отсюда: иначе поднять мост можно было
            // бы только перенабрав ключ заново
            if (keepToken && token && !botName) {
                try {
                    await connect();
                } catch (err) {
                    lastError = err.message;
                    sendJson(res, { ...state(), ok: false, error: err.message });
                    return;
                }
            }

            if (!keepToken) {
                token = incoming;
                deps.setEnvValue(TOKEN_KEY, token);
                botName = null;
                stopPolling();
                if (!token) {
                    lastError = null;
                    sendJson(res, state());
                    return;
                }
                try {
                    await connect();
                } catch (err) {
                    lastError = err.message;
                    sendJson(res, { ...state(), ok: false, error: err.message });
                    return;
                }
            }

            sendJson(res, state());
        },
    };
}

// Уходящий процесс отпускает опрос сам (зовётся из confirmRestart в server.js).
// Перезапуск тут не редкость: сторож поднимает сервер заново на каждой правке
// серверного файла.
//
// Оборвать сокет мало. Telegram не считает getUpdates законченным оттого, что
// клиент отвалился, — опрос живёт на его стороне до своего таймаута, то есть
// ещё до POLL_TIMEOUT_S после смерти процесса. Всё это время следующий наш
// запуск получает Conflict, и красная строка про «ключ опрашивает кто-то ещё»
// оказывается рассказом о нас самих.
//
// Снять висящий опрос может только новый getUpdates на тот же ключ — он
// обрывает предыдущий. Поэтому уходим не молча: шлём короткий запрос без
// ожидания (timeout: 0), он рвёт наш же длинный опрос и возвращается сразу,
// не оставляя очереди за собой. offset: -1 ничего не подтверждает — что делать
// с накопившимся, решит следующий процесс (он его пропускает).
//
// Ждать ответа обязан тот, кто зовёт: без await процесс умрёт раньше запроса
async function stop() {
    stopPolling();
    if (!token) return;
    try {
        await callApi('getUpdates', { offset: -1, timeout: 0 }, RELEASE_TIMEOUT_MS);
    } catch (err) {
        // уходящему процессу уже всё равно: не отпустили — переживём пересменку
        console.error('Telegram release:', err.message);
    }
}

// handleUpdate наружу — только для проверки на поддельных обновлениях, без сети
module.exports = { init, createRoutes, stop, handleUpdate };
