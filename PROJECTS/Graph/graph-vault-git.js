// История git: когда файл появился, как часто меняется и с чем меняется вместе.
//
// Использует константы из graph-vault-core.js.
const { execFileSync } = require('child_process');
const { ROOT } = require('./graph-vault-core.js');

function gitHistory() {
    const empty = { byFile: new Map(), pairs: new Map(), commits: 0 };
    let out;
    try {
        out = execFileSync('git', ['log', '--pretty=format:%h|%ad|%s', '--date=short', '--name-only'], {
            cwd: ROOT,
            encoding: 'utf8',
            windowsHide: true,
            maxBuffer: 16 * 1024 * 1024,
        });
    } catch {
        return empty;
    }

    const commits = out.split(/\r?\n\s*\r?\n/).map((block) => {
        const [head, ...rest] = block.split(/\r?\n/);
        const [hash, date, subject] = (head || '').split('|');
        return { hash, date, subject, files: rest.filter(Boolean) };
    }).filter((commit) => commit.hash);
    if (!commits.length) return empty;

    const byFile = new Map();
    for (const commit of commits) {
        for (const file of commit.files) {
            const entry = byFile.get(file) || { commits: 0, last: commit, first: commit };
            entry.commits++;
            entry.first = commit;
            byFile.set(file, entry);
        }
    }

    const noisy = new Set([...byFile].filter(([, e]) => e.commits / commits.length > 0.6).map(([f]) => f));
    const pairs = new Map();
    for (const commit of commits) {
        const files = commit.files.filter((file) => !noisy.has(file));
        for (let i = 0; i < files.length; i++) {
            for (let j = i + 1; j < files.length; j++) {
                const key = JSON.stringify([files[i], files[j]].sort());
                pairs.set(key, (pairs.get(key) || 0) + 1);
            }
        }
    }
    return { byFile, pairs, commits: commits.length };
}

module.exports = { gitHistory };