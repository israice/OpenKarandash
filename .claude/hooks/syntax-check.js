// PostToolUse-хук: после Edit/Write проверяет, что тронутый файл парсится.
// Зачем: server.js перезапускает себя сам и сломанную правку отсекает тем же --check,
// но сообщение уходит в консоль сервера, а не в чат — сессия уверена, что справилась.
// Хук возвращает ошибку парсинга прямо в контекст, чтобы её починили сразу.
// Смотрит и .js, и инлайновый <script> в .html — в index.html лежит основная часть кода,
// и её не страхует никто: самопроверка сервера касается только самого server.js.
// Та же тихая поломка жила ещё в трёх местах, поэтому хук смотрит и их:
// - .py: сторож (SYSTEM/core/hermes-stack.js, restartBridge) на неразбираемом файле моста
//   лишь пишет в консоль сервера «файл бриджа не разбирается — оставляю работать прежнюю
//   версию» и оставляет старый мост — сессия «проверяет» свою правку на старом коде;
// - .mjs/.cjs: SYSTEM/*.mjs — сами инструменты проверки (gate, ui, branches, live-check),
//   а eslint и npm run check их не видят: глобы в eslint.config.mjs только *.js;
// - .json: битый .claude/settings.json молча отключает все хуки, битый package.json
//   ломает любой npm run.
// Предел: битый package.json в корне проекта не даёт node запустить ни один .js-хук,
// этот тоже (ERR_INVALID_PACKAGE_CONFIG при поиске типа модуля) — о нём хук сообщит,
// только если рядом с хуками лежит .claude/hooks/package.json с {"type":"commonjs"}.
// Регистрация — .claude/settings.json, ключ hooks.PostToolUse.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// NotebookEdit сюда не добавлен: он пишет только .ipynb,
// а фильтр по расширению ниже такие файлы всё равно отсеет.
// MultiEdit в Claude Code 2.1.278 среди инструментов уже нет — остались Edit и Write
const WRITE_TOOLS = new Set(['Edit', 'Write']);

// .jsonl сюда не попадает сам: у него другое расширение, и построчный JSON целиком не парсится
const CHECKED = new Set(['.js', '.mjs', '.cjs', '.html', '.py', '.json']);

// Возвращает JS из инлайновых <script> с сохранением нумерации строк: всё, что вне
// скрипта, становится пустой строкой, поэтому node --check укажет строку самого .html.
// Узнаём и голый <script>, и <script type="module"> — второй нужен, когда код начнут
// выносить в модули. Скрипты с src пропускаем: кода в них нет.
// ponytail: тег ищем построчно, как размечен index.html; потолок — разметка в одну
// строку или экзотические атрибуты, апгрейд: парсер HTML.
const SCRIPT_OPEN = /^\s*<script(\s[^>]*)?>\s*$/i;

function inlineJs(html) {
    const out = [];
    let inside = false;
    let module = false;
    for (const line of html.split(/\r?\n/)) {
        if (inside && /^\s*<\/script>/i.test(line)) inside = false;
        out.push(inside ? line : '');
        if (inside) continue;

        const open = line.match(SCRIPT_OPEN);
        if (!open) continue;
        const attrs = open[1] || '';
        if (/\ssrc\s*=/i.test(attrs)) continue; // внешний файл проверится сам по себе
        // importmap и прочие JSON/текстовые блоки — не JS, node --check их не разберёт
        if (/type\s*=\s*["']?(importmap|application\/json|text\/)/i.test(attrs)) continue;
        if (/type\s*=\s*["']?module/i.test(attrs)) module = true;
        inside = true;
    }
    return { code: out.join('\n'), module };
}

// Единый вид ответа для всех типов файлов: decision 'block' в PostToolUse правку
// не откатывает, а кладёт reason рядом с результатом инструмента.
// node и python печатают строку с ошибкой целиком, а минифицированная строка весит сотни
// килобайт — в контекст сессии такую не тащим; обычный код до потолка не дотягивается
const LINE_MAX = 2000;

function block(tool, name, details) {
    const clipped = details
        .split('\n')
        .map((line) => (line.length > LINE_MAX ? `${line.slice(0, LINE_MAX)}… (строка обрезана)` : line))
        .join('\n');
    console.log(JSON.stringify({
        decision: 'block',
        reason: `Файл не парсится (${tool} ${name}):\n${clipped}`,
    }));
}

// ---- .json ----

// Строгим JSON считаем не всё. Чужой код и рантайм-данные не наша забота: их пишут
// программы, а не сессия, и среди них бывает что угодно (обрезанные дампы, JSON с хвостом)
// тела сценариев SYSTEM/live-check.mjs: готовые — в навыке live-verify, разовые — в DATA/live/
const SCENARIO_BODY = /\/(DATA\/live|\.claude\/skills\/live-verify\/scenarios)\/[^/]+\.js$/;
const JSON_SKIP_DIRS = new Set(['node_modules', 'DATA', 'hermes', 'hermes-home', '.beads']);
// Эти файлы по договорённости их инструментов — JSONC: в них законны и комментарии,
// и висячие запятые. Сейчас в репозитории таких нет, список — на вырост
const JSONC_DIRS = new Set(['.vscode', '.devcontainer']);
const JSONC_NAME = /^(tsconfig|jsconfig)(\..+)?\.json$|^\.?devcontainer\.json$|^\.eslintrc\.json$/i;
// а эти читают node и npm — строгим JSON.parse: комментарий в package.json ломает любой
// npm run, поэтому поблажки для JSONC на них не действуют
const STRICT_NAME = /^package(-lock)?\.json$/i;
const JSON_MAX_BYTES = 8 * 1024 * 1024; // больше — это данные, а не настройки

// корень проекта считаем от самого хука (<корень>/.claude/hooks), а не от cwd сессии:
// сессия может стоять в подпапке, а проект — лежать внутри чужой папки с именем «hermes»
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

function jsonSkipped(resolved) {
    const rel = path.relative(PROJECT_ROOT, resolved);
    const outside = rel.startsWith('..') || path.isAbsolute(rel);
    const parts = (outside ? resolved : rel).split(/[\\/]+/);
    const name = parts.pop() || '';
    if (JSONC_NAME.test(name)) return true;
    return parts.some((part) => JSON_SKIP_DIRS.has(part) || JSONC_DIRS.has(part));
}

// Заменяет // и /* */ пробелами, не трогая строки и переводы строк: позиция ошибки
// в очищенном тексте остаётся позицией в самом файле
function stripJsonComments(text) {
    let out = '';
    let i = 0;
    while (i < text.length) {
        const ch = text[i];
        const next = text[i + 1];
        if (ch === '"') {
            let j = i + 1;
            while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
            out += text.slice(i, j + 1);
            i = j + 1;
        } else if (ch === '/' && (next === '/' || next === '*')) {
            let end = next === '/' ? text.indexOf('\n', i) : text.indexOf('*/', i + 2);
            if (end === -1 && next === '*') return out + text.slice(i); // незакрытый /* — поломка, а не комментарий
            if (end === -1) end = text.length;
            else if (next === '*') end += 2;
            out += text.slice(i, end).replace(/[^\r\n]/g, ' ');
            i = end;
        } else {
            out += ch;
            i += 1;
        }
    }
    return out;
}

function jsonError(text) {
    try {
        JSON.parse(text);
        return null;
    } catch (err) {
        let message = String(err.message);
        // старый Node даёт только «position N» — строку и столбец досчитываем сами
        const at = message.match(/position (\d+)/);
        if (at && !/\(line \d+/.test(message)) {
            const before = text.slice(0, Number(at[1])).split('\n');
            message += ` (line ${before.length} column ${before[before.length - 1].length + 1})`;
        }
        return message;
    }
}

// Windows PowerShell пишет файлы в UTF-16 с BOM, а Edit кодировку файла сохраняет:
// прочитанный как UTF-8, целый файл выглядел бы мусором и был бы объявлен битым
function readText(file) {
    const buf = fs.readFileSync(file);
    if (buf[0] === 0xFF && buf[1] === 0xFE) return buf.toString('utf16le');
    if (buf[0] === 0xFE && buf[1] === 0xFF) return buf.swap16().toString('utf16le');
    return buf.toString('utf8');
}

function checkJson(resolved) {
    if (jsonSkipped(resolved)) return;
    let text;
    try {
        if (fs.statSync(resolved).size > JSON_MAX_BYTES) return;
        text = readText(resolved);
    } catch {
        return; // файл уже унесли — проверять нечего
    }
    // BOM читатели JSON (npm, require) срезают сами; пустой файл — заготовка, а не поломка
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    if (!text.trim()) return;

    const strict = jsonError(text);
    if (!strict) return;
    const name = path.basename(resolved);
    // файл с комментариями (JSONC) — законный, если без них он разбирается; если не
    // разбирается и без них, показываем вторую ошибку: первая указала бы на сам комментарий
    const stripped = STRICT_NAME.test(name) ? text : stripJsonComments(text);
    if (!stripped.trim()) return; // одни комментарии — та же заготовка, что и пустой файл
    const relaxed = stripped === text ? strict : jsonError(stripped);
    if (!relaxed) return;
    block('JSON.parse', name, relaxed);
}

// ---- .py ----

// compile(), а не py_compile: тот пишет __pycache__, а exec-bridge/__pycache__/*.pyc
// уже лежит в git. Ловит то же, что и py_compile в сторожа, включая «return вне функции».
// Файл читаем байтами — так Python сам учитывает BOM и строку «# coding:», по умолчанию
// UTF-8. Ответ пишем байтами в UTF-8: консольная кодировка Windows ломает кириллицу.
// Метка в первой строке отличает наш ответ от заглушки Microsoft Store и чужого вывода.
// Версию сверяем как pythonCmd() в hermes-stack.js: мосту нужен 3.10+, а старый
// интерпретатор объявил бы ошибкой новый синтаксис (match, X | Y в аннотациях)
const PY_OK = 'SYNTAX-CHECK:OK';
const PY_ERR = 'SYNTAX-CHECK:ERR';
const PY_CHECK = `
import sys
if sys.version_info < (3, 10):
    sys.exit(4)
import traceback, warnings
warnings.simplefilter('ignore')
path = sys.argv[1]
result = '${PY_OK}'
try:
    with open(path, 'rb') as handle:
        source = handle.read()
    compile(source, path, 'exec', dont_inherit=True)
except (SyntaxError, ValueError) as err:
    result = '${PY_ERR}\\n' + ''.join(traceback.format_exception_only(type(err), err))
except Exception:
    pass
sys.stdout.buffer.write(result.encode('utf-8', 'backslashreplace'))
`;

function checkPython(resolved) {
    // «py -3» — только на Windows: из WSL он достал бы виндовый Python, а тому
    // путь вида /mnt/c/... не открыть
    const candidates = [['python3'], ['python']];
    if (process.platform === 'win32') candidates.push(['py', '-3']);
    // у хука 10 с на всё: три медленных кандидата по 4 с их бы перешагнули
    const deadline = Date.now() + 8000;

    for (const [cmd, ...launcherArgs] of candidates) {
        const left = deadline - Date.now();
        if (left < 500) return;
        let stdout;
        try {
            // программа идёт через stdin («python -»): многострочный -c на Windows
            // упирается в кавычки. -I — не подмешивать cwd в sys.path и не слушать
            // PYTHON*-переменные, -B — не писать .pyc даже для модулей самого Python
            stdout = execFileSync(cmd, [...launcherArgs, '-I', '-B', '-', resolved], {
                input: PY_CHECK,
                encoding: 'utf8',
                stdio: ['pipe', 'pipe', 'ignore'],
                timeout: Math.min(4000, left),
                killSignal: 'SIGKILL', // SIGTERM обёртка может проигнорировать — и хук повис бы с ней
                windowsHide: true,
            });
        } catch (err) {
            if (err.code === 'ETIMEDOUT') return; // завис — не сжигаем таймаут хука на остальных
            continue; // такого интерпретатора нет, это заглушка или версия старше 3.10
        }
        if (stdout.startsWith(PY_ERR)) {
            block('python compile', path.basename(resolved), stdout.slice(PY_ERR.length).trim());
            return;
        }
        if (stdout.startsWith(PY_OK)) return;
        // вывод не наш — это не тот Python, пробуем следующий
    }
    // интерпретатора нет (на Windows его может не быть вовсе) — молчим
}

function main() {
    let input;
    try {
        input = JSON.parse(fs.readFileSync(0, 'utf8'));
    } catch {
        return; // не разобрали вход — не наша забота
    }

    const filePath = input.tool_input?.file_path;
    if (!WRITE_TOOLS.has(input.tool_name) || !filePath) return;

    const ext = path.extname(filePath).toLowerCase();
    if (!CHECKED.has(ext)) return;

    const resolved = path.resolve(input.cwd || process.cwd(), filePath);

    // пропавший или нечитаемый файл, каталог с таким именем: node --check назвал бы это
    // ошибкой разбора («Cannot find module»), а чтение FIFO повесило бы хук до таймаута
    try {
        if (!fs.statSync(resolved).isFile()) return;
        fs.accessSync(resolved, fs.constants.R_OK);
    } catch {
        return; // файл уже унесли — проверять нечего
    }

    if (ext === '.json') return checkJson(resolved);
    if (ext === '.py') return checkPython(resolved);

    // .js проверяем как файл, инлайновый скрипт — через stdin (`node --check -`),
    // чтобы не заводить временных файлов ради одной проверки.
    // Для .mjs/.cjs тип модуля node берёт из расширения, обход через stdin им не нужен
    let args = ['--check', resolved];
    let source;
    if (ext === '.js') {
        // ES-модуль (SYSTEM/app.js, PROJECTS/Chat/chat.js, PROJECTS/Flow/flow-minion.js)
        // голый `node --check` считает ошибкой: package.json объявляет commonjs.
        // Узнаём модуль по import/export в начале строки и разбираем через stdin
        // с явным типом — как инлайновый <script type="module"> ниже
        try {
            source = fs.readFileSync(resolved, 'utf8');
        } catch {
            return; // файл уже унесли — проверять нечего
        }
        if (SCENARIO_BODY.test(resolved.replace(/\\/g, '/'))) {
            // сценарий живой проверки — тело async-функции для страницы пульта (верхнеуровневые
            // await и return), а не модуль: разбираем обёрнутым, номера строк в ошибке больше на 1
            source = `(async () => {\n${source}\n})`;
            args = ['--check', '-'];
        } else if (/^\s*(import|export)\b/m.test(source)) args = ['--check', '--input-type=module', '-'];
        else source = undefined;
    }
    if (ext === '.html') {
        let inline;
        try {
            inline = inlineJs(fs.readFileSync(resolved, 'utf8'));
        } catch {
            return; // файл уже унесли — проверять нечего
        }
        if (!inline.code.trim()) return; // инлайнового кода нет
        source = inline.code;
        // модульный скрипт разбирается по другим правилам: без явного указания
        // node принял бы import/export за синтаксическую ошибку
        args = inline.module ? ['--check', '--input-type=module', '-'] : ['--check', '-'];
    }

    try {
        execFileSync(process.execPath, args, {
            input: source,
            stdio: ['pipe', 'ignore', 'pipe'],
            timeout: 8000, // у хука 10 с на всё
            killSignal: 'SIGKILL',
            windowsHide: true,
        });
    } catch (err) {
        // node не запустился, завис или убит сигналом — это не ошибка синтаксиса, молчим
        if (typeof err.status !== 'number') return;
        // из вывода node --check нужна строка с ошибкой, а не стек самого node
        const name = path.basename(resolved);
        const details = String(err.stderr || err.message)
            .split(/\r?\n/)
            .filter((line) => !/^\s+at |^Node\.js v/.test(line))
            .join('\n')
            .trim()
            .replace(/^\[stdin\]:/, `${name}:`); // при проверке через stdin node не знает имени файла
        block('node --check', name, details);
    }
}

// сторож не должен ломать сессию: лучше пропустить проверку, чем уронить хук
try {
    main();
} catch { /* молча выходим */ }
