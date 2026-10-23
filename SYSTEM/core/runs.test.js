const test = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('./runs.js');

test('maintenance waits for active turns and rejects new ones until released', async () => {
    const runs = create({ releaseTelegram: async () => {} });
    const active = { sessionId: null, child: null };
    runs.beginTurn(active);

    let release;
    let ready = false;
    const maintenance = runs.pauseForMaintenance().then((unlock) => {
        release = unlock;
        ready = true;
    });
    await Promise.resolve();
    assert.equal(ready, false);
    assert.equal(runs.isStopping(), true);
    assert.throws(() => runs.beginTurn({}), /server is restarting/);

    runs.finishTurn(active);
    runs.releaseTurn(active);
    await maintenance;
    assert.equal(ready, true);

    release();
    assert.equal(runs.isStopping(), false);
    runs.beginTurn({});
});

test('maintenance can be released immediately when no turn is active', async () => {
    const runs = create({ releaseTelegram: async () => {} });
    const release = await runs.pauseForMaintenance();

    assert.equal(runs.isStopping(), true);
    release();
    assert.equal(runs.isStopping(), false);
});
