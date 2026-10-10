// Поиск секретов в том, что git готов увидеть: файлы из индекса плюс
// незакоммиченные, которые .gitignore не скрывает. Сканировать «весь диск» не
// надо намеренно — .env, DATA и node_modules закрыты игнором, и лезть в них
// значило бы каждую проверку читать мегабайты собственного мусора, а потом
// печатать пользователю его собственные ключи в вывод проверки.
//
// Два уровня строгости, и это не украшение:
//
//   PATTERNS  формы, у которых нет безобидной похожей: блок приватного ключа,
//             токен с префиксом провайдера. Такая находка краснят проверку —
//             попадание такого текста в репозиторий есть утечка.
//   GENERIC   «переменной с секретным именем присвоено значение». Похожие формы
//             существуют и встречаются в доке, в примерах и в тестах, поэтому
//             находки печатаются списком и правилом не считаются: ложный
//             красный останавливает работу сильнее, чем пропущенная находка,
//             а этот уровень по построению даёт и то и другое.
//
// Файл можно запустить и отдельно: `node SYSTEM/secrets-scan.js [--root <папка>]`.
// Код выхода: 0 — уровень PATTERNS чист, 1 — там находка, 2 — просканировать не
// удалось (тогда проверка не должна молча пройти: см. проверку в checks.js).
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const TOOLS = path.join(__dirname, '..');
const rootArg = process.argv.indexOf('--root');
const ROOT = rootArg > 0 && process.argv[rootArg + 1] ? path.resolve(process.argv[rootArg + 1]) : TOOLS;

// формы без безобидной похожей
const PATTERNS = [
    ['закрытый блок приватного ключа', /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/],
    ['идентификатор ключа AWS', /\bAKIA[0-9A-Z]{16}\b/],
    ['токен GitHub', /\bgh[pousr]_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{22,}\b/],
    ['токен Slack', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
    ['ключ Anthropic', /\bsk-ant-[A-Za-z0-9_-]{20,}\b/],
    ['ключ OpenAI', /\bsk-(?!ant-)[A-Za-z0-9]{20,}\b/],
    ['ключ Google API', /\bAIza[0-9A-Za-z_-]{35}\b/],
    // длина после двоеточия у телеграм-токена плавает между 34 и 35 знаками,
    // поэтому берём оба: строгие 35 молча пропускали бы половину настоящих
    ['токен телеграм-бота', /\b\d{8,10}:[A-Za-z0-9_-]{34,35}\b/],
    // пароль внутри строки подключения. Пароль не пустой и не заглушка —
    // иначе это `host:5432`, а не учётная запись
    ['пароль в строке подключения', /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s:@]+@/i],
];

// «секретному имени — значение». Само имя и есть признак: без него строка
// `PORT=3001` секретом не является, а с ним почти всегда является
const NAMED_SECRET = /\b(?:api[_-]?key|secret[_-]?key|secret|token|password|passwd|credential)\b/i;
const ASSIGNMENT = new RegExp(`${NAMED_SECRET.source}\\s*[:=]\\s*['"\`]([^'"\`\\s]{16,})['"\`]`, 'i');

// заведомо не секрет: плейсхолдеры, ссылки на окружение, маски. Список открытый:
// каждое новое слово здесь — это один снятый ложный красный
const NOT_A_SECRET = /^(?:<|\$\{|\{\{|process\.env|env\.|os\.environ|\.\.\.)|redact|placeholder|example|changeme|change_me|your|yourkey|your_key|dummy|fake|notreal|sample|xxxx|<|\.\.\./i;

// файлы, которые секретами не являются по построению: шаблоны и примеры, где
// значение — специально выдуманное или пустое
const BY_NATURE = /(^|[\\/])(?:\.env\.example|\.env\.template|.*\.example|.*\.sample|.*\.template)$/i;

const MAX_BYTES = 2 * 1024 * 1024;
// NUL в первых мегабайте — верный признак бинарника: читать его текстом
// бессмысленно, а ключ внутри бинарника мы всё равно не покажем в отчёте
function readText(file) {
    let buffer;
    try {
        buffer = fs.readFileSync(file);
    } catch {
        return null;
    }
    if (buffer.length > MAX_BYTES) return null;
    if (buffer.includes(0)) return null;
    return buffer.toString('utf8');
}

// то, что git готов увидеть. `--cached --others --exclude-standard` — ровно то
// множество, которое попадёт в коммит: индекс плюс новое неигнорируемое. Если
// это не git-репозиторий, откатываемся на обход папки с тем же списком пропуска,
// что и у остальных проверок
function filesToScan(root) {
    try {
        const listed = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
            cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
        });
        const names = listed.split('\0').filter(Boolean);
        if (names.length) return names.map((name) => ({ name, full: path.join(root, name) }));
    } catch {
        // не репозиторий или git не нашёлся — обходом ниже
    }
    // Совпадает с SKIP в SYSTEM/checks.js. json-render и json-renderer — вложенные
    // чужие репозитории: в индексе git их файлов нет, и в обход ниже они попали бы
    // только потому, что он идёт по папкам (на случай, если git не сработал)
    const SKIP = new Set(['node_modules', 'DATA', '.git', '.venv', 'hf-cache', 'vendor', '.kilo',
        'json-render', 'json-renderer']);
    const found = [];
    (function walk(dir) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (SKIP.has(entry.name)) continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else found.push({ name: path.relative(root, full), full });
        }
    }(root));
    return found;
}

// ---------- правила уровня GENERIC ----------

// отсечки, которые отличают значение от текста про значение. Без них «пример»
// и «your_api_key_here» попадали бы в тот же список, что и живой ключ, и список
// перестал бы что-то значить
function plausibleSecret(value) {
    if (NOT_A_SECRET.test(value)) return false;
    if (!/\d/.test(value) || !/[A-Za-z]/.test(value)) return false;
    // разрядка вместо содержания: у настоящего ключа много разных знаков
    return new Set(value).size >= 10;
}

function scanText(name, text) {
    const hard = [];
    const soft = [];
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        for (const [label, pattern] of PATTERNS) {
            if (pattern.test(line)) hard.push(`${name}:${i + 1}  ${label}`);
        }
        const match = line.match(ASSIGNMENT);
        if (match && plausibleSecret(match[1])) {
            // само значение не печатаем: отчёт о находке и есть утечка, а
            // владельцу достаточно места, чтобы пойти и отозвать ключ
            soft.push(`${name}:${i + 1}  значение переменной с секретным именем`);
        }
    }
    return { hard, soft };
}

// ---------- запуск ----------

function scan(root = ROOT) {
    const files = filesToScan(root);
    const hard = [];
    const soft = [];
    for (const { name, full } of files) {
        if (BY_NATURE.test(name)) continue;
        const text = readText(full);
        if (text === null) continue;
        const found = scanText(name, text);
        hard.push(...found.hard);
        soft.push(...found.soft);
    }
    return { hard, soft, files: files.length };
}

function main() {
    let result;
    try {
        result = scan(ROOT);
    } catch (error) {
        console.log(`НАШЛОСЬ: просканировать не удалось — ${error && error.message}`);
        process.exit(2);
    }
    if (result.hard.length) {
        console.log('НАШЛОСЬ: в файлах, которые git готов увидеть, есть похожие на секреты:');
        for (const hit of result.hard) console.log(`  ${hit}`);
        console.log('  Значения ключей отзываются у поставщика; history чистится, а не забывается.');
        process.exit(1);
    }
    if (result.soft.length) {
        console.log(`${result.soft.length} мест(о) с значением переменной с секретным именем — посмотри глазами (это не ошибка):`);
        for (const hit of result.soft.slice(0, 40)) console.log(`  ${hit}`);
        if (result.soft.length > 40) console.log(`  … и ещё ${result.soft.length - 40}`);
    }
    process.exit(0);
}

module.exports = { scan, scanText, plausibleSecret, PATTERNS, filesToScan };

if (require.main === module) main();