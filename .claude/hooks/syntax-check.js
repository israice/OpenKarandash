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

// NotebookEdit сюда не добавлен: он пишет только .ipynb,
// а фильтр по расширению ниже такие файлы всё равно отсеет.
const WRITE_TOOLS = new Set(['Edit', 'Write']);

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
        if (/^\s*(import|export)\b/m.test(source)) args = ['--check', '--input-type=module', '-'];
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
