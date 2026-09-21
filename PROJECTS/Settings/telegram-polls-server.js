// Интерактивный вопрос человеку родным опросом Telegram (sendPoll) — то же, что
// агент в своём TUI задаёт вопросом с вариантами: варианты на выбор плюс свой
// ответ. Выбор возвращается в ту же сессию обычным ходом, как ответ человека.
//
// Что для этого берётся из Bot API:
// - is_anonymous: false — только про неанонимный опрос бот узнаёт, что выбрано
//   (обновление poll_answer);
// - allow_adding_options — человек дописывает свой вариант прямо в опрос, боту
//   приходит служебное сообщение poll_option_added с его текстом. Это и есть
//   «поле для своего ответа»: отдельного текстового поля у опроса нет;
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
const OWN_ANSWER_HINT = 'Свой ответ: добавьте вариант в опрос или ответьте на это сообщение текстом.';

function create({ database, callApi, users, runInSession, sessionExists, remember }) {
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
    const insertPoll = database.prepare('INSERT INTO telegram_polls (poll_id, ask_id, chat_id, message_id, session_id, question, options, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    const pollById = database.prepare('SELECT * FROM telegram_polls WHERE poll_id = ?');
    const pollByMessage = database.prepare('SELECT * FROM telegram_polls WHERE chat_id = ? AND message_id = ?');
    const pollsOfAsk = database.prepare('SELECT chat_id, message_id FROM telegram_polls WHERE ask_id = ?');
    // «кто первый ответил» решает база одной командой, а не проверка в коде:
    // голос и дописанный вариант приходят двумя обновлениями почти разом
    const markAnswered = database.prepare('UPDATE telegram_polls SET answered_at = ? WHERE ask_id = ? AND answered_at IS NULL');

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
    async function askPoll({ sessionId, question, options, multiple = false }) {
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
            allow_adding_options: true,
            description: OWN_ANSWER_HINT,
        };

        let sent = 0;
        let lastError = null;
        for (const chatId of chats) {
            try {
                const message = await callApi('sendPoll', { chat_id: chatId, ...payload });
                // постоянные id вариантов выдаёт Telegram; по ним poll_answer
                // называет выбранное, даже если варианты потом дописывали
                const stored = (message.poll?.options || []).map((o, i) => ({ id: o.persistent_id ?? null, text: o.text ?? texts[i] }));
                insertPoll.run(String(message.poll.id), askId, String(chatId), Number(message.message_id), sessionId,
                    payload.question, JSON.stringify(stored), new Date().toISOString());
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
            callApi('stopPoll', { chat_id: copy.chat_id, message_id: copy.message_id })
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
        if (picked.some((text) => text === undefined)) return;
        await finalize(row, picked.join(', '), false);
    }

    // служебное сообщение poll_option_added: человек дописал свой вариант.
    // Считаем это ответом сразу, не дожидаясь голоса за него: дописывают
    // вариант затем, чтобы его и выбрать
    async function handleOptionAdded(message) {
        const chatId = String(message.chat?.id ?? '');
        if (!users().includes(chatId)) return;
        const added = message.poll_option_added;
        const row = added.poll_message?.message_id && pollByMessage.get(chatId, Number(added.poll_message.message_id));
        if (!row || row.answered_at || !added.option_text) return;
        await finalize(row, added.option_text, true);
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

    return { askPoll, handlePollAnswer, handleOptionAdded, handleReply, routes };
}

module.exports = { create };
