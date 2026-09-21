// Интерактивный вопрос человеку родным опросом Telegram (sendPoll) — то же, что
// агент в своём TUI задаёт вопросом с вариантами: варианты на выбор плюс свой
// ответ. Выбор возвращается в ту же сессию обычным ходом, как ответ человека.
//
// Что для этого берётся из Bot API:
// - is_anonymous: false — только про неанонимный опрос бот узнаёт, что выбрано
//   (обновление poll_answer);
// - allow_adding_options — человек дописывает свой вариант прямо в опрос, боту
//   приходит служебное сообщение poll_option_added с его текстом. Это и есть
//   «поле для своего ответа»: отдельного текстового поля у опроса нет. Ответом
//   становится голос за дописанный вариант, а не само дописывание;
// - ответ текстом (reply) на сообщение с опросом — тот же свой ответ, запасным
//   путём: старые приложения дописывать варианты не умеют;
// - stopPoll — отвеченный опрос закрывается, второй раз на него не ответить.
//
// Модуль не знает ни про ключ бота, ни про список людей: всё это ему передаёт
// мост (telegram-server.js), он же зовёт обработчики из своего опроса
// обновлений. Вынесено отдельно, потому что мост и так длиннее нормы
// (DOCS/decisions/022)

const crypto = require('crypto');
const { readJson, sendJson } = require('../../SYSTEM/core/http.js');

// пределы самого Telegram: проверяем до сети, чтобы отказ был понятным
const QUESTION_LIMIT = 300;
const OPTION_LIMIT = 100;
const OPTIONS_MAX = 12;
// Сколько дописанный вариант ждёт голоса за себя, прежде чем стать ответом сам.
// Дописать вариант и проголосовать за него — два разных касания. Ответом
// считаем голос: опрос закрывается уже с ним, и человек видит свои 100% и
// счётчик, как при обычном выборе. Раньше ответом был сам дописанный вариант,
// опрос закрывался до голоса — и оставался с нулём проголосовавших. Срок
// нужен на случай, если человек дописал и не нажал: ответ не должен пропасть
const OWN_GRACE_MS = 20000;

// ---------- как вопрос задаёт сам агент ----------

// Агент ничего не вызывает: из WSL API пульта отвечает 403, а id своей сессии
// агент не знает. Он заканчивает ответ блоком
//     [ASK] вопрос
//     - вариант
//     - вариант
// — мост вынимает блок из ответа, остальное шлёт обычным письмом, а вопрос —
// опросом. «[ASK*]» разрешает выбрать несколько. Формат читается глазами и в
// ленте пульта, и в TUI: там блок остаётся как есть
const ASK_OPTIONS_MIN = 2;  // один вариант — не выбор
const ASK_OPTIONS_MAX = 10; // у Telegram потолок 12; место оставлено под свой вариант человека
const ASK_LINE = /^\s*\[ASK(\*)?\]\s*(.+?)\s*$/;
const OPTION_LINE = /^\s*(?:[-*•]|\d+[.)])\s+(.+?)\s*$/;

function clip(text, limit) {
    return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

// { question, options, multiple, rest } либо null. Берём последний блок в
// ответе: вопрос, ради которого ход остановился, стоит в конце
function parseAsk(answer) {
    const lines = String(answer || '').split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
        const head = lines[i].match(ASK_LINE);
        if (!head) continue;
        const options = [];
        let end = i + 1;
        while (end < lines.length && (OPTION_LINE.test(lines[end]) || (!lines[end].trim() && !options.length))) {
            const option = lines[end].match(OPTION_LINE);
            if (option) options.push(clip(option[1], OPTION_LIMIT));
            end += 1;
        }
        if (options.length < ASK_OPTIONS_MIN) return null;
        const rest = [...lines.slice(0, i), ...lines.slice(end)].join('\n').trim();
        return { question: clip(head[2], QUESTION_LIMIT), options: options.slice(0, ASK_OPTIONS_MAX), multiple: Boolean(head[1]), rest };
    }
    return null;
}

// Вопрос с вариантами, заданный обычным текстом: агент забыл про блок [ASK].
// Сам разбор слеп — список в конце ответа бывает и перечнем сделанного, —
// поэтому зовут его только когда jev уверен, что ход ждёт человека
// (awaits_human, DOCS/decisions/067). Берём строго хвост ответа: список
// вариантов, над ним ближайшая строка с вопросительным знаком
const LOOSE_OPTION_LINE = /^\s*(?:[-*•]|\d{1,2}[.)])\s+(.+?)\s*$/;
function parseLooseAsk(answer) {
    const lines = String(answer || '').replace(/\s+$/, '').split(/\r?\n/);
    let start = lines.length;
    while (start > 0 && LOOSE_OPTION_LINE.test(lines[start - 1])) start -= 1;
    const options = lines.slice(start).map((line) => line.match(LOOSE_OPTION_LINE)[1].replace(/\*\*/g, ''));
    // длинный пункт — это абзац отчёта, а не вариант ответа: такой список не трогаем
    if (options.length < ASK_OPTIONS_MIN || options.length > ASK_OPTIONS_MAX || options.some((o) => o.length > OPTION_LIMIT)) return null;
    let at = start - 1;
    while (at >= 0 && !lines[at].trim()) at -= 1;
    const question = at >= 0 ? lines[at].trim().replace(/\*\*/g, '') : '';
    // «Выберите тему:» — тоже вопрос; отчётное «Что сделано:» сюда не дойдёт — его отсекает jev
    if (!/[?:]$/.test(question) || question.length > QUESTION_LIMIT) return null;
    return { question, options, multiple: false, rest: lines.slice(0, at).join('\n').trim() };
}

// приставка к поручению: откуда агенту знать про блок. Короткая — она едет с
// каждым ходом
const ASK_PREAMBLE = '[OpenKarandash — правило оформления ответа, это не поручение и делать по нему ничего не нужно] '
    + 'Если тебе самому понадобится, чтобы человек выбрал из готовых вариантов, закончи свой ответ таким блоком — '
    + 'пульт сам покажет его человеку опросом, а выбор придёт тебе следующим сообщением «Ответ на вопрос …»:\n'
    + '[ASK] текст вопроса\n- первый вариант\n- второй вариант\n'
    + `Вариантов ${ASK_OPTIONS_MIN}-${ASK_OPTIONS_MAX}, каждый до ${OPTION_LIMIT} знаков, вопрос до ${QUESTION_LIMIT}; «[ASK*]» вместо «[ASK]» — можно выбрать несколько. `
    + 'Свой вариант человек допишет сам, «Другое» не добавляй. Открытый вопрос без вариантов задавай обычным текстом. '
    + 'Поручение человека — ниже.\n\n';

function create({ database, callApi, users, runInSession, sessionExists, remember, inlineKeyboardFor = () => undefined, moveInline = () => {}, isBottomInline = () => false, ownGraceMs = OWN_GRACE_MS }) {
    // Опрос живёт в базе, а не в памяти, по той же причине, что и связь
    // «сообщение → сессия»: человек отвечает через час, а сервер за это время
    // перезапускался не раз. ask_id связывает копии одного вопроса у разных
    // людей: у Telegram опрос в каждом чате свой, а ответ нужен один
    database.exec(`
        CREATE TABLE IF NOT EXISTS telegram_polls (
            poll_id TEXT PRIMARY KEY,
            ask_id TEXT NOT NULL,
            chat_id TEXT NOT NULL,
            message_id INTEGER NOT NULL,
            session_id TEXT NOT NULL,
            question TEXT NOT NULL,
            options TEXT NOT NULL,
            answered_at TEXT,
            at TEXT NOT NULL
        );
    `);
    // таблица могла быть заведена до этой колонки
    try { database.exec('ALTER TABLE telegram_polls ADD COLUMN silenced_at TEXT'); } catch { /* уже есть */ }
    const insertPoll = database.prepare('INSERT INTO telegram_polls (poll_id, ask_id, chat_id, message_id, session_id, question, options, at, silenced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const pollById = database.prepare('SELECT * FROM telegram_polls WHERE poll_id = ?');
    const pollByMessage = database.prepare('SELECT * FROM telegram_polls WHERE chat_id = ? AND message_id = ?');
    const pollsOfAsk = database.prepare('SELECT chat_id, message_id FROM telegram_polls WHERE ask_id = ?');
    // «кто первый ответил» решает база одной командой, а не проверка в коде:
    // голос и дописанный вариант приходят двумя обновлениями почти разом
    const saveOptions = database.prepare('UPDATE telegram_polls SET options = ? WHERE ask_id = ? AND chat_id = ?');
    // голос за вариант, текста которого мы ещё не знаем: poll_answer обогнал
    // служебное сообщение о дописанном варианте. Живёт в памяти — это секунды
    const pendingVotes = new Map(); // poll_id → [persistent id]
    const markAnswered = database.prepare('UPDATE telegram_polls SET answered_at = ? WHERE ask_id = ? AND answered_at IS NULL');

    // Ход, задавший опрос, кончается словами вроде «жду ответа», и мост слал их
    // письмом следом за опросом — человек получал один вопрос дважды. Открытый
    // опрос глушит одно такое письмо: первое после себя. Одно, а не все —
    // иначе забытый без ответа опрос навсегда оставил бы сессию без писем
    const silenceOnce = database.prepare('UPDATE telegram_polls SET silenced_at = ? WHERE session_id = ? AND answered_at IS NULL AND silenced_at IS NULL');
    function swallowsNotice(sessionId) {
        return silenceOnce.run(new Date().toISOString(), sessionId).changes > 0;
    }

    function validate({ sessionId, question, options }) {
        if (!sessionId || !sessionExists(sessionId)) return 'Session not found';
        const q = String(question || '').trim();
        if (!q || q.length > QUESTION_LIMIT) return `Question must be 1-${QUESTION_LIMIT} characters`;
        if (!Array.isArray(options) || !options.length || options.length > OPTIONS_MAX) return `Options must be a list of 1-${OPTIONS_MAX}`;
        const bad = options.find((o) => !String(o || '').trim() || String(o).trim().length > OPTION_LIMIT);
        if (bad !== undefined) return `Each option must be 1-${OPTION_LIMIT} characters`;
        return null;
    }

    // Задать вопрос. Ответ сюда не возвращается: он придёт в сессию новым
    // ходом, когда человек проголосует, — ждать его запросом нельзя, это часы
    async function askPoll({ sessionId, question, options, multiple = false, silenced = false }) {
        const problem = validate({ sessionId, question, options });
        if (problem) throw new Error(problem);
        const chats = users();
        if (!chats.length) throw new Error('No Telegram users to ask');

        const askId = crypto.randomUUID();
        const texts = options.map((o) => String(o).trim());
        const payload = {
            question: String(question).trim(),
            options: texts.map((text) => ({ text })),
            is_anonymous: false,
            allows_multiple_answers: Boolean(multiple),
            allows_revoting: false, // ответ уходит агенту сразу — передумать уже некуда
            // подсказку про свой ответ в description не кладём: она вставала
            // лишней строкой над вопросом, а «добавить вариант» Telegram
            // показывает и сам
            allow_adding_options: true,
        };

        let sent = 0;
        let lastError = null;
        for (const chatId of chats) {
            try {
                // опрос — тоже сообщение: если он нижний, кнопки пульта под ним,
                // а с прошлого письма их снимает moveInline
                const message = await callApi('sendPoll', { chat_id: chatId, ...payload, reply_markup: inlineKeyboardFor(chatId) });
                moveInline(chatId, message.message_id);
                // постоянные id вариантов выдаёт Telegram; по ним poll_answer
                // называет выбранное, даже если варианты потом дописывали
                const stored = (message.poll?.options || []).map((o, i) => ({ id: o.persistent_id ?? null, text: o.text ?? texts[i] }));
                insertPoll.run(String(message.poll.id), askId, String(chatId), Number(message.message_id), sessionId,
                    payload.question, JSON.stringify(stored), new Date().toISOString(),
                    // опрос из блока [ASK] уходит после письма своего хода — глушить ему нечего
                    silenced ? new Date().toISOString() : null);
                // и обычная связь «сообщение → сессия»: следующее сообщение
                // человека без reply пойдёт в сессию, которая его спросила
                remember(chatId, message.message_id, sessionId);
                sent += 1;
            } catch (err) {
                lastError = err;
                console.error('Telegram sendPoll:', err.message);
            }
        }
        if (!sent) throw lastError;
        return { askId, sent };
    }

    // Ответ получен: закрыть опрос у всех и вернуть выбор в сессию
    async function finalize(row, answer, own) {
        if (!markAnswered.run(new Date().toISOString(), row.ask_id).changes) return; // уже ответили
        for (const copy of pollsOfAsk.all(row.ask_id)) {
            // закрытый опрос без reply_markup теряет кнопки; если он ещё нижний — оставляем
            const keep = isBottomInline(copy.chat_id, copy.message_id) ? { reply_markup: inlineKeyboardFor(copy.chat_id) } : {};
            callApi('stopPoll', { chat_id: copy.chat_id, message_id: copy.message_id, ...keep })
                .catch((err) => console.error('Telegram stopPoll:', err.message));
        }
        const text = `Ответ на вопрос «${row.question}»${own ? ' (свой вариант)' : ''}: ${answer}`;
        await runInSession(row.chat_id, row.session_id, text, { waitIdle: true });
    }

    // poll_answer: человек проголосовал
    async function handlePollAnswer(answer) {
        if (!users().includes(String(answer.user?.id ?? ''))) return;
        const row = pollById.get(String(answer.poll_id));
        if (!row || row.answered_at) return;
        const options = JSON.parse(row.options);
        const byPersistent = (answer.option_persistent_ids || []).map((id) => options.find((o) => o.id === id)?.text);
        const picked = byPersistent.length ? byPersistent : (answer.option_ids || []).map((i) => options[i]?.text);
        if (!picked.length) return; // голос отозван
        // выбран вариант, которого мы не знаем, — это только что дописанный
        // свой: его текст принесёт poll_option_added, он и станет ответом
        if (picked.some((text) => text === undefined)) {
            pendingVotes.set(row.poll_id, answer.option_persistent_ids || []);
            return;
        }
        const own = (answer.option_persistent_ids || []).some((id) => options.find((o) => o.id === id)?.own);
        await finalize(row, picked.join(', '), own);
    }

    // служебное сообщение poll_option_added: человек дописал свой вариант.
    // Запоминаем его текст и ждём голоса за него (см. OWN_GRACE_MS)
    async function handleOptionAdded(message) {
        const chatId = String(message.chat?.id ?? '');
        if (!users().includes(chatId)) return;
        const added = message.poll_option_added;
        const row = added.poll_message?.message_id && pollByMessage.get(chatId, Number(added.poll_message.message_id));
        if (!row || row.answered_at || !added.option_text) return;
        const options = JSON.parse(row.options);
        options.push({ id: added.option_persistent_id ?? null, text: added.option_text, own: true });
        saveOptions.run(JSON.stringify(options), row.ask_id, row.chat_id);

        // голос уже пришёл и ждал только текста
        const voted = pendingVotes.get(row.poll_id);
        if (voted) {
            pendingVotes.delete(row.poll_id);
            const texts = voted.map((id) => options.find((o) => o.id === id)?.text).filter(Boolean);
            if (texts.length) { await finalize(row, texts.join(', '), true); return; }
        }
        // finalize сам не даст ответить дважды, если голос успеет раньше
        const timer = setTimeout(() => {
            finalize(row, added.option_text, true).catch((err) => console.error('Telegram poll own answer:', err.message));
        }, ownGraceMs);
        timer.unref();
    }

    // текст ответом (reply) на сообщение с открытым опросом — свой ответ.
    // true — сообщение было ответом на опрос и дальше мосту разбирать нечего
    async function handleReply(chatId, replyTo, text) {
        const row = replyTo && pollByMessage.get(String(chatId), Number(replyTo));
        if (!row || row.answered_at) return false;
        await finalize(row, String(text).trim(), true);
        return true;
    }

    const routes = {
        // { sessionId, question, options: [..], multiple? } → опрос людям из списка.
        // Ответ придёт в сессию sessionId новым ходом
        '/api/telegram/poll': async (req, res) => {
            const body = await readJson(req);
            try {
                sendJson(res, { ok: true, ...(await askPoll(body)) });
            } catch (err) {
                sendJson(res, { ok: false, error: err.message });
            }
        },
    };

    return { askPoll, swallowsNotice, handlePollAnswer, handleOptionAdded, handleReply, routes };
}

module.exports = { create, parseAsk, parseLooseAsk, ASK_PREAMBLE };
