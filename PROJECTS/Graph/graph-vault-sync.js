// Синхронизация карты проекта: сборка заметок файлов, секций, API-роутов и истории git.
//
// Это главная функция пересборки карты. Она использует все остальные модули graph-vault-*.
const fs = require('fs');
const path = require('path');
const {
    ROOT,
    VAULT,
    MAP_DIR,
    UNIT_DIR,
    API_SUBDIR,
    TEXT_FILES,
    API_REF,
    API_ROUTE,
    HTML_REF,
    MODULE_REF,
    NOTE_NAME_LIMIT,
    state,
} = require('./graph-vault-core.js');
const { projectFiles, readText, parseUnits, resolveRef, section } = require('./graph-vault-project.js');
const { gitHistory } = require('./graph-vault-git.js');
const { writeNote, dropStaleNotes, collectNotes, resetWrittenNotes, noteName } = require('./graph-vault-notes.js');

function syncProjectMap() {
    const files = projectFiles();
    const known = new Set(files);
    const history = gitHistory();

    const mapRoot = path.join(VAULT, MAP_DIR);
    resetWrittenNotes();

    const texts = new Map();
    const units = new Map();
    const routeImpl = new Map();
    for (const file of files) {
        if (!TEXT_FILES.test(file)) continue;
        const text = readText(file);
        texts.set(file, text);
        units.set(file, parseUnits(file, text));
        for (const match of text.matchAll(API_ROUTE)) routeImpl.set(match[1] || match[2], file);
    }

    const routeCallers = new Map();
    for (const file of files) {
        const text = texts.get(file) || '';
        const links = new Set();

        for (const match of text.matchAll(API_REF)) {
            const route = match[1];
            if (!routeImpl.has(route)) continue;
            links.add(`${MAP_DIR}/${API_SUBDIR}/${noteName(route.slice(5))}`);
            if (routeImpl.get(route) !== file) {
                const callers = routeCallers.get(route) || new Set();
                callers.add(file);
                routeCallers.set(route, callers);
            }
        }
        for (const match of [...text.matchAll(HTML_REF), ...text.matchAll(MODULE_REF)]) {
            const target = resolveRef(match[1], file, known);
            if (target && target !== file) links.add(`${MAP_DIR}/${target}`);
        }
        if (file.endsWith('.md')) {
            for (const match of text.matchAll(/\[\[([^\]|#^]+)/g)) links.add(match[1].trim());
        }

        const git = history.byFile.get(file);
        const fileUnits = units.get(file) || [];
        writeNote(path.join(mapRoot, `${file}.md`), {
            kind: 'file',
            file,
            lines: text ? text.split(/\r?\n/).length : undefined,
            commits: git ? git.commits : undefined,
            first_seen: git ? git.first.date : undefined,
            last_commit: git ? `${git.last.date} ${git.last.subject}` : undefined,
        }, [
            `Project file: \`${file}\``,
            '',
            ...section('Links to', [...links].sort().map((target) => `- [[${target}]]`)),
            ...section('Contains', fileUnits
                .filter((unit) => !unit.parent)
                .map((unit) => `- [[${unit.note}]] (line ${unit.line})`)),
        ]);
    }

    for (const [file, fileUnits] of units) {
        const names = new Map(fileUnits.filter((u) => u.kind === 'function').map((u) => [u.title, u]));
        for (const unit of fileUnits) {
            const own = unit.kind === 'section'
                ? fileUnits.filter((other) => other.parent === unit.note)
                : [];
            const calls = new Set();
            if (unit.kind === 'function') {
                for (const [name, target] of names) {
                    if (target !== unit && new RegExp(`(?<![.\\w$])${name}\\s*\\(`).test(unit.code)) calls.add(target.note);
                }
            }
            writeNote(path.join(VAULT, `${unit.note}.md`), {
                kind: unit.kind,
                file,
                line: unit.line,
            }, [
                `${unit.kind === 'section' ? 'Section' : 'Function'} \`${unit.title}\` in [[${unit.parent || `${MAP_DIR}/${file}`}]], line ${unit.line}.`,
                '',
                ...section('Contains', own.map((other) => `- [[${other.note}]] (line ${other.line})`)),
                ...section('Calls', [...calls].sort().map((note) => `- [[${note}]]`)),
            ]);
        }
    }

    for (const [route, impl] of routeImpl) {
        const callers = [...(routeCallers.get(route) || [])].sort();
        writeNote(path.join(mapRoot, API_SUBDIR, `${noteName(route.slice(5))}.md`), {
            kind: 'route',
            route,
        }, [
            `API route \`${route}\`, implemented in [[${MAP_DIR}/${impl}]].`,
            '',
            ...section('Called by', callers.map((file) => `- [[${MAP_DIR}/${file}]]`)),
        ]);
    }

    const pairs = [...history.pairs].filter(([, weight]) => weight >= 2);
    if (pairs.length) {
        writeNote(path.join(mapRoot, 'Git history.md'), {
            kind: 'history',
            commits: history.commits,
        }, [
            `Files that change together (from ${history.commits} commits).`,
            '',
            ...pairs.sort((a, b) => b[1] - a[1]).flatMap(([key, weight]) => {
                const [a, b] = JSON.parse(key);
                return known.has(a) && known.has(b) ? [`- ${weight}× [[${MAP_DIR}/${a}]] ↔ [[${MAP_DIR}/${b}]]`] : [];
            }),
        ]);
    }
}

module.exports = { syncProjectMap };