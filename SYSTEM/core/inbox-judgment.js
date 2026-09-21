// Суждения о том, что человек прислал в Telegram: вид сообщения и выбор
// варианта опроса своими словами.
// Вынесено из turn-judgment.js, когда тот перерос норму в 400 строк
// (DOCS/decisions/022): turn-judgment.js по-прежнему отдаёт всё это наружу,
// вызывающим ничего менять не нужно. Транспорт — typesafe.js, пороги — judgment-config.js.
// Каждая функция возвращает null, когда ключа нет или сервис не ответил.

const typesafe = require('./typesafe.js');
const { THRESHOLDS, PROMPT_LIMIT } = require('./judgment-config.js');

// ---------- что человек прислал в Telegram ----------

// Мост принимал любое сообщение за поручение и запускал настоящий ход — на
// «стоп», «что там», «спасибо» тоже. Это деньги владельца и занятая очередь.
// Один выбор из четырёх разводит это раз и навсегда (DOCS/decisions/054).
const INBOX_QUESTION = {
    intent: {
        type: 'choice',
        instructions: {
            question: 'What does `message` want from the assistant that is working on this project?',
            focus: 'The person is replying in a messenger to a report about finished work.',
        },
        criteria: {
            task: {
                what: 'Work to do or a question to answer: something the assistant must go and act on.',
                examples: ['Почини ленту во Flow', 'А почему сервер нельзя поднимать из сессии?', 'Продолжай'],
            },
            stop: {
                what: 'A demand to stop what is running right now.',
                not_for: 'Asking to stop doing something in the future, which is work.',
                examples: ['Стоп', 'Отмена', 'Прекрати'],
            },
            status: {
                what: 'A question about what is happening right now, asking for no new work.',
                examples: ['Что там?', 'Идёт ещё?', 'Статус'],
            },
            nothing: {
                what: 'An acknowledgement or a remark that needs no action at all.',
                examples: ['Спасибо', 'Ок', 'Понял', 'Получил'],
            },
        },
    },
    // Каким делом человек считает своё поручение. Ответ уходит ему первым же
    // письмом («понял как …») — раньше, чем исполнитель успеет сказать хоть
    // слово, и независимо от того, выполнит ли слабая модель правило [PLAN]
    // (DOCS/decisions/064). Вопрос едет тем же запросом, что intent: лишней
    // задержки нет
    kind: {
        type: 'choice',
        instructions: {
            question: 'If `message` is work for the assistant, what kind of work is it?',
            focus: 'The person writes to an assistant that develops a software project.',
        },
        criteria: {
            fix: {
                what: 'Something works wrong or not as expected and must be repaired.',
                examples: ['Кнопки пропадают после нажатия', 'Почему не пришло письмо? Исправь', 'Опрос закрывается сам'],
            },
            build: {
                what: 'Add something new or extend what exists: a feature, a rule, a behaviour.',
                examples: ['Добавь кнопки ASK и END', 'Сделай, чтобы после END начиналась новая сессия'],
            },
            look: {
                what: 'Change how something looks: layout, colours, wording, order of elements.',
                examples: ['Сделай кнопки красивее', 'Верни кнопки в одну строку', 'Поменяй текст письма'],
            },
            explain: {
                what: 'A question to answer or a thing to explain; nothing has to be changed.',
                examples: ['Как устроена логика телеграма?', 'Почему сервер нельзя поднимать из сессии?'],
            },
            check: {
                what: 'Inspect, test or find something and report the findings.',
                examples: ['Проверь, доделается ли задание', 'Посмотри, что изменил агент', 'Найди, где теряется письмо'],
            },
            write: {
                what: 'Write or rewrite a text for people: a document, a note, a description, a letter.',
                examples: ['Напиши документ про архитектуру', 'Составь описание для README', 'Перепиши записку короче'],
            },
            proceed: {
                what: 'Carry on with the work already under way, or an answer to the assistant\'s own question.',
                examples: ['Продолжай', 'Да, делай', 'Второй вариант', 'Доделай до конца'],
            },
        },
    },
};

// как вид поручения звучит в письме человеку
const KIND_WORDS = {
    fix: 'исправить то, что работает не так',
    build: 'сделать новое или доработать существующее',
    look: 'изменить внешний вид или формулировки',
    explain: 'ответить на вопрос, ничего не меняя',
    check: 'проверить и рассказать, что нашёл',
    write: 'написать текст или документ',
    proceed: 'продолжить начатую работу',
};

// Выбор применяем только уверенный: ошибиться здесь значит либо не выполнить
// поручение, либо оборвать чужую работу на слове «стоп» внутри задания.
// Неуверенный ответ трактуем как поручение — прежнее поведение моста
async function classifyInbox(text) {
    if (!typesafe.isEnabled()) return { intent: 'task', confidence: null };
    const message = String(text || '').trim();
    if (!message) return { intent: 'nothing', confidence: null };

    const res = await typesafe.systemOne({ message: message.slice(0, PROMPT_LIMIT) }, INBOX_QUESTION);
    const pick = typesafe.choice(res?.answers, 'intent');
    const kindPick = typesafe.choice(res?.answers, 'kind');
    const kind = kindPick && (kindPick.confidence ?? 0) >= THRESHOLDS.inboxKind ? kindPick.value : null;
    const understood = { kind, kindWords: kind ? KIND_WORDS[kind] || null : null, kindConfidence: kindPick?.confidence ?? null };
    if (!pick || (pick.confidence ?? 0) < THRESHOLDS.inboxIntent) return { intent: 'task', confidence: pick?.confidence ?? null, ...understood };
    return { intent: pick.value, confidence: pick.confidence, ...understood };
}

// ---------- ответ на опрос своими словами ----------

const REPLY_MATCH = 0.7;

// Человек ответил на опрос текстом: «давай второй», «тот, что с базой, но
// попроще». Какой готовый вариант он имел в виду — индекс в options либо null
// (свой ответ, не из списка). Агенту уходят и вариант, и слова человека:
// уточнение терять нельзя
async function matchPollReply(question, options, reply) {
    const text = String(reply || '').trim();
    if (!typesafe.isEnabled() || !text || !Array.isArray(options) || options.length < 2) return null;
    const criteria = {};
    options.forEach((option, i) => {
        criteria[`o${i + 1}`] = { what: `The person chooses option number ${i + 1}: "${String(option).slice(0, 120)}".` };
    });
    criteria.own = { what: 'The person gives an answer of their own that is none of the listed options, or asks something back.' };
    const res = await typesafe.systemOne(
        { question: String(question || '').slice(0, 300), reply: text.slice(0, 500) },
        { pick: { type: 'choice', instructions: 'Which option does `reply` choose as the answer to `question`? Options may be referred to by number, by position or by meaning.', criteria } },
    );
    const pick = typesafe.choice(res?.answers, 'pick');
    if (!pick || pick.value === 'own' || (pick.confidence ?? 0) < REPLY_MATCH) return null;
    const index = Number(pick.value.slice(1)) - 1;
    return Number.isInteger(index) && options[index] !== undefined ? index : null;
}

module.exports = { classifyInbox, matchPollReply };
