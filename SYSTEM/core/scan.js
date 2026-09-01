// Что не обходят те, кто ходит по дереву проекта: сторож файлов в server.js и
// сборщик карты в PROJECTS/Graph/graph-server.js. Список общий, потому что
// разъехавшиеся копии уже приводили к падению: сторож зашёл в установку Hermes,
// споткнулся о symlink из WSL-окружения (с Windows он не читается) и уронил сервер.

const path = require('path');

// по имени папки — где угодно в дереве
const SKIP_NAMES = new Set(['node_modules', '.git', 'DATA']);

// по месту — только эти конкретные папки, а не любые с таким именем:
// «runtime» вполне может оказаться названием пользовательского раздела
const SKIP_PATHS = [
    path.join('SYSTEM', 'Hermes', 'agent'),    // сам Hermes, ~250 МБ чужого кода
    path.join('SYSTEM', 'Hermes', 'runtime'),  // окружения Python: symlink'и и бинарники
];

// root нужен, чтобы сравнивать относительные пути: абсолютные различаются
// между Windows (C:\…) и WSL (/mnt/c/…), а относительные — нет
function isSkipped(root, fullPath, name) {
    if (SKIP_NAMES.has(name)) return true;
    const relative = path.relative(root, fullPath);
    return SKIP_PATHS.some((skip) => relative === skip || relative.startsWith(skip + path.sep));
}

module.exports = { SKIP_NAMES, SKIP_PATHS, isSkipped };
