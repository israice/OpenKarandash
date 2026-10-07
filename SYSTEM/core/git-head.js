// Какой коммит собран в рабочей копии. Отдельный модуль потому, что читают его
// двое: подстановка в страницу (core/version.js — она в разметке как data-head)
// и сторож коммитов (core/watch.js — по нему в канал уходит перезагрузка).
//
// Читаем файлами, а не командой git. `git rev-parse HEAD` на этой машине стоит
// около 95 мс и блокирует event loop, а его читает опрос, идущий каждые
// 400 мс: два чтения файлов дешевле в сотни раз, а `.git/HEAD` и файл ссылки
// лежат рядом и меняются тем же коммитом.
//
// Три случая, из-за которых это не «просто прочитать файл»:
//   - в копии исполнителя `.git` не папка, а файл со ссылкой `gitdir: …`;
//   - HEAD может указывать на ref, а не держать хеш (ветка) — тогда идём за ref,
//     а он после `git gc` может лежать в packed-refs, а не отдельным файлом;
//   - detached HEAD (ветку не выдали) — тогда в HEAD лежит сам хеш.
const fs = require('fs');
const path = require('path');

function gitDir(root) {
    const dotGit = path.join(root, '.git');
    try {
        if (!fs.statSync(dotGit).isFile()) return dotGit;
        const link = fs.readFileSync(dotGit, 'utf8').trim().replace(/^gitdir:\s*/, '');
        return path.resolve(root, link);
    } catch {
        return ''; // это не репозиторий — коммита нет, и опрос молчит
    }
}

// хеш по имени ссылки: сначала отдельный файл, потом packed-refs
function readRef(dir, name) {
    try {
        return fs.readFileSync(path.join(dir, ...name.split('/')), 'utf8').trim();
    } catch { /* ссылки нет файлом — она упакована */ }
    try {
        for (const line of fs.readFileSync(path.join(dir, 'packed-refs'), 'utf8').split('\n')) {
            const row = line.match(/^([0-9a-f]{40})\s+(\S+)$/);
            if (row && row[2] === name) return row[1];
        }
    } catch { /* папки с упакованными ссылками нет — отметкой будет пусто */ }
    return '';
}

// пустая строка — это не коммит, а «не знаю»: опрос по ней молчит, а страница
// с пустым data-head перезагружаться не станет (сравнивать не с чем)
function head(root) {
    const dir = gitDir(root);
    if (!dir) return '';
    try {
        const text = fs.readFileSync(path.join(dir, 'HEAD'), 'utf8').trim();
        const ref = text.match(/^ref:\s*(\S+)$/);
        return ref ? readRef(dir, ref[1]) : text;
    } catch {
        return ''; // прочитать не вышло — моментом раза не считаем
    }
}

module.exports = { head };