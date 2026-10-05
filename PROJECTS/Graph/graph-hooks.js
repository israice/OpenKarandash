// Индекс хуков интерфейса: где в коде создаётся класс или id и в каком файле он
// описан стилями. Нужен для одного — чтобы клик по элементу в Karandash сразу дал
// «файл:строка», а модель не искала место сама (DOCS/decisions/091).
//
// Живёт в той же базе, что и полнотекстовый индекс, и обновляется тем же проходом
// (его зовёт graph-search.js), но таблицы свои: FTS5 режет текст на токены, и
// имя `model-tag` разлетелось бы на `model` и `tag` — поиск по куску имени
// вернул бы сотни мест вместо одного. Здесь сравнение точное, по строке целиком.
//
// Модуль ничего не знает про сессии и про vault: пути и обход проекта берёт из
// graph-vault.js, а соединение с базой получает снаружи — иначе два открытых
// соединения к одному файлу WAL начали бы драться за блокировку (079).

const fs = require('fs');
const path = require('path');
const { projectFiles } = require('./graph-vault.js');

// файлы, в которых имеет смысл искать место элемента: разметка и её шаблоны.
// стили идут отдельно — там другое правило разбора и другая ценность находки
const MARKUP_EXT = /\.(js|mjs|cjs|jsx|ts|tsx|html|eta)$/i;
const STYLE_EXT = /\.css$/i;

// отпечаток файла — тот же, что в поисковом индексе (там он не вынесен наружу,
// а здесь понадобился: без сравнения отпечатков индекс хуков перечитывал бы весь
// проект целиком после каждой правки)
function fileStamp(file) {
    try {
        const stat = fs.statSync(file);
        return `${stat.size}:${Math.round(stat.mtimeMs)}`;
    } catch {
        return ''; // файла нет — в индексе ему не место
    }
}

// Имена, которые не стоят индексировать: короче трёх символов (классы `is`, `ok`
// не различают элементы) и начинающиеся не с буквы (сгенерированные имена).
// По этим правилам в индексе не окажется ни мусора, ни «util», «tmp» — им не
// отвечает ни один стиль, а вот `model-tag` отвечает
const HOOK_NAME = /^[A-Za-z][A-Za-z0-9_-]{2,}$/;

// классы и id, которые появляются прямо в коде: присваиванием, добавлением в
// список или разметкой. Именно такие строки и отвечают на вопрос «где здесь
// строится этот элемент» — их на проект единицы, тогда как само имя класса
// встречается десятки раз (замерено на плашке модели: 13 упоминаний против
// одного присваивания, DOCS/decisions/087)
const CLASS_ASSIGN = /className\s*[+]?=\s*['"`]([^'"`]*)['"`]/g;
const CLASS_LIST = /classList\.(?:add|remove|toggle)\s*\(\s*['"`]([^'"`]*)['"`]/g;
const CLASS_ATTR = /\bclass(?:Name)?\s*=\s*['"`]([^'"`]*)['"`]/g;
const ID_SET = /\bid\s*=\s*['"`]([^'"`]*)['"`]/g;
// поиск узла по имени — не место создания: разметка может быть в шаблоне, а
// искать её будут в десяти файлах. Вид 'ref' и стоит в самом низу порядка
const ID_LOOKUP = /(?:getElementById|\$\s*)\s*\(\s*['"`]#?([A-Za-z][\w-]*)['"`]/g;
// селектор в стиле: класс или id перед открывающей скобкой. Само правило не
// разбираем (медиазапросы, вложенность) — из строки берём только имена
const STYLE_SELECTOR = /([.#])([A-Za-z][\w-]+)[^{}\n]*\{/g;

function push(out, name, kind, line) {
    const hook = String(name || '').trim();
    if (HOOK_NAME.test(hook)) out.push({ hook, kind, line });
}

// Комментарии пропускаем: в них имя класса встречается как пример («вида
// `className = 'model-tag'`» в сборщике TOOLS/homework), и без этого фильтра
// комментарий выдавался за место создания элемента. Блок-комментарии считаем
// по флагу, а не по одной строке: многострочный /* … */ иначе утекает в индекс
// половиной своих строк.
//
// У блок-комментариев три закрытия, и каждое обязано выключать свой флаг: в JS
// это `*/`, в разметке и шаблонах .eta — `-->`. Пока флаг гасился только на
// `*/`, html-комментарий в шаблоне topbar.eta открывался на строке 28 и больше не
// закрывался: весь файл после него считался комментарием, и в индексе не оставалось
// ни одного хука — то есть клик по любому элементу верхнего меню не находил места
// в коде вовсе (проверено: scanHooks на SYSTEM/topbar.eta давал 0 из 164 строк)
function isComment(trimmed, state) {
    if (state.block) {
        const closer = state.closer || '*/';
        if (trimmed.includes(closer)) state.block = false;
        return true;
    }
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('<!--')) {
        // свой закрыватель запоминаем здесь же: у /* … */ он один, у <!-- … -->
        // другой, и по умолчанию гасить оба одним `*/` нельзя
        if (!trimmed.startsWith('//') && !trimmed.includes('*/') && !trimmed.includes('-->')) {
            state.block = true;
            state.closer = trimmed.startsWith('<!--') ? '-->' : '*/';
        }
        return true;
    }
    return false;
}

// что и на какой строке файла — построчный проход: номера строк нужны сами по
// себе, а регулярка по всему файлу их не отдаёт
function scanHooks(file, text) {
    const out = [];
    const style = STYLE_EXT.test(file);
    const state = { block: false };
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();
        if (style) {
            // в стиле важен только кусок до открывающей скобки: свойства внутри
            // правила значениями содержат точки и решётки, а селекторов там нет
            const head = line.slice(0, line.indexOf('{') + 1);
            if (head.includes('{')) {
                for (const m of head.matchAll(STYLE_SELECTOR)) push(out, m[2], 'style', i + 1);
            }
            continue;
        }
        if (!MARKUP_EXT.test(file)) continue;
        if (isComment(trimmed, state)) continue;
        for (const m of line.matchAll(CLASS_ATTR)) for (const c of m[1].split(/\s+/)) push(out, c, 'class', i + 1);
        for (const m of line.matchAll(CLASS_ASSIGN)) for (const c of m[1].split(/\s+/)) push(out, c, 'class', i + 1);
        for (const m of line.matchAll(CLASS_LIST)) for (const c of m[1].split(/\s+/)) push(out, c, 'class', i + 1);
        for (const m of line.matchAll(ID_SET)) push(out, m[1], 'id', i + 1);
        for (const m of line.matchAll(ID_LOOKUP)) push(out, m[1], 'ref', i + 1);
    }
    return out;
}

function initSchema(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS hooks (
            hook TEXT NOT NULL,
            file TEXT NOT NULL,
            line INTEGER NOT NULL,
            kind TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS hooks_by_name ON hooks(hook);
        CREATE TABLE IF NOT EXISTS hook_state (
            file  TEXT PRIMARY KEY,
            stamp TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS hook_scanner (
            version TEXT PRIMARY KEY
        );
    `);
}

// Версия разбора. Сборка инкрементальная и сравнивает только отпечаток файла, а
// отпечаток после правки самого разбора не меняется: файл тот же, timestamp тот
// же, и новые правила остались бы неприменёнными — навсегда, до следующей правки
// файла. Поэтому версия живёт отдельно и меняет всё: увидели новую, сбрасываем
// отметки, и следующая сборка перечитывает проект целиком.
//
// Свою версию поднимает любая правка scanHooks или isComment — то есть любое
// правило, по которому решается, попадёт ли строка в индекс. Правило такое и
// было применено на деле: правка закрытия html-комментария в .eta не дала
// эффекта, пока индекс не пересобрался по принуждению (проверено: karandashButton
// в topbar.eta находится сканером, но в базе оставался только в трёх .js).
const SCANNER_VERSION = '2';

function scannerIsCurrent(db) {
    const row = db.prepare('SELECT version FROM hook_scanner LIMIT 1').get();
    return row?.version === SCANNER_VERSION;
}

// сброс делается целиком, а не по отметкам. Отметки сбросить было бы мало:
// удалённые файлы остались бы в индексе навсегда — их больше ни в каком проходе
// не встретить, и строки осиротеют. Полная пересборка безопасна тем, что идёт
// внутри транзакции rebuildSearchIndex (журнал индекса): читатели пустоты не
// видят, а сбой откатывается вместе с ней
function markScannerChanged(db) {
    db.exec('DELETE FROM hooks; DELETE FROM hook_state; DELETE FROM hook_scanner;');
    db.prepare('INSERT INTO hook_scanner (version) VALUES (?)').run(SCANNER_VERSION);
}

// Пересборка инкрементальная, как у полнотекстового: обходим состав проекта,
// перечитываем только те файлы, чей отпечаток разошёлся, и переписываем их
// строки целиком (строк у файла десятки, а выборочно их вычеркнуть нечем).
// Что исчезло — убираем: иначе класс удалённого элемента годами указывал бы на
// строку, которой нет.
//
// Транзакцию здесь не открываем: зовёт нас rebuildSearchIndex, и она уже держит
// открытой свою (вложенная BEGIN в SQLite роняет всю сборку индекса целиком).
// Своего отката у нас нет — он есть у вызывающего, и ошибка уходит в его catch
const ROOT = path.resolve(__dirname, '..', '..');

function syncHooks(db) {
    // правила разбора поменялись — весь проект перечитывается заново
    if (!scannerIsCurrent(db)) markScannerChanged(db);

    const files = projectFiles().filter((f) => MARKUP_EXT.test(f) || STYLE_EXT.test(f));
    const known = new Map(db.prepare('SELECT file, stamp FROM hook_state').all().map((r) => [r.file, r.stamp]));
    const kept = new Set();
    const dropRows = db.prepare('DELETE FROM hooks WHERE file = ?');
    const dropState = db.prepare('DELETE FROM hook_state WHERE file = ?');
    const insert = db.prepare('INSERT INTO hooks(hook, file, line, kind) VALUES (?, ?, ?, ?)');
    const writeState = db.prepare('INSERT INTO hook_state(file, stamp) VALUES (?, ?) ON CONFLICT(file) DO UPDATE SET stamp = excluded.stamp');

    for (const file of files) {
        const stamp = fileStamp(path.join(ROOT, file));
        if (!stamp) continue;
        kept.add(file);
        if (known.get(file) === stamp) continue;
        let text = '';
        try { text = fs.readFileSync(path.join(ROOT, file), 'utf8'); } catch { continue; }
        dropRows.run(file);
        for (const { hook, kind, line } of scanHooks(file, text)) insert.run(hook, file, line, kind);
        writeState.run(file, stamp);
    }
    for (const file of known.keys()) {
        if (kept.has(file)) continue;
        dropRows.run(file);
        dropState.run(file);
    }
}

// Порядок находок отвечает на вопрос «где это править», поэтому он такой:
// сначала id (в проекте он уникален), потом место создания класса, потом стиль.
// Внутри одной ценности — файл с наименьшим числом упоминаний: он и есть
// главный, а не тот, где класс случайно упомянут в шаблоне или комментарии
const KIND_ORDER = { id: 0, class: 1, style: 2 };

// Объявление в разметке и поиск узла по id — разные вещи, и раньше индекс отдавал
// их одним видом. Из-за этого местом создания кнопки карандаш назывался
// `karandash.js:19` — строка `document.getElementById('karandashButton')`, то есть
// место, где кнопку ИЩУТ, а не где она создана; сама разметка жила в
// SYSTEM/topbar.eta:132 и в тройку первых не попадала вовсе. Теперь поиск —
// отдельный вид в самом низу: он отвечает на вопрос «кто этим пользуется», и
// полезен после того, как место уже найдено, а не вместо него
const REF_ORDER = 3;

function findHooks(db, names, limit = 6) {
    const query = db.prepare('SELECT file, line, kind FROM hooks WHERE hook = ?');
    const byFile = new Map();
    for (const name of [...new Set(names || [])]) {
        for (const row of query.all(String(name))) {
            if (!byFile.has(row.file)) byFile.set(row.file, { file: row.file, rows: [] });
            const entry = byFile.get(row.file);
            const known = entry.rows.some((r) => r.line === row.line && r.kind === row.kind);
            if (!known) entry.rows.push({ line: row.line, kind: row.kind, hook: name });
        }
    }
    const rank = (kind) => (kind === 'ref' ? REF_ORDER : (KIND_ORDER[kind] ?? 4));
    const score = ({ rows }) => {
        const best = Math.min(...rows.map((r) => rank(r.kind)));
        return [best, rows.length, rows[0].file];
    };
    const ranked = [...byFile.values()].sort((a, b) => {
        const [ka, na, fa] = score(a);
        const [kb, nb, fb] = score(b);
        return (ka - kb) || (na - nb) || (fa < fb ? -1 : 1);
    });
    return ranked.slice(0, limit).map(({ file, rows }) => ({
        file,
        // вид файла — лучший из его строк: объявление в разметке важнее поиска
        // узла по тому же имени, даже если поисков в том же файле больше
        kind: [...rows].sort((a, b) => rank(a.kind) - rank(b.kind))[0].kind,
        hook: rows.map((r) => r.hook).sort((a, b) => a.length - b.length)[0],
        lines: rows.map((r) => r.line).sort((a, b) => a - b).slice(0, 6),
    }));
}

module.exports = { initSchema, syncHooks, scanHooks, findHooks };
