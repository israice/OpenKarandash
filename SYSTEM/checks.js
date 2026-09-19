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
// чужой код и рабочие копии агентов: их размер и их ошибки не наши
const SKIP = new Set(['node_modules', 'DATA', '.git', 'hermes', 'hermes-home', '.worktrees', '.claude', '.beads', '.kilo']);

let failed = false;

function run(title, file, args) {
    process.stdout.write(`${title}... `);
    try {
        execFileSync(file, args, { cwd: ROOT, stdio: 'pipe', shell: process.platform === 'win32' });
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

run('неизвестные имена', process.execPath, [path.join(TOOLS, 'node_modules', 'eslint', 'bin', 'eslint.js')]);
// не .bin/madge — это shell-скрипт (#!/bin/sh), node напрямую его не исполнит,
// он ищет настоящий вход в самом пакете
run('циклические связи', process.execPath, [path.join(TOOLS, 'node_modules', 'madge', 'bin', 'cli.js'), '--circular', 'server.js']);
checkSize();

process.exit(failed ? 1 : 0);
