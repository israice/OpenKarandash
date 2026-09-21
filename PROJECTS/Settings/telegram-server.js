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

// свой экземпляр Eta со своей папкой шаблонов (см. «Серверные фрагменты» в
// AGENTS.md): cache:false — правка .eta подхватывается без перезапуска
const eta = new Eta({ views: __dirname, cache: false });
// ВРЕМЕННО: дневник опроса — понять, откуда берётся Conflict
const fsDiag = require('fs');
const diagStart = Date.now();
function diag(text) {
    try {
        fsDiag.appendFileSync('DATA/telegram-poll.log',
            `${new Date().toISOString()} pid=${process.pid} +${Math.round((Date.now() - diagStart) / 1000)}s ${text}\n`);
    } catch { /* дневник не должен ронять мост */ }
}

const TOKEN_KEY = 'TELEGRAM_BOT_TOKEN';
const USERS_KEY = 'TELEGRAM_USER_IDS';

const API = 'https://api.telegram.org/bot';
// poll_answer — голос в опросе-вопросе (telegram-polls-server.js); без явного списка
// Telegram присылал бы и то, что мосту не нужно
const ALLOWED_UPDATES = ['message', 'poll_answer'];
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
const TEXT_LIMIT = 3500;        // у Telegram потолок 4096 на сообщение, остальное — заголовок
const MESSAGE_MEMORY = 500;     // сколько наших сообщений помним для ответа reply

// Кнопки под полем ввода (ReplyKeyboardMarkup), а не под сообщением: такая
// клавиатура видна человеку всё время, а не только у последнего письма, и за
// нажатие не нужно отчитываться answerCallbackQuery. Нажатие приходит обычным
// текстом кнопки — поэтому handleUpdate перехватывает эти слова раньше, чем
// они успеют стать поручением. Логики у кнопок пока нет
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
const KEYBOARD = {
    keyboard: [BUTTONS.map(({ text, style }) => (style ? { text, style } : { text }))],
    resize_keyboard: true,  // без этого одна строка кнопок растянута на высоту обычной клавиатуры
    is_persistent: true,    // не прячется после нажатия
    input_field_placeholder: 'Ответ агенту или кнопка ниже',
};
// нажатие приходит текстом кнопки вместе с эмодзи; голое слово, набранное
// руками, считаем тем же нажатием
function pressedButton(text) {
    const value = String(text || '').trim();
    return BUTTONS.find((b) => b.text === value || b.label === value.toUpperCase()) || null;
}
// клавиатуру Telegram показывает только вместе с сообщением. Чтобы человек
// увидел её сразу, а не с ближайшим отчётом, шлём одно письмо — и помним, кому
// какой набор уже показан: перезапуск сервера не должен слать его заново.
// Сменился набор кнопок — поднять номер
const KEYBOARD_VERSION = 3;

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
let trimReplies = null;
let forgetSession = null;
let saveOffset = null;
let readOffset = null;
let saveKeyboard = null;
let readKeyboard = null;

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
    database.exec('CREATE TABLE IF NOT EXISTS telegram_keyboard (chat_id TEXT PRIMARY KEY, version INTEGER NOT NULL, at TEXT NOT NULL);');
    saveKeyboard = database.prepare('INSERT INTO telegram_keyboard (chat_id, version, at) VALUES (?, ?, ?) ON CONFLICT(chat_id) DO UPDATE SET version = excluded.version, at = excluded.at');
    readKeyboard = database.prepare('SELECT version FROM telegram_keyboard WHERE chat_id = ?');
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
// send успевали истечь по таймауту — при исправном Telegram. Поймано на
// журнале: «send ok» случался через 0,2 с после «ok run=… took=50074ms»
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

function remember(chatId, messageId, sessionId) {
    rememberReply.run(String(chatId), Number(messageId), sessionId, new Date().toISOString());
    trimReplies.run(MESSAGE_MEMORY); // старое подчищаем сразу, как и у истории выше
}

// Отправка с повторами. Без них один таймаут сети терял уведомление навсегда:
// ход закончен, в истории вкладки запись есть, а в личке у человека ничего —
// и он узнаёт об этом, только не дождавшись. Повторяем всё, кроме отказов
// самого Telegram (заблокировал бота, неверный чат): их повтор не исправит
const SEND_RETRY_DELAYS_MS = [1000, 4000];

async function send(chatId, text) {
    for (let attempt = 0; ; attempt += 1) {
        try {
            const sendStarted = Date.now();
            const sent = await callApi('sendMessage', {
                chat_id: chatId,
                text,
                disable_web_page_preview: true,
                // с каждым письмом: убранную человеком клавиатуру вернёт
                // ближайшее же сообщение
                reply_markup: KEYBOARD,
            });
            diag(`send ok attempt=${attempt} took=${Date.now() - sendStarted}ms`);
            return sent;
        } catch (err) {
            // «Telegram answered …» и текст его описания — это ответ сервиса,
            // а не сбой связи: сеть отработала, повторять нечего
            const answered = /Telegram answered|chat not found|bot was blocked|Forbidden/i.test(err.message);
            diag(`send err attempt=${attempt} msg=${err.message} cause=${err.cause?.code || err.cause?.message || '-'}`);
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
            await send(chatId, `⌨️ Кнопки пульта: ${BUTTONS.map((b) => b.text).join(' · ')}. Пока они ничего не делают.`);
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
async function notifyTurnFinished({ sessionId, title, text }) {
    if (!token || !users.length || !text) return;
    const head = title ? `✅ ${title}` : '✅ Done';
    const body = text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT)}…` : text;
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

async function handleUpdate(update) {
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

    // нажатие кнопки приходит её текстом. Логики у кнопок пока нет, а без
    // перехвата слово «ASK» ушло бы агенту настоящим поручением
    const button = pressedButton(message.text);
    if (button) {
        await send(chatId, `${button.text} — кнопка пока ничего не делает.`).catch(() => {});
        return;
    }

    const replyTo = message.reply_to_message?.message_id;
    // текст ответом на сообщение с открытым опросом — свой вариант ответа
    if (await polls.handleReply(chatId, replyTo, message.text)) return;
    const sessionId = (replyTo && sessionByReply.get(chatId, Number(replyTo))?.sessionId)
        || lastSessionOfChat.get(chatId)?.sessionId;
    if (!sessionId) {
        await send(chatId, 'No session to continue yet — it appears here after the first finished run.').catch(() => {});
        return;
    }

    // не всякое сообщение — поручение: «стоп», «что там» и «спасибо» раньше
    // запускали настоящий ход, то есть тратили деньги владельца и занимали
    // очередь. Неуверенный ответ означает поручение — как мост вёл себя всегда
    // (DOCS/decisions/054)
    const { intent } = await turnJudgment.classifyInbox(message.text).catch(() => ({ intent: 'task' }));
    if (intent !== 'task') {
        await send(chatId, answerWithoutTurn(intent, sessionId)).catch(() => {});
        return;
    }

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
    if (busySessions.has(sessionId)) {
        await send(chatId, '⏳ This session is still working — wait for its answer.').catch(() => {});
        return;
    }

    busySessions.add(sessionId);
    try {
        // ответ придёт сюда же сам: закончившийся ход снова позовёт notifyTurnFinished
        await deps.ask({ sessionId, text });
    } catch (err) {
        // сессию могли удалить из пульта уже после того, как человек прочитал
        // её ответ, — «Session not found» в личке выглядит поломкой моста,
        // хотя мост исправен. Говорим, что случилось на самом деле
        let text = `⚠️ ${err.message}`;
        if (/session not found/i.test(err.message)) {
            // и забываем её: иначе сообщение без reply снова и снова
            // отправлялось бы в ту же несуществующую сессию
            forgetSession.run(sessionId);
            text = '🗑 Эта сессия удалена из пульта — отвечать в неё больше некуда. Следующее сообщение уйдёт в предыдущую сессию, а новую работу начните из пульта.';
        }
        await send(chatId, text).catch(() => {});
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
            diag(`ok run=${myRun} skipping=${skipping} took=${Date.now() - startedAt}ms n=${updates?.length ?? 0}`);
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
            diag(`err run=${myRun} pollRun=${pollRun} msg=${err.message}`);
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
    diag(`stopPolling from ${new Error().stack.split('\n')[2].trim()}`);
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
    diag('connect()');
    const me = await callApi('getMe');
    botName = me.username ? `@${me.username}` : me.first_name || 'bot';
    lastError = null;
    startPolling();
    showKeyboard();
}

function init(dependencies) {
    deps = { ...deps, ...dependencies };
    initDb(deps.db);
    polls = require('./telegram-polls-server.js').create({
        database: deps.db,
        callApi,
        users: () => users,
        runInSession,
        sessionExists: (id) => deps.sessionExists(id),
        remember,
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
    return { notifyTurnFinished };
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

module.exports = { init, createRoutes, stop };
