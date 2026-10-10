// Память о сессиях: заметки в vault, которые переживают пересборку карты.
//
// Зависит от graph-vault-core.js и graph-vault-notes.js.
const fs = require('fs');
const path = require('path');
const {
    ROOT,
    VAULT,
    MAP_DIR,
    SESSION_DIR,
    EDITING_TOOLS,
    SESSION_TITLE_LIMIT,
    state,
} = require('./graph-vault-core.js');
const { noteName, writeNote } = require('./graph-vault-notes.js');

function sessionNote(session) {
    const date = String(session.updatedAt || '').slice(0, 10);
    const title = String(state.deps.sessionTitle(session) || '').slice(0, SESSION_TITLE_LIMIT).trim();
    return noteName(`${date} ${title} ${String(session.id).slice(0, 8)}`);
}

function syncSessionNotes() {
    const files = require('./graph-vault-project.js').projectFiles();
    const byName = new Map();
    for (const file of files) byName.set(path.basename(file).toLowerCase(), file);

    const noteDir = path.join(VAULT, SESSION_DIR);
    for (const session of state.deps.listSessions.all()) {
        const messages = state.deps.listMessages.all(session.id);
        const spoken = messages.filter((m) => m.role === 'user' || m.role === 'assistant');
        const touched = new Set();
        for (const message of messages) {
            if (message.role !== 'tool') continue;
            const edit = message.text.match(EDITING_TOOLS);
            const target = edit && byName.get(path.basename(edit[2]).toLowerCase());
            if (target) touched.add(target);
        }

        if (!spoken.some((m) => m.role === 'assistant') && !touched.size) continue;

        const when = Date.parse(session.updatedAt) || 0;
        const changed = [...touched].filter((file) => {
            try {
                return fs.statSync(path.join(ROOT, file)).mtimeMs > when + 60_000;
            } catch {
                return false;
            }
        });

        const answer = [...spoken].reverse().find((m) => m.role === 'assistant');
        writeNote(path.join(noteDir, `${sessionNote(session)}.md`), {
            kind: 'session',
            date: String(session.updatedAt || '').slice(0, 10),
            messages: session.messageCount,
            stale: changed.length ? 'true' : undefined,
        }, [
            ...(changed.length ? [`⚠ Changed after this session: ${changed.join(', ')}`, ''] : []),
            `## What was requested`,
            state.deps.sessionTitle(session),
            '',
            ...require('./graph-vault-project.js').section('How it ended', answer ? [answer.text.split(/\r?\n\r?\n/)[0].slice(0, 400)] : []),
            ...require('./graph-vault-project.js').section('Files', [...touched].sort().map((file) => `- [[${MAP_DIR}/${file}]]`)),
        ]);
    }
}

module.exports = { sessionNote, syncSessionNotes };