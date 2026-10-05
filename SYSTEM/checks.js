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
// и посторонний worktree не должен краснить проверку главного дерева
const SKIP = new Set(['node_modules', 'DATA', '.git', '.venv', 'hf-cache', 'vendor', '.kilo']);

let failed = false;

function run(title, file, args) {
    process.stdout.write(`${title}... `);
    try {
        // На Windows путь к node может лежать в папке с пробелом («C:\Program
        // Files\nodejs\node.exe»), и cmd без кавычек режет его на два слова —
        // проверка падала с «'C:\Program' is not recognized», молча ничего не
        // проверяя. В оболочке путь всегда в кавычках
        const shell = process.platform === 'win32';
        const quote = (value) => (shell ? `"${value}"` : value);
        execFileSync(quote(file), args.map(quote), { cwd: ROOT, stdio: 'pipe', shell });
        console.log('чисто');
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

run('неизвестные имена', process.execPath, [path.join(TOOLS, 'node_modules', 'eslint', 'bin', 'eslint.js')]);
// не .bin/madge — это shell-скрипт (#!/bin/sh), node напрямую его не исполнит,
// он ищет настоящий вход в самом пакете
run('циклические связи', process.execPath, [path.join(TOOLS, 'node_modules', 'madge', 'bin', 'cli.js'), '--circular', 'server.js']);
checkSize();
checkScreenUnits();

process.exit(failed ? 1 : 0);
