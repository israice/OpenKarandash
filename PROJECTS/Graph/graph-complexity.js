// Метрика сложности проекта (п. 5 дорожной карты, DOCS/decisions/111).
// Один владелец: PROJECTS/Graph. Маршрут — GET /api/complexity в graph-server.js.
// Отдаёт фактическое состояние, а не оценки: число строк в файлах, исходящие
// require на файл, глубина папок. Порог длинного файла — MAX_LINES (022).

const fs = require('fs');
const path = require('path');

const MAX_LINES = 400;
const SKIP = new Set(['node_modules', 'DATA', '.git', '.venv', 'hf-cache', 'vendor', '.kilo']);
const ROOT = path.join(__dirname, '..', '..');

function walk(dir, visit) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (SKIP.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, visit);
        else visit(full);
    }
}

function countRequires(code) {
    const hits = code.match(/\brequire\(\s*['"][^'"]+['"]\s*\)/g);
    return hits ? hits.length : 0;
}

function collect() {
    const files = [];
    walk(ROOT, (full) => {
        if (!/\.(js|mjs|cjs)$/.test(full)) return;
        const code = fs.readFileSync(full, 'utf8');
        const rel = path.relative(ROOT, full).split(path.sep).join('/');
        files.push({
            file: rel,
            lines: code.split('\n').length,
            requires: countRequires(code),
            depth: rel.split('/').length - 1,
        });
    });
    const long = files.filter((f) => f.lines > MAX_LINES).sort((a, b) => b.lines - a.lines);
    const byRequires = [...files].sort((a, b) => b.requires - a.requires).slice(0, 10);
    const byDepth = [...files].sort((a, b) => b.depth - a.depth).slice(0, 10);
    const maxDepth = files.reduce((m, f) => Math.max(m, f.depth), 0);
    return {
        files: files.length,
        maxLines: MAX_LINES,
        longFiles: long,
        maxFolderDepth: maxDepth,
        topRequires: byRequires.filter((f) => f.requires > 0),
        topDepth: byDepth,
    };
}

module.exports = { collect };
