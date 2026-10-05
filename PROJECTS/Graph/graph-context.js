// Что известно о файле помимо «здесь создаётся»: секция внутри него, в которой
// живут названные строки, соседи по фиче и то, кто на файл ссылается.
//
// Зачем: строка `Code:` в запросе из Karandash называет файл и строки, и агент
// с этого места уже не ищет. Но файл — не точка: у него есть секция, в которой
// строки живут, соседи по фиче и то, кто на этот файл ссылается. Всё это лежит в
// карте проекта (PROJECTS/Graph), и раньше оно
// доставалось только поиском по vault — то есть теми же шагами, от которых
// строка `Code:` как раз и освобождает (DOCS/decisions/100).
//
// Здесь только чтение уже собранной карты и файлов. Ничего не строится заново:
// карту пересобирает сервер после правок, а этот модуль её читает.
const fs = require('fs');
const path = require('path');
const { ROOT, MAP_DIR, TEXT_FILES, buildVaultGraph } = require('./graph-vault.js');

// разделитель секций — тот же, что у карты (SECTION в graph-vault.js), плюс
// html-комментарий для шаблонов .eta: в разметке секцию помечает `<!-- … -->`,
// а не `// --- … ---`. Правило одно на оба места, разъехавшиеся секции называли
// бы разное про один файл
const SECTION_MARK = /^\s*\/\/ -{3,} (.+?) -{3,}\s*$/;
// секция из разметки не должна быть многострочной: в topbar.eta комментарий на
// пять строк, и каждая его строка не секция. Берём только однострочные

// сколько соседей и сколько ссылок помещаются в строку запроса. Больше —
// шум: агент всё равно открывает названные файлы по одному, а строка едет в
// запрос целиком на каждом ходе
const MAX_SIBLINGS = 6;
const MAX_REFERRERS = 4;

// читаем то, что вообще бывает исходником. TEXT_FILES из карты про .eta не знает,
// а шаблоны верхнего меню и списка сессий лежат именно там, и клик по кнопке
// карандаш без этого секции не получал бы вовсе (проверено: секций 0, файл не
// прочитан). Список свой, а не склейка с TEXT_FILES: правило карты для карты, и
// склейка ломалась бы от каждой её правки
const READABLE = /\.(js|mjs|cjs|jsx|ts|tsx|html|eta|css|json|md)$/i;

function readIfText(relative) {
    const full = path.join(ROOT, relative);
    if (!fs.existsSync(full) || !READABLE.test(relative)) return null;
    try {
        return fs.readFileSync(full, 'utf8');
    } catch {
        return null;
    }
}

// ---------- секция файла по номеру строки ----------

// границы секций в карте не хранятся (там только названия и левый край), поэтому
// файл читается заново — целиком, но без разбора: нужен только разделитель
function sectionsOf(relative) {
    const text = readIfText(relative);
    if (!text) return [];
    const lines = text.split(/\r?\n/);
    const markup = /\.(eta|html)$/i.test(relative);
    const out = [];
    let open = null; // незакрытый многострочный комментарий разметки

    lines.forEach((line, i) => {
        const trimmed = line.trim();
        if (open) {
            if (trimmed.includes('-->')) {
                // комментарий закрылся на этой строке: если он был в одну строку,
                // это и есть секция, а многострочный — только пояснение к месту
                const single = trimmed.match(/^<!--\s*([^<>]{3,80}?)\s*-->$/);
                if (single) out.push({ title: single[1], line: i + 1 });
                open = null;
            }
            return;
        }
        if (!markup) {
            const m = line.match(SECTION_MARK);
            if (m) out.push({ title: m[1], line: i + 1 });
            return;
        }
        if (trimmed.startsWith('<!--')) {
            const single = trimmed.match(/^<!--\s*([^<>]{3,80}?)\s*-->$/);
            if (single) out.push({ title: single[1], line: i + 1 });
            else open = true;
        }
    });

    for (let i = 0; i < out.length; i++) {
        out[i].end = (out[i + 1]?.line ?? lines.length + 1) - 1;
    }
    return out;
}

// секция, в которую попадает строка. Без неё агент читает файл целиком, хотя
// задача обычно лежит в двадцати строках: у karandash.js их 456, а нужная — одна
function sectionAt(relative, line) {
    const sections = sectionsOf(relative);
    if (!sections.length) return null;
    const hit = sections.find((s) => line >= s.line && line <= s.end);
    if (!hit) return null;
    const span = hit.end - hit.line + 1;
    return `«${hit.title}», строки ${hit.line}–${hit.end}${span > 60 ? '' : ` (${span})`}`;
}

// ---------- соседи по фиче ----------

// файлы той же папки, кроме самого: у фичи своя папка, и в ней всё, что относится
// к ней самому естественным образом. README первой строкой — его читают перед
// правкой, и он же объясняет, что за фича.
//
// Соседи есть только у папки фичи (PROJECTS/<Фича>). У SYSTEM и TOOLS папка — это
// слой, а не фича: там рядом лежат двадцать несвязанных файлов, и список из них
// в запросе не значит ничего, кроме шума (замерено: клик по кнопке карандаш давал
// `SYSTEM/app.js, boot.js, branch-gate.mjs…` — пять файлов мимо задачи)
const FEATURE_FOLDER = /^PROJECTS\/[^/]+\//;

function siblingsOf(relative) {
    const dir = path.posix.dirname(relative);
    if (!dir || dir === '.' || !FEATURE_FOLDER.test(`${relative}/`)) return [];
    let entries;
    try {
        entries = fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true });
    } catch {
        return [];
    }
    const files = entries
        .filter((e) => e.isFile())
        .map((e) => path.posix.join(dir, e.name))
        .filter((f) => f !== relative);
    // README вперёд: он объясняет фичу, остальное — её код
    files.sort((a, b) => {
        const ra = path.posix.basename(a) === 'README.md' ? 0 : 1;
        const rb = path.posix.basename(b) === 'README.md' ? 0 : 1;
        return ra - rb || a.localeCompare(b);
    });
    return files.slice(0, MAX_SIBLINGS);
}

// ---------- решения ----------

// Решения о файле здесь НЕ перечисляются, и это решение, а не пропуск: сервер
// и так подбирает записки к каждому ходу по его тексту (SYSTEM/core/decision-hints.js,
// решение 089). Второй источник давал бы две разные подборки на один ход —
// и вторая была бы хуже: решения упоминают соседние файлы в примерах, и в строке
// оказывалась записка не о том (на замере к karandash.js попадала 099, где его
// имя стоит в примере, а не в «Решении»).

// ---------- кто ссылается ----------

// обратные ссылки: кто в проекте ссылается на этот файл. Берёмся из карты
// (DATA/vault/Project), где такие связи уже посчитаны при её сборке: свободный
// поиск имени файла по тексту дал бы упоминания в комментариях и в отчётах.
//
// карта стоит полсекунды (замерено: 994 заметки, 1564 ребра, 523 мс), а клик по
// элементу ждать её не должен — поэтому держим копию и сбрасываем по событию
// пересборки, а не по времени: карта пересобирается после правок, и ответ после
// правки должен отражать её новую версию, а не ту, что была секунду назад
let graphCache = null;

function graph() {
    if (!graphCache) graphCache = buildVaultGraph();
    return graphCache;
}

function forgetGraph() {
    graphCache = null;
}

function referrersOf(relative) {
    const built = graph();
    const note = `${MAP_DIR}/${relative}.md`;
    const byPath = new Map(built.notes.map((n) => [n.path, n]));
    const back = (built.links || [])
        .filter(([a, b]) => a === note || b === note)
        .map(([a, b]) => (a === note ? b : a));

    // из ответа уходят три вида заметок, и все три — части самой карты, а не
    // файлы проекта: `route` (роут, описанный этим файлом), `history` (таблица
    // «меняются вместе») и заметки секций/функций — у них в поле `file` стоит
    // сам relative, то есть это другой взгляд на тот же файл. Остаются файлы,
    // которые действительно ссылаются: у них `file` другой
    const out = new Set();
    for (const other of back) {
        if (other === note) continue;
        const meta = byPath.get(other);
        if (meta && meta.kind !== 'file') continue;
        const real = meta ? meta.file : other.replace(`${MAP_DIR}/`, '');
        if (real && real !== relative) out.add(real);
    }
    return [...out].slice(0, MAX_REFERRERS);
}

// ---------- всё вместе ----------

// Контекст одного места: секция, в которой живут строки, соседи по фиче и
// обратные ссылки. Ограничение по размеру здесь не косметическое: строка едет в
// запрос агента целиком, и каждый лишний символ оплачивается на каждом ходе
function contextOf(file, line) {
    const out = { section: null, siblings: [], referrers: [] };
    if (!file) return out;
    out.section = sectionAt(file, line) || null;
    out.siblings = siblingsOf(file);
    out.referrers = referrersOf(file);
    return out;
}

module.exports = {
    contextOf,
    sectionsOf,
    sectionAt,
    siblingsOf,
    forgetGraph,
};
