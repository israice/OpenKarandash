const test = require('node:test');
const assert = require('node:assert/strict');
const { ensurePullRequest, githubSlug } = require('./desktop-sessions.js');

test('accepts GitHub HTTPS and SSH repository URLs', () => {
    assert.equal(githubSlug('https://github.com/israice/OpenKarandash.git'), 'israice/OpenKarandash');
    assert.equal(githubSlug('git@github.com:israice/OpenKarandash.git'), 'israice/OpenKarandash');
    assert.throws(() => githubSlug('https://example.com/owner/repo.git'), /GitHub repository URL/);
});

test('opens a PR and enables squash auto-merge through GitHub API', async () => {
    const previousFetch = global.fetch;
    const calls = [];
    global.fetch = async (url, options) => {
        calls.push({ url: String(url), options });
        const result = calls.length === 1
            ? []
            : calls.length === 2
                ? { number: 17, node_id: 'PR_node', html_url: 'https://github.com/israice/OpenKarandash/pull/17' }
                : calls.length === 3
                    ? { data: { node: { state: 'OPEN', autoMergeRequest: null } } }
                    : { data: { enablePullRequestAutoMerge: { pullRequest: { number: 17 } } } };
        return new Response(JSON.stringify(result), { status: 200 });
    };

    try {
        const result = await ensurePullRequest({
            repository: 'https://github.com/israice/OpenKarandash.git',
            branch: 'worker/session-17',
            base: 'main',
            token: 'test-token',
            title: 'Automate session updates',
            sessionId: 'session-17',
        });
        assert.deepEqual(result, {
            number: 17,
            url: 'https://github.com/israice/OpenKarandash/pull/17',
        });
        assert.equal(calls.length, 4);
        assert.equal(calls[1].options.method, 'POST');
        assert.equal(calls[1].options.headers.Authorization, 'Bearer test-token');
        assert.match(calls[3].options.body, /enablePullRequestAutoMerge/);
    } finally {
        global.fetch = previousFetch;
    }
});

test('requires a token before making a PR request', async () => {
    await assert.rejects(
        ensurePullRequest({
            repository: 'https://github.com/israice/OpenKarandash.git',
            branch: 'worker/session-18',
            base: 'main',
            token: '',
            title: 'A task',
            sessionId: 'session-18',
        }),
        /DESKTOP_GITHUB_TOKEN is required/,
    );
});
