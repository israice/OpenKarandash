// Системные зависимости хоста: git, python, Docker и сам claude CLI со входом
// в аккаунт. Сторож зовёт ensureHost() первым делом при `node server.js`,
// чтобы человек, скачавший репозиторий, сразу получил рабочий проект, а не
// список того, что надо доставить руками. Чего нет — ставится в систему
// штатным установщиком платформы (winget на Windows, apt в WSL/Linux,
// официальный установщик claude), чего не хватает для входа — спрашивается
// прямо в этом же терминале (`claude auth login`). DOCS/decisions/029.
//
// Что не ставится и почему: сам Node.js — без него эта команда вообще не
// запустится, так что проверять его некому; остальные CLI из Settings (codex,
// opencode, pi) — они не обязательны для работы, их подключают по желанию.
//
// Всё, что ставит установщик, идёт с stdio: 'inherit' — пароль sudo, окно
// UAC у winget и ссылка для входа в claude показываются в терминале
// пользователя, а не глотаются.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const IS_WIN = process.platform === 'win32';
const IS_WSL = !IS_WIN && /microsoft/i.test(os.release());
const DOCKER_DESKTOP_WIN = 'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe';
const DOCKER_DESKTOP_WSL = '/mnt/c/Program Files/Docker/Docker/Docker Desktop.exe';

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
// процесса — он унаследовал старый при запуске. Перечитываем PATH из реестра
// (Windows) или добавляем известные папки установщиков (Linux), чтобы дальше
// её находил и этот сторож, и дочерний сервер (он наследует наш env)
function refreshPath() {
    if (IS_WIN) {
        const ps = out('powershell', ['-NoProfile', '-Command',
            "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')"]);
        if (ps) process.env.PATH = `${ps};${process.env.PATH || ''}`;
        return;
    }
    const extra = [path.join(os.homedir(), '.local', 'bin'), '/usr/local/bin'];
    const parts = (process.env.PATH || '').split(path.delimiter);
    for (const dir of extra) if (!parts.includes(dir)) parts.unshift(dir);
    process.env.PATH = parts.join(path.delimiter);
}

// ---------- установщики платформы ----------
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

// ---------- 1. git ----------
function ensureGit() {
    if (has('git')) return true;
    return IS_WIN ? winget('Git.Git', 'git') : apt(['git'], 'git');
}

// ---------- 2. python ----------
// та же проверка, что у hermes-stack: судим по выводу --version, потому что на
// Windows «python» может быть заглушкой Microsoft Store
function pythonOk() {
    for (const cmd of IS_WIN ? ['python', 'py'] : ['python3', 'python']) {
        const m = (out(cmd, ['--version']) || '').match(/Python (\d+)\.(\d+)/);
        if (m && (Number(m[1]) > 3 || (Number(m[1]) === 3 && Number(m[2]) >= 10))) return true;
    }
    return false;
}
function ensurePython() {
    if (pythonOk()) return true;
    const ok = IS_WIN ? winget('Python.Python.3.12', 'python 3.10+') : apt(['python3'], 'python 3.10+');
    return ok && pythonOk();
}

// ---------- 3. docker ----------
const dockerUp = () => has('docker', ['info']);

// синхронное ожидание: prepare у сторожа целиком синхронный, сервер должен
// стартовать уже с готовым окружением
function waitFor(check, ms, label) {
    const until = Date.now() + ms;
    let shown = false;
    while (Date.now() < until) {
        if (check()) return true;
        if (!shown) { log(`${label} (до ${Math.round(ms / 1000)} с)...`); shown = true; }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);
    }
    return false;
}

function startDockerDesktop(fromWsl) {
    log('Docker Desktop установлен, но не запущен — запускаю');
    // cmd /c start: Docker Desktop — GUI-приложение, ждать его завершения нельзя
    if (fromWsl) spawnSync('/mnt/c/Windows/System32/cmd.exe', ['/c', 'start', '', DOCKER_DESKTOP_WIN], { stdio: 'ignore' });
    else spawnSync('cmd.exe', ['/c', 'start', '', DOCKER_DESKTOP_WIN], { stdio: 'ignore', windowsHide: true });
    return waitFor(dockerUp, 150_000, 'жду Docker Desktop');
}

function ensureDocker() {
    if (dockerUp()) return true;
    if (IS_WIN) {
        if (!fs.existsSync(DOCKER_DESKTOP_WIN) && !has('docker')) {
            // ставится с окном UAC; после установки может понадобиться выход
            // из системы — тогда честно говорим об этом и не ждём чуда сейчас
            if (!winget('Docker.DockerDesktop', 'Docker Desktop')) return false;
            if (!fs.existsSync(DOCKER_DESKTOP_WIN)) { warn('Docker Desktop поставлен, но не найден по стандартному пути — запустите его вручную (возможно, нужен перезаход в Windows)'); return false; }
        }
        if (fs.existsSync(DOCKER_DESKTOP_WIN)) return startDockerDesktop(false);
        warn('docker есть, а демон не отвечает — запустите Docker вручную');
        return false;
    }
    // WSL с Docker Desktop на Windows: демон живёт там, здесь только клиент по
    // WSL-интеграции. Нет клиента при живом Desktop — не включена интеграция
    if (IS_WSL && fs.existsSync(DOCKER_DESKTOP_WSL)) {
        if (!has('docker')) { warn('Docker Desktop есть на Windows, но в этом WSL нет клиента — включите WSL integration в Docker Desktop → Settings → Resources'); return false; }
        return startDockerDesktop(true);
    }
    // чистый Linux (или WSL без Desktop): движок из apt
    if (!has('docker')) {
        if (!apt(['docker.io', 'docker-compose-v2'], 'Docker')) return false;
        run('sudo', ['usermod', '-aG', 'docker', os.userInfo().username]);
        warn('вы добавлены в группу docker — чтобы docker работал без sudo, перезайдите в терминал');
    }
    log('запускаю демон docker (sudo service docker start)');
    run('sudo', ['service', 'docker', 'start']);
    return waitFor(dockerUp, 30_000, 'жду демон docker');
}

// ---------- 4. claude CLI и вход ----------
// Цели те же, что в TARGETS сервера: 'windows' и 'wsl'. С Windows-хоста в WSL
// ходим через wsl.exe, из WSL на Windows — через powershell.exe (interop).
// Установщик и вход запускаются в оболочке цели, чтобы PATH и профиль были её
function targetShell(id) {
    if (IS_WIN && id === 'windows') return (cmd, opts) => spawnSync('powershell', ['-NoProfile', '-Command', cmd], opts);
    if (IS_WIN && id === 'wsl') return has('wsl.exe', ['--status']) ? (cmd, opts) => spawnSync('wsl.exe', ['-e', 'bash', '-lc', cmd], opts) : null;
    if (!IS_WIN && id === 'wsl') return (cmd, opts) => spawnSync('bash', ['-lc', cmd], opts);
    if (IS_WSL && id === 'windows') {
        const ps = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
        return fs.existsSync(ps) ? (cmd, opts) => spawnSync(ps, ['-NoProfile', '-Command', cmd], opts) : null;
    }
    return null;
}

function claudeVersion(shell) {
    const r = shell('claude --version', { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'ignore'] });
    const m = r.status === 0 ? (r.stdout || '').match(/\d+\.\d+\.\d+/) : null;
    return m ? m[0] : null;
}

// true/false по `claude auth status` (JSON с loggedIn); null — CLI старый и
// такой команды не знает, тогда вход не навязываем
function claudeLoggedIn(shell) {
    const r = shell('claude auth status', { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'ignore'] });
    if (r.status !== 0) return null;
    try { return Boolean(JSON.parse(r.stdout).loggedIn); } catch { return /logged\s*in:?\s*true/i.test(r.stdout || ''); }
}

function installClaude(id, shell) {
    log(`claude CLI (${id}) не найден — ставлю официальным установщиком`);
    const cmd = id === 'windows'
        ? 'irm https://claude.ai/install.ps1 | iex'
        : 'curl -fsSL https://claude.ai/install.sh | bash';
    const r = shell(cmd, { stdio: 'inherit', timeout: 600_000 });
    refreshPath();
    if (r.status !== 0) { warn(`установщик claude (${id}) завершился с ошибкой`); return false; }
    return true;
}

// Порядок целей: та, что выбрана в Settings (мост хранит её как
// CLAUDE_BRIDGE_TARGET), затем родная для хоста, затем вторая. Берём первую
// установленную; нет ни одной — ставим на предпочтительную. Возвращаем id
// цели, которую сервер подключит сам, без кнопки Connect в Settings
function ensureClaude(preferred) {
    const order = [...new Set([preferred, IS_WIN ? 'windows' : 'wsl', 'wsl', 'windows'].filter(Boolean))];
    const shells = order.map((id) => [id, targetShell(id)]).filter(([, s]) => s);
    let picked = shells.find(([, s]) => claudeVersion(s));
    if (!picked) {
        const [id, shell] = shells[0];
        if (!installClaude(id, shell) || !claudeVersion(shell)) { warn('claude CLI не установлен — Claude в проекте работать не будет'); return null; }
        picked = [id, shell];
    }
    const [id, shell] = picked;
    log(`claude CLI: ${id}, версия ${claudeVersion(shell)}`);
    if (claudeLoggedIn(shell) === false) {
        log(`claude (${id}) не залогинен — запускаю вход, следуйте подсказкам в терминале`);
        shell('claude auth login', { stdio: 'inherit', timeout: 600_000 });
        if (claudeLoggedIn(shell) === false) warn('вход в claude не выполнен — сессии Claude не заработают, пока не выполнить `claude auth login`');
    }
    return id;
}

// ---------- вход ----------
// withStack=false (HERMES_STACK=0): нужен только claude; python и docker — нет
function ensureHost({ preferredClaude, withStack }) {
    refreshPath();
    ensureGit();
    if (withStack) {
        ensurePython();
        if (!ensureDocker()) warn('Docker не поднялся — сервер стартует без Hermes, запросы к Claude пойдут напрямую в CLI');
    }
    return { claudeTarget: ensureClaude(preferredClaude) };
}

module.exports = { ensureHost };
