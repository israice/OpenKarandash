#!/usr/bin/env node
// Отбор своих кусков правки из файла, в котором лежат и чужие незакоммиченные
// правки (параллельные сессии работают в той же рабочей копии). `git add -p`
// в сессии агента недоступен — он интерактивный, — поэтому: смотрим куски,
// называем номера своих, получаем патч и кладём его в индекс.
//
// Только читает (git diff) и печатает; в индекс пишет не он, а следующая команда.
//
//   node .claude/skills/finish-task/pick-hunks.js <файл>                     — список кусков с номерами
//   node .claude/skills/finish-task/pick-hunks.js <файл> 0,2,5-7 --out <патч> — патч из выбранных кусков
//   git apply --cached --unidiff-zero <патч>                                  — положить его в индекс
//   git diff --cached -- <файл>                                               — убедиться, что в индексе только своё
//
// Куски берутся без контекста (-U0): так соседние правки не слипаются в один
// кусок. Позиции в заголовках пересчитываются: без контекста git ставит вставку
// ровно по номеру строки, а пропущенные куски сдвигают все последующие.
'use strict';

const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

function fail(message) {
    console.error(message);
    process.exit(1);
}

const args = process.argv.slice(2);
const outAt = args.indexOf('--out');
const outFile = outAt >= 0 ? args[outAt + 1] : null;
if (outAt >= 0) args.splice(outAt, 2);
const [file, picks] = args;
if (!file) fail('Использование: pick-hunks.js <файл> [номера через запятую, можно диапазоны 3-6] [--out <патч>]');

// latin1 — чтобы патч вышел байт в байт: кодировку и концы строк файла не трогаем
let diff;
try {
    diff = execFileSync('git', ['-c', 'core.quotePath=false', 'diff', '-U0', '--no-color', '--no-ext-diff', '--no-renames', '--', file],
        { encoding: 'latin1', maxBuffer: 256 * 1024 * 1024 });
} catch (error) {
    fail(`git diff не отработал: ${error.message}`);
}
if (!diff.trim()) fail(`У «${file}» нет неиндексированных правок. Новый файл (в git status помечен ??) твой целиком — стейджи его по имени: git add -- "${file}"`);
if (/^Binary files /m.test(diff)) fail(`«${file}» — двоичный файл, кусками не делится.`);

const head = [];
const hunks = [];
for (const line of diff.split(/(?<=\n)/)) {
    if (line.startsWith('@@')) hunks.push([line]);
    else if (hunks.length) hunks[hunks.length - 1].push(line);
    else head.push(line);
}

const readable = (text) => Buffer.from(text, 'latin1').toString('utf8').replace(/\r?\n$/, '');

if (!picks) {
    console.log(`${file}: кусков ${hunks.length}`);
    hunks.forEach((hunk, i) => {
        console.log(`\n[${i}] ${readable(hunk[0])}`);
        for (const line of hunk.slice(1, 9)) console.log(`    ${readable(line).slice(0, 160)}`);
        if (hunk.length > 9) console.log(`    … ещё строк: ${hunk.length - 9}`);
    });
    console.log('\nДальше: тот же вызов с номерами своих кусков и --out <файл патча>.');
    process.exit(0);
}

const keep = new Set();
for (const part of picks.split(',')) {
    const range = part.trim().match(/^(\d+)(?:-(\d+))?$/);
    if (!range) fail(`Не понял номер куска: «${part}»`);
    for (let n = Number(range[1]); n <= Number(range[2] ?? range[1]); n++) keep.add(n);
}
for (const n of keep) if (n >= hunks.length) fail(`Куска [${n}] нет: всего ${hunks.length}, счёт с нуля.`);

let delta = 0; // насколько уже отобранные куски сдвинули строки нового файла
const body = [];
hunks.forEach((hunk, i) => {
    if (!keep.has(i)) return;
    const m = hunk[0].match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@([\s\S]*)$/);
    if (!m) fail(`Не разобрал заголовок куска [${i}]: ${readable(hunk[0])}`);
    const oldStart = Number(m[1]);
    const oldCount = m[2] === undefined ? 1 : Number(m[2]);
    const newCount = m[4] === undefined ? 1 : Number(m[4]);
    // при нулевом счёте номер указывает на строку ПЕРЕД местом правки
    const firstOld = oldCount === 0 ? oldStart + 1 : oldStart;
    const firstNew = firstOld + delta;
    const newStart = newCount === 0 ? firstNew - 1 : firstNew;
    body.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@${m[5]}`, ...hunk.slice(1));
    delta += newCount - oldCount;
});

const patch = Buffer.from(head.join('') + body.join(''), 'latin1');
if (outFile) {
    fs.writeFileSync(outFile, patch);
    console.log(`Патч из ${keep.size} кусков (из ${hunks.length}) записан в ${outFile}. Дальше: git apply --cached --unidiff-zero "${outFile}" и git diff --cached -- "${file}"`);
} else {
    process.stdout.write(patch);
}
