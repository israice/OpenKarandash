// Синхронизация профиля настоящего Chrome в копию для jev (Windows, без
// зависимостей). Копирует Local State и выбранный профиль хозяина так, чтобы
// копия стала самостоятельным каталогом Chrome с профилем Default — в него
// jev открывает браузер через chrome-bridge.js, с теми же входами в аккаунты.
//
// Зачем копия, а не родной профиль: Chrome с 136-й версии не открывает
// отладочный порт на штатном каталоге данных, а родной каталог занят живым
// Chrome. Копия решает обе проблемы: порт открыт (каталог не штатный), родной
// Chrome не трогаем. Куки копии расшифровываются тем же пользователем Windows,
// потому что ключ (Local State) едет вместе.
//
// Запуск на Windows: node PROJECTS/Browser/sync-user-profile.js [--profile "Имя"]
// Выбор профиля: по умолчанию тот, что стоял последним (Local State, active_time),
// можно взять другой по имени из профильного переключателя Chrome. Повторный
// запуск докачивает изменившееся: старые файлы перезаписываются, новых не трогаем.
//
// Если настоящий Chrome открыт, части файлов (куки, сессии) не дочитать — они
// залочены, про них печатается предупреждение. Для полной копии закрой Chrome и
// запусти синк ещё раз.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const ENV_FILE = path.join(ROOT, '.env');

// кэш и мусор, который не нужен для входов в аккаунты, — не копируем
const SKIP_DIRS = new Set([
    'Cache', 'Code Cache', 'GPUCache', 'GrShaderCache', 'ShaderCache',
    'DawnGraphiteCache', 'DawnWebGPUCache', 'GraphiteDawnCache',
    'Service Worker', 'File System', 'Blob Storage', 'Shared Dictionary',
    'Crashpad', 'Extensions', 'GPUPersistentCache', 'DawnRenderPipeCache',
    'GraphiteCacheStorage', 'Media Cache', 'MediaSharingSettings',
]);
const SKIP_FILES = new Set(['LOCK', 'SingletonLock', 'SingletonSocket', 'SingletonCookie', 'lockfile']);

function readEnv() {
    const out = {};
    let text = '';
    try {
        text = fs.readFileSync(ENV_FILE, 'utf8');
    } catch {
        return out;
    }
    for (const line of text.split(/\r?\n/)) {
        const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
        if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
    return out;
}

const env = readEnv();
const sourceData = process.env.CHROME_USER_DATA_DIR || path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data');
const targetDir = process.env.CHROME_PROFILE_DIR || env.CHROME_PROFILE_DIR || path.join(ROOT, 'DATA', 'userchrome-profile');

// ---- маленькие утилиты консоли ----
function log(msg) { console.log('[sync] ' + msg); }
function warn(msg) { console.warn('[sync][!] ' + msg); }

function profileArg(argv) {
    const m = /^--profile=(.*)$/.exec(argv.find((a) => a.startsWith('--profile=')) || '');
    return m ? m[1] : (process.env.CHROME_SOURCE_PROFILE || '');
}

function chromeRunning() {
    try {
        const r = spawnSync('tasklist', ['/fi', 'imagename eq chrome.exe', '/nh'], { encoding: 'utf8', windowsHide: true });
        if (r.error) return false;
        return (r.stdout.match(/chrome\.exe/gi) || []).length > 0;
    } catch {
        return false;
    }
}

function localStatePath(dataDir) {
    return path.join(dataDir, 'Local State');
}

// активный профиль: по Local State берём тот, что стоял последним (максимум active_time)
function pickActiveProfile(dataDir) {
    try {
        const state = JSON.parse(fs.readFileSync(localStatePath(dataDir), 'utf8'));
        const info = state.profile && state.profile.info_cache;
        if (!info) return null;
        let best = null;
        let bestTime = -1;
        for (const [dir, v] of Object.entries(info)) {
            const t = Number(v.active_time || 0);
            if (t > bestTime) { bestTime = t; best = dir; }
        }
        return best;
    } catch {
        return null;
    }
}

// ---- копирование с пропуском залоченных файлов ----
const skipped = [];
let copiedFiles = 0;

function shouldSkipDir(name) { return SKIP_DIRS.has(name); }
function shouldSkipFile(name) { return SKIP_FILES.has(name); }

function copyTree(src, dst) {
    let entries = [];
    try {
        entries = fs.readdirSync(src, { withFileTypes: true });
    } catch (e) {
        skipped.push({ what: path.basename(src), why: e.code || e.message });
        return;
    }
    fs.mkdirSync(dst, { recursive: true });
    for (const ent of entries) {
        const s = path.join(src, ent.name);
        const d = path.join(dst, ent.name);
        if (ent.isDirectory()) {
            if (shouldSkipDir(ent.name)) continue;
            copyTree(s, d);
        } else if (ent.isFile() || ent.isSymbolicLink()) {
            if (shouldSkipFile(ent.name)) continue;
            try {
                fs.copyFileSync(s, d, fs.constants.COPYFILE_FICLONE);
                copiedFiles++;
            } catch (e) {
                skipped.push({ what: ent.name, why: e.code || e.message });
            }
        }
    }
}

// ---- главное ----
let empty = true;
try { empty = fs.readdirSync(targetDir).length === 0; } catch { /* каталога ещё нет */ }

log(`источник: ${sourceData}`);
log(`назначение: ${targetDir}`);

if (!fs.existsSync(sourceData)) {
    warn(`не найден каталог Chrome: ${sourceData}`);
    process.exit(1);
}
if (!fs.existsSync(localStatePath(sourceData))) {
    warn(`нет Local State в ${sourceData} — это не каталог данных Chrome`);
    process.exit(1);
}

let chosen = profileArg(process.argv.slice(2)) || pickActiveProfile(sourceData) || 'Profile 1';
const chosenPath = path.join(sourceData, chosen);
if (!fs.existsSync(chosenPath)) {
    warn(`профиль "${chosen}" не найден в ${sourceData}; доступны:`);
    try {
        for (const d of fs.readdirSync(sourceData, { withFileTypes: true })) {
            if (d.isDirectory() && /^Profile \d+|^Default$/.test(d.name)) console.log('   ' + d.name);
        }
    } catch { /* ничего */ }
    process.exit(1);
}

const isRunning = chromeRunning();
if (isRunning) warn('настоящий Chrome открыт — файлы входа (куки, сессии) залочены и в копию не попадут; для полной копии закрой Chrome и запусти синк снова');

// Local State несёт ключ расшифровки куки (os_crypt), кладём первым — это файл,
// а не каталог, поэтому отдельным копированием
fs.mkdirSync(targetDir, { recursive: true });
try {
    fs.copyFileSync(localStatePath(sourceData), localStatePath(targetDir), fs.constants.COPYFILE_FICLONE);
    copiedFiles++;
} catch (e) {
    skipped.push({ what: 'Local State', why: e.code || e.message });
}
// выбранный профиль ложится как Default: копия становится самостоятельным каталогом с одним профилем
copyTree(chosenPath, path.join(targetDir, 'Default'));

log(`скопировано файлов: ${copiedFiles}`);
log(`профиль: ${chosen} -> ${path.join(targetDir, 'Default')}`);
if (skipped.length) {
    const shown = skipped.slice(0, 15);
    warn(`не скопировано (${skipped.length}):`);
    for (const s of shown) warn(`   ${s.what} (${s.why})`);
    if (isRunning) warn('причина почти всегда одна: Chrome работает. Закройте Chrome и запустите синк ещё раз.');
}

// пропишем каталог в .env, если его там ещё нет
if (!env.CHROME_PROFILE_DIR) {
    let prefix = '';
    try {
        const cur = fs.readFileSync(ENV_FILE, 'utf8');
        if (cur && !cur.endsWith('\n')) prefix = '\n';
    } catch { /* .env создастся */ }
    fs.appendFileSync(ENV_FILE, `${prefix}CHROME_PROFILE_DIR=${targetDir}\n`);
    log(`добавлено CHROME_PROFILE_DIR=${targetDir} в .env`);
} else if (env.CHROME_PROFILE_DIR !== targetDir) {
    warn(`CHROME_PROFILE_DIR в .env другой (${env.CHROME_PROFILE_DIR}), назначение сейчас ${targetDir}`);
}

console.log('');
log(`готово. jev теперь откроет браузер с профилем "${chosen}" (копией настоящего).`);