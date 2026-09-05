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

const { readJson, sendJson } = require('../../SYSTEM/core/http.js');

const TOKEN_KEY = 'TELEGRAM_BOT_TOKEN';
const USERS_KEY = 'TELEGRAM_USER_IDS';

const API = 'https://api.telegram.org/bot';
const POLL_TIMEOUT_S = 50;      // длинный опрос: ответ приходит сразу, как только есть сообщение
const POLL_RETRY_MS = 5000;     // сеть отвалилась — не долбим Telegram в цикле
const CONFLICT_RETRY_MS = 2000; // пересменка: ключ отвоёвывается быстрее обычной ошибки
const CONFLICT_GRACE_MS = 30000;// столько длится пересменка — столько молчим про драку
const CONFLICT_IDLE_MS = 60000; // дальше не тянем ключ на себя каждые две секунды
const TEXT_LIMIT = 3500;        // у Telegram потолок 4096 на сообщение, остальное — заголовок
const MESSAGE_MEMORY = 500;     // сколько наших сообщений помним для ответа reply

// вид ключа бота: «<цифры>:<буквенный хвост>». Проверяем до сети, чтобы очевидная
// опечатка не превращалась в загадочный отказ Telegram
const TOKEN_RE = /^\d{5,}:[A-Za-z0-9_-]{20,}$/;
const USER_RE = /^-?\d+$/;

let deps = { setEnvValue: () => {}, ask: null };

let token = '';
let users = [];        // кому шлём и от кого принимаем — остальные для бота не существуют
let botName = null;    // имя из getMe: им же подтверждается, что ключ рабочий
let lastError = null;
let offset = 0;

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

// какое наше сообщение относилось к какой сессии: ответ (reply) в Telegram
// возвращает человека ровно в ту сессию, чей результат он прочитал.
// Ключ — «чат:сообщение», потому что id сообщений в Telegram свои у каждого
// чата: по одному числу ответы двух людей попадали бы в чужие сессии
const sessionByMessage = new Map();
// а обычное сообщение без reply уходит в последнюю, о которой мы писали
const lastSessionByChat = new Map();

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
        error: lastError,
    };
}

// ---------- разговор с Telegram ----------

async function callApi(method, payload, timeoutMs = 15000, extraSignal = null) {
    if (!token) throw new Error('Telegram bot token is not set');
    // extraSignal — способ оборвать длинный опрос досрочно: по нему сменившийся
    // ключ отпускает getUpdates сразу, а не через минуту ожидания
    const timeout = AbortSignal.timeout(timeoutMs);
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
    sessionByMessage.set(`${chatId}:${messageId}`, sessionId);
    // Map хранит порядок вставки — самые старые записи уходят первыми
    while (sessionByMessage.size > MESSAGE_MEMORY) {
        sessionByMessage.delete(sessionByMessage.keys().next().value);
    }
}

async function send(chatId, text) {
    const result = await callApi('sendMessage', {
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
    });
    return result;
}

// ---------- отправка: последний ответ завершившейся сессии ----------

// Зовётся из runTurn (server.js) без await: телеграм не должен ни задерживать
// ход, ни ронять его своей ошибкой — поэтому внутри всё под try/catch
async function notifyTurnFinished({ sessionId, title, text }) {
    if (!token || !users.length || !text) return;
    const head = title ? `✅ ${title}` : '✅ Done';
    const body = text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT)}…` : text;
    const message = `${head}\n\n${body}`;

    for (const chatId of users) {
        try {
            const result = await send(chatId, message);
            remember(chatId, result.message_id, sessionId);
            lastSessionByChat.set(chatId, sessionId);
            lastError = null;
        } catch (err) {
            lastError = err.message;
            console.error('Telegram sendMessage:', err.message);
        }
    }
}

// ---------- приём: ответ человека возвращается в ту же сессию ----------

// ход из Telegram идёт долго, а опрос его не ждёт — значит, на одну сессию
// может прилететь второе сообщение поверх незаконченного первого. Такие
// не запускаем: в сессии должен идти один ход за раз
const busySessions = new Set();

async function handleUpdate(update) {
    const message = update.message;
    if (!message || !message.text) return;

    const chatId = String(message.chat?.id ?? '');
    // чужим не отвечаем вовсе: бот виден всему миру, а по этому мосту можно
    // запускать агента в проекте — пускаем только перечисленные в .env id
    if (!users.includes(chatId)) return;

    const replyTo = message.reply_to_message?.message_id;
    const sessionId = (replyTo && sessionByMessage.get(`${chatId}:${replyTo}`)) || lastSessionByChat.get(chatId);
    if (!sessionId) {
        await send(chatId, 'No session to continue yet — it appears here after the first finished run.').catch(() => {});
        return;
    }

    if (busySessions.has(sessionId)) {
        await send(chatId, '⏳ This session is still working — wait for its answer.').catch(() => {});
        return;
    }

    busySessions.add(sessionId);
    try {
        // ответ придёт сюда же сам: закончившийся ход снова позовёт notifyTurnFinished
        await deps.ask({ sessionId, text: message.text });
    } catch (err) {
        await send(chatId, `⚠️ ${err.message}`).catch(() => {});
    } finally {
        busySessions.delete(sessionId);
    }
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollLoop(myRun) {
    while (pollRun === myRun) {
        try {
            const startedAt = Date.now();
            pollAbort = new AbortController();
            const updates = await callApi(
                'getUpdates',
                { offset, timeout: POLL_TIMEOUT_S, allowed_updates: ['message'] },
                (POLL_TIMEOUT_S + 15) * 1000,
                pollAbort.signal,
            );
            if (pollRun !== myRun) return; // опрос сменили, пока запрос висел
            conflictSince = null;
            lastError = null;
            for (const update of updates || []) {
                offset = update.update_id + 1;
                // ход может идти часами — опрос его не ждёт, иначе следующие
                // сообщения человека молча копились бы до конца работы
                handleUpdate(update).catch((err) => { lastError = err.message; });
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
// закончились, а отвечать на позавчерашнее «ок» новым ходом — сюрприз
async function startPolling() {
    stopPolling();
    const myRun = pollRun;
    offset = 0;
    try {
        const backlog = await callApi('getUpdates', { offset: -1, timeout: 0 });
        if (backlog?.length) offset = backlog[backlog.length - 1].update_id + 1;
    } catch { /* не вышло — начнём с того, что придёт дальше */ }
    if (pollRun !== myRun) return;
    pollLoop(myRun);
}

// ---------- подключение ----------

async function connect() {
    const me = await callApi('getMe');
    botName = me.username ? `@${me.username}` : me.first_name || 'bot';
    lastError = null;
    startPolling();
}

function init(dependencies) {
    deps = { ...deps, ...dependencies };
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
        '/api/telegram/state': async (req, res) => {
            sendJson(res, state());
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

module.exports = { init, createRoutes };
