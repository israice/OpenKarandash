#!/usr/bin/env node
// Сверка коммита задачи с правилом автокоммита (AGENTS.override.md, «Конвенции»).
// Ловит ровно то, что в истории уже ломалось: коммит без строки VERSION.md
// (v0.0.31 ушёл без неё, строку дописывали следующим коммитом), заголовок, не
// равный строке версии, дубль номера записки решения, случайно застейдженные
// hermes и кеш Python.
//
// Только читает индекс и историю. Код выхода 1 — есть ошибки, коммитить нельзя
// (или последний коммит неверен); предупреждения код не меняют.
//
//   node .claude/skills/finish-task/audit-commit.js          — перед коммитом: что лежит в индексе
//   node .claude/skills/finish-task/audit-commit.js --head   — после коммита: что получилось в HEAD
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { git, findRoot, workingCopies, same, versionsIn, compare, label, noteNumber, DECISIONS } = require('./next-numbers.js');

const root = findRoot();
if (!root) {
    console.error('Рабочая копия проекта не найдена (нет VERSION.md ни в cwd, ни рядом с навыком).');
    process.exit(1);
}
const copies = workingCopies(root);
const isMain = same(copies[0], root);
const headMode = process.argv.includes('--head');

// В этом репозитории стоит diff.ignoreSubmodules=all (DOCS/decisions/041): без явного флага
// git diff молчит о ссылке hermes, даже когда она уже лежит в индексе, — и проверка «в коммит
// попал hermes» не сработала бы никогда. Сравнение индекса и коммитов в сам клон не заглядывает,
// так что флаг ничего не стоит; разницу с рабочей копией (ниже, partly) с ним не гоняем —
// там git пошёл бы обходить клон на гигабайт
const SEE_GITLINKS = '--ignore-submodules=none';

const errors = [];
const warnings = [];
const info = [];

// строки вида «M<TAB>путь» → [{ status, file }]
function nameStatus(text) {
    return text.split('\n').filter(Boolean).map((line) => {
        const [status, ...rest] = line.split('\t');
        return { status, file: rest.join('\t') };
    });
}

// добавленные и убранные строки версии в правке VERSION.md
function versionDelta(diffText) {
    const added = [];
    const removed = [];
    for (const line of diffText.split('\n')) {
        if (line.startsWith('+++') || line.startsWith('---')) continue;
        if (line.startsWith('+')) added.push(...versionsIn(line.slice(1)));
        if (line.startsWith('-')) removed.push(...versionsIn(line.slice(1)));
    }
    return { added, removed };
}

function checkFiles(files) {
    for (const { status, file } of files) {
        if (file === 'hermes') errors.push('В коммит попал hermes — это ссылка на чужой клон, его расхождение не твоя правка. Убери из индекса.');
        if (/(^|\/)__pycache__\/|\.pyc$/.test(file)) errors.push(`В коммит попал кеш Python: ${file} — он меняется сам при каждом запуске мостов. Убери из индекса.`);
        if (/(^|\/)\.env$/.test(file)) errors.push(`В коммит попал ${file} — секреты в git не идут.`);
        if (status === 'D' && file.startsWith('DOCS/decisions/')) {
            warnings.push(`Удаляется записка ${file}: отменённое решение не удаляют, а помечают в самой записке (DOCS/decisions/README.md).`);
        }
    }
}

// номер новой записки не должен совпасть ни с файлом на диске (в любой рабочей
// копии), ни с чем-либо, что уже добавлялось в историю под другим именем
function checkNotes(files) {
    const added = files.filter((f) => f.status === 'A' && f.file.startsWith('DOCS/decisions/') && noteNumber(f.file) !== null);
    if (!added.length) return;
    const names = new Set();
    for (const dir of copies) {
        try { for (const name of fs.readdirSync(path.join(dir, DECISIONS))) names.add(name); } catch { /* папки нет */ }
    }
    const history = git(root, ['log', '--all', '--no-renames', '--diff-filter=A', '--name-only', '--format=', '--', 'DOCS/decisions']);
    for (const name of history.split('\n')) if (name.trim()) names.add(path.basename(name.trim()));
    for (const { file } of added) {
        const own = path.basename(file);
        const clash = [...names].filter((name) => name !== own && noteNumber(name) === noteNumber(own));
        if (clash.length) errors.push(`Номер записки ${own.slice(0, 3)} уже занят: ${clash.join(', ')}. Перенумеруй свою (next-numbers.js покажет свободный номер) и поправь ссылки на неё.`);
    }
}

function checkVersion(delta, headVersions, where) {
    if (!isMain) {
        if (delta.added.length) warnings.push('Это копия ветки исполнителя: строку версии здесь не пишут — она принадлежит коммиту, который приземлится в main.');
        return null;
    }
    if (delta.removed.length) errors.push(`${where}: из VERSION.md убраны строки версий (${delta.removed.map(label).join(', ')}) — DEV LOG только дописывается.`);
    if (delta.added.length === 0) {
        errors.push(`${where}: нет новой строки «vX.Y.Z - что сделано» в VERSION.md. Одна задача — один коммит и одна версия; без строки пульт покажет старую версию.`);
        return null;
    }
    if (delta.added.length > 1) {
        errors.push(`${where}: в VERSION.md добавлено ${delta.added.length} строки версий (${delta.added.map(label).join(', ')}) — чужую строку параллельной сессии в свой коммит не берут (рецепт в staging.md).`);
        return null;
    }
    const mine = delta.added[0];
    const newer = headVersions.filter((v) => compare(v, mine) >= 0);
    if (newer.length) errors.push(`${where}: ${label(mine)} не больше уже закоммиченной ${label(newer[newer.length - 1])} — пока ты работал, версию заняли. Возьми номер из next-numbers.js и перенеси свою строку в конец DEV LOG.`);
    return mine;
}

function auditStaged() {
    const files = nameStatus(git(root, ['diff', '--cached', '--no-renames', '--name-status', SEE_GITLINKS]));
    if (!files.length) {
        errors.push('В индексе пусто: сначала положи файлы задачи по имени — git add -- <файл> <файл>.');
        return;
    }
    info.push('В коммит идут:', ...files.map((f) => `    ${f.status}  ${f.file}`));
    const partly = new Set(nameStatus(git(root, ['diff', '--no-renames', '--name-status'])).map((f) => f.file));
    const partial = files.filter((f) => partly.has(f.file)).map((f) => f.file);
    if (partial.length) info.push(`Застейджены не целиком (в рабочей копии остались правки сверх индекса): ${partial.join(', ')} — так и должно быть, если остаток чужой.`);

    checkFiles(files);
    checkNotes(files);
    const headVersions = versionsIn(git(root, ['show', 'HEAD:VERSION.md']));
    const mine = checkVersion(versionDelta(git(root, ['diff', '--cached', '-U0', '--', 'VERSION.md'])), headVersions, 'Индекс');
    if (mine) {
        const staged = versionsIn(git(root, ['show', ':VERSION.md']));
        if (staged.length && staged[staged.length - 1].line !== mine.line) errors.push('Новая строка версии стоит не в конце DEV LOG — пульт берёт версию из последней строки.');
        info.push('', 'Первая строка сообщения коммита — ровно эта:', mine.line);
    }
}

function auditHead() {
    const subject = git(root, ['log', '-1', '--format=%s']).trim();
    const body = git(root, ['log', '-1', '--format=%b']);
    // сравниваем с первым родителем, а не через git show: у коммита слияния (так ветку
    // исполнителя принимают в main, и версия ставится именно на нём) git show печатает
    // совмещённую разницу с «++» — строка версии в ней не распознаётся
    const files = nameStatus(git(root, ['diff', '--no-renames', '--name-status', SEE_GITLINKS, 'HEAD~1', 'HEAD']));
    info.push(`Последний коммит: ${subject}`, ...files.map((f) => `    ${f.status}  ${f.file}`));

    checkFiles(files);
    const before = versionsIn(git(root, ['show', 'HEAD~1:VERSION.md']));
    const mine = checkVersion(versionDelta(git(root, ['diff', '-U0', 'HEAD~1', 'HEAD', '--', 'VERSION.md'])), before, 'Коммит');
    if (mine && subject !== mine.line) {
        errors.push(`Заголовок коммита не равен строке версии.\n    заголовок: ${subject}\n    VERSION.md: ${mine.line}`);
    }
    // id задач в этом проекте — «OpenKarandash-f59.4», «OpenKarandash-ykb»
    if (!/Задачи в beads нет|OpenKarandash-[a-z0-9]+/i.test(body)) {
        warnings.push('В теле сообщения нет ни id задачи beads, ни слов «Задачи в beads нет».');
    }
    if (!/роверен/i.test(body)) warnings.push('В теле сообщения нет честной пометки, что проверено, а что нет.');
    if (errors.length) info.push('', 'Коммит локальный и не отправлен: исправь и перезапиши его (git commit --amend), пока поверх не легли другие.');
}

if (headMode) auditHead(); else auditStaged();

if (info.length) console.log(info.join('\n'));
if (warnings.length) console.log(`\nПредупреждения:\n${warnings.map((w) => `- ${w}`).join('\n')}`);
if (errors.length) {
    console.log(`\nОШИБКИ — ${headMode ? 'коммит неверен' : 'не коммить'}:\n${errors.map((e) => `- ${e}`).join('\n')}`);
    process.exit(1);
}
console.log(`\n${headMode ? 'Коммит соответствует правилу.' : 'Индекс соответствует правилу — можно коммитить.'}`);
