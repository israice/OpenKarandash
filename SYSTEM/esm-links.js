// Связи браузерных ES-модулей: именованные импорты и круги в графе.
//
// Что ловит:
//  1. Импорт имени, которого в файле-источнике нет. В браузере такая строка
//     роняет ВЕСЬ граф модулей: «The requested module ... does not provide an
//     export named ...» — вкладка не грузится, а на экране пусто, и человек
//     видит пустую страницу без сообщения об ошибке. Ни `node --check`, ни
//     eslint с единственным правилом no-undef, ни madge этого не видят: у них
//     нет понятия о том, что модуль что-то экспортирует.
//  2. Круг в графе модулей — запрещён решением 022. madge ловит круги только
//     в графе server.js: браузерные модули (PROJECTS/, SYSTEM/*.js) он не
//     обходит, потому что сервер их не грузит.
//
// Как проверяет: тем же линкером, что и браузер (ES-линкер Node), но без
// оценки — код модулей не выполняется, DOM не нужен. Пакеты из importmap
// страницы (three, @dimforge/...) подменяются пустыми: их экспортов мы не
// берём, а разбирать их нет.
//
// Файл запускается сам с нужным флагом: vm.SourceTextModule живёт за
// --experimental-vm-modules, и без него проверять нечем.
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

if (typeof vm.SourceTextModule !== 'function') {
    // Перезапуск с флагом. Код выхода ребёнка — наш код выхода.
    // Предупреждение об экспериментальном API гасим точечно: оно относится
    // к нашему перезапуску, а не к коду проекта.
    const { spawnSync } = require('node:child_process');
    const child = spawnSync(process.execPath, [
        '--disable-warning=ExperimentalWarning', '--experimental-vm-modules', __filename, ...process.argv.slice(2),
    ], {
        stdio: 'inherit',
        env: { ...process.env, ESM_LINKS_VM: '1' },
    });
    process.exit(child.status ?? 1);
}

// корень проверяемого дерева: свой — для ветки исполнителя (--root), общий —
// для главной копии
const rootArg = process.argv.indexOf('--root');
const ROOT = rootArg > 0 ? path.resolve(process.argv[rootArg + 1]) : path.join(__dirname, '..');

// чужие коды и то, что сервер собирает сам: их ошибки не наши (те же пропуски,
// что в SYSTEM/checks.js). TOOLS и DOCS — не браузерный код: там скрипты
// Node, и проверять их модульные связи незачем
const SKIP = new Set(['node_modules', 'DATA', '.git', '.venv', 'hf-cache', 'vendor', '.kilo',
    'json-render', 'json-renderer', 'TOOLS', 'DOCS']);

// ---------- обход дерева ----------

function collect(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (SKIP.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) collect(full, out);
        else if (entry.name.endsWith('.js')) out.push(full);
    }
    return out;
}

// ---------- чтение импортов ----------

// Четыре формы, которые в проекте встречаются:
//   import { a, b as c } from './x.js';  — именованные
//   import * as NS from './x.js';         — весь модуль (проверять нечего)
//   import './x.js';                     — ради эффекта
//   import NS from './x.js';             — умолчание (в проекте не встречается,
//                                         но разбираем, чтобы не пропустить)
const FROM_RE = /import\s+((?:[A-Za-z_$][\w$]*\s*,\s*)?(?:\{[^}]*\}\s*)?(?:\*\s*as\s+[A-Za-z_$][\w$]*\s*)?)from\s*['"]([^'"]+)['"]/g;
const SIDE_EFFECT_RE = /import\s*['"]([^'"]+)['"]/g;

// именованный импорт: «a», «a as b» — просим именно «a», «a,» — тот же «a»
function namedImports(clause) {
    const braces = clause.match(/\{([^}]*)\}/);
    if (!braces) return [];
    return braces[1].split(',')
        .map((item) => item.trim().split(/\s+as\s+/)[0].trim())
        .filter((name) => name && name !== 'type');
}

// что файл просит у модулей: [{ spec, names: [...] }]. names — имена
// экспортов, которых файл ждёт; '*' — namespace-импорт, проверять нечего
function importsOf(source) {
    const found = [];
    for (const match of source.matchAll(FROM_RE)) {
        const clause = match[1];
        const names = namedImports(clause);
        const namespace = /\*\s*as\s+/.test(clause);
        const defaultName = clause.replace(/\{[^}]*\}/, '').replace(/\*\s*as\s+[A-Za-z_$][\w$]*/, '')
            .replace(/,/, '').trim();
        if (defaultName) names.push('default');
        found.push({ spec: match[2], names: namespace ? ['*'] : names });
    }
    for (const match of source.matchAll(SIDE_EFFECT_RE)) {
        found.push({ spec: match[1], names: [] });
    }
    return found;
}

// ---------- связывание модулей ----------

const fileUrl = (file) => 'file:///' + path.resolve(file).replace(/\\/g, '/');
const urlToPath = (url) => decodeURIComponent(url.replace(/^file:\/\/\//, ''));

const parsed = new Map(); // файл → исходник (читаем один раз)
function sourceOf(file) {
    if (!parsed.has(file)) parsed.set(file, fs.readFileSync(file, 'utf8'));
    return parsed.get(file);
}

// Свежий экземпляр модуля на каждую проверку: связать можно один раз
function moduleOf(file) {
    return new vm.SourceTextModule(sourceOf(file), { identifier: fileUrl(file) });
}

// линкер: относительные импорты ведут в настоящие файлы, пакеты из importmap
// подменяются пустыми.
//
// Кэш на одну связку обязателен: файл, до которого дошли по кругу, должен
// вернуться ТЕМ ЖЕ экземпляром модуля. Без кэша линкер создаёт новый
// экземпляр на каждый обход, и круг превращается в бесконечную рекурсию —
// проверка зависает вместо того, чтобы показать круг.
function linkerFor(directTarget) {
    const directUrl = fileUrl(directTarget);
    const cache = new Map();

    return (specifier, referencingModule) => {
        let file;
        if (specifier === directUrl) {
            file = directTarget;
        } else if (specifier.startsWith('file:///')) {
            file = urlToPath(specifier);
        } else if (!specifier.startsWith('.') && !specifier.startsWith('/')) {
            // пакет из importmap страницы: в браузере его даёт страница, у нас
            // его нет, и проверить в нём нечего
            return new vm.SourceTextModule('export {}');
        } else {
            const base = urlToPath(referencingModule.identifier);
            file = path.resolve(path.dirname(base), specifier);
        }
        if (!cache.has(file)) cache.set(file, moduleOf(file));
        return cache.get(file);
    };
}

// Проверка одной пары: экспорт с таким именем у цели есть или нет.
// Возвращает текст ошибки или null
async function exportExists(target, name) {
    const url = fileUrl(target);
    const source = name === 'default'
        ? `import __default__ from '${url}';`
        : `import { ${name} } from '${url}';`;
    const probe = new vm.SourceTextModule(source, { identifier: url });
    try {
        await probe.link(linkerFor(target));
        return null;
    } catch (error) {
        const message = String(error.message || error);
        // ошибка про другой модуль — не про этот: значит, недобор происходит
        // глубже, и его поймает тот файл, который импортирует имя напрямую
        if (!message.includes(url)) return null;
        return message;
    }
}

// ---------- проверка ----------

// Серверный код (CommonJS) — не наша забота: его связи обходит madge, и в
// браузере он не грузится вовсе. Признак — require/module.exports.
const COMMONJS_RE = /\brequire\s*\(|\bmodule\.exports\b/;

const problems = [];
const edges = new Map(); // файл → файлы, из которых он импортирует

async function main() {
    const files = collect(ROOT);

    for (const file of files) {
        const source = sourceOf(file);
        const rel = path.relative(ROOT, file);
        if (COMMONJS_RE.test(source)) continue;

        // файл должен разбираться как модуль: сломанный синтаксис в браузере
        // означает то же самое, что и здесь
        try {
            new vm.SourceTextModule(source, { identifier: fileUrl(file) });
        } catch (error) {
            problems.push(`${rel}: файл не разбирается как модуль — ${error.message}`);
            continue;
        }

        const targets = new Set();
        for (const { spec, names } of importsOf(source)) {
            // пакет из importmap страницы: в браузере его даёт страница, у нас
            // его нет, и проверить в нём нечего
            if (!spec.startsWith('.') && !spec.startsWith('/')) continue;

            const target = path.resolve(path.dirname(file), spec);
            if (!fs.existsSync(target)) {
                problems.push(`${rel}: импорт '${spec}' — файла нет`);
                continue;
            }
            targets.add(target);

            for (const name of names) {
                if (name === '*') continue;
                const message = await exportExists(target, name);
                if (message) problems.push(`${rel}: импорт '${name}' из '${spec}' — в файле такого экспорта нет`);
            }
        }
        edges.set(file, [...targets]);
    }

    // круги в графе модулей
    for (const cycle of findCycles(edges)) {
        problems.push(`круг модулей: ${cycle.map((f) => path.relative(ROOT, f)).join(' → ')}`);
    }

    if (problems.length === 0) {
        console.log('чисто');
        return 0;
    }
    for (const problem of problems) console.log(`  ${problem}`);
    return 1;
}

// Поиск кругов: обход в глубину с метками «в стеке / обработан». Возвращает
// список замкнутых путей (каждый начинается и кончается одним файлом)
function findCycles(graph) {
    const cycles = [];
    const state = new Map(); // файл → 0 (в стеке) / 1 (обработан)
    const stack = [];

    const visit = (file) => {
        state.set(file, 0);
        stack.push(file);
        for (const next of graph.get(file) || []) {
            const mark = state.get(next);
            if (mark === 0) {
                const start = stack.indexOf(next);
                cycles.push([...stack.slice(start), next]);
            } else if (mark === undefined) {
                visit(next);
            }
        }
        stack.pop();
        state.set(file, 1);
    };

    for (const file of graph.keys()) {
        if (state.get(file) === undefined) visit(file);
    }
    return cycles;
}

main()
    .then((code) => process.exit(code))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
