// Hermes-стек под сторожем сервера: мост к Claude (python, хост) и агент Hermes
// (docker compose, только сервис gateway). Сторож зовёт prepare() до первого
// запуска дочернего сервера и stop() по Ctrl+C — так `node server.js` остаётся
// единственной командой и на PowerShell, и в WSL, а после Ctrl+C ничего живого
// не остаётся. DOCS/decisions/029.
//
// Что здесь проверяется и чинится до старта:
//   - npm-зависимости: нет node_modules или манифест новее прошлой установки;
//   - hermes/: нет — клонируем с GitHub (HERMES_REPO/HERMES_REF из .env), есть —
//     подтягиваем свежий апстрим; в git папка не хранится (.gitignore);
//   - образ hermes-agent: нет или собран с другого коммита — пересобираем;
//   - .env: недостающие ключи стека дописываются с генерированными секретами.
// Чего нет на хосте (docker, python) — не ставится: об этом пишется в консоль,
// а сервер поднимается без Hermes — остальные CLI ходят с хоста напрямую.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const IS_WIN = process.platform === 'win32';
const HERMES_API = 'http://127.0.0.1:8642/v1';
const COMPOSE_ARGS = ['compose', '--env-file', '.env', '--project-directory', '.',
    '-f', 'hermes/docker-compose.yml', '-f', 'docker-compose.hermes.yml'];

let root = null;
let bridge = null;       // дочерний процесс моста
let bridgePortNum = '8788';
let bridgeTarget = null; // какой claude гоняет мост: 'wsl' | 'windows' — тот, что выбран в Settings
let composeUp = false;   // мы подняли контейнер — нам и гасить

const log = (text) => console.log(`[hermes] ${text}`);
const warn = (text) => console.warn(`[hermes] ${text}`);

// ---------- мелочи ----------
// Без shell: docker/git/python на Windows — настоящие .exe, Node находит их по
// PATH сам. shell: true с массивом аргументов склеивает их без экранирования
// (Node ругается DEP0190), и проверка python с `-c "..."` на этом и ломалась.
// Единственное исключение — npm: это .cmd-обёртка, без shell Node отвечает
// EINVAL, поэтому её зовём одной строкой через shell
const sync = (cmd, args, opts = {}) => {
    if (IS_WIN && cmd === 'npm') return spawnSync(`npm ${args.join(' ')}`, { cwd: root, shell: true, ...opts });
    return spawnSync(cmd, args, { cwd: root, ...opts });
};
const has = (cmd, args = ['--version']) => sync(cmd, args, { stdio: 'ignore' }).status === 0;
const run = (cmd, args, opts = {}) => sync(cmd, args, { stdio: 'inherit', ...opts });
const out = (cmd, args, opts = {}) => {
    const r = sync(cmd, args, { encoding: 'utf8', ...opts });
    return r.status === 0 ? r.stdout.trim() : null;
};
const readEnvFile = (file) => {
    const map = {};
    if (!fs.existsSync(file)) return map;
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
        if (m) map[m[1]] = m[2].trim().replace(/^(['"])([\s\S]*)\1$/, '$2');
    }
    return map;
};
const secret = () => crypto.randomBytes(24).toString('hex');

// ---------- 1. npm ----------
function ensureNodeModules() {
    const stamp = path.join(root, 'node_modules', '.package-lock.json');
    const newer = (file) => {
        try { return fs.statSync(path.join(root, file)).mtimeMs > fs.statSync(stamp).mtimeMs; } catch { return true; }
    };
    if (!fs.existsSync(stamp) || newer('package.json') || newer('package-lock.json')) {
        log('npm-зависимости отсутствуют или устарели — npm install');
        if (run('npm', ['install']).status !== 0) warn('npm install завершился с ошибкой');
    }
}

// ---------- 2. hermes/ ----------
// Код Hermes в нашем git не лежит: это чужой проект, его берём с публичного
// GitHub. Нет папки — клонируем (одна ветка, без истории); есть — подтягиваем
// апстрим быстрой перемоткой. Если пользователь что-то правил внутри hermes/ и
// перемотка невозможна — оставляем как есть и говорим об этом, ничего не
// затираем. Без сети — тоже не беда: работаем с тем, что есть. Ветка/тег —
// HERMES_REF в .env (по умолчанию main), репозиторий — HERMES_REPO
const HERMES_REPO_DEFAULT = 'https://github.com/NousResearch/hermes-agent.git';
function ensureHermesSource(env) {
    const dir = path.join(root, 'hermes');
    const repo = env.HERMES_REPO || HERMES_REPO_DEFAULT;
    const ref = env.HERMES_REF || 'main';
    if (!has('git')) return warn('git не найден — hermes/ не проверяю');
    if (!fs.existsSync(path.join(dir, 'Dockerfile'))) {
        log(`hermes/ нет — клонирую ${repo} (${ref})`);
        fs.rmSync(dir, { recursive: true, force: true }); // пустой/битый остаток
        const r = run('git', ['clone', '--depth', '1', '--branch', ref, repo, dir]);
        if (r.status !== 0) warn('клонирование Hermes не удалось — без него Hermes не поднять');
        return;
    }
    const git = (args, opts = {}) => sync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 60_000, ...opts });
    const before = (git(['rev-parse', 'HEAD']).stdout || '').trim();
    if (git(['fetch', '--quiet', '--depth', '1', 'origin', ref], { stdio: 'ignore' }).status !== 0) {
        return warn('не удалось спросить GitHub про обновления Hermes (нет сети?) — работаю с тем, что есть');
    }
    const latest = (git(['rev-parse', 'FETCH_HEAD']).stdout || '').trim();
    if (!latest || latest === before) return;
    // клон неглубокий (--depth 1), и у свежего коммита нет истории до текущего —
    // merge --ff-only на таком отвечает «уже актуально» и ничего не двигает.
    // Поэтому переставляем дерево на FETCH_HEAD напрямую, но только чистое:
    // свои правки внутри hermes/ никто не просил затирать
    const dirty = (git(['status', '--porcelain']).stdout || '').trim();
    if (dirty) return warn(`Hermes на GitHub ушёл вперёд (${before.slice(0, 8)} → ${latest.slice(0, 8)}), но в hermes/ есть свои правки — не трогаю`);
    const r = git(['reset', '--hard', '--quiet', 'FETCH_HEAD'], { stdio: 'ignore' });
    if (r.status !== 0) return warn('не удалось перевести hermes/ на свежий коммит');
    log(`Hermes обновлён с GitHub: ${before.slice(0, 8)} → ${latest.slice(0, 8)}`);
}

// ---------- 3. .env ----------
// уже заданные строки не трогаем; секреты генерируем, чтобы руками ничего не вписывать
function ensureEnv() {
    const rootEnv = path.join(root, '.env');
    const bridgeEnvFile = path.join(root, 'claude-bridge', '.env');
    if (!fs.existsSync(bridgeEnvFile)) {
        fs.copyFileSync(path.join(root, 'claude-bridge', '.env.example'), bridgeEnvFile);
        log('claude-bridge/.env создан из .env.example');
    }
    const env = readEnvFile(rootEnv);
    const bridgeEnv = readEnvFile(bridgeEnvFile);
    const token = env.CLAUDE_BRIDGE_TOKEN || bridgeEnv.CLAUDE_BRIDGE_TOKEN || secret();
    const apiKey = env.API_SERVER_KEY || env.HERMES_API_KEY || secret();
    const bridgePort = bridgeEnv.CLAUDE_BRIDGE_PORT || '8788';
    const uid = IS_WIN ? 1000 : os.userInfo().uid;
    const gid = IS_WIN ? 1000 : os.userInfo().gid;
    const wanted = [
        ['CLAUDE_BRIDGE_TOKEN', token, 'Hermes-стек (DOCS/decisions/029): общий секрет claude-bridge и Hermes'],
        ['CLAUDE_BRIDGE_URL', `http://host.docker.internal:${bridgePort}/v1`, 'как контейнер Hermes видит бридж на хосте'],
        ['API_SERVER_KEY', apiKey, 'ключ agent API самого Hermes (:8642); им же ходит сервер'],
        ['API_SERVER_HOST', '0.0.0.0'],
        ['API_SERVER_PORT', '8642'],
        ['HERMES_API_URL', HERMES_API, 'адрес agent API Hermes для коннектора hermes'],
        ['HERMES_API_KEY', apiKey],
        ['HERMES_UID', String(uid), 'владелец файлов hermes-home/ внутри контейнера'],
        ['HERMES_GID', String(gid)],
    ];
    let add = '';
    for (const [key, value, comment] of wanted) {
        if (env[key] !== undefined) continue;
        if (comment) add += `# ${comment}\n`;
        add += `${key}=${value}\n`;
        process.env[key] = process.env[key] ?? value; // текущий процесс тоже должен их видеть
        log(`.env: добавлен ${key}`);
    }
    if (add) fs.appendFileSync(rootEnv, (fs.readFileSync(rootEnv, 'utf8').endsWith('\n') ? '' : '\n') + add);

    // мосту — тот же токен и ключ, если у него пусто
    let text = fs.readFileSync(bridgeEnvFile, 'utf8');
    const fill = (key, value) => {
        if (!bridgeEnv[key]) text = text.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${value}`);
    };
    fill('CLAUDE_BRIDGE_TOKEN', token);
    fill('HERMES_API_KEY', apiKey);
    fs.writeFileSync(bridgeEnvFile, text);
    return { token, apiKey, bridgePort };
}

// ---------- 4. образ ----------
function ensureImage() {
    const rev = out('git', ['rev-parse', 'HEAD'], { cwd: path.join(root, 'hermes') }) || '';
    const stampFile = path.join(root, 'hermes-home', '.image-built-from');
    fs.mkdirSync(path.join(root, 'hermes-home'), { recursive: true });
    const built = fs.existsSync(stampFile) ? fs.readFileSync(stampFile, 'utf8').trim() : '';
    const exists = has('docker', ['image', 'inspect', 'hermes-agent']);
    if (exists && !built) { fs.writeFileSync(stampFile, rev); return; } // собран до появления этой проверки
    if (exists && built === rev) return;
    log(exists ? `Hermes обновился (${built.slice(0, 8)} → ${rev.slice(0, 8)}) — пересобираю образ` : 'образа hermes-agent нет — собираю (первый раз долго)');
    if (run('docker', [...COMPOSE_ARGS, 'build', 'gateway']).status === 0) fs.writeFileSync(stampFile, rev);
    else warn('сборка образа не удалась');
}

// ---------- 5. мост ----------
function pythonCmd() {
    // на Windows «python» может оказаться заглушкой Microsoft Store — она
    // отвечает не версией, а приглашением установить; поэтому судим по выводу
    for (const cmd of IS_WIN ? ['python', 'py'] : ['python3', 'python']) {
        const version = out(cmd, ['--version']) || '';
        const m = version.match(/Python (\d+)\.(\d+)/);
        if (m && (Number(m[1]) > 3 || (Number(m[1]) === 3 && Number(m[2]) >= 10))) return cmd;
    }
    return null;
}
// Мост гоняет тот же claude, что выбран в Settings (WSL или Windows), а не
// «свой для платформы»: стартовое значение — CLAUDE_BRIDGE_TARGET из
// claude-bridge/.env, а при подключении Claude в интерфейсе сервер сообщает
// сторожу выбранную цель (setClaudeTarget), мост перезапускается под неё, и
// выбор записывается обратно в claude-bridge/.env, чтобы пережить перезапуск
const bridgeAlive = () => fetch(`http://127.0.0.1:${bridgePortNum}/health`, { signal: AbortSignal.timeout(1500) }).then((r) => r.ok, () => false);

function spawnBridge() {
    const py = pythonCmd();
    if (!py) { warn('python 3.10+ не найден — бридж не поднят'); return false; }
    fs.mkdirSync(path.join(root, 'logs'), { recursive: true });
    const logFile = fs.openSync(path.join(root, 'logs', 'bridge.log'), 'a');
    bridge = spawn(py, ['server.py'], {
        cwd: path.join(root, 'claude-bridge'),
        stdio: ['ignore', logFile, logFile],
        // без shell: python.exe — настоящий exe, а через cmd.exe kill() убил
        // бы обёртку и оставил мост сиротой
        shell: false,
        windowsHide: true,
        env: { ...process.env, CLAUDE_BRIDGE_TARGET: bridgeTarget, CLAUDE_BRIDGE_CWD: root },
    });
    bridge.on('exit', (code) => { bridge = null; if (code) warn(`бридж завершился с кодом ${code} — смотри logs/bridge.log`); });
    log(`запускаю claude-bridge (${py}) на :${bridgePortNum}, claude: ${bridgeTarget}`);
    return true;
}

function startBridge(bridgePort) {
    bridgePortNum = bridgePort;
    if (!bridgeTarget) {
        const saved = readEnvFile(path.join(root, 'claude-bridge', '.env')).CLAUDE_BRIDGE_TARGET;
        bridgeTarget = saved === 'windows' || saved === 'wsl' ? saved : (IS_WIN ? 'windows' : 'wsl');
    }
    return bridgeAlive().then((ok) => {
        if (ok) { log(`бридж уже слушает :${bridgePort} — переиспользую`); return true; }
        if (!spawnBridge()) return false;
        return waitFor(bridgeAlive, 15_000);
    });
}

// Файлы моста, за которыми сторож следит: мост — обычный питон-процесс, Node его
// код не перечитывает, и до этого правка .py вступала в силу только после того,
// как пользователь гасил весь стек руками (Ctrl+C и заново)
function bridgeFiles() {
    if (!root) return []; // стека нет или ещё не готовили: следить не за чем
    const dir = path.join(root, 'claude-bridge');
    try {
        return fs.readdirSync(dir).filter((f) => f.endsWith('.py')).map((f) => path.join(dir, f));
    } catch {
        return []; // папки нет — следить не за чем
    }
}

// Перезапуск одного моста: сервер и Hermes при этом не трогаются. Сломанная
// правка мост не роняет — файл, который не разбирается, не подхватываем, как и
// сторож не подхватывает непарсящийся server.js
async function restartBridge(why) {
    if (!bridge) {
        // мост не наш (переиспользован чужой) или не поднимался — перезапускать нечего
        if (await bridgeAlive()) warn(`бридж запущен не сторожем — ${why} применится после его перезапуска`);
        return false;
    }
    const py = pythonCmd();
    const files = bridgeFiles();
    if (py && files.length) {
        const check = spawnSync(py, ['-m', 'py_compile', ...files], { stdio: 'ignore', windowsHide: true });
        if (check.status !== 0) {
            warn('файл бриджа не разбирается — оставляю работать прежнюю версию');
            return false;
        }
    }
    log(`${why} — перезапускаю бридж`);
    const old = bridge;
    bridge = null;
    await new Promise((resolve) => { old.once('exit', resolve); old.kill(); });
    if (spawnBridge() && !(await waitFor(bridgeAlive, 15_000))) {
        warn('бридж не ответил после перезапуска — смотри logs/bridge.log');
        return false;
    }
    return true;
}

// Settings → Claude → Connect: пользователь выбрал WSL или Windows. Id цели
// server.js совпадает с целью моста ('wsl' | 'windows'); 'custom' (CLAUDE_BIN)
// оставляем как есть — мост найдёт бинарь сам по CLAUDE_BRIDGE_BINARY, если задан
async function setClaudeTarget(id) {
    if (id !== 'wsl' && id !== 'windows') return;
    if (id === bridgeTarget) return;
    bridgeTarget = id;
    const file = path.join(root, 'claude-bridge', '.env');
    if (fs.existsSync(file)) {
        const text = fs.readFileSync(file, 'utf8');
        const next = /^CLAUDE_BRIDGE_TARGET=.*$/m.test(text)
            ? text.replace(/^CLAUDE_BRIDGE_TARGET=.*$/m, `CLAUDE_BRIDGE_TARGET=${id}`)
            : `${text}${text.endsWith('\n') ? '' : '\n'}CLAUDE_BRIDGE_TARGET=${id}\n`;
        fs.writeFileSync(file, next);
    }
    await restartBridge(`Claude переключён на ${id}`);
}

// ---------- 6. Hermes ----------
async function startHermes(apiKey) {
    if (!fs.existsSync(path.join(root, 'hermes-home', 'config.yaml'))) {
        // без provider: claude-bridge свежий Hermes ищет credentials и падает до бриджа
        fs.copyFileSync(path.join(root, 'hermes-home.config.example.yaml'), path.join(root, 'hermes-home', 'config.yaml'));
        log('hermes-home/config.yaml заведён из образца');
    }
    // HOME агента в контейнере — /opt/data (hermes-home). Проект в него
    // смонтирован с диска Windows, и владелец файлов там не совпадает с uid
    // агента: без safe.directory любой git в терминале агента отвечает
    // «dubious ownership», и ход уходит на обход ошибки вместо задачи
    const gitconfig = path.join(root, 'hermes-home', '.gitconfig');
    if (!fs.existsSync(gitconfig)) {
        fs.writeFileSync(gitconfig, '[safe]\n\tdirectory = *\n');
        log('hermes-home/.gitconfig заведён: git внутри контейнера доверяет смонтированному проекту');
    }
    const r = run('docker', [...COMPOSE_ARGS, 'up', '-d', 'gateway']);
    if (r.status !== 0) return warn('docker compose up не удался — Hermes не поднят');
    composeUp = true;
    const alive = () => fetch(`${HERMES_API}/models`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(2000) }).then((res) => res.ok, () => false);
    log('жду agent API Hermes на :8642');
    if (await waitFor(alive, 90_000)) log('Hermes отвечает — Settings → Hermes найдёт его');
    else warn('Hermes не ответил за 90 с — смотри docker compose logs');
}

async function waitFor(check, ms) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
        if (await check()) return true;
        await new Promise((r) => setTimeout(r, 1000));
    }
    return false;
}

// ---------- вход и выход ----------
// синхронная часть (npm, hermes/, .env, образ) блокирует до конца: сервер
// должен стартовать уже с готовыми зависимостями. Мост и Hermes — асинхронно,
// сервер их не ждёт: подключение к Hermes всё равно идёт по кнопке в Settings
function prepare(projectRoot) {
    root = projectRoot;
    ensureNodeModules();
    ensureHermesSource(readEnvFile(path.join(root, '.env')));
    const { apiKey, bridgePort } = ensureEnv();
    const docker = has('docker', ['info']);
    if (!docker) warn('Docker недоступен (не запущен Docker Desktop?) — Hermes не поднимаю, сервер работает без него');
    else ensureImage();
    return { apiKey, bridgePort, docker };
}

async function startAsync({ apiKey, bridgePort, docker }) {
    try {
        const bridgeOk = await startBridge(bridgePort);
        if (!bridgeOk) warn('бридж не отвечает — Hermes без него не сможет отвечать');
        if (docker) await startHermes(apiKey);
    } catch (err) {
        warn(`подъём стека прерван: ${err.message}`);
    }
}

// синхронно: зовётся из обработчика SIGINT прямо перед process.exit
function stop() {
    if (composeUp) {
        log('останавливаю Hermes');
        run('docker', [...COMPOSE_ARGS, 'down'], { stdio: 'ignore' });
        composeUp = false;
    }
    if (bridge) {
        log('останавливаю бридж');
        bridge.kill();
        bridge = null;
    }
}

module.exports = { prepare, startAsync, stop, setClaudeTarget, bridgeFiles, restartBridge };
