// Встроенные кнопки под полем ввода (ReplyKeyboardMarkup и inline): их набор,
// вид, нажатие и то, как они переезжают на новое письмо.
//
// Вынесено отдельно от telegram-server.js (DOCS/decisions/022). Кнопки — это
// отдельная тема: свой набор, свой номер версии, своё «показать тем, кто ещё не
// видел» и своя пометка выбранного. Мост отвечает за разговор, кнопки — за то,
// как он выглядит.
//
// Зависимости передаются явно (DOCS/decisions/042: модуль отдаёт наружу своё
// целиком, а не путь к файлу): callApi — позвать Bot API, send — отправить письмо
// с кнопками, db — хранилище (telegram-db-server.js), getUsers — кому вообще
// пишем, onSendError — куда деть ошибку отправки.

module.exports = function createKeyboard({ callApi, send, db, getUsers, onSendError }) {
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
    // Кнопки только встроенные (решение владельца 2026-09-21): обычной клавиатуры у
    // бота больше нет. Снять её у тех, у кого она осталась с прошлых версий, можно
    // только сообщением с remove_keyboard — его шлёт showKeyboard один раз
    const REMOVE_KEYBOARD = { remove_keyboard: true };
    // Обычную клавиатуру Telegram снимает только вместе с сообщением. Шлём одно
    // письмо с remove_keyboard — и помним, кому оно уже ушло: перезапуск сервера не
    // должен слать его заново. Сменился набор кнопок — поднять номер (письмо
    // повторится и снимет клавиатуру, если она вдруг вернулась)
    const KEYBOARD_VERSION = 6;

    // Кнопки встроенной клавиатурой — под нижним письмом бота. Она привязана к
    // сообщению; выбранная помечена скобками — 【 】
    function inlineKeyboardFor(chatId) {
        let mode = 'action';
        try { mode = db.readChatState?.get(String(chatId))?.mode || 'action'; } catch { /* по умолчанию */ }
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

    // Встроенные кнопки живут только под самым нижним письмом, отправленным в чат:
    // стоит уйти новому сообщению (письму, опросу, ответу на кнопку), как кнопки
    // прошлого снимаются. messageId = null — новое сообщение без встроенных кнопок.
    // Нижнее сообщение помнится в базе (telegram_inline): сторож перезапускает
    // сервер на каждой правке, и в памяти оно терялось бы вместе с процессом
    function moveInline(chatId, messageId) {
        const key = String(chatId);
        let prev = null;
        try { prev = db.readInline?.get(key)?.messageId ?? null; } catch { /* база ещё не готова */ }
        try {
            if (messageId) db.saveInline?.run(key, Number(messageId)); else db.dropInline?.run(key);
        } catch { /* не записалось — кнопки снимутся со следующим письмом */ }
        if (prev && prev !== messageId) {
            callApi('editMessageReplyMarkup', { chat_id: chatId, message_id: prev, reply_markup: { inline_keyboard: [] } })
                .catch(() => {}); // письмо старое или уже без кнопок — не ошибка
        }
    }

    function isBottomInline(chatId, messageId) {
        try { return db.readInline?.get(String(chatId))?.messageId === messageId; } catch { return false; }
    }

    function pressButton(chatId, button) {
        const now = new Date().toISOString();
        if (button.label === 'END') {
            db.saveChatState.run(chatId, 'action', 1, now);
            return 'Начинаем с новой сессии\n\n⚡ Выбран ACTION: напишите поручение — оно станет новой работой в пульте.';
        }
        if (button.label === 'ACTION') {
            const fresh = db.readChatState.get(chatId)?.fresh ? 1 : 0;
            db.saveChatState.run(chatId, 'action', fresh, now);
            return fresh
                ? '⚡ ACTION: напишите поручение — оно станет новой работой в пульте.'
                : '⚡ ACTION: сообщение уйдёт поручением в текущую работу. Новую работу начинает ⏹ END.';
        }
        if (MODE_LABELS.includes(button.label)) {
            // выбор запоминаем: кнопка остаётся отмеченной до выбора другой
            const fresh = db.readChatState.get(chatId)?.fresh ? 1 : 0;
            db.saveChatState.run(chatId, button.label.toLowerCase(), fresh, now);
        }
        return `${button.text} — выбрано. Пока эта кнопка ничего не меняет в работе.`;
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
        for (const chatId of getUsers()) {
            if ((db.readKeyboard.get(chatId)?.version ?? 0) >= KEYBOARD_VERSION) continue;
            try {
                // keepInline: письмо со снятием клавиатуры не должно забирать встроенные
                // кнопки у нижнего письма
                await send(chatId, `⌨️ Кнопки пульта теперь под письмами бота: ${BUTTONS.map((b) => b.text).join(' · ')}. ⏹ END — начать новую работу: следующее сообщение станет её поручением.`, REMOVE_KEYBOARD, { keepInline: true });
                db.saveKeyboard.run(chatId, KEYBOARD_VERSION, new Date().toISOString());
            } catch (err) {
                failed = true;
                onSendError(err.message);
                console.error('Telegram keyboard:', err.message);
            }
        }
        if (failed && attempt < KEYBOARD_RETRIES) {
            keyboardTimer = setTimeout(() => showKeyboard(attempt + 1), KEYBOARD_RETRY_MS);
            keyboardTimer.unref(); // таймер не должен держать уходящий процесс
        }
    }

    return {
        BUTTONS,
        inlineKeyboardFor,
        pressedButton,
        pressButton,
        moveInline,
        isBottomInline,
        showKeyboard,
    };
};