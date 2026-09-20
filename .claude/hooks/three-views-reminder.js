// PostToolUse-хук: после правки кода ленты напоминает, что сессия рисуется в трёх
// местах — Sessions, Feed и Flow — из одного источника (DOCS/decisions/039, раздел
// «Один источник для Sessions, Feed и Flow»).
// Зачем: три отображения — отдельный код с отдельной обработкой полей (MESSAGE_SPECS
// в Feed, messageMetadata в Sessions, sessionFacts во Flow), правка одного в другие
// сама не попадает. Коммит 59a1888 (v0.0.19) целиком ушёл на то, чтобы догнать
// Sessions и Flow до Feed, а 2026-09-19 владельцу пришлось повторить правило:
// «расхождение между ними — дефект». До хука правило жило в заметке решения и в
// памяти WSL-claude — Windows-claude и сессии, запущенные сервером, его не видели.
// Хук ничего не блокирует. Говорит один раз на сессию для каждого набора ещё не
// тронутых отображений и называет именно их файлы; когда тронуты все три — молчит.
// Регистрация — .claude/settings.json, ключ hooks.PostToolUse.
const fs = require('fs');
const os = require('os');
const path = require('path');

// MultiEdit в установленном Claude Code (2.1.278) нет — в справке по хукам его нет
const WRITE_TOOLS = new Set(['Edit', 'Write']);

// три отображения и где в них рисуется строка сессии; порядок здесь = порядок в
// тексте напоминания. Имена файлов и функций устареют, когда flow.js разрежут по
// темам (DOCS/decisions/022), — сверять с DOCS/decisions/039
const VIEWS = {
    sessions: 'Sessions — PROJECTS/Chat/chat-stream.js (renderStoredMessage), chat-feed.js, chat-details.js (messageMetadata)',
    feed: 'Feed — PROJECTS/Feed/page.js (MESSAGE_SPECS, addMessageCard)',
    flow: 'Flow — PROJECTS/Flow/flow.js (NODE_KINDS, nodeKindOf, sessionFacts, sessionMetadata), flow-session-sync.js',
};
const VIEW_NAMES = { sessions: 'Sessions', feed: 'Feed', flow: 'Flow' };
// общий источник — не отображение: его правка ничего не «закрывает», но напоминает о всех трёх
const SOURCE = 'source';

// Небольшие файлы целиком про ленту срабатывают на любую правку. В больших смешанных
// (flow.js — весь канвас, server.js — весь сервер) нужна только область: пара якорей
// [начало, конец], конец — объявление, идущее сразу за областью. Ключевое слово в
// new_string тут не годится: правка внутри тела sessionFacts (новая строка
// ['Attempt', …]) имени функции не содержит — поэтому ищем место правки в файле
const TARGETS = [
    { file: 'PROJECTS/Chat/chat-feed.js', view: 'sessions' },
    { file: 'PROJECTS/Chat/chat-details.js', view: 'sessions' },
    { file: 'PROJECTS/Chat/chat-stream.js', view: 'sessions' },
    { file: 'PROJECTS/Feed/page.js', view: 'feed' },
    { file: 'PROJECTS/Flow/flow-session-sync.js', view: 'flow' },
    {
        file: 'PROJECTS/Flow/flow.js',
        view: 'flow',
        regions: [
            // роль → вид ноды: NODE_KINDS, TOOL_KINDS, nodeKindOf
            [/^[ \t]*const NODE_KINDS = \{/m, /^[ \t]*function setNodeKind\(/m],
            // секции ноды: sessionFacts, rawText, sessionMetadata, applyNodeFacts, applyNodeImages
            [/^[ \t]*function sessionFacts\(/m, /^[ \t]*function toolFilePath\(/m],
            // содержимое ноды и деление строк на реплики и шаги: applySessionNode, isStepRow
            [/^[ \t]*function applySessionNode\(/m, /^[ \t]*function buildSessionNodes\(/m],
        ],
    },
    { file: 'SYSTEM/core/hermes-history.js', view: SOURCE },
    {
        file: 'server.js',
        view: SOURCE,
        regions: [
            // чем разбор истории Hermes пишет в нашу базу
            [/^const hermesStore = \{/m, /^function hermesLinkFor\(/m],
            // таблица messages и её колонки
            [/^[ \t]*CREATE TABLE IF NOT EXISTS messages \(/m, /ALTER TABLE sessions ADD COLUMN target\b/],
            // запись полей строки
            [/^const upsertMessage = db\.prepare\(/m, /^const touchSession = db\.prepare\(/m],
            // выборка, которую читают все три страницы, и сводка расхода
            [/^const listMessages = db\.prepare\(/m, /^const countMessages = db\.prepare\(/m],
            // stampEvent, record*, finishExchange — какие строки и с какими полями рождаются
            [/^function originForSession\(/m, /^async function askOutsideBrowser\(/m],
            // сам ответ /api/sessions/messages
            [/^[ \t]*if \(urlPath === '\/api\/sessions\/messages'\)/m, /error: 'Unknown endpoint'/],
        ],
    },
];

const unifyEol = (s) => s.replace(/\r\n/g, '\n');
const safeName = (s) => String(s).replace(/[^\w-]/g, '_').slice(0, 80);

// Путь приходит абсолютным с разделителями своей платформы (на Windows — обратные
// слэши). Сверяем по хвосту: корень у WSL, Windows и рабочих копий веток разный
function targetFor(filePath) {
    // normalize убирает «..» и двойные слэши: PROJECTS/Chat/../Feed/page.js — тот же page.js
    const normalized = path.posix.normalize(filePath.split('\\').join('/')).toLowerCase();
    return TARGETS.find(({ file }) => {
        const tail = file.toLowerCase();
        return normalized === tail || normalized.endsWith('/' + tail);
    });
}

// границы областей в тексте файла; область без любого из якорей пропускаем —
// функцию переименовали или унесли, и угадывать её место не станем
function findRegions(content, regions) {
    const found = [];
    for (const [startRe, endRe] of regions) {
        const start = content.search(startRe);
        if (start < 0) continue;
        const length = content.slice(start + 1).search(endRe);
        if (length < 0) continue;
        found.push([start, start + 1 + length]);
    }
    return found;
}

// Где в файле (уже после правки) прошла правка, — из tool_response.structuredPatch:
// Edit и Write кладут туда куски diff с newStart и строками «+», «-», « ». В справке по
// хукам поля нет — оно сверено по тому, что хуки PostToolUse получали на этой машине, и
// по журналам сессий (2.1.251–2.1.278). Раз обещания нет, каждый кусок сверяем с самим
// файлом: не сошлась хоть одна строка, поля нет или вид другой — возвращаем null, и
// место правки ищется по new_string.
// added — номера добавленных и изменённых строк. seams — швы чистых удалений: номер
// строки, ПЕРЕД которой что-то вырезали и ничего не вставили (удалённой строки в новом
// файле нет). Замена «-» + «+» швом не считается: её место уже назвали строки «+»
function patchedLines(toolResponse, fileLines) {
    const patch = toolResponse && toolResponse.structuredPatch;
    if (!Array.isArray(patch) || !patch.length) return null;
    const added = [];
    const seams = [];
    for (const hunk of patch) {
        if (!hunk || !Number.isInteger(hunk.newStart) || hunk.newStart < 1 || !Array.isArray(hunk.lines)) return null;
        let line = hunk.newStart;
        let cut = false; // идёт серия удалённых строк, за которой пока ничего не вставлено
        for (const row of hunk.lines) {
            if (typeof row !== 'string') return null;
            const mark = row[0];
            if (mark === '\\') continue; // «\ No newline at end of file»
            if (mark === '-') {
                cut = true;
                continue;
            }
            if (mark !== '+' && mark !== ' ') return null;
            if (fileLines[line - 1] !== row.slice(1).replace(/\r$/, '')) return null;
            if (mark === '+') added.push(line);
            else if (cut) seams.push(line);
            cut = false;
            line += 1;
        }
        if (cut) seams.push(line);
    }
    return added.length || seams.length ? { added, seams } : null;
}

// Попала ли правка в область. Файл читаем уже ПОСЛЕ правки. Точный путь — номера
// строк из structuredPatch: он видит и чистое удаление (пустой new_string), и не путает
// короткий фрагмент с его двойником в другой функции. Запасной путь — ищем в файле
// new_string: вхождений бывает несколько (replace_all, короткий фрагмент) — хватит
// одного в области: лишнее напоминание раз в сессию дешевле пропущенного.
// ponytail: без structuredPatch чистое удаление найти нечем — молчим
function editTouchesRegions(resolved, toolName, toolInput, toolResponse, regions) {
    let content;
    try {
        // не файл (каталог, канал) — читать нельзя: чтение канала повисло бы до таймаута
        if (!fs.statSync(resolved).isFile()) return false;
        content = unifyEol(fs.readFileSync(resolved, 'utf8'));
    } catch {
        return false; // файл уже унесли — смотреть не на что
    }
    const found = findRegions(content, regions);
    if (!found.length) return false;

    const patch = patchedLines(toolResponse, content.split('\n'));
    if (patch) {
        const lineOf = (offset) => content.slice(0, offset).split('\n').length;
        // Область — строки от first до next, не включая next: строка конечного якоря —
        // уже следующее объявление. Шов внутри области, если вырезали после её первой
        // строки и не дальше, чем прямо перед конечным якорем
        return found.some(([from, to]) => {
            const first = lineOf(from);
            const next = lineOf(to);
            return patch.added.some((line) => line >= first && line < next)
                || patch.seams.some((seam) => seam > first && seam <= next);
        });
    }
    // Write заменяет файл целиком, а значит и области в нём
    if (toolName === 'Write') return true;

    if (typeof toolInput.new_string !== 'string' || !toolInput.new_string) return false;
    const fragment = unifyEol(toolInput.new_string);
    for (let at = content.indexOf(fragment); at >= 0; at = content.indexOf(fragment, at + 1)) {
        const end = at + fragment.length;
        if (found.some(([from, to]) => at < to && end > from)) return true;
    }
    return false;
}

// Состояние — пустые файлы-метки в папке сессии во временном каталоге, не в
// репозитории: edited-<вид> — что уже правили, reminded-<кто>-<набор> — о чём уже
// сказали. Записывает правку и возвращает всё, что правили в этой сессии
function noteEdit(dir, view) {
    const edited = new Set([view]);
    try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'edited-' + view), '');
        for (const name of fs.readdirSync(dir)) {
            if (name.startsWith('edited-')) edited.add(name.slice('edited-'.length));
        }
    } catch { /* временный каталог недоступен — считаем, что правили только это */ }
    return edited;
}

// Хуки параллельных вызовов идут одновременно, поэтому метка «сказали» ставится
// флагом wx: создать её удаётся ровно одному процессу. У помощника свой контекст —
// напоминание, показанное ему, основная сессия не видела, поэтому метка у каждого своя
function claimReminder(dir, agentId, missing) {
    const mark = `reminded-${safeName(agentId || 'main')}-${missing.join('+')}`;
    try {
        fs.writeFileSync(path.join(dir, mark), '', { flag: 'wx' });
    } catch (err) {
        if (err.code === 'EEXIST') return false; // об этом наборе уже говорили
        // метку не поставить — повторное напоминание лучше ошибки
    }
    return true;
}

function main(data) {
    const input = JSON.parse(data);
    const toolInput = input.tool_input;
    if (!WRITE_TOOLS.has(input.tool_name) || !toolInput || typeof toolInput.file_path !== 'string') return;
    // ответ ниже — в виде PostToolUse; под другим событием (PostToolUseFailure — правка
    // не состоялась, PreToolUse — её ещё нет) он был бы и неверным, и не по делу
    if (input.hook_event_name && input.hook_event_name !== 'PostToolUse') return;
    if (typeof input.session_id !== 'string' || !input.session_id) return;

    // хук запускается на каждую правку: чужой путь отсекаем до любой работы с диском
    const target = targetFor(toolInput.file_path);
    if (!target) return;
    if (target.regions) {
        const resolved = path.resolve(input.cwd || process.cwd(), toolInput.file_path);
        if (!editTouchesRegions(resolved, input.tool_name, toolInput, input.tool_response, target.regions)) return;
    }

    const dir = path.join(os.tmpdir(), 'ok-three-views-' + safeName(input.session_id));
    const edited = noteEdit(dir, target.view);
    const missing = Object.keys(VIEWS).filter((view) => !edited.has(view));
    if (!missing.length) return; // все три отображения уже тронуты
    if (!claimReminder(dir, input.agent_id, missing)) return;

    const touched = target.view === SOURCE
        ? `общий источник ленты (${target.file})`
        : `отображение ${VIEW_NAMES[target.view]} (${target.file})`;
    const lines = [
        `Правка задела ${touched}. Сессия рисуется в трёх местах из одного источника — /api/sessions/messages: `
            + 'Sessions, Feed и Flow (DOCS/decisions/039). Новая роль или поле заводится сразу во всех трёх, '
            + 'расхождение между ними — дефект.',
        `В этой сессии ещё не тронуты: ${missing.map((view) => VIEWS[view]).join('; ')}.`,
    ];
    if (!edited.has(SOURCE)) {
        lines.push('Порядок работы: сначала источник (listMessages и record* в server.js, '
            + 'SYSTEM/core/hermes-history.js), потом три отображения.');
    }
    lines.push('Правка ленты считается сделанной, когда изменение видно живьём во всех трёх — Sessions, Feed и '
        + 'Flow < TEMP < 321; живая проверка на сервере пользователя — SYSTEM/live-check.mjs.');

    console.log(JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: lines.join('\n') },
    }));
}

// читатель закрыл канал раньше ответа — это не повод падать с ошибкой
process.stdout.on('error', () => {});
let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { data += chunk; });
process.stdin.on('error', () => process.exit(0));
process.stdin.on('end', () => {
    try {
        main(data);
    } catch { /* не разобрали вход или споткнулись сами — сторож сессию не ломает */ }
});
