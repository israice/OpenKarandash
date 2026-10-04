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
const createDb = require('./telegram-db-server.js');
const createTransport = require('./telegram-transport-server.js');
const createKeyboard = require('./telegram-keyboard-server.js');
const createPolling = require('./telegram-poll-server.js');
const createInbox = require('./telegram-inbox-server.js');
const pollsModule = require('./telegram-polls-server.js');
const letters = require('./telegram-letters-server.js');

// свой экземпляр Eta со своей папкой шаблонов (см. «Серверные фрагменты» в
// AGENTS.md): cache:false — правка .eta подхватывается без перезапуска
const eta = new Eta({ views: __dirname, cache: false });
const TOKEN_KEY = 'TELEGRAM_BOT_TOKEN';
const USERS_KEY = 'TELEGRAM_USER_IDS';

const RELEASE_TIMEOUT_MS = 3000; // отпускание опроса на выходе: перезапуск не ждёт недоступный Telegram

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
// поэтому не дошедшее до человеку уведомление не оставляло следа нигде
let sendError = null;

// части моста. Собираются в init, когда есть база и ядро; до этого — null
let db = null;
let callApi = null;
let keyboard = null;
let polling = null;
let inbox = null;

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
                // встроенные кнопки — только у нижнего письма; replyMarkup нужен
                // лишь для снятия старой обычной клавиатуры (showKeyboard)
                reply_markup: replyMarkup || keyboard.inlineKeyboardFor(chatId),
            });
            // keepInline: сообщение с обычной клавиатурой (ответ на нажатие) не
            // должно снимать кнопки с нижнего письма — иначе после нажатия их нет нигде
            if (!(replyMarkup && keepInline)) keyboard.moveInline(chatId, replyMarkup ? null : sent.message_id);
            return sent;
        } catch (err) {
            // «Telegram answered …» и текст его описания — это ответ сервиса,
            // а не сбой связи: сеть отработала, повторять нечего
            const answered = /Telegram answered|chat not found|bot was blocked|Forbidden/i.test(err.message);
            if (answered || attempt >= SEND_RETRY_DELAYS_MS.length) throw err;
            await polling.sleep(SEND_RETRY_DELAYS_MS[attempt]);
        }
    }
}


// ---------- отправка: последний ответ завершившейся сессии ----------

// Зовётся из runTurn (SYSTEM/core/run-turn.js) без await: телеграм не должен ни задерживать
// ход, ни ронять его своей ошибкой — поэтому внутри всё под try/catch
// с какой уверенности jev «ход ждёт человека» список в конце ответа считаем
// вариантами вопроса; высоко — ошибка превращает отчёт в опрос
const LOOSE_ASK_CONFIDENCE = 0.8;

async function notifyTurnFinished({ sessionId, title, text, errorText, steps, awaitsHuman }) {
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
    // блока нет, но jev уверен, что ход ждёт человека, и ответ кончается
    // вопросом со списком — это тот же вопрос, просто агент забыл про блок
    const ask = pollsModule.parseAsk(text)
        || ((awaitsHuman ?? 0) >= LOOSE_ASK_CONFIDENCE ? pollsModule.parseLooseAsk(text) : null);
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
    db.rememberSent(sessionId, head, body);

    for (const chatId of users) {
        try {
            const result = await send(chatId, message);
            db.remember(chatId, result.message_id, sessionId);
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



// ---------- подключение ----------

async function connect() {
    const me = await callApi('getMe');
    botName = me.username ? `@${me.username}` : me.first_name || 'bot';
    lastError = null;
    polling.start();
    keyboard.showKeyboard();
}

// Сборка моста. Порядок важен: база → транспорт → кнопки → приём → опросы →
// длинный опрос. Опросы создаются последними, потому что приём отдаёт им свои
// runInSession и кнопки, а идти в Telegram начинает только connect ниже.
function init(dependencies) {
    deps = { ...deps, ...dependencies };
    db = createDb(deps.db);
    // ключ приходит функцией, а не значением: человек может сменить его прямо
    // в окне настроек, и следующий запрос должен уйти уже с новым
    ({ callApi } = createTransport(() => token));
    keyboard = createKeyboard({
        callApi,
        send,
        db,
        getUsers: () => users,
        onSendError: (message) => { sendError = message; },
    });
    polling = createPolling({
        callApi,
        db,
        onError: (message) => { lastError = message; },
        // голос в опросе — отдельный вход приёма: у него нет ни текста, ни чата
        handleUpdate: Object.assign((update) => inbox.handleUpdate(update), {
            pollAnswer: (answer) => polls.handlePollAnswer(answer),
        }),
    });
    inbox = createInbox({
        callApi,
        send,
        db,
        getUsers: () => users,
        keyboard,
        letters,
        turnJudgment,
        sleep: polling.sleep,
        deps,
    });
    polls = pollsModule.create({
        database: deps.db,
        callApi,
        users: () => users,
        runInSession: inbox.runInSession,
        sessionExists: (id) => deps.sessionExists(id),
        remember: db.remember,
        inlineKeyboardFor: keyboard.inlineKeyboardFor,
        moveInline: keyboard.moveInline,
        isBottomInline: keyboard.isBottomInline,
    });
    inbox.setPolls(polls);
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
    return { notifyTurnFinished, planPreamble, tell };
}

// короткая служебная строка всем людям из списка (сервер сменил исполнителя).
// Без await у зовущего и без исключений наружу: это не должно задерживать ход
function tell(text) {
    if (!token) return;
    for (const chatId of users) send(chatId, text).catch((err) => { sendError = err.message; });
}

const PLAN_PREAMBLE = '[OpenKarandash — обязательное правило начала ответа] '
    + 'Человек пишет с телефона и не видит твоей работы. СНАЧАЛА, до первого вызова любого инструмента, выведи текстом одну строку: '
    + '«[PLAN] » и одна-две короткие фразы на языке человека — как ты понял поручение и что сейчас сделаешь. '
    + 'Пульт сразу перешлёт её человеку, чтобы он убедился, что понят верно. Только после этой строки берись за инструменты и работай как обычно. '
    + 'Поручение человека — ниже.\n\n';
function planPreamble() {
    return PLAN_PREAMBLE;
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
            const list = db.listSent.all(db.SENT_MEMORY).reverse().map((m) => ({
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
            if (token && botName) keyboard.showKeyboard();

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
                polling.stop();
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

// Уходящий процесс отпускает опрос сам (зовётся из confirmRestart в SYSTEM/core/runs.js).
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
    polling.stop();
    if (!token) return;
    try {
        await callApi('getUpdates', { offset: -1, timeout: 0 }, RELEASE_TIMEOUT_MS);
    } catch (err) {
        // уходящему процессу уже всё равно: не отпустили — переживём пересменку
        console.error('Telegram release:', err.message);
    }
}

// handleUpdate наружу — только для проверки на поддельных обновлениях, без сети
module.exports = {
    init,
    createRoutes,
    stop,
    handleUpdate: (...args) => inbox.handleUpdate(...args),
};
