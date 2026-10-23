const fs = require('node:fs');
const path = require('node:path');

function nextVersionEntry(text, title, pullRequest) {
    const versions = [...text.matchAll(/^v(\d+)\.(\d+)\.(\d+)\b.*$/gm)];
    if (!versions.length) throw new Error('VERSION.md has no semantic version entries');

    const latest = versions[versions.length - 1];
    const version = `v${latest[1]}.${latest[2]}.${Number(latest[3]) + 1}`;
    const summary = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!summary) throw new Error('The merged pull request has no title');
    if (!/^\d+$/.test(String(pullRequest))) throw new Error('A numeric pull request number is required');

    return { version, entry: `${version} - ${summary} (PR #${pullRequest})` };
}

function main() {
    const file = path.join(__dirname, '..', 'VERSION.md');
    const text = fs.readFileSync(file, 'utf8');
    const result = nextVersionEntry(text, process.env.VERSION_PR_TITLE, process.env.VERSION_PR_NUMBER);
    if (text.includes(`(PR #${process.env.VERSION_PR_NUMBER})`)) {
        throw new Error(`VERSION.md already contains an entry for PR #${process.env.VERSION_PR_NUMBER}`);
    }
    fs.writeFileSync(file, `${text.replace(/\s*$/, '')}\n${result.entry}\n`, 'utf8');
    console.log(result.version);
}

if (require.main === module) {
    try {
        main();
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}

module.exports = { nextVersionEntry };
