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
    let standbyPending = null;
    let validatedStandbyId = null;

    async function desktopIdFor(sessionId) {
        if (!desktop.isEnabled()) return null;
        if (!sessionId) return null;
        const current = db.getDesktop.get(sessionId);
        if (current?.desktopSessionId && current.desktopStatus === 'ready') return current.desktopSessionId;
        return (await ensureStandby()).id;
    }

    async function ensureStandby() {
        if (!desktop.isEnabled()) return null;
        const current = db.getStandbyDesktop.get();
        if (current) {
            if (validatedStandbyId === current.desktopSessionId) return current;
            try {
                const url = await desktop.urlFor(current.desktopSessionId);
                validatedStandbyId = current.desktopSessionId;
                if (url !== current.desktopUrl) {
                    db.setStandbyDesktop.run(current.id, url);
                    return { ...current, url };
                }
                return current;
            } catch (error) {
                console.warn(`[desktop] removing unavailable standby desktop ${current.id}: ${error.message}`);
                db.clearStandbyDesktop.run();
                validatedStandbyId = null;
                try {
                    await desktop.destroyDesktop(current.id);
                } catch (cleanupError) {
                    console.error(`[desktop] failed to remove unavailable standby desktop ${current.id}: ${cleanupError.message}`);
                }
            }
        }
        if (standbyPending) return standbyPending;
        standbyPending = (async () => {
            let created = null;
            try {
                created = await desktop.createDesktop('openkarandash-standby');
                await desktop.prepareStandby(created.id);
                db.setStandbyDesktop.run(created.id, created.url);
                validatedStandbyId = created.id;
                return created;
            } catch (error) {
                if (created) {
                    try {
                        await desktop.destroyDesktop(created.id);
                    } catch (cleanupError) {
                        console.error(`[desktop] failed to remove standby desktop ${created.id} after preparation error: ${cleanupError.message}`);
                    }
                }
                throw error;
            } finally {
                standbyPending = null;
            }
        })();
        return standbyPending;
    }

    async function takeStandby() {
        while (true) {
            const standby = db.getStandbyDesktop.get();
            if (!standby) {
                await ensureStandby();
                continue;
            }
            if (db.claimStandbyDesktop.run(standby.id).changes) {
                validatedStandbyId = null;
                return standby;
            }
        }
    }

    async function ensure(sessionId) {
        if (!desktop.isEnabled() || !sessionId) return null;
        const current = db.getDesktop.get(sessionId);
        if (current?.desktopSessionId && current.desktopStatus === 'ready') return current.desktopSessionId;
        if (pending.has(sessionId)) return pending.get(sessionId);
        const work = (async () => {
            let created = null;
            try {
                if (current?.desktopSessionId) await desktop.destroyDesktop(current.desktopSessionId);
                db.setDesktop.run(null, 'creating', null, desktop.repository || null, null,
                    desktop.baseBranch, null, 'preparing', null, sessionId);
                created = await takeStandby();
                void ensureStandby().catch((error) => {
                    console.error(`[desktop] failed to replenish the standby desktop: ${error.message}`);
                });
                db.setDesktop.run(created.id, 'preparing', created.url, desktop.repository || null, null,
                    desktop.baseBranch, null, 'preparing', null, sessionId);
                const prepared = await desktop.prepareDesktop(created.id, sessionId);
                db.setDesktop.run(created.id, prepared.status, created.url, desktop.repository || null, prepared.branch,
                    desktop.baseBranch, null, 'clean', null, sessionId);
                return created.id;
            } catch (error) {
                if (created) {
                    try {
                        await desktop.destroyDesktop(created.id);
                    } catch (cleanupError) {
                        console.error(`[desktop] failed to remove desktop ${created.id} after preparation error: ${cleanupError.message}`);
                    }
                }
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

    function start() {
        return ensureStandby();
    }

    async function destroy(sessionId) {
        const active = pending.get(sessionId);
        if (active) {
            try {
                await active;
            } catch (error) {
                console.warn(`[desktop] session ${sessionId} preparation ended before deletion: ${error.message}`);
            }
        }
        const state = db.getDesktop.get(sessionId);
        if (!state?.desktopSessionId) return;
        await desktop.destroyDesktop(state.desktopSessionId);
        db.setDesktop.run(null, 'deleted', null, state.repository || null, null,
            state.baseBranch || desktop.baseBranch, null, 'deleted', null, sessionId);
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
                    GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${desktop.githubToken}`).toString('base64')}`,
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

    return { isEnabled: desktop.isEnabled, start, ensure, ensureStandby, desktopIdFor, destroy, finalize };
}

module.exports = { create, ensurePullRequest, githubSlug };
