// Запуск домашней работы одной командой:
//
//   node TOOLS/homework/run.mjs "текст задачи"
//   node TOOLS/homework/run.mjs --file brief.txt --out report.md
//
// На входе — то, что человек написал (для клика по элементу интерфейса вместе
// со строкой «UI element: «New» button#newButton…» — она главный источник
// якорей). На выходе — отчёт в stdout или в файл --out.
//
// Код выхода: 0 — отчёт собран; 1 — нечего искать (нет ни якоря, ни фразы);
// 2 — неверный вызов.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

// anchors.js и collect.js — CommonJS, как весь серверный код проекта
const require = createRequire(import.meta.url);
const { collect } = require('./collect.js');

function usage(message) {
    if (message) console.error(message);
    console.error('Вызов: node TOOLS/homework/run.mjs "текст задачи" [--file <файл>] [--out <файл>] [--quiet]');
    process.exit(2);
}

const args = process.argv.slice(2);
let message = null;
let outFile = null;
let quiet = false;
for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--file') message = fs.readFileSync(path.resolve(args[++i] || ''), 'utf8');
    else if (arg === '--out') outFile = path.resolve(args[++i] || '');
    else if (arg === '--quiet') quiet = true;
    // неизвестное имя с тире — опечатка в вызове, а не текст задачи: иначе
    // «--нет-такого» тихо уходит в разбор и кончается «не нашлось», код 1
    else if (arg.startsWith('--')) usage(`Неизвестный флаг: ${arg}`);
    else if (message == null) message = arg;
    else usage(`Непонятный аргумент: ${arg}`);
}
if (message == null) usage();

const { report, code, phrases, kind, files, chars } = collect(message);

if (!code.length && !phrases.length) {
    console.error('Не нашлось ни якоря, ни поисковой фразы — задача слишком общая, чтобы собрать отчёт.\nСпроси у человека, где именно это место.');
    process.exit(1);
}

if (outFile) fs.writeFileSync(outFile, report);
if (!quiet) console.log(report);
console.error(`\n— отчёт ${chars} символов, тип «${kind?.id || '?'}», файлов ${files.length}${outFile ? `, записан в ${outFile}` : ''}`);