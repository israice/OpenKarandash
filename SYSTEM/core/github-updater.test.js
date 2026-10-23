const test = require('node:test');
const assert = require('node:assert/strict');
const { isDependencyChange } = require('./github-updater.js');

test('dependency changes require a container rebuild', () => {
    assert.equal(isDependencyChange(['SYSTEM/core/api.js']), false);
    assert.equal(isDependencyChange(['package.json']), true);
    assert.equal(isDependencyChange(['package-lock.json']), true);
});
