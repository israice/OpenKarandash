// Операции с заметками vault: чтение, запись, удаление устаревших.
//
// Общие константы и состояние берутся из graph-vault-core.js.
const fs = require('fs');
const path = require('path');
const {
    ROOT,
    VAULT,
    MAP_DIR,
    NOTE_NAME_LIMIT,
    state,
} = require('./graph-vault-core.js');

// ---------- имя заметки ----------

function noteName(text) {
    return text.replace(/[\\/:*?"<>|]/g, '-').trim().slice(0, NOTE_NAME_LIMIT).trim();
}

// ---------- запись заметки ----------

let writtenNotes = new Set();

function writeNote(notePath, frontmatter, body) {
    const note = [
        '---',
        ...Object.entries(frontmatter).filter(([, value]) => value !== undefined && value !== '').map(([k, v]) => `${k}: ${v}`),
        '---',
        '',
        ...body,
        '',
    ].join('\n');

    writtenNotes.add(path.resolve(notePath));
    try {
        if (fs.readFileSync(notePath, 'utf8') === note) return;
    } catch {
    }
    fs.mkdirSync(path.dirname(notePath), { recursive: true });
    fs.writeFileSync(notePath, note);
}

// ---------- удаление устаревших заметок ----------

function dropStaleNotes(dir) {
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return;
    }
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            dropStaleNotes(full);
            try {
                if (!fs.readdirSync(full).length) fs.rmdirSync(full);
            } catch {
            }
            continue;
        }
        if (entry.name.endsWith('.md') && !writtenNotes.has(path.resolve(full))) fs.unlinkSync(full);
    }
}

// ---------- сбор заметок vault ----------

function collectNotes(dir, base, acc = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (VAULT_SKIP.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) collectNotes(full, base, acc);
        else if (entry.name.endsWith('.md')) acc.push(path.relative(base, full).split(path.sep).join('/'));
    }
    return acc;
}

// экспортируем VAULT_SKIP отсюда, чтобы не было циклической зависимости
const { VAULT_SKIP } = require('./graph-vault-core.js');

module.exports = {
    noteName,
    writeNote,
    dropStaleNotes,
    collectNotes,
    writtenNotes: () => writtenNotes,
    resetWrittenNotes: () => { writtenNotes = new Set(); },
};