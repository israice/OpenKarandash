const test = require('node:test');
const assert = require('node:assert/strict');
const { nextVersionEntry } = require('./record-version.js');

test('increments the latest patch and records the merged PR', () => {
    const result = nextVersionEntry(
        '# DEV LOG\nv0.0.208 - previous work\n',
        'Add GitHub deployment automation',
        42,
    );

    assert.deepEqual(result, {
        version: 'v0.0.209',
        entry: 'v0.0.209 - Add GitHub deployment automation (PR #42)',
    });
});

test('normalizes newlines from pull request titles', () => {
    const result = nextVersionEntry('# DEV LOG\nv1.2.3 - old\n', 'Update\r\nversion', 7);
    assert.equal(result.entry, 'v1.2.4 - Update version (PR #7)');
});

test('rejects malformed version history and missing PR identifiers', () => {
    assert.throws(() => nextVersionEntry('# DEV LOG\n', 'work', 1), /no semantic version/);
    assert.throws(() => nextVersionEntry('v0.0.1 - old\n', 'work', 'x'), /numeric pull request/);
});
