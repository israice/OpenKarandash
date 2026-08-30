// Вкладка Graph, серверная половина: карта проекта в виде vault, память о сессиях,
// поисковый индекс (FTS5) и чтение-правка файла из узла графа.
// Вынесено из server.js — вся вкладка живёт в PROJECTS/Graph.
//
// Модуль ничего не знает про http и хранилище сессий: то, что ему нужно снаружи,
// приходит один раз через init().

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..', '..');

// всё, что сервер производит сам, лежит в одной папке: vault, поисковый индекс,
// база сессий. её не обходят ни карта, ни сторож файлов
const DATA_DIR = 'DATA';
const VAULT_DIR = `${DATA_DIR}/vault`; // Obsidian vault проекта: создаётся сам
fs.mkdirSync(path.join(ROOT, DATA_DIR), { recursive: true }); // до открытия баз ниже

// { listSessions, listMessages, sessionTitle, onMapReady } — проставляет init()
let deps = null;

function init(options) {
    deps = options;
    return module.exports;
}

// ---------- граф Obsidian ----------

// vault читаем прямо с диска: Local REST API требует запущенного Obsidian и токена,
// а нам нужны только имена заметок и ссылки [[...]] между ними
const VAULT = process.env.OBSIDIAN_VAULT || path.join(ROOT, VAULT_DIR);

// подпапка vault под карту файлов проекта. её содержимое генерируем мы, поэтому
// перезаписываем целиком; заметки, написанные руками, лежат вне её и не страдают
const MAP_DIR = 'Проект';
const UNIT_DIR = 'Секции';   // заметки секций и функций внутри крупных файлов
const API_SUBDIR = 'API';    // заметки API-роутов: стык клиента и сервера
const SESSION_DIR = 'Сессии'; // память о прошлых сессиях, эту папку не сносим

// в этих файлах ищем упоминания других файлов проекта — из них и получаются рёбра
const TEXT_FILES = /\.(js|mjs|cjs|ts|tsx|jsx|json|html|css|md|txt|yml|yaml|sh|py|sql)$/i;
const MAX_SCAN_BYTES = 512 * 1024; // огромные файлы (дампы, бандлы) не сканируем

// служебные папки Obsidian: настройки и корзина — не заметки
const VAULT_SKIP = new Set(['.obsidian', '.trash', '.git']);

function collectNotes(dir, base, acc = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (VAULT_SKIP.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) collectNotes(full, base, acc);
        else if (entry.name.endsWith('.md')) acc.push(path.relative(base, full).split(path.sep).join('/'));
    }
    return acc;
}

// в карту идёт всё, что физически лежит в папке проекта, включая скрытые файлы
// и то, что игнорирует git (.env, локальные настройки).
// исключений ровно два, и оба вынужденные:
//   .git — служебная база на тысячи объектов, содержимое проекта в ней дублируется
//   DATA — то, что сервер произвёл сам: карта из vault уже в графе узлами,
//   и заметки о заметках плодились бы с каждой пересборкой
const MAP_SKIP = new Set(['.git', 'node_modules', DATA_DIR]);

function projectFiles(dir = ROOT, acc = []) {
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return acc; // папка исчезла или недоступна — пропускаем её целиком
    }
    for (const entry of entries) {
        if (MAP_SKIP.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) projectFiles(full, acc);
        else acc.push(path.relative(ROOT, full).split(path.sep).join('/'));
    }
    return dir === ROOT ? acc.sort() : acc;
}

// карта проекта в виде заметок Obsidian. рёбра берём только из якорных мест —
// строковых литералов, атрибутов и wikilinks. свободный поиск имени файла в тексте
// даёт слишком много ложных связей, поэтому от него отказались
const API_REF = /['"`](\/api\/[a-z0-9/_-]+)['"`]/gi;      // и fetch('/api/…'), и api('/api/…'), и path: в хуках
const API_ROUTE = /urlPath === '(\/api\/[a-z0-9/_-]+)'/g; // объявление роута в server.js
const HTML_REF = /(?:src|href)\s*=\s*["']([^"':#?]+)["']/gi;
const MODULE_REF = /(?:require\(|from\s+|import\()\s*['"](\.[^'"]+)['"]/g;
const SECTION = /^\s*\/\/ -{3,} (.+?) -{3,}\s*$/;
const TOP_FUNCTION = /^(\s*)(?:async )?function ([A-Za-z0-9_$]+)\s*\(/;
const BIG_FILE_LINES = 200; // мелкие файлы на секции не режем — только зашумит граф

// имя заметки должно быть уникальным по всему vault: buildVaultGraph резолвит
// [[ссылки]] по basename, как это делает сам Obsidian
function noteName(text) {
    return text.replace(/[\\/:*?"<>|]/g, '-').trim();
}

// секции (комментарии-разделители) и функции верхнего уровня — узлы внутри файла.
// тело функции считаем до следующего объявления того же отступа: без AST, но
// этого хватает, чтобы увидеть, кто кого вызывает
// перед поиском вызовов вычищаем строки и комментарии: имя функции, упомянутое
// в тексте сообщения или в пояснении, вызовом не является. содержимое заменяем
// пробелами, а не выкусываем — так не склеятся соседние идентификаторы
function stripStringsAndComments(code) {
    let out = '';
    let mode = null;      // '//' | '/*' | "'" | '"' | '`'
    const inserts = [];   // вложенные ${...}: в них лежит код, его сохраняем
    let braces = 0;       // глубина фигурных скобок внутри текущей подстановки

    for (let i = 0; i < code.length; i++) {
        const ch = code[i];
        const next = code[i + 1];

        if (mode === '//') {
            if (ch === '\n') { mode = null; out += ch; } else out += ' ';
            continue;
        }
        if (mode === '/*') {
            if (ch === '*' && next === '/') { mode = null; out += '  '; i++; }
            else out += ch === '\n' ? ch : ' ';
            continue;
        }
        if (mode) { // внутри строки или шаблона
            if (ch === '\\') { out += '  '; i++; continue; } // экранированный символ целиком
            // ${...} в шаблоне — это выражение, а не текст: возвращаемся к разбору кода
            if (mode === '`' && ch === '$' && next === '{') {
                inserts.push(braces);
                braces = 0;
                mode = null;
                out += '  ';
                i++;
                continue;
            }
            if (ch === mode) { mode = null; out += ' '; continue; }
            out += ch === '\n' ? ch : ' ';
            continue;
        }

        if (ch === '/' && next === '/') { mode = '//'; out += '  '; i++; continue; }
        if (ch === '/' && next === '*') { mode = '/*'; out += '  '; i++; continue; }
        if (ch === "'" || ch === '"' || ch === '`') { mode = ch; out += ' '; continue; }

        // выходим из подстановки только по её закрывающей скобке, а не по вложенной
        if (inserts.length) {
            if (ch === '{') braces++;
            else if (ch === '}') {
                if (braces === 0) { braces = inserts.pop(); mode = '`'; out += ' '; continue; }
                braces--;
            }
        }
        out += ch;
    }
    return out;
}

function parseUnits(file, text) {
    const lines = text.split(/\r?\n/); // файлы проекта в CRLF
    if (lines.length < BIG_FILE_LINES) return [];

    const units = [];
    lines.forEach((line, i) => {
        const section = line.match(SECTION);
        if (section) {
            units.push({ kind: 'section', title: section[1], line: i + 1, indent: 0 });
            return;
        }
        const fn = line.match(TOP_FUNCTION);
        if (fn) units.push({ kind: 'function', title: fn[2], line: i + 1, indent: fn[1].length });
    });

    // границы: юнит тянется до следующего юнита с тем же или меньшим отступом
    units.forEach((unit, i) => {
        const next = units.slice(i + 1).find((other) => other.indent <= unit.indent);
        unit.body = lines.slice(unit.line, next ? next.line - 1 : lines.length).join('\n');
        unit.code = stripStringsAndComments(unit.body); // по нему ищем вызовы
        unit.note = `${MAP_DIR}/${UNIT_DIR}/${noteName(`${path.basename(file)} ${unit.title}`)}`;
        // функция принадлежит последней секции выше себя — так граф становится
        // деревом файл → секция → функция, а не плоским веером от файла
        if (unit.kind === 'function') {
            const owner = units.slice(0, i).reverse().find((other) => other.kind === 'section');
            unit.parent = owner ? owner.note : null;
        }
    });
    return units;
}

// история git: когда файл появился, как часто меняется и с чем меняется вместе
function gitHistory() {
    const empty = { byFile: new Map(), pairs: new Map(), commits: 0 };
    let out;
    try {
        out = execFileSync('git', ['log', '--pretty=format:%h|%ad|%s', '--date=short', '--name-only'], {
            cwd: ROOT,
            encoding: 'utf8',
            windowsHide: true,
            maxBuffer: 16 * 1024 * 1024,
        });
    } catch {
        return empty; // не репозиторий или пустая история
    }

    const commits = out.split(/\r?\n\s*\r?\n/).map((block) => {
        const [head, ...rest] = block.split(/\r?\n/);
        const [hash, date, subject] = (head || '').split('|');
        return { hash, date, subject, files: rest.filter(Boolean) };
    }).filter((commit) => commit.hash);
    if (!commits.length) return empty;

    const byFile = new Map();
    for (const commit of commits) {
        for (const file of commit.files) {
            const entry = byFile.get(file) || { commits: 0, last: commit, first: commit };
            entry.commits++;
            entry.first = commit; // log идёт от новых к старым, последний перезаписавший — самый старый
            byFile.set(file, entry);
        }
    }

    // файл, который меняется почти в каждом коммите (VERSION.md), связан со всем
    // подряд и превратился бы в ложный хаб — из пар его исключаем
    const noisy = new Set([...byFile].filter(([, e]) => e.commits / commits.length > 0.6).map(([f]) => f));
    const pairs = new Map();
    for (const commit of commits) {
        const files = commit.files.filter((file) => !noisy.has(file));
        for (let i = 0; i < files.length; i++) {
            for (let j = i + 1; j < files.length; j++) {
                const key = JSON.stringify([files[i], files[j]].sort());
                pairs.set(key, (pairs.get(key) || 0) + 1);
            }
        }
    }
    return { byFile, pairs, commits: commits.length };
}

function readText(file) {
    try {
        if (fs.statSync(path.join(ROOT, file)).size > MAX_SCAN_BYTES) return '';
        return fs.readFileSync(path.join(ROOT, file), 'utf8');
    } catch {
        return ''; // файл исчез между обходом и чтением
    }
}

// заметки, записанные в текущую пересборку: по ним видно, что устарело
let writtenNotes = new Set();

// правки идут пачками, а меняется обычно одна заметка из двух сотен. переписывать
// весь vault каждые три секунды — лишняя работа и лишний износ диска
function writeNote(notePath, frontmatter, body) {
    const note = [
        '---',
        ...Object.entries(frontmatter).filter(([, value]) => value !== undefined && value !== '').map(([k, v]) => `${k}: ${v}`),
        '---',
        '',
        ...body,
        '',
    ].join('\n');

    writtenNotes.add(path.resolve(notePath));
    try {
        if (fs.readFileSync(notePath, 'utf8') === note) return; // содержимое то же — не трогаем
    } catch {
        // заметки ещё нет — создадим ниже
    }
    fs.mkdirSync(path.dirname(notePath), { recursive: true });
    fs.writeFileSync(notePath, note);
}

// осиротевшие заметки: файл удалили или переименовали, а заметка о нём осталась
function dropStaleNotes(dir) {
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return;
    }
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            dropStaleNotes(full);
            try {
                if (!fs.readdirSync(full).length) fs.rmdirSync(full); // папка опустела
            } catch {
                // не удалось — не беда, попробуем в следующий раз
            }
            continue;
        }
        if (entry.name.endsWith('.md') && !writtenNotes.has(path.resolve(full))) fs.unlinkSync(full);
    }
}

function syncProjectMap() {
    const files = projectFiles();
    const known = new Set(files);
    const history = gitHistory();

    const mapRoot = path.join(VAULT, MAP_DIR);
    writtenNotes = new Set(); // начинаем новый круг: что не запишем — то устарело

    // первый проход: разбираем тексты, собираем роуты и юниты
    const texts = new Map();
    const units = new Map();
    const routeImpl = new Map(); // роут → файл, где он объявлен
    for (const file of files) {
        if (!TEXT_FILES.test(file)) continue;
        const text = readText(file);
        texts.set(file, text);
        units.set(file, parseUnits(file, text));
        for (const match of text.matchAll(API_ROUTE)) routeImpl.set(match[1], file);
    }

    // второй проход: заметки файлов со ссылками
    const routeCallers = new Map();
    for (const file of files) {
        const text = texts.get(file) || '';
        const links = new Set();

        for (const match of text.matchAll(API_REF)) {
            const route = match[1];
            if (!routeImpl.has(route)) continue; // роут, которого нет — не узел
            links.add(`${MAP_DIR}/${API_SUBDIR}/${noteName(route.slice(5))}`);
            if (routeImpl.get(route) !== file) {
                const callers = routeCallers.get(route) || new Set();
                callers.add(file);
                routeCallers.set(route, callers);
            }
        }
        for (const match of [...text.matchAll(HTML_REF), ...text.matchAll(MODULE_REF)]) {
            const target = resolveRef(match[1], file, known);
            if (target && target !== file) links.add(`${MAP_DIR}/${target}`);
        }
        if (file.endsWith('.md')) {
            for (const match of text.matchAll(/\[\[([^\]|#^]+)/g)) links.add(match[1].trim());
        }

        const git = history.byFile.get(file);
        const fileUnits = units.get(file) || [];
        writeNote(path.join(mapRoot, `${file}.md`), {
            kind: 'file',
            file,
            lines: text ? text.split(/\r?\n/).length : undefined,
            commits: git ? git.commits : undefined,
            first_seen: git ? git.first.date : undefined,
            last_commit: git ? `${git.last.date} ${git.last.subject}` : undefined,
        }, [
            `Файл проекта: \`${file}\``,
            '',
            ...section('Ссылается на', [...links].sort().map((target) => `- [[${target}]]`)),
            ...section('Внутри', fileUnits
                .filter((unit) => !unit.parent) // функции внутри секций перечислит сама секция
                .map((unit) => `- [[${unit.note}]] (строка ${unit.line})`)),
        ]);
    }

    // заметки секций и функций: связь с родителем и вызовы соседей
    for (const [file, fileUnits] of units) {
        const names = new Map(fileUnits.filter((u) => u.kind === 'function').map((u) => [u.title, u]));
        for (const unit of fileUnits) {
            // секция не «вызывает» свои функции — она их содержит, иначе одна и та же
            // связь попадёт в граф дважды и разными смыслами
            const own = unit.kind === 'section'
                ? fileUnits.filter((other) => other.parent === unit.note)
                : [];
            const calls = new Set();
            if (unit.kind === 'function') {
                for (const [name, target] of names) {
                    // (?<![.\w$]) отсекает методы объектов: res.close(), Promise.resolve() —
                    // иначе общие имена вроде open/close дают лавину ложных вызовов
                    if (target !== unit && new RegExp(`(?<![.\\w$])${name}\\s*\\(`).test(unit.code)) calls.add(target.note);
                }
            }
            writeNote(path.join(VAULT, `${unit.note}.md`), {
                kind: unit.kind,
                file,
                line: unit.line,
            }, [
                // ссылаемся только на прямого родителя: функция внутри секции —
                // на секцию, иначе в графе появится второе ребро до файла
                `${unit.kind === 'section' ? 'Секция' : 'Функция'} \`${unit.title}\` в [[${unit.parent || `${MAP_DIR}/${file}`}]], строка ${unit.line}.`,
                '',
                ...section('Внутри', own.map((other) => `- [[${other.note}]] (строка ${other.line})`)),
                ...section('Вызывает', [...calls].sort().map((note) => `- [[${note}]]`)),
            ]);
        }
    }

    // заметки API-роутов: точка стыковки клиента и сервера
    for (const [route, impl] of routeImpl) {
        const callers = [...(routeCallers.get(route) || [])].sort();
        writeNote(path.join(mapRoot, API_SUBDIR, `${noteName(route.slice(5))}.md`), {
            kind: 'route',
            route,
        }, [
            `API-роут \`${route}\`, реализован в [[${MAP_DIR}/${impl}]].`,
            '',
            ...section('Вызывают', callers.map((file) => `- [[${MAP_DIR}/${file}]]`)),
        ]);
    }

    // заметка «менялись вместе»: рёбра из истории git, вес = число общих коммитов
    const pairs = [...history.pairs].filter(([, weight]) => weight >= 2);
    if (pairs.length) {
        writeNote(path.join(mapRoot, 'История git.md'), {
            kind: 'history',
            commits: history.commits,
        }, [
            `Файлы, которые меняются вместе (из ${history.commits} коммитов).`,
            '',
            ...pairs.sort((a, b) => b[1] - a[1]).flatMap(([key, weight]) => {
                const [a, b] = JSON.parse(key);
                return known.has(a) && known.has(b) ? [`- ${weight}× [[${MAP_DIR}/${a}]] ↔ [[${MAP_DIR}/${b}]]`] : [];
            }),
        ]);
    }
}

// путь из src=/href=/require() относительно файла, где встретился
function resolveRef(ref, from, known) {
    if (/^[a-z]+:/i.test(ref)) return null; // http:, data:, obsidian: — не файлы проекта
    const base = ref.startsWith('.') ? path.posix.join(path.posix.dirname(from), ref) : ref.replace(/^\//, '');
    for (const candidate of [base, `${base}.js`, `${base}.mjs`, `${base}/index.js`]) {
        if (known.has(candidate)) return candidate;
    }
    return null;
}

function section(title, items) {
    return items.length ? [`## ${title}`, ...items, ''] : [];
}

// vault заводим и наполняем при старте сервера, дальше обновляем после правок —
// к моменту, когда пользователь откроет вкладку Graph, карта уже готова
function prepareVault() {
    try {
        fs.mkdirSync(VAULT, { recursive: true });
        syncProjectMap();
        syncSessionNotes();
        dropStaleNotes(path.join(VAULT, MAP_DIR)); // карта: файл исчез — заметка тоже
        dropStaleNotes(path.join(VAULT, SESSION_DIR)); // сессию удалили из списка — и заметку
    } catch (error) {
        console.error(`Не удалось собрать карту проекта в vault: ${error.message}`);
    }
    rebuildSearchIndex(); // индекс строим и при частичной карте: поиск лучше устаревшего ничего
    deps.onMapReady(); // карта пересобралась — страница перерисует граф
}

// frontmatter заметки: только простые «ключ: значение», без вложенности —
// ровно то, что пишет writeNote
function readFrontmatter(text) {
    const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!match) return {};
    const meta = {};
    for (const line of match[1].split(/\r?\n/)) {
        const pair = line.match(/^([a-z_]+):\s*(.*)$/i);
        if (pair) meta[pair[1]] = pair[2];
    }
    return meta;
}

function buildVaultGraph() {
    if (!fs.existsSync(VAULT)) return { ok: false, error: `Vault не найден: ${VAULT}` };

    const paths = collectNotes(VAULT, VAULT);

    // ссылку ищем сначала по полному пути — так одноимённые файлы из разных папок
    // остаются разными узлами. по короткому имени резолвим только то, что однозначно:
    // именно так ведёт себя и сам Obsidian, требуя путь при совпадении имён
    const byPath = new Map(paths.map((note) => [note.toLowerCase(), note]));
    const byName = new Map();
    const ambiguous = new Set();
    for (const note of paths) {
        const name = path.basename(note, '.md').toLowerCase();
        if (byName.has(name)) ambiguous.add(name);
        byName.set(name, note);
    }
    for (const name of ambiguous) byName.delete(name);

    function resolveLink(raw) {
        const link = raw.trim().replace(/\.md$/i, '');
        return byPath.get(`${link.toLowerCase()}.md`) || byName.get(path.basename(link).toLowerCase());
    }

    const notes = [];
    const links = new Set();
    for (const note of paths) {
        let text;
        try {
            text = fs.readFileSync(path.join(VAULT, note), 'utf8');
        } catch {
            continue; // заметку удалили между обходом и чтением
        }

        const meta = readFrontmatter(text);
        notes.push({
            path: note,
            kind: meta.kind || 'note', // написанные руками заметки без frontmatter
            file: meta.file,
            line: meta.line ? Number(meta.line) : undefined,
            route: meta.route,
            date: meta.date,
            group: note.split('/')[0],
        });

        // из [[Имя|подпись#заголовок]] нужна только часть до | # ^
        for (const match of text.matchAll(/\[\[([^\]|#^]+)/g)) {
            const target = resolveLink(match[1]);
            // пара нормализуется: заметка ссылается на родителя, родитель — на неё,
            // но в графе это одно ребро
            if (target && target !== note) links.add(JSON.stringify([note, target].sort()));
        }
    }

    return {
        ok: true,
        vault: path.basename(VAULT),
        notes,
        links: [...links].map((pair) => JSON.parse(pair)),
    };
}

// ---------- память о сессиях ----------

// заметки сессий лежат вне MAP_DIR и потому переживают пересборку карты.
// это память: её не сносим даже при сбросе списка сессий
const EDITING_TOOLS = /^(Edit|Write|NotebookEdit) (.+)$/;

function sessionNote(session) {
    const date = String(session.updatedAt || '').slice(0, 10);
    return noteName(`${date} ${deps.sessionTitle(session)} ${String(session.id).slice(0, 8)}`);
}

function syncSessionNotes() {
    const files = projectFiles();
    const byName = new Map();
    for (const file of files) byName.set(path.basename(file).toLowerCase(), file);

    const noteDir = path.join(VAULT, SESSION_DIR);
    for (const session of deps.listSessions.all()) {
        const messages = deps.listMessages.all(session.id);
        const spoken = messages.filter((m) => m.role === 'user' || m.role === 'assistant');
        const touched = new Set();
        for (const message of messages) {
            if (message.role !== 'tool') continue;
            const edit = message.text.match(EDITING_TOOLS);
            const target = edit && byName.get(path.basename(edit[2]).toLowerCase());
            if (target) touched.add(target);
        }

        // оборванные сессии без ответа и без правок памяти не заслуживают
        if (!spoken.some((m) => m.role === 'assistant') && !touched.size) continue;

        // сессия устарела, если затронутые файлы правились уже после неё —
        // иначе прошлое решение читалось бы как актуальное
        const when = Date.parse(session.updatedAt) || 0;
        const changed = [...touched].filter((file) => {
            try {
                return fs.statSync(path.join(ROOT, file)).mtimeMs > when + 60_000;
            } catch {
                return false;
            }
        });

        const answer = [...spoken].reverse().find((m) => m.role === 'assistant');
        writeNote(path.join(noteDir, `${sessionNote(session)}.md`), {
            kind: 'session',
            date: String(session.updatedAt || '').slice(0, 10),
            messages: session.messageCount,
            stale: changed.length ? 'true' : undefined,
        }, [
            ...(changed.length ? [`⚠ После этой сессии менялись: ${changed.join(', ')}`, ''] : []),
            `## Что просили`,
            deps.sessionTitle(session),
            '',
            ...section('Чем закончилось', answer ? [answer.text.split(/\r?\n\r?\n/)[0].slice(0, 400)] : []),
            ...section('Файлы', [...touched].sort().map((file) => `- [[${MAP_DIR}/${file}]]`)),
        ]);
    }
}

// ---------- поиск по проекту (FTS5) ----------

// индекс — производный кэш, его можно удалить и пересобрать, поэтому он живёт
// отдельно от .sessions.db, где переписка существует в единственном экземпляре.
// лежит в DATA: эту папку не обходит ни карта, ни сторож файлов, и запись
// в базу не вызывает перезагрузку страницы
const INDEX_FILE = path.join(ROOT, DATA_DIR, '.index.db');
const searchDb = new DatabaseSync(INDEX_FILE);
searchDb.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');

// unicode61 нужен для кириллицы, prefix — чтобы работал поиск по началу слова
searchDb.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS docs USING fts5(
        kind UNINDEXED,
        ref  UNINDEXED,
        title,
        body,
        tokenize = 'unicode61 remove_diacritics 2',
        prefix = '2 3'
    );
`);

const insertDoc = searchDb.prepare('INSERT INTO docs(kind, ref, title, body) VALUES (?, ?, ?, ?)');

// сырой ввод в MATCH роняет запрос («fts5: syntax error near "."»), поэтому каждое
// слово оборачиваем в кавычки, а последнему разрешаем префиксный поиск
function ftsQuery(raw) {
    const terms = String(raw || '')
        .split(/\s+/)
        .filter(Boolean)
        .map((term) => `"${term.replace(/"/g, '""')}"`);
    if (!terms.length) return '';
    terms[terms.length - 1] += '*';
    return terms.join(' ');
}

// индекс собираем целиком: весь проект — сотни килобайт, полная пересборка
// занимает единицы миллисекунд, инкрементальность тут не окупается
function rebuildSearchIndex() {
    searchDb.exec('BEGIN');
    try {
        searchDb.exec('DELETE FROM docs');

        // код: крупные файлы режем по секциям, чтобы попадание указывало на узел графа
        for (const file of projectFiles()) {
            if (!TEXT_FILES.test(file)) continue;
            const text = readText(file);
            if (!text) continue;

            const units = parseUnits(file, text).filter((unit) => unit.kind === 'section');
            if (units.length) {
                for (const unit of units) insertDoc.run('code', unit.note, `${file} › ${unit.title}`, unit.body);
            } else {
                insertDoc.run('code', `${MAP_DIR}/${file}`, file, text);
            }
        }

        // заметки vault: и сгенерированные, и написанные руками
        for (const note of collectNotes(VAULT, VAULT)) {
            const text = readText(path.join(VAULT_DIR, note)) || safeRead(path.join(VAULT, note));
            if (text) insertDoc.run('note', note.replace(/\.md$/, ''), note, text);
        }

        // сессии: только человеческая часть переписки. вывод инструментов — это
        // 1500 строк вида «Read index.html», в поиске от них один шум
        for (const session of deps.listSessions.all()) {
            const messages = deps.listMessages.all(session.id).filter((m) => m.role === 'user' || m.role === 'assistant');
            if (!messages.length) continue;
            insertDoc.run(
                'session',
                `${SESSION_DIR}/${sessionNote(session)}`,
                deps.sessionTitle(session),
                messages.map((m) => m.text).join('\n\n'),
            );
        }

        searchDb.exec('COMMIT');
    } catch (error) {
        searchDb.exec('ROLLBACK');
        console.error(`Не удалось собрать поисковый индекс: ${error.message}`);
    }
}

function safeRead(file) {
    try {
        return fs.readFileSync(file, 'utf8');
    } catch {
        return '';
    }
}

function searchProject(query, limit = 20) {
    const match = ftsQuery(query);
    if (!match) return { ok: true, hits: [] };
    try {
        // веса по колонкам: совпадение в заголовке важнее, чем в теле
        const hits = searchDb.prepare(`
            SELECT kind, ref, title, snippet(docs, 3, '«', '»', '…', 12) AS snippet
            FROM docs WHERE docs MATCH ? ORDER BY bm25(docs, 0, 0, 10.0, 1.0) LIMIT ?
        `).all(match, Math.min(Number(limit) || 20, 100));
        return { ok: true, hits };
    } catch (error) {
        return { ok: false, error: `Не удалось выполнить поиск: ${error.message}` };
    }
}

// ---------- чтение и правка файла из графа ----------

// узел графа открывается в окне с содержимым, поэтому нужен доступ к самому файлу.
// путь приходит от клиента — проверяем его так же, как при раздаче статики
const MAX_EDIT_BYTES = 2 * 1024 * 1024; // больше в textarea всё равно не отредактировать

// сравнивать надо реальные пути: символическая ссылка внутри проекта указывала бы
// наружу, а обычная склейка строк этого не заметила бы
const ROOT_REAL = fs.realpathSync(ROOT);

function resolveInsideRoot(relative) {
    const candidate = path.resolve(ROOT_REAL, String(relative || ''));
    let real;
    try {
        real = fs.realpathSync(candidate);
    } catch {
        // файла может не быть — тогда проверяем папку, в которой он должен лежать
        try {
            real = path.join(fs.realpathSync(path.dirname(candidate)), path.basename(candidate));
        } catch {
            return null;
        }
    }
    return real === ROOT_REAL || real.startsWith(ROOT_REAL + path.sep) ? real : null;
}

function readProjectFile(relative) {
    const full = resolveInsideRoot(relative);
    if (!full) return { ok: false, error: 'Путь за пределами проекта' };

    let stat;
    try {
        stat = fs.statSync(full);
    } catch {
        return { ok: false, error: `Файл не найден: ${relative}` };
    }
    if (stat.isDirectory()) return { ok: false, error: 'Это папка, а не файл' };

    const rel = path.relative(ROOT_REAL, full).split(path.sep).join('/');
    if (!TEXT_FILES.test(rel)) {
        return { ok: true, path: rel, binary: true, size: stat.size, editable: false };
    }
    if (stat.size > MAX_EDIT_BYTES) {
        return { ok: true, path: rel, binary: true, size: stat.size, editable: false, note: 'Файл слишком велик для правки' };
    }

    // заметки vault генерируются заново при каждой пересборке: править их бессмысленно,
    // правка исчезнет через несколько секунд
    const generated = rel.startsWith(`${VAULT_DIR}/`);
    return {
        ok: true,
        path: rel,
        text: fs.readFileSync(full, 'utf8'),
        size: stat.size,
        editable: !generated,
        note: generated ? 'Заметка собирается сервером — правки затрутся при следующей пересборке' : undefined,
    };
}

function writeProjectFile(relative, text) {
    const full = resolveInsideRoot(relative);
    if (!full) return { ok: false, error: 'Путь за пределами проекта' };

    const rel = path.relative(ROOT_REAL, full).split(path.sep).join('/');
    if (rel.startsWith(`${VAULT_DIR}/`)) return { ok: false, error: 'Заметки vault пересобираются автоматически' };
    if (!TEXT_FILES.test(rel)) return { ok: false, error: 'Двоичные файлы не редактируются' };
    if (!fs.existsSync(full)) return { ok: false, error: `Файл не найден: ${rel}` };
    if (typeof text !== 'string') return { ok: false, error: 'Нет текста для записи' };

    try {
        fs.writeFileSync(full, text);
    } catch (error) {
        return { ok: false, error: `Не удалось записать файл: ${error.message}` };
    }
    return { ok: true, path: rel, size: Buffer.byteLength(text) };
}

module.exports = {
    DATA_DIR, // им пользуется server.js: и сторож файлов, и путь до базы сессий
    VAULT_DIR,
    init,
    prepareVault,
    buildVaultGraph,
    searchProject,
    readProjectFile,
    writeProjectFile,
    MAX_EDIT_BYTES, // лимит на тело запроса /api/file/write: в нём едет файл целиком
    projectFiles, // нужен сторожу файлов в server.js: состав папки проекта
};
