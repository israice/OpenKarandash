#!/usr/bin/env node
// Живые факты для ритуала завершения задачи (навык finish-task): следующая версия
// для VERSION.md, следующий свободный номер записки DOCS/decisions/ и состояние
// рабочей копии. Считает скрипт, а не агент: «последний + 1» на глаз уже дал
// четыре дубля номеров записок (010, 012, 026, 039) и коммит без строки версии.
//
// Только читает: файлы и git без записи. Зависимостей нет. Код выхода всегда 0 —
// скрипт вызывается подстановкой !`…` из SKILL.md, а там ненулевой код отменяет
// загрузку навыка целиком. Любая поломка печатается строкой, а не исключением.
//
// Запуск: node .claude/skills/finish-task/next-numbers.js
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// то же выражение, что у currentVersion/versionHistory в SYSTEM/core/version.js, плюс группы
const VERSION_LINE = /^v(\d+)\.(\d+)\.(\d+).*$/gm;
const DECISIONS = path.join('DOCS', 'decisions');

// --no-optional-locks: git status по пути освежает индекс и на миг берёт index.lock —
// скрипт зовут при каждой загрузке навыка, и без флага он мешал бы git add соседней сессии
function git(cwd, args) {
    try {
        return execFileSync('git', ['--no-optional-locks', '-c', 'core.quotePath=false', ...args], {
            cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30000, maxBuffer: 32 * 1024 * 1024,
        });
    } catch {
        return '';
    }
}

// Рабочая копия — та, где стоит сессия (cwd может быть и веткой исполнителя);
// если cwd вне проекта (scratchpad), берём копию, в которой лежит сам навык
function findRoot() {
    const fromCwd = git(process.cwd(), ['rev-parse', '--show-toplevel']).trim();
    const own = path.resolve(__dirname, '..', '..');
    return [fromCwd, own].find((dir) => dir && fs.existsSync(path.join(dir, 'VERSION.md'))) || null;
}

// git отдаёт путь рабочей копии в форме той ОС, что её заводила; та же
// копия может быть видна иначе, поэтому приводим к существующему виду
function localPath(dir) {
    if (fs.existsSync(dir)) return dir;
    const mnt = dir.match(/^\/mnt\/([a-z])\/(.*)$/);
    if (mnt) return `${mnt[1].toUpperCase()}:/${mnt[2]}`;
    return dir;
}

// все рабочие копии репозитория: главная идёт первой (так печатает git)
function workingCopies(root) {
    const dirs = git(root, ['worktree', 'list', '--porcelain']).split('\n')
        .filter((line) => line.startsWith('worktree '))
        .map((line) => localPath(line.slice('worktree '.length).trim()))
        .filter((dir) => fs.existsSync(dir));
    return dirs.length ? dirs : [root];
}

const same = (a, b) => {
    try { return fs.realpathSync(a) === fs.realpathSync(b); } catch { return path.resolve(a) === path.resolve(b); }
};

function versionsIn(text) {
    return [...(text || '').matchAll(VERSION_LINE)].map((m) => ({
        parts: [Number(m[1]), Number(m[2]), Number(m[3])],
        line: m[0].trim(),
    }));
}

const compare = (a, b) => a.parts[0] - b.parts[0] || a.parts[1] - b.parts[1] || a.parts[2] - b.parts[2];
const label = (v) => `v${v.parts.join('.')}`;
const cut = (text, max = 170) => (text.length > max ? `${text.slice(0, max)}…` : text);

function readFile(file) {
    try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

function versionFacts(root, copies, isMain, out, warn) {
    const onDisk = versionsIn(readFile(path.join(root, 'VERSION.md')));
    const inHead = versionsIn(git(root, ['show', 'HEAD:VERSION.md']));
    const last = onDisk[onDisk.length - 1];
    out.push(`Последняя строка DEV LOG: ${last ? cut(last.line) : 'не найдена — в VERSION.md нет строк вида vX.Y.Z'}`);

    // занятые номера: строки на диске во всех рабочих копиях (в том числе ещё не
    // закоммиченные чужой сессией) и заголовки недавних коммитов всех веток
    const taken = [...onDisk.map((v) => ({ ...v, where: 'VERSION.md этой копии' }))];
    for (const dir of copies) {
        if (same(dir, root)) continue;
        for (const v of versionsIn(readFile(path.join(dir, 'VERSION.md')))) taken.push({ ...v, where: `VERSION.md в ${dir}` });
    }
    for (const subject of git(root, ['log', '--all', '-n', '80', '--format=%s']).split('\n')) {
        for (const v of versionsIn(subject)) taken.push({ ...v, where: 'заголовок коммита' });
    }
    if (!taken.length) return;

    const top = taken.reduce((max, v) => (compare(v, max) > 0 ? v : max));
    const next = `v${top.parts[0]}.${top.parts[1]}.${top.parts[2] + 1}`;
    out.push(isMain
        ? `Следующая версия: ${next}  (строка в конец VERSION.md: «${next} - что сделано», первая строка сообщения коммита — она же)`
        : `Следующая версия в main: ${next}  (справочно — в копии ветки строку версии не пишут)`);

    if (last && compare(top, last) > 0) {
        warn.push(`${label(top)} уже занята (${top.where}), хотя последняя строка VERSION.md этой копии — ${label(last)}; поэтому следующая — ${next}.`);
    }
    const headLines = new Set(inHead.map((v) => v.line));
    const pending = onDisk.filter((v) => !headLines.has(v.line));
    if (pending.length) {
        warn.push('В VERSION.md уже дописаны, но не закоммичены строки: '
            + pending.map((v) => `«${cut(v.line, 90)}»`).join('; ')
            + '. Если строка не твоя — её дописала параллельная сессия: не трогай её, бери номер после неё и собирай VERSION.md для коммита по рецепту из staging.md.');
    }
    const order = onDisk.map(label);
    const dupes = order.filter((v, i) => order.indexOf(v) !== i);
    if (dupes.length) warn.push(`В VERSION.md повторяются версии: ${[...new Set(dupes)].join(', ')}.`);
}

function noteNumber(name) {
    const m = path.basename(name).match(/^(\d{3})-/);
    return m ? Number(m[1]) : null;
}

function decisionFacts(root, copies, out, warn) {
    // 1) что лежит на диске во всех рабочих копиях — сюда попадают и записки,
    //    которые параллельная сессия уже создала, но ещё не закоммитила
    const used = new Map(); // номер → Set имён
    const add = (name) => {
        const n = noteNumber(name);
        if (n === null) return;
        if (!used.has(n)) used.set(n, new Set());
        used.get(n).add(path.basename(name));
    };
    const here = [];
    for (const dir of copies) {
        let names = [];
        try { names = fs.readdirSync(path.join(dir, DECISIONS)); } catch { /* в этой копии папки нет */ }
        for (const name of names) {
            add(name);
            if (same(dir, root)) here.push(name);
        }
    }
    // 2) всё, что когда-либо добавлялось в историю любой ветки: номер удалённой
    //    или переименованной записки тоже занят — на него остались ссылки
    const history = git(root, ['log', '--all', '--no-renames', '--diff-filter=A', '--name-only', '--format=', '--', 'DOCS/decisions']);
    for (const name of history.split('\n')) if (name.trim()) add(name.trim());

    if (!used.size) {
        out.push('Следующий номер записки решения: не определён — DOCS/decisions/ не найдена');
        return;
    }
    const next = String(Math.max(...used.keys()) + 1).padStart(3, '0');
    out.push(`Следующий номер записки решения: ${next}  (файл DOCS/decisions/${next}-тема-через-дефисы.md; создай его сразу, хотя бы с заголовком, — номер на диске виден другим сессиям)`);

    const byNumber = new Map();
    for (const name of here) {
        const n = noteNumber(name);
        if (n === null) continue;
        byNumber.set(n, [...(byNumber.get(n) || []), name]);
    }
    for (const [n, names] of byNumber) {
        if (names.length > 1) warn.push(`Номер ${String(n).padStart(3, '0')} на диске занят дважды: ${names.join(' и ')} — один из файлов надо перенумеровать до коммита.`);
    }
    const fresh = git(root, ['status', '--porcelain', '--', 'DOCS/decisions']).split('\n')
        .filter((line) => line.startsWith('??') || line.startsWith('A'))
        .map((line) => path.basename(line.slice(3).trim().replace(/^"|"$/g, '')));
    if (fresh.length) warn.push(`Записки ещё не в git: ${fresh.join(', ')} — если файл не твой, его пишет параллельная сессия, в свой коммит не бери.`);
}

function statusFacts(root, out) {
    const lines = git(root, ['status', '--porcelain']).split('\n').filter(Boolean);
    if (!lines.length) {
        out.push('Незакоммиченных правок в рабочей копии нет.');
    } else {
        out.push(`Незакоммиченное в рабочей копии (${lines.length}); всё, что здесь не из твоей задачи, — чужое, в коммит не идёт:`);
        for (const line of lines.slice(0, 40)) {
            const never = /__pycache__|\.pyc"?$/.test(line) ? '   ← кеш Python, не стейджить' : '';
            out.push(`    ${line}${never}`);
        }
        if (lines.length > 40) out.push(`    … и ещё ${lines.length - 40}`);
    }
}

function main() {
    const root = findRoot();
    if (!root) {
        console.log('Рабочая копия проекта не найдена (нет VERSION.md ни в cwd, ни рядом с навыком). Числа посчитай вручную: последняя строка vX.Y.Z в VERSION.md + 1 и наибольший номер в DOCS/decisions/ + 1.');
        return;
    }
    const copies = workingCopies(root);
    const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).trim() || '?';
    const isMain = same(copies[0], root);
    const out = [];
    const warn = [];

    out.push(`Рабочая копия: ${root} (ветка ${branch}${isMain ? ', главная копия' : ', копия ветки исполнителя'})`);
    if (!isMain) {
        warn.push('Это рабочая копия ветки, а не главная: строку версии сюда не дописывают и vX.Y.Z в заголовок коммита не ставят — версия принадлежит коммиту, который приземлится в main.');
    }
    versionFacts(root, copies, isMain, out, warn);
    decisionFacts(root, copies, out, warn);
    statusFacts(root, out);

    console.log(out.join('\n'));
    if (warn.length) console.log(`\nВнимание:\n${warn.map((w) => `- ${w}`).join('\n')}`);
}

// audit-commit.js берёт отсюда разбор версий и номеров записок — считать их в
// двух местах по-разному нельзя
module.exports = { git, findRoot, workingCopies, same, versionsIn, compare, label, noteNumber, DECISIONS };

if (require.main === module) {
    try {
        main();
    } catch (error) {
        console.log(`next-numbers.js не смог собрать факты: ${error && error.message}. Посчитай вручную: последняя строка vX.Y.Z в VERSION.md + 1 и наибольший номер в DOCS/decisions/ + 1.`);
    }
    process.exitCode = 0;
}
