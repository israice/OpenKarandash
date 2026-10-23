const test = require('node:test');
const assert = require('node:assert/strict');
const { ensureNode } = require('./desktop-manager.js');

function execResponse(output = '', code = 0) {
    const events = [];
    if (output) events.push({ type: 'data', data: Buffer.from(output).toString('base64') });
    events.push({ type: 'done', code });
    return new Response(events.map((event) => JSON.stringify(event)).join('\n'));
}

test('uses Node.js and npm supplied by the desktop base image', async () => {
    const previousFetch = global.fetch;
    const calls = [];
    global.fetch = async (_url, options) => {
        const request = JSON.parse(options.body);
        calls.push(request);
        if (request.command[0] === 'node') return execResponse('v22.23.4\n');
        if (request.command[0] === 'npm') return execResponse('10.9.9\n');
        throw new Error(`Unexpected desktop command: ${request.command.join(' ')}`);
    };

    try {
        const env = await ensureNode('test-session');
        assert.deepEqual(env, {});
        assert.deepEqual(calls.map((call) => call.command), [
            ['node', '--version'],
            ['npm', '--version'],
        ]);
    } finally {
        global.fetch = previousFetch;
    }
});

test('rejects a desktop image without the supported Node.js version', async () => {
    const previousFetch = global.fetch;
    global.fetch = async () => execResponse('v20.19.0\n');
    try {
        await assert.rejects(ensureNode('test-session'), /requires Node\.js 22; found v20\.19\.0/);
    } finally {
        global.fetch = previousFetch;
    }
});
