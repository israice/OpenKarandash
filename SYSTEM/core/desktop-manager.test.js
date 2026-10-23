const test = require('node:test');
const assert = require('node:assert/strict');
const { ensureNode, resolveOpenCodeBin } = require('./desktop-manager.js');

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

test('prefers the OpenCode binary persisted with the desktop home', async () => {
    const previousFetch = global.fetch;
    const calls = [];
    global.fetch = async (_url, options) => {
        const request = JSON.parse(options.body);
        calls.push(request.command);
        return execResponse();
    };

    try {
        assert.equal(
            await resolveOpenCodeBin('home-opencode-first'),
            '/home/desktop/.opencode/bin/opencode',
        );
        assert.deepEqual(calls, [['/home/desktop/.opencode/bin/opencode', '--version']]);
    } finally {
        global.fetch = previousFetch;
    }
});

test('falls back to the image OpenCode binary when the home install is unavailable', async () => {
    const previousFetch = global.fetch;
    const calls = [];
    global.fetch = async (_url, options) => {
        const request = JSON.parse(options.body);
        calls.push(request.command);
        return execResponse('', request.command[0] === '/home/desktop/.opencode/bin/opencode' ? 127 : 0);
    };

    try {
        assert.equal(await resolveOpenCodeBin('image-opencode-fallback'), 'opencode');
        assert.deepEqual(calls, [
            ['/home/desktop/.opencode/bin/opencode', '--version'],
            ['opencode', '--version'],
        ]);
    } finally {
        global.fetch = previousFetch;
    }
});
