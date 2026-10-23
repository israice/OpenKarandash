// Ownership bridge between the SQLite chat session and the desktop manager.
// One promise per chat id prevents duplicate allocation on concurrent sends.
const pending = new Map();

function githubSlug(repository) {
    const match = String(repository).match(/^(?:https:\/\/github\.com\/|git@github\.com:)([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
    if (!match) throw new Error('Automatic pull requests require a GitHub repository URL');
    return `${match[1]}/${match[2]}`;
}

async function githubRequest(path, token, options = {}) {
    const response = await fetch(`https://api.github.com${path}`, {
        ...options,
        headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${token}`,
            'X-GitHub-Api-Version': '2022-11-28',
            ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        },
    });
    const text = await response.text();
    let body = {};
    try { body = text ? JSON.parse(text) : {}; } catch { body = {}; }
    if (!response.ok) {
        throw new Error(`GitHub API returned ${response.status}: ${body.message || response.statusText}`);
    }
    return body;
}

async function ensurePullRequest({ repository, branch, base, token, title, sessionId }) {
    if (!token) throw new Error('DESKTOP_GITHUB_TOKEN is required to open and auto-merge a pull request');
    const slug = githubSlug(repository);
    const [owner, repo] = slug.split('/');
    const query = new URLSearchParams({
        state: 'open',
        head: `${owner}:${branch}`,
        base,
    });
    const open = await githubRequest(`/repos/${slug}/pulls?${query}`, token);
    let pullRequest = open[0];
    if (!pullRequest) {
        pullRequest = await githubRequest(`/repos/${slug}/pulls`, token, {
            method: 'POST',
            body: JSON.stringify({
                title: String(title || `OpenKarandash session ${sessionId}`).slice(0, 240),
                head: branch,
                base,
                body: `Automated changes from OpenKarandash session \`${sessionId}\`.\n\nProject checks and merge-queue validation must pass before GitHub merges this pull request.`,
            }),
        });
    }

    const graph = async (queryText, variables) => {
        const result = await githubRequest('/graphql', token, {
            method: 'POST',
            body: JSON.stringify({ query: queryText, variables }),
        });
        if (result.errors?.length) throw new Error(`GitHub auto-merge request failed: ${result.errors.map((item) => item.message).join('; ')}`);
        return result.data;
    };
    const state = await graph(
        'query ($id: ID!) { node(id: $id) { ... on PullRequest { state autoMergeRequest { enabledAt } } } }',
        { id: pullRequest.node_id },
    );
    if (state.node?.state === 'OPEN' && !state.node.autoMergeRequest) {
        await graph(
            'mutation ($id: ID!) { enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: SQUASH }) { pullRequest { number } } }',
            { id: pullRequest.node_id },
        );
    }
    return { number: pullRequest.number, url: pullRequest.html_url };
}
let standby = null;
let standbyPromise = null;

function create({ desktop, db }) {
    async function prewarm() {
        if (!desktop.isEnabled() || standby || standbyPromise) return standby;
        standbyPromise = desktop.createDesktop('openkarandash-standby')
            .then((created) => { standby = created; return created; })
            .catch(() => null)
            .finally(() => { standbyPromise = null; });
        return standbyPromise;
    }

    async function ensure(sessionId) {
        if (!desktop.isEnabled() || !sessionId) return null;
        const current = db.getDesktop.get(sessionId);
        if (current?.desktopSessionId && current.desktopStatus === 'ready') return current.desktopSessionId;
        if (pending.has(sessionId)) return pending.get(sessionId);
        const work = (async () => {
            let created = null;
            try {
                db.setDesktop.run(null, 'creating', null, desktop.repository || null, null,
                    desktop.baseBranch, null, 'preparing', null, sessionId);
                created = standby || await desktop.createDesktop('openkarandash');
                standby = null;
                db.setDesktop.run(created.id, 'preparing', created.url, desktop.repository || null, null,
                    desktop.baseBranch, null, 'preparing', null, sessionId);
                const prepared = await desktop.prepareDesktop(created.id, sessionId);
                db.setDesktop.run(created.id, prepared.status, created.url, desktop.repository || null, prepared.branch,
                    desktop.baseBranch, null, 'clean', null, sessionId);
                void prewarm();
                return created.id;
            } catch (error) {
                if (created) await desktop.destroyDesktop(created.id).catch(() => {});
                db.setDesktop.run(null, 'error', null, desktop.repository || null, null,
                    desktop.baseBranch, null, 'error', String(error.message || error), sessionId);
                throw error;
            } finally {
                pending.delete(sessionId);
            }
        })();
        pending.set(sessionId, work);
        return work;
    }

    async function destroy(sessionId) {
        const state = db.getDesktop.get(sessionId);
        if (state?.desktopSessionId) await desktop.destroyDesktop(state.desktopSessionId);
    }

    async function finalize(sessionId, message) {
        if (!desktop.isEnabled() || !desktop.repository) return;
        const state = db.getDesktop.get(sessionId);
        if (!state?.desktopSessionId || !state.branch) return;
        try {
            const status = await desktop.exec(state.desktopSessionId, ['git', 'status', '--porcelain'], desktop.workspace, { timeoutMs: 30000 });
            if (status.trim()) {
                const versionStatus = await desktop.exec(
                    state.desktopSessionId,
                    ['git', 'status', '--porcelain', '--', 'VERSION.md'],
                    desktop.workspace,
                    { timeoutMs: 30000 },
                );
                if (versionStatus.trim()) {
                    throw new Error('VERSION.md is updated automatically after the pull request is merged; remove it from this session change');
                }
                const nodeEnv = await desktop.ensureNode(state.desktopSessionId);
                await desktop.exec(state.desktopSessionId, ['npm', 'ci'], desktop.workspace, { timeoutMs: 600000, env: nodeEnv });
                await desktop.exec(state.desktopSessionId, ['npm', 'test'], desktop.workspace, { timeoutMs: 300000, env: nodeEnv });
                await desktop.exec(state.desktopSessionId, ['npm', 'run', 'check'], desktop.workspace, { timeoutMs: 300000, env: nodeEnv });
                await desktop.exec(state.desktopSessionId, ['git', 'add', '-A'], desktop.workspace, { timeoutMs: 30000 });
                await desktop.exec(state.desktopSessionId, ['git', 'commit', '-m', message || `OpenKarandash session ${sessionId}`], desktop.workspace, { timeoutMs: 120000 });
            } else if (state.syncStatus === 'pr-open' || state.syncStatus === 'pushed') {
                return;
            }
            const lastCommit = (await desktop.exec(state.desktopSessionId, ['git', 'rev-parse', 'HEAD'], desktop.workspace, { timeoutMs: 30000 })).trim().split(/\s+/)[0] || null;
            if (process.env.DESKTOP_GIT_PUSH === '1') {
                const authEnv = desktop.githubToken ? {
                    GIT_CONFIG_COUNT: '1',
                    GIT_CONFIG_KEY_0: 'http.extraheader',
                    GIT_CONFIG_VALUE_0: `Authorization: Bearer ${desktop.githubToken}`,
                    GIT_TERMINAL_PROMPT: '0',
                } : undefined;
                await desktop.exec(state.desktopSessionId, ['git', 'push', '--set-upstream', 'origin', state.branch], desktop.workspace, {
                    timeoutMs: 120000, env: authEnv,
                });
                const pullRequest = await ensurePullRequest({
                    repository: desktop.repository,
                    branch: state.branch,
                    base: state.baseBranch || desktop.baseBranch,
                    token: desktop.githubToken,
                    title: message,
                    sessionId,
                });
                console.log(`[desktop] session ${sessionId} opened pull request ${pullRequest.url}`);
                db.setDesktop.run(state.desktopSessionId, state.desktopStatus, state.desktopUrl, state.repository,
                    state.branch, state.baseBranch, lastCommit, 'pr-open', null, sessionId);
                return;
            }
            db.setDesktop.run(state.desktopSessionId, state.desktopStatus, state.desktopUrl, state.repository,
                state.branch, state.baseBranch, lastCommit, 'committed', null, sessionId);
        } catch (error) {
            db.setDesktop.run(state.desktopSessionId, state.desktopStatus, state.desktopUrl, state.repository,
                state.branch, state.baseBranch, state.lastCommit || null, 'error', String(error.message || error), sessionId);
            throw error;
        }
    }

    return { ensure, destroy, finalize, prewarm };
}

module.exports = { create, ensurePullRequest, githubSlug };
