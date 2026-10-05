// Системные зависимости хоста: git и python — и всё. Сторож зовёт ensureHost()
// первым делом при `node server.js`, чтобы человек, скачавший репозиторий, сразу
// получил рабочий проект, а не список того, что надо доставить руками. Чего нет —
// ставится штатным установщиком платформы (winget на Windows), идёт с
// stdio: 'inherit', чтобы окно UAC и вывод установщика были видны в терминале
// пользователя.
//
// Агентский CLI (pi) сюда не входит: его находит и подключает сам сервер
// через /api/agent/detect и кнопку Connect в Settings — ставить его молча нельзя,
// человек выбирает сам.
//
// Что не ставится и почему: сам Node.js — без него эта команда вообще не
// запустится, так что проверять его некому; Docker и WSL убраны из проекта
// решением владельца (DOCS/decisions/077).
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const IS_WIN = process.platform === 'win32';

const log = (text) => console.log(`[host] ${text}`);
const warn = (text) => console.warn(`[host] ${text}`);

const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { stdio: 'inherit', ...opts });
const out = (cmd, args, opts = {}) => {
    const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 30_000, ...opts });
    return r.status === 0 ? (r.stdout || '').trim() : null;
};
const has = (cmd, args = ['--version']) => out(cmd, args) !== null;

// ---------- PATH ----------
// Только что поставленная программа лежит в PATH системы, но не в PATH этого
// процесса — он унаследовал старый при запуске. Перечитываем PATH из реестра,
// чтобы дальше её находил и этот сторож, и дочерний сервер (он наследует env)
function refreshPath() {
    if (IS_WIN) {
        const ps = out('powershell', ['-NoProfile', '-Command',
            "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')"]);
        if (ps) process.env.PATH = `${ps};${process.env.PATH || ''}`;
        return;
    }
    const extra = [path.join(require('os').homedir(), '.local', 'bin'), '/usr/local/bin'];
    const parts = (process.env.PATH || '').split(path.delimiter);
    for (const dir of extra) if (!parts.includes(dir)) parts.unshift(dir);
    process.env.PATH = parts.join(path.delimiter);
}

// ---------- установщик платформы ----------
function winget(id, label) {
    if (!has('winget')) { warn(`${label} не найден, а winget недоступен — поставьте ${label} вручную`); return false; }
    log(`${label} не найден — ставлю через winget (${id})`);
    const r = run('winget', ['install', '-e', '--id', id, '--silent',
        '--accept-package-agreements', '--accept-source-agreements']);
    refreshPath();
    if (r.status !== 0) { warn(`winget не смог поставить ${label} — поставьте вручную`); return false; }
    return true;
}

function apt(pkgs, label) {
    if (!has('apt-get')) { warn(`${label} не найден, а apt-get нет — поставьте ${label} вручную`); return false; }
    log(`${label} не найден — ставлю через apt (${pkgs.join(' ')}); может спросить пароль sudo`);
    const r = run('sudo', ['apt-get', 'install', '-y', ...pkgs]);
    refreshPath();
    if (r.status !== 0) { warn(`apt не смог поставить ${label} — поставьте вручную`); return false; }
    return true;
}

const install = (winId, linuxPkgs, label) => (IS_WIN ? winget(winId, label) : apt(linuxPkgs, label));

// ---------- 1. git ----------
function ensureGit() {
    if (has('git')) return true;
    return install('Git.Git', ['git'], 'git');
}

// ---------- 2. python ----------
// судим по выводу --version, потому что на Windows «python» может быть
// заглушкой Microsoft Store
function pythonOk() {
    for (const cmd of IS_WIN ? ['python', 'py'] : ['python3', 'python']) {
        const m = (out(cmd, ['--version']) || '').match(/Python (\d+)\.(\d+)/);
        if (m && (Number(m[1]) > 3 || (Number(m[1]) === 3 && Number(m[2]) >= 10))) return true;
    }
    return false;
}
function ensurePython() {
    if (pythonOk()) return true;
    const ok = install('Python.Python.3.12', ['python3'], 'python 3.10+');
    return ok && pythonOk();
}

// ---------- вход ----------
function ensureHost() {
    refreshPath();
    ensureGit();
    ensurePython();
}

module.exports = { ensureHost };