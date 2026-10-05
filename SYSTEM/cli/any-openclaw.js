// Всё, что в any.js знает про openclaw конкретно: запуск хода, ключ модели и
// разбор ответа. Лежит отдельно по той же причине, что и сам коннектор: openclaw
// отличается от pi и opencode не флагом, а формой ответа — вместо потока
// событий он печатает один JSON-объект в конце. Держать это в общем коннекторе
// значит растягивать его ветками, которых у остальных семейств нет и не будет.
//
// OpenClaw — настоящий CLI-агент, а не заглушка из списка на New projects
// (см. DOCS/decisions/056): у него есть каталог моделей, своя сессия и свой
// формат ответа, и всё это здесь и используется.
const fs = require('fs');
const path = require('path');
const os = require('os');

const { openclawModels, openclawResult } = require('./any-parse.js');

// Промпт openclaw лежит не в аргументах, а в файле: ход у нас собран из
// пересказа истории, подсказок и домашки, и это сотни килобайт. Командная
// строка Windows такой длины не берёт (и не пережила бы кириллицу без
// явной кодировки), а `--message-file` читает UTF-8. Файл переживает один ход —
// его читает CLI и забывает, поэтому уборка сразу после выхода процесса
function writeMessage(text) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karandash-openclaw-'));
    const file = path.join(dir, 'prompt.md');
    fs.writeFileSync(file, String(text ?? ''), 'utf8');
    return { file, dir };
}

// Уборка синхронная намеренно: её зовут в finally без await, а fs.rm возвращает
// обещание. Промис на этом месте успел бы протухнуть к следующему ходу, и в %TEMP%
// копились бы каталоги с промптами — по всей истории диалога
function removeMessage(dir) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* уборка не должна ронять ход */ }
}

// Ключ модели уходит в openclaw ровно тем, что выбран в строке над сессией:
// догадываться о недостающем шлюзе здесь нельзя, иначе ход ушёл бы к другому
// шлюзу, чем показано (а раньше подставлялся openrouter — единственный шлюз,
// на который openclaw всё равно ходит по умолчанию). Модели, которой в
// каталоге openclaw нет, путь не достраивается: такую честнее отдать CLI и
// услышать её отказ, чем подсунуть похожую
function modelKey(model) {
    return String(model || '') || null;
}

// Флаги запуска хода. `--local` — ход идёт встроенным исполнителем, по ключам
// провайдера, которые openclaw уже хранит у себя. Без него CLI идёт в Gateway,
// а тот на голой машине не запущен, и ход падает на соединении.
function buildArgs({ model, resumeId, text }) {
    const { file, dir } = writeMessage(text);
    const args = ['agent', '--local', '--json'];
    if (model) args.push('--model', modelKey(model));
    // продолжаем ту же сессию openclaw: её id приходит в ответе (см. ниже)
    if (resumeId) args.push('--session-id', resumeId);
    args.push('--message-file', file);
    return { args, cleanup: () => removeMessage(dir) };
}

// Каталог моделей. `--all` обязателен: без него openclaw печатает только то,
// чем пользовалась текущая сессия, а до первого хода там пусто — список
// провайдера наполняется при подключении, то есть именно до первого хода.
//
// Пока Gateway не запущен, openclaw отдаёт локальную копию каталога, а она на
// голой машине состоит из нескольких записей claude-cli с available:false. Разбор
// их отбрасывает, и выбор выглядит пустым, хотя модели есть. Поэтому пустой
// список один раз уточняем через `--refresh`: он ходит к провайдерам и наполняет
// копию по-настоящему. Обновление дорогое, поэтому только на пустом результате.
function models({ target, capture, timeoutMs }) {
    const listing = openclawModels(capture(target, ['models', 'list', '--all', '--json'], timeoutMs));
    if (listing.length) return listing;
    return openclawModels(capture(target, ['models', 'list', '--all', '--json', '--refresh'], timeoutMs));
}

// Ход openclaw: stdout разбирается целиком (openclawResult), потому что потока
// событий у него нет. Учёт токенов и цены — тот же, что у pi: у openclaw поля
// usage называются так же (input/output/cacheRead/cacheWrite/cost.total), так
// что общая схема метаданных хода осталась одна на всех.
// cli — та же функция запуска, что у остальных семейств (см. cli в any.js):
// она уже умеет оборачивать npm-шим в node с его .mjs, и openclaw-шим ровно
// такой случай
async function ask({ ctx, cli, target, args, timeoutMs }) {
    const stdout = await cli(target, args, {
        timeoutMs,
        onSpawn: (child) => { ctx.run.child = child; },
    }).catch((err) => { ctx.fail(err.message); return ''; });

    const result = openclawResult(stdout);
    if (!result) {
        // JSON не распознан: показываем вывод как есть, но говорим, что это не
        // разобранный ответ, — иначе в ленте окажется многострочный JSON без
        // единого слова о том, что он не прочитан
        const raw = String(stdout || '').trim();
        ctx.fail(`openclaw returned no JSON result${raw ? `:\n${raw.slice(0, 2000)}` : ''}`);
        return;
    }
    // id сессии openclaw известен только из ответа, поэтому begin() — после
    // разбора, а не до запуска: у первого хода его ещё не у кого взять
    ctx.begin(result.sessionId);
    if (result.stopReason) ctx.meta.stopReason = result.stopReason;
    // прерванный ход — не пустой: openclaw отдаёт накопленное, и молчать тут
    // нельзя, иначе потеряется всё, что агент успел сделать
    if (!result.answer && !result.aborted) {
        ctx.fail('openclaw returned an empty answer');
        return;
    }
    if (result.answer) {
        ctx.answer = result.answer;
        ctx.emit({ type: 'text', text: ctx.answer });
    }
    const usage = result.usage || {};
    ctx.meta.usage.inputTokens += usage.input || 0;
    ctx.meta.usage.outputTokens += usage.output || 0;
    ctx.meta.usage.cacheReadTokens += usage.cacheRead || 0;
    ctx.meta.usage.cacheCreationTokens += usage.cacheWrite || 0;
    ctx.meta.lastRequestTokens = (usage.input || 0) + (usage.cacheRead || 0) + (usage.cacheWrite || 0);
    if (typeof usage.cost?.total === 'number') ctx.meta.costUsd = (ctx.meta.costUsd || 0) + usage.cost.total;
}

module.exports = { buildArgs, models, ask, modelKey };