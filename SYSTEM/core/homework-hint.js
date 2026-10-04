// Домашняя работа едет в запрос сама: отчёт собирает код (TOOLS/homework),
// агент тратить на это ходы не должен.
//
// Почему раньше это было делом агента и не работало. Замер на восьми последних
// сессиях (TOOLS/steps/run.mjs): 326 шагов, 112 лишних (34 %), из них 22 шага —
// разведка grep/glob/read раньше домашней работы и 54 чтения файлов, которые
// ход так и не правил. Отчёт по тем же запросам собирается без единого хода
// модели: 13 запросов из 24 дали отчёт с 1–11 файлами, средний 10.9 КБ
// (DOCS/decisions/084 считал ту же работу за 45–58 % шагов хода). Правило
// «сначала домашняя работа» было в AGENTS.override.md, и агент его читал —
// шаги 5–6 последней сессии и есть чтение самого файла правил. Правило в
// контексте не выдержало; отчёт в промпте выдерживает.
//
// Собирать отчёт на каждый ход нельзя: сборщик ходит в rg и в индекс проекта,
// то есть тратит секунды даже там, где искать нечему, а запросов без правки в
// ленте много (замер на 24 последних: 11 без якорей, среди них «Ответь одним
// словом: ок», «ты тут?», «продолжай»). Поэтому решение «работа в проекте или
// разговор» принимает jev — тем же приёмом, каким приём из памяти
// (DOCS/decisions/088). Разговор — отчёт не собираем вовсе.
//
// Отдельно jev судил, «отчёт про это место или мимо», и эта проверка на
// замере не годилась: на девяти настоящих запросах оценка не разделила верные
// и чужие отчёты (0.31 там, где отчёт накрыл правку, и 0.85 там, где не
// накрыл). Гард по ней означал бы, что половина нужных отчётов не доедет, а
// чужие пройдут, поэтому вопрос убран, а не подкручен (решение 092).
//
// Функции возвращают null, когда ключа нет, сервис не ответил, отчёт пустой
// или суждение признало сообщение разговором: подсказка — украшение хода, а не
// его условие.
const path = require('path');
const typesafe = require('./typesafe.js');
const { THRESHOLDS } = require('./judgment-config.js');


// collect.js и anchors.js лежат в TOOLS, а серверный код — в SYSTEM: путь
// строим от корня проекта, чтобы модуль не зависел от того, откуда его
// подключили
const ROOT = path.join(__dirname, '..', '..');
const { collect } = require(path.join(ROOT, 'TOOLS', 'homework', 'collect.js'));
// якоря нужны отдельно от сборщика: по ним видно, есть ли в сообщении хоть
// что искать, и это стоит без похода в rg — на продолжении сессии сбор
// пропускается целиком
const { anchorsOf } = require(path.join(ROOT, 'TOOLS', 'homework', 'anchors.js'));

// сколько символов сообщения отдаём на суждение: решение «работа в проекте»
// принимается по виду задачи, а длинное письмо его только размывает
const REQUEST_LIMIT = 1000;
// сколько символов отчёта едет в запрос. Отчёт по задаче про один класс выходит
// на 19 КБ, и это против 143–182 КБ вывода инструментов, который он заменяет;
// но и целиком его в промпт класть нельзя — хвост обрезается по границе строки
const REPORT_LIMIT = 12000;
// короче этого отчёт — огрызок, а не находка: такой агент дочитает быстрее сам
const MIN_CHARS = 600;

// Вопрос один и он до сбора: работа в проекте или разговор. Сборщик ходит в rg
// и в индекс проекта, то есть тратит секунды даже там, где искать нечему, а
// запросов без правки в ленте много (замер на 24 последних: 11 без якорей,
// среди них «Ответь одним словом: ок», «ты тут?», «продолжай»).
const QUESTION = {
    type: 'noul',
    instructions: {
        question: 'Does `request` ask to change, fix or find something in this project — a page, a button, a style, a file?',
        focus: 'Judge what the person asks to be done, not whether the message mentions files or tools. A question about the conversation itself, a greeting, a short answer request or a continuation of earlier work is not work in the project.',
    },
    criteria: {
        true: {
            what: 'The person asks to change, fix, add or locate something in this project.',
            examples: [
                'Кнопка New перестала открывать панель — почини.',
                'Добавь отступ справа, как между секциями.',
                'Где в коде живёт эта подпись?',
            ],
        },
        false: {
            what: 'A message to the assistant rather than a task in the project: chat, a short answer, a check of the chat itself, or a continuation where the work was already agreed.',
            not_for: 'A vague-sounding task that still names a thing to change.',
            examples: [
                'Ответь одним словом: ок.',
                'Ты тут?',
                'Продолжай',
            ],
        },
    },
};

// обрезаем по границе строки: половина строки в конце промпта хуже, чем лишняя
// строка отчёта
function clipReport(report) {
    const text = String(report || '');
    if (text.length <= REPORT_LIMIT) return text;
    const cut = text.slice(0, REPORT_LIMIT);
    return `${cut.slice(0, cut.lastIndexOf('\n'))}\n…(отчёт обрезан)`;
}

// ---------- память сессии ----------
//
// Продолжающий ход («ищи ещё глубже», «эту же строку и в настройках», «да
// сделай») своих якорей не имеет: в замере на 23 ходах восьми сессий таких
// было 8, и отчёт для них не собирался вовсе — агент остаётся с тем, что было
// в первом запросе, и идёт перечитывать файлы целиком. Карта (файлы и строки)
// весит около килобайта против 10–19 КБ отчёта с кусками кода, поэтому на
// продолжении едет она, а не весь отчёт.
//
// Память живёт в процессе сервера и только на текущую работу: переживать
// перезапуск нечему, а хранить её в базе — значило бы держать в памяти отчёт
// ради каждой сессии месяцами.
const maps = new Map();

// карта отчёта — его заголовки «## Файл …, строки …»: файлы и строки, без
// кусков кода. Берём из отчёта, а не строим заново, чтобы формат отчёта и
// карта не разъехались
function mapOf(report) {
    return String(report || '')
        .split('\n')
        .filter((line) => line.startsWith('## Файл'))
        .slice(0, 12)
        .map((line) => line.replace(/^##\s*/, '').trim())
        .join('\n');
}

// { report | map, kind, files, chars, work, reused } либо null — отчёта нет
async function pickHomework({ request, sessionId }) {
    const text = String(request || '').trim();
    if (!text || text.length < 10) return null;

    // Продолжение той же сессии проверяется первым и без суждения: своих
    // якорей у такого хода нет («ищи ещё глубже», «да сделай», «и эту строку
    // тоже»), и на замере модель оценивает его в 0.03–0.26 — гард отсекал бы
    // ровно те ходы, ради которых карта и заводится. Отчёт по этой сессии уже
    // собран, значит работа в проекте тут точно есть, а суждение было бы
    // вторым мнением о том же самом
    const known = sessionId ? maps.get(sessionId) : null;
    if (known && !anchorsOf(text).code.length) {
        return { ...known, report: null, work: null, reused: true };
    }

    // Дальше суждение, и только потом сбор: сборщик ходит в rg и в индекс
    // проекта, то есть тратит секунды даже там, где искать нечему, а запросов
    // без правки много. Вопрос узкий и на нём модель надёжна — «просят ли в
    // проекте что-то менять», а не «про этот ли отчёт». Нет суждения или сеть
    // легла — собираем: дешевле лишняя секунда, чем лишняя разведка в ходе
    const verdict = typesafe.isEnabled()
        ? await typesafe.systemOne({ request: text.slice(0, REQUEST_LIMIT) }, { work: QUESTION })
        : null;
    const work = typesafe.noul(verdict?.answers, 'work');
    if (work !== null && work < THRESHOLDS.homeworkWork) return null;

    let built;
    try {
        built = collect(text);
    } catch {
        return null; // сборщик упал — ход идёт как раньше, без отчёта
    }
    // без якоря отчёт пустой: ехать в промпт нечему
    if (!built.code.length || !built.files.length || built.chars < MIN_CHARS) return null;

    const found = {
        map: mapOf(built.report),
        kind: built.kind?.id || null,
        files: built.files.length,
        chars: built.chars,
    };
    if (sessionId) maps.set(sessionId, found);
    return { ...found, report: clipReport(built.report), work, reused: false };
}

// блок в запрос агента. Это не вопрос человека, а служебная преамбула, поэтому
// в тексте строки сессии её нет — она попадает в «Sent to model»
// (SYSTEM/core/handoff.js). Агент вправе не доверять отчёту и искать сам
function homeworkPreamble(homework) {
    if (!homework) return '';
    if (homework.reused) {
        return `[OpenKarandash] По этой сессии отчёт уже собран, вот его карта — файлы и строки, `
            + `где смотреть (${homework.files} файлов, ${homework.kind || 'тип не определён'}):\n\n${homework.map}\n\n`
            + 'Кусков кода здесь нет намеренно: полный отчёт был в первом запросе этой сессии.\n\n';
    }
    return `[OpenKarandash] Домашняя работа по этому запросу уже собрана (${homework.files} файлов, `
        + `${homework.kind || 'тип не определён'}), искать то же самое ещё раз не нужно:\n\n${homework.report}\n\n`
        + 'Отчёт указывает, где смотреть, но решение и правка за тобой: он мог указать не туда.\n\n';
}

// что из отчёта пишется в result_meta хода — тем же полем, что записки и приём
// (DOCS/decisions/089): по этим числам видно, сколько отчётов уехало и на какие
// запросы
function homeworkTrace(homework) {
    if (!homework) return null;
    return { kind: homework.kind, files: homework.files, chars: homework.chars, work: homework.work, reused: homework.reused };
}

module.exports = { pickHomework, homeworkPreamble, homeworkTrace, clipReport, WORK_QUESTION: QUESTION };
