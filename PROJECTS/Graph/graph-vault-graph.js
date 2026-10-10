// Построение графа vault: чтение готовых заметок и построение узлов/рёбер.
//
// Зависит от graph-vault-core.js и graph-vault-notes.js.
const fs = require('fs');
const path = require('path');
const {
    VAULT,
    MAP_DIR,
} = require('./graph-vault-core.js');
const { collectNotes } = require('./graph-vault-notes.js');

// ---------- frontmatter заметки ----------

function readFrontmatter(text) {
    const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!match) return {};
    const meta = {};
    for (const line of match[1].split(/\r?\n/)) {
        const pair = line.match(/^([a-z_]+):\s*(.*)$/i);
        if (pair) meta[pair[1]] = pair[2];
    }
    return meta;
}

// ---------- построение графа из vault ----------

function buildVaultGraph() {
    if (!fs.existsSync(VAULT)) return { ok: false, error: `Vault not found: ${VAULT}` };

    const paths = collectNotes(VAULT, VAULT);

    const byPath = new Map(paths.map((note) => [note.toLowerCase(), note]));
    const byName = new Map();
    const ambiguous = new Set();
    for (const note of paths) {
        const name = path.basename(note, '.md').toLowerCase();
        if (byName.has(name)) ambiguous.add(name);
        byName.set(name, note);
    }
    for (const name of ambiguous) byName.delete(name);

    function resolveLink(raw) {
        const link = raw.trim().replace(/\.md$/i, '');
        return byPath.get(`${link.toLowerCase()}.md`) || byName.get(path.basename(link).toLowerCase());
    }

    const notes = [];
    const links = new Set();
    for (const note of paths) {
        let text;
        try {
            text = fs.readFileSync(path.join(VAULT, note), 'utf8');
        } catch {
            continue;
        }

        const meta = readFrontmatter(text);
        notes.push({
            path: note,
            kind: meta.kind || 'note',
            file: meta.file,
            line: meta.line ? Number(meta.line) : undefined,
            route: meta.route,
            date: meta.date,
            group: note.split('/')[0],
        });

        for (const match of text.matchAll(/\[\[([^\]|#^]+)/g)) {
            const target = resolveLink(match[1]);
            if (target && target !== note) links.add(JSON.stringify([note, target].sort()));
        }
    }

    return {
        ok: true,
        vault: path.basename(VAULT),
        notes,
        links: [...links].map((pair) => JSON.parse(pair)),
    };
}

module.exports = { buildVaultGraph, readFrontmatter };