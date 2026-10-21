// Проверки перед словами «готово»: одна команда `npm run check` на всё.
// Живой прогон интерфейса сюда не входит — он требует поднятого пользователем
// сервера (DOCS/decisions/002) и делается агентом ui-checker отдельно.
//
// Почему это вообще заведено: `node --check` (хук syntax-check.js) видит только
// синтаксис. Обращение к переменной, которой нигде нет, он пропускает — так в
// PROJECTS/Settings/settings.js полгода жил вызов потерянной pickInstall, а в
// PROJECTS/Flow/flow.js — обращение к ROOT_FIELDS, которую не успели написать.
// Обе ошибки падают уже в браузере у пользователя. DOCS/decisions/034.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// инструменты (eslint, madge) — всегда из главной копии: в рабочей копии ветки
// node_modules нет. А проверяемая папка может быть другой: `--root <папка>`
// гонит те же проверки на ветке исполнителя (SYSTEM/branch-gate.mjs, DOCS/decisions/049)
const TOOLS = path.join(__dirname, '..');
const rootArg = process.argv.indexOf('--root');
const ROOT = rootArg > 0 && process.argv[rootArg + 1] ? path.resolve(process.argv[rootArg + 1]) : TOOLS;
// норма «один файл — одна тема» (DOCS/decisions/022): 150–300 строк, за 400 — делить
const MAX_LINES = 400;
// чужой код (node_modules, вендор) и то, что сервер собирает сам (DATA): их размер
// и их ошибки не наши. Сюда же — окружения и кэши инструментов: они весят больше
// гигабайта и состоят из чужих пакетов, и их файлы попадали в счёт «наших
// длинных» (DOCS/decisions/034). `.kilo` — рабочие копии веток того же проекта
// внутри репозитория: их файлы это копии наших файлов, а не код главной копии,
// и посторонний worktree не должен краснить проверку главного дерева.
//
// json-render и json-renderer — вложенные ЧУЖИЕ git-репозитории (у каждого
// свой .git), поэтому главному git они не видны: git status помечает их как
// untracked, и их файлы попадали в наши счётчики. Причина не косметическая:
// проверки врали. «Размер файлов» насчитывал 55 сборочных файлов из
// json-renderer/.next (по 20 тысяч строк), «размер от экрана» — CSS и чанки
// Next, а eslint падал на json-render/apps/web/eslint.config.js из-за
// отсутствующего пакета @internal/eslint-config. Краснело всё это из-за чужого
// сборочного мусора, а наш код оставался непроверенным.
//
// Папки пропускаются целиком: они чужие, их размер и ошибки не наши, а
// rightmost-уровень у них один — это репозитории. Удалять их нельзя: в
// json-renderer есть незакоммиченные правки (AGENTS.md, bun.lock), которых
// главный git не хранит.
const SKIP = new Set([
    'node_modules', 'DATA', '.git', '.venv', 'hf-cache', 'vendor', '.kilo',
    'json-render', 'json-renderer',
]);

let failed = false;

// На Windows путь к node может лежать в папке с пробелом («C:\Program
// Files\nodejs\node.exe»), и cmd без кавычек режет его на два слова —
// проверка падала с «'C:\Program' is not recognized», молча ничего не
// проверяя. В оболочке путь всегда в кавычках
const shell = process.platform === 'win32';
const quote = (value) => (shell ? `"${value}"` : value);

function run(title, file, args) {
    process.stdout.write(`${title}... `);
    try {
        execFileSync(quote(file), args.map(quote), { cwd: ROOT, stdio: 'pipe', shell });
        console.log('чисто');
    } catch (error) {
        failed = true;
        console.log('НАШЛОСЬ:');
        console.log(String(error.stdout || '') + String(error.stderr || ''));
    }
}

// Стадия со своим выводом: скрипт сам говорит «чисто» или перечисляет находки.
// Прежняя run() печатает своё слово и вывод скрипта прячет — для madge это
// годилось, для проверки связей нужно видеть находки как есть
function runReport(title, file, args) {
    process.stdout.write(`${title}... `);
    try {
        const out = execFileSync(quote(file), args.map(quote), { cwd: ROOT, encoding: 'utf8', stdio: 'pipe', shell });
        console.log(String(out).trim() || 'чисто');
    } catch (error) {
        failed = true;
        console.log('НАШЛОСЬ:');
        console.log(String(error.stdout || '') + String(error.stderr || ''));
    }
}

// файлы проекта длиннее нормы: не ошибка, а повод делить — поэтому счёт,
// а не провал (иначе проверка встала бы намертво на server.js и flow.js)
function checkSize() {
    process.stdout.write('размер файлов... ');
    const long = [];
    (function walk(dir) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (SKIP.has(entry.name)) continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.name.endsWith('.js')) {
                const lines = fs.readFileSync(full, 'utf8').split('\n').length;
                if (lines > MAX_LINES) long.push({ file: path.relative(ROOT, full), lines });
            }
        }
    }(ROOT));
    if (long.length === 0) {
        console.log('чисто');
        return;
    }
    console.log(`${long.length} файл(ов) длиннее ${MAX_LINES} строк — по DOCS/decisions/022 их пора делить:`);
    for (const { file, lines } of long.sort((a, b) => b.lines - a.lines)) console.log(`  ${lines}\t${file}`);
}

// Размер, отсчитываемый от экрана (vh/vw), живёт в одном файле —
// SYSTEM/styles/base.css (DOCS/decisions/093). Повтор такого значения в
// компоненте — это ровно тот дефект, из-за которого страница то выше окна, то
// ниже: правка одной страницы ломает остальные. Здесь механическая страховка:
// список файлов с vh/vw даёт красный список мест, а не тихое «ну ладно».
function checkScreenUnits() {
    process.stdout.write('размер от экрана... ');
    const ALLOWED = 'SYSTEM' + path.sep + 'styles' + path.sep + 'base.css';
    const UNIT = /(^|[^\w-])\d*\.?\d+(d?vh|d?vw)\b/i;
    const hits = [];
    (function walk(dir) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (SKIP.has(entry.name)) continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) { walk(full); continue; }
            if (!/\.(css|js|html)$/.test(entry.name)) continue;
            if (path.relative(ROOT, full) === ALLOWED) continue;
            // комментарии ничего не задают: они объясняют, откуда взялось
            // значение, и «100dvh» в тексте правилом не считается
            const code = fs.readFileSync(full, 'utf8')
                .replace(/\/\*[\s\S]*?\*\//g, '')
                .replace(/^\s*\/\/.*$/gm, '');
            code.split('\n').forEach((line, i) => {
                if (UNIT.test(line)) hits.push(`${path.relative(ROOT, full)}:${i + 1}`);
            });
        }
    }(ROOT));
    if (hits.length === 0) { console.log('чисто'); return; }
    failed = true;
    console.log(`НАШЛОСЬ: vh/vw вне SYSTEM/styles/base.css — значение размера от экрана должно быть одно (DOCS/decisions/093):`);
    for (const hit of hits) console.log(`  ${hit}`);
}

// Заглушка должна встречаться в SYSTEM/index.html ровно один раз
// (DOCS/decisions/106). Причина не в эстетике: renderPage подставляет строкой,
// а String.replace берёт ПЕРВОЕ вхождение, — литерал в HTML-комментарии съедает
// подстановку, и настоящая полка остаётся с текстом «{{TOPBAR}}» на странице.
// Так случилось дважды: 2026-10-05 с {{SESSION_VIEW}} и снова с {{TOPBAR}} и
// {{SESSION_VIEW}} в комментарии index.html:114 — верхнее меню уезжало в
// невидимый комментарий, а панель сессий оставалась пустой. Список заглушек не
// зашит сюда, а читается из renderPage, иначе проверка врала бы после правки
// подстановок. Шаблоны .eta проверяются тем же: литерал заглушки в шаблоне
// опасен, потому что подставленный раньше шаблон попадёт под чужую замену
function checkPlaceholders() {
    process.stdout.write('заглушки страницы... ');
    const INDEX = path.join(ROOT, 'SYSTEM', 'index.html');
    const version = fs.readFileSync(path.join(TOOLS, 'SYSTEM', 'core', 'version.js'), 'utf8');
    const names = [...version.matchAll(/\.replace\('\{\{([A-Z_]+)\}\}'/g)].map((m) => m[1]);
    if (names.length === 0) {
        failed = true;
        console.log('НАШЛОСЬ: в renderPage не найдено ни одной подстановки {{...}} — проверка молча вышла бы из строя');
        return;
    }
    const index = fs.readFileSync(INDEX, 'utf8');
    const problems = [];
    for (const name of names) {
        // считаем вхождения, а не проверяем наличие: лишнее в комментарии
        // снаружи и есть тот самый случай, из-за которого полка пустеет
        const count = index.split(`{{${name}}}`).length - 1;
        if (count !== 1) problems.push(`SYSTEM/index.html: {{${name}}} встречается ${count} раз, а должна ровно один`);
    }
    (function walk(dir) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (SKIP.has(entry.name)) continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) { walk(full); continue; }
            if (!entry.name.endsWith('.eta')) continue;
            // Комментарии выкидываем: литерал в блоке <% /* … */ %> или в <!-- … -->
            // в разметку не попадает, а написан там в объяснении — из-за него проверка
            // врала бы на всех трёх шаблонах сразу. Ищем по тому, что Eta отдаёт
            const text = fs.readFileSync(full, 'utf8')
                .replace(/<%[\s\S]*?%>/g, '')
                .replace(/<!--[\s\S]*?-->/g, '');
            for (const name of names) {
                if (text.includes(`{{${name}}}`)) {
                    problems.push(`${path.relative(ROOT, full)}: литерал {{${name}}} в шаблоне — подставленный раньше шаблон попадёт под чужую замену`);
                }
            }
        }
    }(ROOT));
    if (problems.length === 0) { console.log('чисто'); return; }
    failed = true;
    console.log(`НАШЛОСЬ: заглушка должна встречаться в index.html ровно один раз (DOCS/decisions/106):`);
    for (const problem of problems) console.log(`  ${problem}`);
}

// Кнопка верхнего меню без id ломает скрытие: SYSTEM/toolbar-menu.js скрывает по
// id (btn.hidden = hidden.has(btn.id)), а переключатель в меню «+» пишет id в
// localStorage. У кнопки без id он '', и все такие кнопки делят один ключ —
// переключатель одной прятал их все, а вернуть по одной уже нельзя. Нашлось на
// четырёх кнопках Search/Refresh/Favorite/Notifications. Проверяем только
// .btn-group__btn: у кнопок вне групп id не обязателен и там скрытие не работает
function checkTopbarButtonIds() {
    process.stdout.write('id кнопок тулбара... ');
    const TEMPLATE = path.join(ROOT, 'SYSTEM', 'topbar.eta');
    const text = fs.readFileSync(TEMPLATE, 'utf8')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<%[\s\S]*?%>/g, '');
    const bad = [...text.matchAll(/<button[^>]*class="[^"]*btn-group__btn[^"]*"[^>]*>/g)]
        .filter((m) => !/\bid="/.test(m[0]));
    if (bad.length === 0) { console.log('чисто'); return; }
    failed = true;
    console.log('НАШЛОСЬ: у кнопки верхнего меню нет id — скрытие через меню «+» сработает по всем таким кнопкам сразу:');
    for (const [, tag] of bad) {
        const label = (tag.match(/aria-label="([^"]*)"/) || [])[1] || '(без подписи)';
        console.log(`  SYSTEM/topbar.eta: <button> без id, aria-label="${label}"`);
    }
}

// Ключи в индексе git — самая дорогая находка из возможных: файл уже в истории,
// и «удалить его» не отзывает ключ. Поэтому скан идёт первым: дешевле упредить,
// чем объяснять потом. Сам скан — SYSTEM/secrets-scan.js, он же запускается и
// отдельно; сбой скана (код 2, сканировать не удалось) проверку не пропускает:
// молчаливый «чисто» от инструмента, который не отработал, хуже его отсутствия
process.stdout.write('секреты в индексе... ');
try {
    const scan = execFileSync(process.execPath, [path.join(TOOLS, 'SYSTEM', 'secrets-scan.js'), '--root', ROOT], {
        cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    console.log('чисто');
    const advice = String(scan).trim();
    if (advice) console.log(advice);
} catch (error) {
    failed = true;
    console.log('НАШЛОСЬ:');
    console.log(String(error.stdout || '') + String(error.stderr || '') + String(error.message || ''));
}

run('неизвестные имена', process.execPath, [path.join(TOOLS, 'node_modules', 'eslint', 'bin', 'eslint.js')]);
// не .bin/madge — это shell-скрипт (#!/bin/sh), node напрямую его не исполнит,
// он ищет настоящий вход в самом пакете
run('циклические связи', process.execPath, [path.join(TOOLS, 'node_modules', 'madge', 'bin', 'cli.js'), '--circular', 'server.js']);
// браузерные ES-модули: именованные импорты и круги в их графе. madge смотрит
// только граф server.js, а браузерный код он не грузит — и импорт несуществующего
// экспорта не ловит ни одна из прежних проверок (DOCS/decisions/123)
runReport('связи браузерных модулей', process.execPath, [path.join(TOOLS, 'SYSTEM', 'esm-links.js')]);
checkSize();
checkScreenUnits();
checkPlaceholders();
checkTopbarButtonIds();

process.exit(failed ? 1 : 0);
