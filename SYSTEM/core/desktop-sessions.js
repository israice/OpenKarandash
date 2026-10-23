// Ownership bridge between the SQLite chat session and the desktop manager.
// One promise per chat id prevents duplicate allocation on concurrent sends.
const pending = new Map();

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
            if (!status.trim()) return;
            await desktop.exec(state.desktopSessionId, ['git', 'add', '-A'], desktop.workspace, { timeoutMs: 30000 });
            await desktop.exec(state.desktopSessionId, ['git', 'commit', '-m', message || `Update ${sessionId}`], desktop.workspace, { timeoutMs: 120000 });
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
            }
            db.setDesktop.run(state.desktopSessionId, state.desktopStatus, state.desktopUrl, state.repository,
                state.branch, state.baseBranch, lastCommit, process.env.DESKTOP_GIT_PUSH === '1' ? 'pushed' : 'committed', null, sessionId);
        } catch (error) {
            db.setDesktop.run(state.desktopSessionId, state.desktopStatus, state.desktopUrl, state.repository,
                state.branch, state.baseBranch, state.lastCommit || null, 'error', String(error.message || error), sessionId);
            throw error;
        }
    }

    return { isEnabled: desktop.isEnabled, start, ensure, ensureStandby, desktopIdFor, destroy, finalize };
}

module.exports = { create };
