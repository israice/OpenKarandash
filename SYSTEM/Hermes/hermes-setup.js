// Установка Hermes при первом запуске проекта.
//
// Задача: пользователь склонировал репозиторий, запустил сервер — и всё готово,
// осталось выбрать провайдера в настройках. Поэтому здесь нет ни одного шага,
// который надо делать руками, и каждый шаг идемпотентен: повторный запуск на
// готовой установке ничего не делает и ничего не ломает.
//
// Почему не `setup-hermes.sh` из самого Hermes: он кладёт venv в одно место
// (`<репозиторий>/venv`) и правит PATH пользователя. Нам нужны два независимых
// окружения — для Windows и для WSL, — потому что бинарники Python несовместимы,
// а проект живёт на одной и той же папке и открывается из обеих систем.
//
// Запуск руками (сервер поднимать не нужно):
//   node SYSTEM/Hermes/hermes-setup.js --status
//   node SYSTEM/Hermes/hermes-setup.js --install

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const AGENT_DIR = path.join(__dirname, 'agent');
const PIN_FILE = path.join(__dirname, 'AGENT-PIN.txt');
const AGENT_REPO = 'https://github.com/nousresearch/hermes-agent';

// состояние Hermes держим внутри проекта, а не в домашней папке: тогда оно
// переезжает вместе с репозиторием и одинаково видно из Windows и из WSL
const HERMES_HOME = path.join(ROOT, 'DATA', 'hermes');

const IS_WINDOWS = process.platform === 'win32';

// два окружения на одной папке проекта: у Windows и Linux несовместимые
// бинарники, общий venv сломал бы себя при первом же запуске из другой системы
const PLATFORM_KEY = IS_WINDOWS ? 'win' : 'wsl';
const VENV_DIR = path.join(__dirname, 'runtime', PLATFORM_KEY, 'venv');
const HERMES_BIN = IS_WINDOWS
    ? path.join(VENV_DIR, 'Scripts', 'hermes.exe')
    : path.join(VENV_DIR, 'bin', 'hermes');

const LOG_FILE = path.join(__dirname, 'runtime', PLATFORM_KEY, 'setup.log');

// venv не переносится вместе с папкой: внутри него абсолютные пути — shebang'и
// в bin/, ссылки редактируемой установки, launcher'ы Windows. После переезда папки
// файлы на месте, а запуск падает на «bad interpreter». Поэтому рядом с окружением
// лежит путь, по которому его собрали: не совпал — окружение ставится заново
const VENV_MARKER = path.join(__dirname, 'runtime', PLATFORM_KEY, 'venv-path.txt');

function venvMoved() {
    if (!fs.existsSync(VENV_PYTHON)) return false; // окружения нет вовсе — это не переезд
    try {
        return fs.readFileSync(VENV_MARKER, 'utf8').trim() !== VENV_DIR;
    } catch {
        return true; // метки нет: окружение собрано до этой проверки, где — неизвестно
    }
}

// признак готового окружения — интерпретатор, а не папка: установку могли
// оборвать посреди `uv venv`, и тогда папка есть, а работать в ней нечем
const VENV_PYTHON = IS_WINDOWS
    ? path.join(VENV_DIR, 'Scripts', 'python.exe')
    : path.join(VENV_DIR, 'bin', 'python');

const PYTHON_VERSION = '3.11';

// ---------- поиск uv ----------

// uv ставится однажды на систему, а не в проект: он сам по себе менеджер
// окружений, и держать его копию в каждом проекте незачем
function findUv() {
    const candidates = IS_WINDOWS
        ? [
            path.join(process.env.LOCALAPPDATA || '', 'hermes', 'bin', 'uv.exe'),
            path.join(os.homedir(), '.local', 'bin', 'uv.exe'),
            path.join(os.homedir(), '.cargo', 'bin', 'uv.exe'),
        ]
        : [
            path.join(os.homedir(), '.local', 'bin', 'uv'),
            path.join(os.homedir(), '.cargo', 'bin', 'uv'),
        ];

    for (const candidate of candidates) {
        if (candidate && fs.existsSync(candidate)) return candidate;
    }

    // в PATH — последним: так найденный в проверенных местах uv выигрывает
    // у случайного одноимённого бинарника
    try {
        const found = execFileSync(IS_WINDOWS ? 'where' : 'which', ['uv'], { encoding: 'utf8' })
            .split(/\r?\n/)[0].trim();
        return found || null;
    } catch {
        return null;
    }
}

// ---------- состояние установки ----------

function pinnedCommit() {
    try {
        return fs.readFileSync(PIN_FILE, 'utf8').trim();
    } catch {
        return null;
    }
}

function status() {
    const uv = findUv();
    return {
        platform: PLATFORM_KEY,
        agent: fs.existsSync(path.join(AGENT_DIR, 'pyproject.toml')),
        pin: pinnedCommit(),
        uv,
        venv: fs.existsSync(VENV_PYTHON),
        moved: venvMoved(),
        hermes: fs.existsSync(HERMES_BIN),
        home: HERMES_HOME,
        config: fs.existsSync(path.join(HERMES_HOME, 'config.yaml')),
        bin: HERMES_BIN,
    };
}

const isReady = (s = status()) => Boolean(s.agent && s.hermes && s.config && !s.moved);

// ---------- выполнение шагов ----------

function run(command, args, { cwd = ROOT, env = {}, onLog } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd,
            env: { ...process.env, UV_NO_CONFIG: '1', ...env },
            windowsHide: true,
        });

        const feed = (chunk) => {
            for (const line of String(chunk).split(/\r?\n/)) {
                if (line.trim()) onLog?.(line);
            }
        };
        child.stdout.on('data', feed);
        child.stderr.on('data', feed);
        child.on('error', reject);
        child.on('exit', (code) => (
            code === 0 ? resolve() : reject(new Error(`${path.basename(command)} завершился с кодом ${code}`))
        ));
    });
}

// Hermes держит своё состояние в SQLite. На папке проекта, открытой из WSL
// через /mnt/c, режим WAL не работает («disk I/O error»): drvfs не даёт
// разделяемую память, которая ему нужна. Поэтому сразу просим journal_mode
// delete — иначе установка проходит, а первый же запуск падает
const CONFIG_TEMPLATE = `# Конфигурация Hermes для этого проекта.
# Создана автоматически при первой установке (SYSTEM/Hermes/hermes-setup.js).
# Провайдер и модель меняются из настроек интерфейса, править руками не нужно.

database:
  # папка проекта видна и из Windows, и из WSL через /mnt/c, где WAL не работает
  journal_mode: "delete"

model:
  # выбирается в настройках интерфейса; "auto" — определить по найденным ключам
  provider: "auto"
`;

async function install({ onLog = () => {} } = {}) {
    const log = (line) => {
        onLog(line);
        try {
            fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`);
        } catch { /* лог — вспомогательный, из-за него установка падать не должна */ }
    };

    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });

    // 1. сам агент
    if (!fs.existsSync(path.join(AGENT_DIR, 'pyproject.toml'))) {
        const pin = pinnedCommit();
        log(`Скачиваю Hermes${pin ? ` (коммит ${pin.slice(0, 7)})` : ''}…`);
        await run('git', ['clone', AGENT_REPO, AGENT_DIR], { onLog: log });
        if (pin) await run('git', ['checkout', pin], { cwd: AGENT_DIR, onLog: log });
        // на /mnt/c git иначе считает изменёнными все файлы разом — из-за прав доступа
        await run('git', ['config', 'core.filemode', 'false'], { cwd: AGENT_DIR, onLog: log }).catch(() => {});
    } else {
        log('Hermes уже в папке проекта.');
    }

    // 2. uv — менеджер окружений, которым Hermes ставит свой Python
    let uv = findUv();
    if (!uv) {
        log('Ставлю uv…');
        if (IS_WINDOWS) {
            await run('powershell', ['-NoProfile', '-Command', 'irm https://astral.sh/uv/install.ps1 | iex'], { onLog: log });
        } else {
            await run('sh', ['-c', 'curl -LsSf https://astral.sh/uv/install.sh | sh'], { onLog: log });
        }
        uv = findUv();
        if (!uv) throw new Error('uv установился, но не нашёлся — проверьте ~/.local/bin');
    }
    log(`uv: ${uv}`);

    // 3. окружение под текущую систему
    if (venvMoved()) {
        log('Папку проекта переносили — старое окружение Python не запустится, собираю заново.');
        fs.rmSync(VENV_DIR, { recursive: true, force: true });
    }
    if (!fs.existsSync(VENV_PYTHON)) {
        log(`Создаю окружение Python ${PYTHON_VERSION} (${PLATFORM_KEY})…`);
        fs.mkdirSync(path.dirname(VENV_DIR), { recursive: true });
        await run(uv, ['venv', VENV_DIR, '--python', PYTHON_VERSION], { onLog: log });
    }

    // 4. зависимости. Полный набор extras может не собраться целиком —
    //    откатываемся к ядру, чтобы установка не превращалась в «всё или ничего»
    if (!fs.existsSync(HERMES_BIN)) {
        log('Ставлю зависимости Hermes — первый раз это несколько минут…');
        const pipArgs = (spec) => ['pip', 'install', '--python', VENV_DIR, '-e', spec];
        try {
            await run(uv, pipArgs('.[all]'), { cwd: AGENT_DIR, onLog: log });
        } catch (err) {
            log(`Полный набор не собрался (${err.message}) — ставлю ядро.`);
            await run(uv, pipArgs('.'), { cwd: AGENT_DIR, onLog: log });
        }
    }
    if (!fs.existsSync(HERMES_BIN)) throw new Error(`Hermes не появился по пути ${HERMES_BIN}`);
    // метку пишем последней: она означает «этим окружением можно пользоваться отсюда»
    fs.writeFileSync(VENV_MARKER, `${VENV_DIR}\n`, 'utf8');

    // 5. состояние и конфиг — внутри проекта
    fs.mkdirSync(HERMES_HOME, { recursive: true });
    const configPath = path.join(HERMES_HOME, 'config.yaml');
    if (!fs.existsSync(configPath)) {
        fs.writeFileSync(configPath, CONFIG_TEMPLATE, 'utf8');
        log(`Конфиг проекта: ${configPath}`);
    }

    log('Готово. Осталось выбрать провайдера в настройках.');
    return status();
}

// Ключ провайдера кладём в .env самого Hermes ($HERMES_HOME/.env) — это место,
// откуда он их читает (hermes_cli/env_loader.py). В проектный .env его дублировать
// не стали: секрет в двух файлах — это два места, где его забудут почистить.
// Он и так внутри DATA/, которая в git не попадает
function setSecret(name, value) {
    const file = path.join(HERMES_HOME, '.env');
    fs.mkdirSync(HERMES_HOME, { recursive: true });

    const line = `${name}=${value}`;
    let text = '';
    try {
        text = fs.readFileSync(file, 'utf8');
    } catch { /* файла ещё нет — заведём */ }

    const pattern = new RegExp(`^${name}=.*$`, 'm');
    text = pattern.test(text)
        ? text.replace(pattern, line)
        : `${text}${text && !text.endsWith('\n') ? '\n' : ''}${line}\n`;

    fs.writeFileSync(file, text, { encoding: 'utf8', mode: 0o600 });
    return file;
}

// Вход Claude Code: Hermes умеет брать его OAuth-учётку как источник для
// провайдера anthropic (agent/credential_sources.py, источник claude_code) —
// то есть работать по подписке, без отдельного ключа API. Проверяем то же место,
// что и он: файл входа Claude CLI в домашней папке
function claudeCliLogin() {
    const file = path.join(os.homedir(), '.claude', '.credentials.json');
    return fs.existsSync(file) ? file : null;
}

// что сейчас выбрано: читаем конфиг сами, а не спрашиваем CLI — запуск Python
// ради двух строк тормозил бы каждую перерисовку панели настроек
function currentChoice() {
    // Конфиг двухуровневый, и одно и то же имя встречается на обоих уровнях:
    // «model:» — и заголовок секции, и ключ внутри «delegation:». Поэтому читаем
    // именно «ключ внутри секции», а не первое совпадение по файлу
    const read = (section, key) => {
        try {
            const lines = fs.readFileSync(path.join(HERMES_HOME, 'config.yaml'), 'utf8').split(/\r?\n/);
            let inside = false;
            for (const line of lines) {
                if (/^\S/.test(line)) inside = line.startsWith(`${section}:`); // вышли на верхний уровень
                if (!inside) continue;
                const match = line.match(new RegExp(`^\\s+${key}:[ \\t]*"?([^"#]*?)"?\\s*$`));
                if (match && match[1]) return match[1].trim();
            }
        } catch { /* конфига ещё нет */ }
        return null;
    };

    return {
        provider: read('model', 'provider'),
        model: read('model', 'default'),
        // модель подагентов: на ней идут подзадачи, туда и уходит основная масса токенов
        worker: read('delegation', 'model'),
        workerProvider: read('delegation', 'provider'),
    };
}

// установку могут запросить одновременно старт сервера и кнопка в интерфейсе —
// второй вызов подключается к уже идущей, а не начинает вторую
let pending = null;
function installOnce(options) {
    if (isReady()) return Promise.resolve(status());
    if (!pending) {
        pending = install(options).finally(() => { pending = null; });
    }
    return pending;
}

// окружение для любого запуска hermes: своё состояние, свой конфиг
const childEnv = () => ({ HERMES_HOME, UV_NO_CONFIG: '1' });

// правку конфига делает сам Hermes своей же командой, а не мы разбором YAML:
// формат конфига — его дело, и он же проверит значение
function config(key, value) {
    return run(HERMES_BIN, ['config', 'set', key, String(value)], { cwd: AGENT_DIR, env: childEnv() });
}

if (require.main === module) {
    const mode = process.argv[2] || '--status';
    if (mode === '--install') {
        install({ onLog: (line) => console.log(line) }).then(
            (s) => console.log(JSON.stringify(s, null, 2)),
            (err) => { console.error(`Установка не удалась: ${err.message}`); process.exit(1); },
        );
    } else {
        console.log(JSON.stringify({ ...status(), ready: isReady() }, null, 2));
    }
}

module.exports = { status, isReady, install, installOnce, config, currentChoice, setSecret, claudeCliLogin, childEnv, HERMES_HOME, HERMES_BIN, VENV_DIR, AGENT_DIR };
