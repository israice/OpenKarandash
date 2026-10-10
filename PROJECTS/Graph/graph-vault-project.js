// Сканирование файлов проекта, разбор секций и функций, чтение текста.
//
// Зависит от graph-vault-core.js для констант и graph-vault-notes.js для noteName.
const fs = require('fs');
const path = require('path');
const {
    ROOT,
    MAP_SKIP,
    TEXT_FILES,
    MAX_SCAN_BYTES,
    BIG_FILE_LINES,
    SECTION,
    TOP_FUNCTION,
    MAP_DIR,
    UNIT_DIR,
} = require('./graph-vault-core.js');
const { noteName } = require('./graph-vault-notes.js');

// ---------- список файлов проекта ----------

function projectFiles(dir = ROOT, acc = []) {
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return acc;
    }
    for (const entry of entries) {
        if (MAP_SKIP.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) projectFiles(full, acc);
        else acc.push(path.relative(ROOT, full).split(path.sep).join('/'));
    }
    return dir === ROOT ? acc.sort() : acc;
}

// ---------- чтение текста файла ----------

function readText(file) {
    try {
        if (fs.statSync(path.join(ROOT, file)).size > MAX_SCAN_BYTES) return '';
        return fs.readFileSync(path.join(ROOT, file), 'utf8');
    } catch {
        return '';
    }
}

// ---------- разбор секций и функций крупного файла ----------

function stripStringsAndComments(code) {
    let out = '';
    let mode = null;
    const inserts = [];
    let braces = 0;

    for (let i = 0; i < code.length; i++) {
        const ch = code[i];
        const next = code[i + 1];

        if (mode === '//') {
            if (ch === '\n') { mode = null; out += ch; } else out += ' ';
            continue;
        }
        if (mode === '/*') {
            if (ch === '*' && next === '/') { mode = null; out += '  '; i++; }
            else out += ch === '\n' ? ch : ' ';
            continue;
        }
        if (mode) {
            if (ch === '\\') { out += '  '; i++; continue; }
            if (mode === '`' && ch === '$' && next === '{') {
                inserts.push(braces);
                braces = 0;
                mode = null;
                out += '  ';
                i++;
                continue;
            }
            if (ch === mode) { mode = null; out += ' '; continue; }
            out += ch === '\n' ? ch : ' ';
            continue;
        }

        if (ch === '/' && next === '/') { mode = '//'; out += '  '; i++; continue; }
        if (ch === '/' && next === '*') { mode = '/*'; out += '  '; i++; continue; }
        if (ch === "'" || ch === '"' || ch === '`') { mode = ch; out += ' '; continue; }

        if (inserts.length) {
            if (ch === '{') braces++;
            else if (ch === '}') {
                if (braces === 0) { braces = inserts.pop(); mode = '`'; out += ' '; continue; }
                braces--;
            }
        }
        out += ch;
    }
    return out;
}

function parseUnits(file, text) {
    const lines = text.split(/\r?\n/);
    if (lines.length < BIG_FILE_LINES) return [];

    const units = [];
    lines.forEach((line, i) => {
        const section = line.match(SECTION);
        if (section) {
            units.push({ kind: 'section', title: section[1], line: i + 1, indent: 0 });
            return;
        }
        const fn = line.match(TOP_FUNCTION);
        if (fn) units.push({ kind: 'function', title: fn[2], line: i + 1, indent: fn[1].length });
    });

    units.forEach((unit, i) => {
        const next = units.slice(i + 1).find((other) => other.indent <= unit.indent);
        unit.body = lines.slice(unit.line, next ? next.line - 1 : lines.length).join('\n');
        unit.code = stripStringsAndComments(unit.body);
        unit.note = `${MAP_DIR}/${UNIT_DIR}/${noteName(`${path.basename(file)} ${unit.title}`)}`;
        if (unit.kind === 'function') {
            const owner = units.slice(0, i).reverse().find((other) => other.kind === 'section');
            unit.parent = owner ? owner.note : null;
        }
    });
    return units;
}

// ---------- разрешение ссылок ----------

function resolveRef(ref, from, known) {
    if (/^[a-z]+:/i.test(ref)) return null;
    const base = ref.startsWith('.') ? path.posix.join(path.posix.dirname(from), ref) : ref.replace(/^\//, '');
    for (const candidate of [base, `${base}.js`, `${base}.mjs`, `${base}/index.js`]) {
        if (known.has(candidate)) return candidate;
    }
    return null;
}

// ---------- секция markdown ----------

function section(title, items) {
    return items.length ? [`## ${title}`, ...items, ''] : [];
}

module.exports = {
    projectFiles,
    readText,
    parseUnits,
    stripStringsAndComments,
    resolveRef,
    section,
};