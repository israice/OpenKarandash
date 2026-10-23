// Narrow HTTP client for docker_for_desktops. OpenKarandash never talks to the
// Docker socket: the desktop manager owns container lifecycle and exposes only
// an authenticated, session-scoped exec API.
const enabled = process.env.DESKTOP_ENABLED === '1';
const baseUrl = (process.env.DESKTOP_MANAGER_URL || 'http://127.0.0.1:8080').replace(/\/+$/, '');
const token = process.env.DESKTOP_MANAGER_TOKEN || '';
const repository = String(process.env.DESKTOP_REPOSITORY_URL || '').trim();
const baseBranch = String(process.env.DESKTOP_BASE_BRANCH || 'main').trim() || 'main';
const workspace = String(process.env.DESKTOP_WORKSPACE || '/home/desktop/workspace').trim();
const opencodeBin = String(process.env.DESKTOP_OPENCODE_BIN || 'opencode').trim() || 'opencode';
const gitName = process.env.DESKTOP_GIT_NAME || 'OpenKarandash worker';
const gitEmail = process.env.DESKTOP_GIT_EMAIL || 'openkarandash-worker@localhost';
const githubToken = String(process.env.DESKTOP_GITHUB_TOKEN || '').trim();

const headers = () => ({
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
});

async function jsonRequest(path, options = {}, { notFoundIsSuccess = false } = {}) {
    const response = await fetch(`${baseUrl}${path}`, { ...options, headers: { ...headers(), ...(options.headers || {}) } });
    if (notFoundIsSuccess && response.status === 404) return {};
    const text = await response.text();
    let body;
    try { body = text ? JSON.parse(text) : {}; } catch { body = { detail: text }; }
    if (!response.ok) throw new Error(body.detail?.message || body.detail || `desktop manager returned ${response.status}`);
    return body;
}

async function execRaw(sessionId, command, workdir, { timeoutMs, onLine, onSpawn, env } = {}) {
    const controller = new AbortController();
    const timer = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : null;
    let execId = null;
    let stopped = false;
    let output = '';
    const child = {
        __stoppedByUser: false,
        kill() {
            this.__stoppedByUser = true;
            stopped = true;
            if (execId) fetch(`${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/exec/${encodeURIComponent(execId)}`, {
                method: 'DELETE', headers: headers(),
            }).catch(() => {});
            controller.abort();
        },
    };
    onSpawn?.(child);
    let response;
    try {
        response = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/exec`, {
            method: 'POST', headers: headers(), signal: controller.signal,
            body: JSON.stringify({ command, workdir, ...(env ? { env } : {}) }),
        });
        execId = response.headers.get('x-exec-id');
        if (!response.ok) throw new Error((await response.text()) || `desktop exec returned ${response.status}`);
        const reader = response.body?.getReader();
        if (!reader) throw new Error('desktop exec returned no stream');
        const decoder = new TextDecoder();
        let tail = '';
        let exitCode = 0;
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            tail += decoder.decode(value, { stream: true });
            const lines = tail.split('\n');
            tail = lines.pop() || '';
            for (const line of lines) {
                if (!line.trim()) continue;
                const event = JSON.parse(line);
                if (event.type === 'data') {
                    const text = Buffer.from(event.data, 'base64').toString('utf8');
                    for (const part of text.split(/\r?\n/)) if (part.trim()) {
                        output += `${part}\n`;
                        onLine?.(part);
                    }
                } else if (event.type === 'done') exitCode = event.code ?? 0;
                else if (event.type === 'error') throw new Error(event.error);
            }
        }
        if (tail.trim()) {
            const event = JSON.parse(tail);
            if (event.type === 'done') exitCode = event.code ?? 0;
        }
        if (exitCode !== 0) throw new Error(stopped || child.__stoppedByUser ? 'Stopped by the user' : `command exited with code ${exitCode}`);
        return output;
    } catch (error) {
        if (stopped || child.__stoppedByUser) throw new Error('Stopped by the user');
        if (error.name === 'AbortError') throw new Error(`Timed out (${Math.round((timeoutMs || 0) / 1000)}s)`);
        throw error;
    } finally {
        if (timer) clearTimeout(timer);
    }
}

const openCodeBins = new Map();

async function resolveOpenCodeBin(sessionId) {
    if (openCodeBins.has(sessionId)) return openCodeBins.get(sessionId);
    // A persistent home can contain a newer CLI and its database; prefer them together
    // instead of opening that database with the older image-level binary.
    const candidates = opencodeBin === 'opencode'
        ? ['/home/desktop/.opencode/bin/opencode', 'opencode', '/usr/local/bin/opencode']
        : [opencodeBin];
    for (const candidate of candidates) {
        try {
            await execRaw(sessionId, [candidate, '--version'], '/home/desktop', { timeoutMs: 15000 });
            openCodeBins.set(sessionId, candidate);
            return candidate;
        } catch {
            // Try the next supported installation location.
        }
    }
    throw new Error(`OpenCode was not found in desktop ${sessionId}`);
}

async function exec(sessionId, command, workdir, options = {}) {
    const actualCommand = [...command];
    if (actualCommand[0] === 'opencode' || actualCommand[0] === opencodeBin) {
        actualCommand[0] = await resolveOpenCodeBin(sessionId);
    }
    return execRaw(sessionId, actualCommand, workdir, options);
}

async function ensureGit(sessionId) {
    if (!repository) return;
    try {
        await exec(sessionId, ['git', '--version'], '/home/desktop', { timeoutMs: 15000 });
    } catch (error) {
        if (!String(error.message).includes('code 127')) throw error;
        await exec(sessionId, ['sudo', 'apt-get', 'update'], '/home/desktop', { timeoutMs: 180000 });
        await exec(sessionId, ['sudo', 'apt-get', 'install', '-y', 'git'], '/home/desktop', { timeoutMs: 180000 });
    }
}

async function ensureNode(sessionId) {
    const nodeVersion = (await exec(sessionId, ['node', '--version'], '/home/desktop', { timeoutMs: 15000 })).trim();
    if (!/^v22\.\d+\.\d+$/.test(nodeVersion)) {
        throw new Error(`Desktop image requires Node.js 22; found ${nodeVersion || 'no version'}`);
    }
    const npmVersion = (await exec(sessionId, ['npm', '--version'], '/home/desktop', { timeoutMs: 15000 })).trim();
    if (!/^\d+\.\d+\.\d+$/.test(npmVersion)) {
        throw new Error(`Desktop image requires npm; found ${npmVersion || 'no version'}`);
    }
    return {};
}

async function createDesktop(owner) {
    const created = await jsonRequest('/api/sessions', {
        method: 'POST', body: JSON.stringify({ inherit: true, wait: 120 }),
    });
    return { id: created.id, url: created.url, owner };
}

async function prepareStandby(desktopId) {
    await resolveOpenCodeBin(desktopId);
    if (!repository) {
        await exec(desktopId, ['mkdir', '-p', workspace], '/home/desktop', { timeoutMs: 30000 });
        return;
    }
    await ensureGit(desktopId);
    const authEnv = githubToken ? {
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'http.extraheader',
        GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${githubToken}`).toString('base64')}`,
        GIT_TERMINAL_PROMPT: '0',
    } : undefined;
    await exec(desktopId, ['git', 'clone', '--depth', '1', '--branch', baseBranch, repository, workspace], '/home/desktop', {
        timeoutMs: 300000, env: authEnv,
    });
}

async function prepareDesktop(desktopId, sessionId) {
    if (!repository) return { branch: `worker/${sessionId}`, status: 'ready' };
    const branch = `worker/${String(sessionId).replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 80)}`;
    await exec(desktopId, ['git', 'checkout', '-b', branch], workspace, { timeoutMs: 30000 });
    await exec(desktopId, ['git', 'config', 'user.name', gitName], workspace, { timeoutMs: 30000 });
    await exec(desktopId, ['git', 'config', 'user.email', gitEmail], workspace, { timeoutMs: 30000 });
    return { branch, status: 'ready' };
}

async function destroyDesktop(id) {
    if (!id) return;
    await jsonRequest(`/api/sessions/${encodeURIComponent(id)}?delete_data=true`, { method: 'DELETE' }, {
        notFoundIsSuccess: true,
    });
    openCodeBins.delete(id);
}

async function urlFor(id) {
    return (await jsonRequest(`/api/sessions/${encodeURIComponent(id)}/url`)).url;
}

function isEnabled() { return enabled; }

module.exports = {
    isEnabled, createDesktop, prepareStandby, prepareDesktop, destroyDesktop, urlFor, exec,
    repository, baseBranch, workspace, githubToken, opencodeBin, resolveOpenCodeBin,
    repository, baseBranch, workspace, githubToken, ensureNode,
};
