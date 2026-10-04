// Форматирование значений страницы Feed: время, числа, стоимость, проценты,
// печать JSON и маленькие иконки. Отдельный файл потому, что здесь ровно
// чистые функции над значениями — ни DOM, ни состояние страницы: их берут и
// таблицы полей (feed-fields.js), и карточки (feed-cards.js,
// feed-message-cards.js), и сам page.js, а копия в каждом из них означала бы
// правку в трёх местах (DOCS/decisions/022 — один файл, одна тема).

function fmtTime(iso) { return iso ? new Date(iso).toLocaleString('ru-RU') : '—'; }
function fmtNum(n) { return (n === null || n === undefined) ? '—' : Number(n).toLocaleString('ru-RU'); }
function fmtCost(usd) { return (usd === null || usd === undefined) ? '—' : `$${Number(usd).toFixed(4)}`; }
function fmtDuration(ms) { return (ms === null || ms === undefined) ? '—' : `${(ms / 1000).toFixed(1)}s`; }
function fmtPercent(p) { return (p === null || p === undefined) ? '—' : `${p}%`; }
function fmtBool(v) { return v ? 'yes' : 'no'; }
// rate limit шлёт время сброса unix-секундами, а заполненность окна — долей 0…1
function fmtEpoch(sec) { return new Date(sec * 1000).toLocaleString('ru-RU'); }
function fmtShare(v) { return `${Math.round(v * 100)}%`; }
function truncate(s, n) { return s && s.length > n ? `${s.slice(0, n)}…` : (s || '');}

// toolInput приходит уже сериализованным в JSON (см. recordStep в SYSTEM/core/sessions-db.js) —
// распечатываем читаемо, если получится, иначе показываем как есть.
// Обычный JSON.stringify(…, null, 2) экранирует переносы строк внутри значений
// как «\n» — для многострочных полей вроде old_string/new_string (правки кода
// в toolInput) это превращает содержимое в одну нечитаемую строку. Поэтому
// многострочные строковые значения печатаем отдельным блоком с настоящими
// переносами строк, а не через JSON.stringify — сами данные при этом не меняются,
// меняется только то, как они выводятся на экран.
function formatJsonValue(value, indent) {
    const pad = '  '.repeat(indent);
    const childPad = '  '.repeat(indent + 1);
    if (value === null || value === undefined) return 'null';
    if (Array.isArray(value)) {
        if (value.length === 0) return '[]';
        const items = value.map((v) => `${childPad}${formatJsonValue(v, indent + 1)}`);
        return `[\n${items.join(',\n')}\n${pad}]`;
    }
    if (typeof value === 'object') {
        const keys = Object.keys(value);
        if (keys.length === 0) return '{}';
        const items = keys.map((k) => `${childPad}${JSON.stringify(k)}: ${formatJsonValue(value[k], indent + 1)}`);
        return `{\n${items.join(',\n')}\n${pad}}`;
    }
    if (typeof value === 'string' && value.includes('\n')) {
        const lines = value.split('\n').map((line) => childPad + line);
        return `"""\n${lines.join('\n')}\n${childPad}"""`;
    }
    return JSON.stringify(value);
}
function prettyJson(raw) {
    if (!raw) return '';
    try { return formatJsonValue(JSON.parse(raw), 0); } catch { return raw; }
}

// маленькие однотипные иконки (не эмодзи — свои SVG в стиле остального
// тулбара, см. .icon-button в index.html: 24×24 viewBox, stroke=currentColor,
// stroke-width 2, скруглённые концы) — по одной на тип карточки, чтобы роль
// читалась по форме и цвету чипа, а не по случайному эмодзи-глифу
const ICON_PATHS = {
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 20c0-4.4 3.6-7 8-7s8 2.6 8 7"/>',
    assistant: '<path d="M21 15a2 2 0 0 1-2 2H8l-4 4V5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2z"/>',
    thinking: '<path d="M13 2 4 14h6l-1 8 9-12h-6z"/>',
    tool: '<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>',
    hook: '<path d="M10.5 13.5a4 4 0 0 0 6 .4l2-2a4 4 0 0 0-5.6-5.6l-1.1 1.1"/><path d="M13.5 10.5a4 4 0 0 0-6-.4l-2 2a4 4 0 0 0 5.6 5.6l1.1-1.1"/>',
    system: '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="2" y1="14" x2="6" y2="14"/><line x1="10" y1="8" x2="14" y2="8"/><line x1="18" y1="16" x2="22" y2="16"/>',
    unknown: '<circle cx="12" cy="12" r="9"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2-3 4"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
    meta: '<circle cx="12" cy="12" r="9"/><line x1="12" y1="16" x2="12" y2="11"/><line x1="12" y1="8" x2="12.01" y2="8"/>',
};
function iconSvg(name) {
    const inner = ICON_PATHS[name] || ICON_PATHS.unknown;
    return `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
}

// атрибуты в разметке: id и подпись идут в option через escapeAttr — кавычка в
// id рвала атрибут, а одного замещения '<' подписи не хватало
function escapeAttr(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export {
    fmtTime, fmtNum, fmtCost, fmtDuration, fmtPercent, fmtBool, fmtEpoch, fmtShare,
    truncate, formatJsonValue, prettyJson, iconSvg, escapeAttr,
};