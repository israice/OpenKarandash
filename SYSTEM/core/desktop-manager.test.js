const test = require('node:test');
const assert = require('node:assert/strict');
const { ensureNode } = require('./desktop-manager.js');

function execResponse(output = '', code = 0) {
    const events = [];
    if (output) events.push({ type: 'data', data: Buffer.from(output).toString('base64') });
    events.push({ type: 'done', code });
    return new Response(events.map((event) => JSON.stringify(event)).join('\n'));
}

test('ensures Node 22 using the verified official archive and returns its PATH', async () => {
    const previousFetch = global.fetch;
    const calls = [];
    global.fetch = async (_url, options) => {
        const request = JSON.parse(options.body);
        calls.push(request);
        if (request.command[0] === 'uname') return execResponse('x86_64\n');
        if (request.command[0] === 'sh') return execResponse();
        return execResponse('/usr/local/bin:/usr/bin:/bin\n');
    };

    try {
        const env = await ensureNode('test-session');
        assert.equal(env.PATH, '/home/desktop/.tools/node22/bin:/usr/local/bin:/usr/bin:/bin');
        const installCommand = calls.find((call) => call.command[0] === 'sh').command[2];
        assert.match(installCommand, /latest-v22\.x/);
        assert.match(installCommand, /node-v22\\\.\[0-9\].*linux-x64/);
        assert.match(installCommand, /sha256sum -c/);
    } finally {
        global.fetch = previousFetch;
    }
});

test('rejects unsupported desktop architectures', async () => {
    const previousFetch = global.fetch;
    global.fetch = async () => execResponse('riscv64\n');
    try {
        await assert.rejects(ensureNode('test-session'), /do not support architecture riscv64/);
    } finally {
        global.fetch = previousFetch;
    }
});
