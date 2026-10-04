// Сбор отчёта по задаче: исполняет то, что насчитали якоря (anchors.js).
// Ходов модели здесь нет вообще — только rg, полнотекстовый индекс проекта и
// чтение найденного. На выходе — отчёт, с которым модель сразу правит.
//
// Почему сбор не доверяют модели: в разобранных сессиях разведка занимала
// 45–58 % всех шагов (45 из 77, 39 из 89, 35 из 61) и 143–182 тыс. символов
// вывода инструментов, которые потом перечитывались как кэш. Здесь та же работа
// стоит одного запуска и ~7 КБ отчёта (замерено на задаче про цвет пункта).
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { anchorsOf, rulesOf, ROOT } = require('./anchors.js');

// что не ищем никогда: индексы, вендор и то, что сервер собрал сам. Собственная
// папка TOOLS/homework тоже — иначе отчёт по любой задаче начинается с кода
// сборщика (он ищет те же классы, что и задача про стили селекта).
const GLOBS = ['*.js', '*.mjs', '*.css', '*.html', '*.eta', '*.json'];
const IGNORE = ['node_modules', 'DATA', '.git', 'vendor', 'penpot-mcp', 'TOOLS/homework'];

function run(file, args, timeout = 30000) {
    // На Windows путь к node может лежать в папке с пробелом («C:\Program
    // Files\nodejs\node.exe»), и cmd без кавычек режет его на два слова.
    // Кавычки нужны только исполняемому файлу: аргументы node экранирует сам, а
    // наш собственный кавычками ломает запросы rg (проверено — отчёт пустел).
    // Обходимся без shell:true: с ним node предупреждает, что аргументы не
    // экранируются (DEP0190)
    try {
        return execFileSync(file, args, {
            cwd: ROOT, encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'],
        }) || '';
    } catch (e) {
        // rg при «не нашлось» возвращает не ноль, а 1 — это не ошибка
        return String(e.stdout || '') || '';
    }
}

// точный поиск по коду: якоря из «UI element» находятся точно или не находятся.
// Якорей несколько, и специфичность у них разная: `.provider__select--source`
// живёт в одном файле, а `icon-button` — в десятке. Поэтому ищем по одному и
// отбрасываем те, что нашлись слишком широко: иначе общий класс вытесняет
// точный селектор и отчёт уводит не туда (проверено на задаче про цвет пункта —
// якорь `chatView` давал 42 попадания и задавил всё остальное).
const TOO_WIDE = 12;

function rgAnchors(code) {
    const out = [];
    const wide = [];
    for (const anchor of code) {
        const args = ['-n', '--no-heading', '-c'];
        for (const g of GLOBS) args.push('-g', g);
        for (const dir of IGNORE) args.push('-g', `!${dir}`);
        args.push(anchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), '.');
        const counts = run('rg', args).split('\n')
            .map((l) => l.match(/^(.+?):(\d+)$/))
            .filter(Boolean)
            .map(([, file, n]) => ({ file: file.replace(/^\.\//, '').replace(/\\/g, '/'), n: Number(n) }));
        const total = counts.reduce((sum, c) => sum + c.n, 0);
        if (!total) continue;
        if (total > TOO_WIDE) { wide.push(`${anchor} (${total})`); continue; }
        out.push({ anchor, counts, total });
    }
    // узкие якоря первыми: по ним и начинается отчёт
    out.sort((a, b) => a.total - b.total);
    return { anchors: out, wide };
}

// содержимое найденного: конкретные строки с номерами
function rgDetail(anchor) {
    const args = ['-n', '--no-heading'];
    for (const g of GLOBS) args.push('-g', g);
    for (const dir of IGNORE) args.push('-g', `!${dir}`);
    args.push(anchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), '.');
    return run('rg', args);
}

// полнотекстовый индекс проекта — правило 1 AGENTS.override.md.
// Только код: в индексе лежат ещё заметки прошлых сессий, и на запрос из
// человеческого текста они находятся лучше кода — поиск возвращал прошлую
// сессию с тем же текстом задачи (замерено). Код полезнее: он и есть цель.
function graphSearch(phrase) {
    const out = run(process.execPath, [path.join(ROOT, 'PROJECTS', 'Graph', 'search.js'), '--kind', 'code', phrase]);
    return out.trim() && out.trim() !== 'Nothing found.' ? out.trim() : '';
}

// файлы, где символ встречается, с номерами строк: из них потом читаем окна
function hitsByFile(rgOut) {
    const map = new Map();
    for (const line of rgOut.split('\n')) {
        const m = line.match(/^(.+?):(\d+):/);
        if (!m) continue;
        const rel = m[1].replace(/^\.\//, '').replace(/\\/g, '/');
        if (!map.has(rel)) map.set(rel, []);
        map.get(rel).push(Number(m[2]));
    }
    return map;
}

// окно вокруг попадания: правило 2 AGENTS.override.md — не читать файл целиком,
// если меняться в нём не собираешься
function windowAround(lines, at, before = 6, after = 14) {
    const from = Math.max(0, at - before);
    const to = Math.min(lines.length, at + after);
    return lines.slice(from, to).map((l, i) => `${from + i + 1}: ${l}`).join('\n');
}

function section(title, body) {
    return body && body.trim() ? `## ${title}\n${body.trim()}\n` : '';
}

function collect(message, opts = {}) {
    const { code, phrases, kind } = anchorsOf(message);
    const parts = [];
    parts.push(`# Домашняя работа по задаче\n\nТип задачи: ${kind ? kind.id : 'не опознан'}.`);

    const { anchors, wide } = rgAnchors(code);

    // Ни одного якоря, который нашёлся узко, — значит от собранного отчёта
    // толку нет: человек описал место словами («сперва Home, потом та
    // страница»), а в коде это `defaultView`/`lastView`, которых в сообщении
    // нет. Молча отдавать пустой отчёт хуже, чем сказать прямо: модель начнёт
    // разведку с нуля, но хотя бы не поверит, что искать больше негде.
    if (!anchors.length) {
        parts.push(section('Отчёт пустой — и это факт',
            [
                code.length
                    ? `Якоря из сообщения: ${code.join(', ')}. Каждый нашёлся шире ${TOO_WIDE} попаданий (список ниже) — это слишком общие имена, по ним отчёт врёт.`
                    : 'В сообщении не оказалось ни класса, ни идентификатора, ни имени файла: описано место словами, а не через элемент интерфейса.',
                'Настоящие имена в коде при этом есть (для «первой открывается Home» это `defaultView` и `lastView` в SYSTEM/index.html и SYSTEM/tabs.js), но вывести их из текста нельзя — нужен слой смыслового разбора.',
                'Что делать: спроси у человека, какой элемент или файл трогать (кликнуть по нему в интерфейсе даёт строку «UI element: …» с точными якорями), либо искать самому одним `node PROJECTS/Graph/search.js "2-4 слова"` — это один шаг вместо тридцати.',
            ].join('\n')));
    }

    // точные попадания по символам — самое ценное, идёт первым
    const seenFiles = new Set();
    for (const { anchor, counts } of anchors) {
        const detail = hitsByFile(rgDetail(anchor));
        for (const [file, ats] of detail) {
            // файл уже показан по более точному якорю — второй раз не читаем
            if (seenFiles.has(file) && (opts.perAnchor ?? 2) > 0) continue;
            const full = path.join(ROOT, file);
            let lines;
            try { lines = fs.readFileSync(full, 'utf8').split('\n'); } catch { continue; }
            const chunks = [];
            const seen = new Set();
            // потолок окон на файл — 6, а не 3: в файле правил селекта семь
            // попаданий, и на третьем окне обрывалось как раз на правилах
            // выбранного и невыбранного пункта — то есть на самой задаче
            for (const at of ats.slice(0, opts.perFile ?? 6)) {
                const key = Math.floor(at / 20);
                if (seen.has(key)) continue;
                seen.add(key);
                chunks.push(windowAround(lines, at - 1));
            }
            seenFiles.add(file);
            parts.push(section(`Файл ${file} (${lines.length} строк) — якорь «${anchor}», строки ${ats.slice(0, 12).join(', ')}`,
                chunks.join('\n...\n')));
        }
        void counts;
    }

    // при пустом отчёте поиск по фразам только мешает: он находит по словам
    // человека не то (замерено — «был последний раз» нашло записку про pi), и
    // модель потратит на это шаг впустую
    if (anchors.length) {
        for (const p of phrases) {
            parts.push(section(`Поиск по проекту: «${p}»`, graphSearch(p).split('\n').slice(0, 14).join('\n')));
        }
    }

    const rules = rulesOf(kind?.id);
    if (rules) {
        parts.push(section('Правила этого типа задачи',
            [`Файл: ${rules.file} (${rules.lines} строк)`, `Как проверить: ${rules.check}`].join('\n')));
    }

    parts.push(section('Живая проверка — сначала посмотри, отвечает ли сервер',
        'node TOOLS/live-verify/run.mjs open view=all — без работающего сервера результат врёт'));

    if (wide.length) {
        parts.push(section('Якоря отброшены как слишком общие', wide.join(', ')));
    }

    const report = parts.filter(Boolean).join('\n');
    return { report, code, phrases, kind, files: [...seenFiles], chars: report.length };
}

module.exports = { collect, rgAnchors, graphSearch, hitsByFile };