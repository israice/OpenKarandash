// SessionStart-хук: сообщает, какие файлы CLI реально подмешал в системный
// промпт до первого хода агента — без единого вызова Read под это (см.
// TASKS.md, «Чего в плане нет и почему», и DOCS/decisions/019 — хук это
// единственный честный канал для такого факта в трассу). Flow достаёт пути
// из этого события в messageFilePaths (PROJECTS/Flow/flow.js) так же, как
// toolFilePath достаёт их из обычных Read/Edit.
//
// Всегда честны, независимо от --setting-sources:
// - корневой CLAUDE.md / CLAUDE.local.md проекта — часть memory hierarchy,
//   которая не зависит от --setting-sources (тот режет только settings.json/
//   permissions/hooks, не CLAUDE.md);
// - файл авто-памяти (`memory/MEMORY.md`) — своя папка проекта под
//   ~/.claude/projects/, тоже не относится к settings sources. Имя папки —
//   cwd с заменой `\ / : _ пробел` на `-` (см. CLAUDE.md, раздел «Claude из
//   WSL»: одна и та же формула даёт и Windows-, и WSL-варианты имени).
//
// Пользовательский ~/.claude/CLAUDE.md (+ его @-импорты) добавляется, только
// если запуск не сузил --setting-sources: LEAN_ARGS в server.js делает это
// флагом `project,local` и параллельно ставит дочернему процессу переменную
// OPENKARANDASH_SETTING_SOURCES — без неё (интерактивный запуск CLI руками,
// не через сервер) считаем источники настроек умолчальными и файл включаем.
// Проверено вживую: под LEAN_ARGS хуки из глобального ~/.claude/settings.json
// в трассу не попадают вовсе — user-источник правда исключён
const fs = require('fs');
const os = require('os');
const path = require('path');

// @path — import-синтаксис CLAUDE.md (до 5 хопов у самого CLI); путь
// относительно папки импортирующего файла. Первый хоп нам и нужен: дальше
// уходить смысла нет — глубже пользователь обычно не заглядывает руками,
// а гадать про чужие цепочки импортов — уже не честный факт, а предположение
function importedFiles(mdFile) {
    let text;
    try {
        text = fs.readFileSync(mdFile, 'utf8');
    } catch {
        return [];
    }
    const dir = path.dirname(mdFile);
    const matches = text.match(/@[^\s]+\.md/g) || [];
    return matches
        .map((m) => path.resolve(dir, m.slice(1)))
        .filter((p) => fs.existsSync(p));
}

function main() {
    let input;
    try {
        input = JSON.parse(fs.readFileSync(0, 'utf8'));
    } catch {
        return;
    }

    const projectDir = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
    const claudeMd = path.join(projectDir, 'CLAUDE.md');
    const claudeLocalMd = path.join(projectDir, 'CLAUDE.local.md');
    const escapedProjectDir = projectDir.replace(/[\\/:_ ]/g, '-');
    const memoryMd = path.join(os.homedir(), '.claude', 'projects', escapedProjectDir, 'memory', 'MEMORY.md');

    let contextFiles = [claudeMd, claudeLocalMd, memoryMd].filter((p) => fs.existsSync(p));

    if (!process.env.OPENKARANDASH_SETTING_SOURCES) {
        const userClaudeMd = path.join(os.homedir(), '.claude', 'CLAUDE.md');
        if (fs.existsSync(userClaudeMd)) {
            contextFiles.push(userClaudeMd, ...importedFiles(userClaudeMd));
        }
    }

    if (!contextFiles.length) return;
    console.log(JSON.stringify({ contextFiles }));
}

main();
