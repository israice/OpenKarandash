const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');

const execFileAsync = promisify(execFile);
const ROOT = path.join(__dirname, '..', '..');
const DEPENDENCY_FILES = new Set(['package.json', 'package-lock.json']);

function isDependencyChange(files) {
    return files.some((file) => DEPENDENCY_FILES.has(file));
}

function create({ root = ROOT, runs, notify, pollMs = Number(process.env.GITHUB_UPDATE_POLL_MS) || 60000 }) {
    let timer = null;
    let checking = false;
    let announcedHead = '';
    let blockedNotice = '';

    async function git(...args) {
        const { stdout } = await execFileAsync('git', args, {
            cwd: root,
            encoding: 'utf8',
            timeout: 30000,
            windowsHide: true,
        });
        return stdout.trim();
    }

    async function isAncestor(ancestor, descendant) {
        try {
            await git('merge-base', '--is-ancestor', ancestor, descendant);
            return true;
        } catch (error) {
            if (error.code === 1) return false;
            throw error;
        }
    }

    function block(head, reason) {
        const key = `${head}:${reason}`;
        if (blockedNotice !== key) notify(`update:blocked:${reason}`);
        blockedNotice = key;
    }

    async function check() {
        if (checking) return;
        checking = true;
        let release = null;

        try {
            await git('fetch', 'origin', '+refs/heads/main:refs/remotes/origin/main');
            const branch = await git('branch', '--show-current');
            const localHead = await git('rev-parse', 'HEAD');
            const remoteHead = await git('rev-parse', 'refs/remotes/origin/main');
            if (localHead === remoteHead) {
                announcedHead = '';
                blockedNotice = '';
                return;
            }

            if (announcedHead !== remoteHead) {
                notify('update:available');
                announcedHead = remoteHead;
            }

            if (branch !== 'main') {
                block(remoteHead, 'branch');
                return;
            }

            const changes = (await git('diff', '--name-only', `${localHead}..${remoteHead}`))
                .split(/\r?\n/).filter(Boolean);
            if (!changes.includes('VERSION.md')) {
                block(remoteHead, 'waiting-version');
                return;
            }
            if (isDependencyChange(changes)) {
                block(remoteHead, 'dependencies');
                return;
            }

            const status = await git('status', '--porcelain');
            if (status) {
                block(remoteHead, 'local-changes');
                return;
            }

            if (!await isAncestor('HEAD', 'refs/remotes/origin/main')) {
                block(remoteHead, 'diverged');
                return;
            }
            if (runs.isStopping()) return;

            release = await runs.pauseForMaintenance();
            if (runs.isRestartRequested()) return;
            await git('fetch', 'origin', '+refs/heads/main:refs/remotes/origin/main');
            const currentHead = await git('rev-parse', 'HEAD');
            const currentBranch = await git('branch', '--show-current');
            const currentStatus = await git('status', '--porcelain');
            const currentRemoteHead = await git('rev-parse', 'refs/remotes/origin/main');
            if (currentRemoteHead !== remoteHead) {
                block(currentRemoteHead, 'changed-during-drain');
                return;
            }
            if (currentHead !== localHead || currentBranch !== 'main' || currentStatus) {
                block(remoteHead, 'local-changes');
                return;
            }

            await git('merge', '--ff-only', 'refs/remotes/origin/main');
            notify('update:installed');
            announcedHead = '';
            blockedNotice = '';
        } catch (error) {
            console.error(`[github-update] update check failed: ${error.message}`);
            block(announcedHead || 'unknown', 'failed');
        } finally {
            if (release) release();
            checking = false;
        }
    }

    function start() {
        const enabled = process.env.GITHUB_AUTO_UPDATE === '1'
            || (process.env.GITHUB_AUTO_UPDATE !== '0' && process.env.ALLOW_CONTAINER === '1');
        if (timer || !enabled) return false;
        if (!Number.isSafeInteger(pollMs) || pollMs < 10000) {
            throw new Error('GITHUB_UPDATE_POLL_MS must be at least 10000');
        }
        void check();
        timer = setInterval(() => { void check(); }, pollMs);
        timer.unref();
        return true;
    }

    function stop() {
        if (!timer) return;
        clearInterval(timer);
        timer = null;
    }

    return { start, stop, check };
}

module.exports = { create, isDependencyChange };
