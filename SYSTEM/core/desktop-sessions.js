// Ownership bridge between the SQLite chat session and the desktop manager.
// One promise per chat id prevents duplicate allocation on concurrent sends.
const pending = new Map();
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
            if (!status.trim()) return;
            await desktop.exec(state.desktopSessionId, ['git', 'add', '-A'], desktop.workspace, { timeoutMs: 30000 });
            await desktop.exec(state.desktopSessionId, ['git', 'commit', '-m', message || `Update ${sessionId}`], desktop.workspace, { timeoutMs: 120000 });
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
            }
            db.setDesktop.run(state.desktopSessionId, state.desktopStatus, state.desktopUrl, state.repository,
                state.branch, state.baseBranch, lastCommit, process.env.DESKTOP_GIT_PUSH === '1' ? 'pushed' : 'committed', null, sessionId);
        } catch (error) {
            db.setDesktop.run(state.desktopSessionId, state.desktopStatus, state.desktopUrl, state.repository,
                state.branch, state.baseBranch, state.lastCommit || null, 'error', String(error.message || error), sessionId);
            throw error;
        }
    }

    return { ensure, destroy, finalize, prewarm };
}

module.exports = { create };
