// Письма моста человеку: что написать, когда ход закончился или сломался.
// Отдельно от telegram-server.js, потому что это слова, а не связь: их правят
// чаще и по другим поводам (DOCS/decisions/022).
//
// Письмо читают с телефона, не у пульта. Поэтому ошибка пишется не текстом
// поставщика («Provider finish_reason: error»), а тем, что человеку нужно
// знать: что случилось, что агент успел сделать и что делать дальше. Исходный
// текст ошибки остаётся последней строкой — по нему ищут причину

const turnJudgment = require('../../SYSTEM/core/turn-judgment.js');

const TEXT_LIMIT = 3500; // у Telegram потолок 4096 на сообщение, остальное — заголовок
const STEPS_SHOWN = 6;
const STEP_LIMIT = 90;
const QUOTE_LIMIT = 300;

// Причина человеческим языком. Порядок важен: первое совпадение побеждает
const REASONS = [
    [/rate.?limit|\b429\b|quota|credit|insufficient|billing|payment/i, 'у модели кончился лимит запросов или деньги на счёте поставщика'],
    [/not a valid model|model[^.]{0,40}not found|unknown model|no such model/i, 'такой модели у поставщика нет — выберите другую модель в пульте'],
    [/\b40[13]\b|unauthori[sz]ed|forbidden|api.?key|invalid.{0,10}token/i, 'поставщик модели не принял ключ доступа — проверьте ключ в настройках'],
    [/not connected/i, 'агент не подключён к пульту'],
    [/restart/i, 'пульт в этот момент перезапускался'],
    [/session not found/i, 'эта работа удалена из пульта'],
    [/time.?out|timed out|ETIMEDOUT|ECONNRESET|ENOTFOUND|network|fetch failed|socket/i, 'оборвалась связь с моделью'],
    [/finish_reason|overload|upstream|provider|\b5\d\d\b|internal server/i, 'поставщик модели оборвал ответ — сбой на его стороне, не в пульте и не в задании'],
];

// причина по суждению jev (turn-judgment.js, classifyFailure): он понимает и
// незнакомую формулировку. К моменту письма суждение уже вынесено сервером —
// здесь оно берётся из памяти, без сети; нет его — работает таблица выше
const JUDGED_REASONS = {
    limit: REASONS[0][1],
    no_model: REASONS[1][1],
    auth: REASONS[2][1],
    not_connected: REASONS[3][1],
    network: REASONS[6][1],
    provider: REASONS[7][1],
    agent_fault: 'агент или его модель сработали неправильно — сбились на вызове инструмента, упёрлись в предел шагов или завершились сами',
    task: 'в таком виде поручение не выполнит ни один агент — оно слишком велико для модели или отклонено по содержанию; разбейте его или переформулируйте',
};

function humanReason(errorText) {
    const judged = JUDGED_REASONS[turnJudgment.knownFailure(errorText)?.reason];
    if (judged) return judged;
    const found = REASONS.find(([pattern]) => pattern.test(String(errorText || '')));
    return found ? found[1] : 'агент сообщил об ошибке';
}

// слова причины без текста ошибки: суждение уже вынесено заранее, а строке
// о замене по кулдауну (server.js, DOCS/decisions/071) текст ошибки терять
// не из чего — его не было, ошибки ещё не случилось
function reasonText(reason) {
    return JUDGED_REASONS[reason] || 'исполнитель временно недоступен';
}

function clip(text, limit) {
    const value = String(text || '').trim();
    return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

// steps — строки шагов хода (роль tool), как они лежат в ленте
function stepsBlock(steps) {
    const list = (steps || []).map((step) => clip(String(step).split('\n')[0], STEP_LIMIT)).filter(Boolean);
    if (!list.length) return 'До обрыва агент ничего не успел сделать.';
    // показываем последние: они ближе к месту обрыва
    const shown = list.slice(-STEPS_SHOWN);
    const hidden = list.length - shown.length;
    return `До обрыва агент успел (шагов: ${list.length}):\n${hidden ? `· …ещё ${hidden} раньше\n` : ''}${shown.map((step) => `· ${step}`).join('\n')}`;
}

// { head, body } письма о конце хода. errorText — ход сломался; text — последние
// слова агента (при ошибке их может не быть, а может быть полотчёта)
function turnLetter({ title, text, errorText, steps }) {
    if (!errorText) {
        return { head: title ? `✅ ${title}` : '✅ Готово', body: clip(text, TEXT_LIMIT) };
    }
    const parts = [
        `Работа оборвалась: ${humanReason(errorText)}.`,
        stepsBlock(steps),
    ];
    if (text && text.trim()) parts.push(`Последнее, что сказал агент:\n${clip(text, QUOTE_LIMIT)}`);
    parts.push('Ответьте на это письмо, например «продолжай», — агент возьмётся с того же места.');
    parts.push(`Текст ошибки: ${clip(errorText, QUOTE_LIMIT)}`);
    return { head: title ? `⚠️ ${title}` : '⚠️ Ошибка', body: clip(parts.join('\n\n'), TEXT_LIMIT) };
}

// слова человека не дошли до агента: ход даже не начался
function undeliveredLetter(text, errorText) {
    return `⚠️ Не удалось передать агенту: «${clip(text, QUOTE_LIMIT)}»\n\n`
        + `Причина: ${humanReason(errorText)}.\n\n`
        + 'Когда причина устранена, ответьте на это письмо — ответ уйдёт в ту же работу.\n\n'
        + `Текст ошибки: ${clip(errorText, QUOTE_LIMIT)}`;
}

module.exports = { turnLetter, undeliveredLetter, humanReason, reasonText };
