// PostToolUse-хук: после Edit/Write проверяет, что тронутый код парсится (node --check).
// Зачем: server.js перезапускает себя сам и сломанную правку отсекает тем же --check,
// но сообщение уходит в консоль сервера, а не в чат — сессия уверена, что справилась.
// Хук возвращает ошибку парсинга прямо в контекст, чтобы её починили сразу.
// Смотрит и .js, и инлайновый <script> в .html — в index.html лежит основная часть кода,
// и её не страхует никто: самопроверка сервера касается только самого server.js.
// Регистрация — .claude/settings.json, ключ hooks.PostToolUse.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// NotebookEdit сюда не добавлен (в отличие от file-lock.js): он пишет только .ipynb,
// а фильтр по расширению ниже такие файлы всё равно отсеет.
const WRITE_TOOLS = new Set(['Edit', 'Write']);

// Возвращает JS из инлайновых <script> с сохранением нумерации строк: всё, что вне
// скрипта, становится пустой строкой, поэтому node --check укажет строку самого .html.
// ponytail: узнаём только голый <script> на отдельной строке — так размечен index.html.
// Скрипты с атрибутами пропускаем осознанно: у src-скриптов кода тут нет, а
// type="module" — это ESM, и node --check в режиме CJS дал бы ложную тревогу.
// Потолок — разметка усложнится и часть кода перестанет проверяться; апгрейд: парсер HTML.
function inlineJs(html) {
    const out = [];
    let inside = false;
    for (const line of html.split(/\r?\n/)) {
        if (inside && /^\s*<\/script>/i.test(line)) inside = false;
        out.push(inside ? line : '');
        if (!inside && /^\s*<script\s*>\s*$/i.test(line)) inside = true;
    }
    return out.join('\n');
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
    if (ext !== '.js' && ext !== '.html') return;

    const resolved = path.resolve(input.cwd || process.cwd(), filePath);

    // .js проверяем как файл, инлайновый скрипт — через stdin (`node --check -`),
    // чтобы не заводить временных файлов ради одной проверки
    let args = ['--check', resolved];
    let source;
    if (ext === '.html') {
        try {
            source = inlineJs(fs.readFileSync(resolved, 'utf8'));
        } catch {
            return; // файл уже унесли — проверять нечего
        }
        if (!source.trim()) return; // инлайнового кода нет
        args = ['--check', '-'];
    }

    try {
        execFileSync(process.execPath, args, { input: source, stdio: ['pipe', 'ignore', 'pipe'] });
    } catch (err) {
        // из вывода node --check нужна строка с ошибкой, а не стек самого node
        const name = path.basename(resolved);
        const details = String(err.stderr || err.message)
            .split(/\r?\n/)
            .filter((line) => !/^\s+at |^Node\.js v/.test(line))
            .join('\n')
            .trim()
            .replace(/^\[stdin\]:/, `${name}:`); // при проверке через stdin node не знает имени файла
        console.log(JSON.stringify({
            decision: 'block',
            reason: `Файл не парсится (node --check ${name}):\n${details}`,
        }));
    }
}

main();
