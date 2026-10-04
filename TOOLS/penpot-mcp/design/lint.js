// Проверка вёрстки без скриншота: текст, вылезающий из родителя, наезд
// сиблингов, выход за доску, текст без контраста. Раньше это ловилось глазами
// по скриншоту — медленно и неполно. Здесь ответ приходит списком проблем.
//
//   node TOOLS/penpot-mcp/design/build.mjs --check
//
// Допуски взяты из практики: 0.75 на антиалиасинг текста, 2 на округление
// флекс-раскладки. Всё, что длиннее этих чисел, — уже настоящий наезд.
const SLOP = 2;
const TEXT_SLOP = 1.5;
const OVERLAP_MIN = 6;

// Список досок задаётся здесь, а не через переменные окружения: в execute_code
// нет `process`.
const boards = ['CLI dropdown', 'Kit'];

const hasPaint = (s) => {
    const f = s.fills;
    const st = s.strokes;
    return (Array.isArray(f) && f.length > 0) || (Array.isArray(st) && st.length > 0);
};
const isContainer = (s) => (s.type === 'board' || s.type === 'group') && (s.flex || s.type === 'board');
// opacity у части фигур не задан вовсе, поэтому 1 как значение по умолчанию:
// без этого `undefined > 0` отсекал всё дерево обхода и линтер молчал.
const visible = (s) => s.visible && !s.hidden && (s.opacity ?? 1) > 0;

const problems = [];
const add = (kind, where, detail, extra = {}) => problems.push({ kind, where, detail, ...extra });

for (const name of boards) {
    const board = penpotUtils.findShape((s) => s.name === name, penpot.root);
    if (!board) { add('missing-board', name, 'доска не найдена'); continue; }

    // Главное, без чего проверка бессмысленна: ширина и высота текста равны 1 px
    // до расчёта вёрстки. Все размеры — только после await, иначе линтер видит
    // «пустые» тексты и не ловит переполнение.
    await board.waitForLayoutUpdate();

    const inBoard = (x, y, w, h) => x >= board.x - SLOP && y >= board.y - SLOP
        && x + w <= board.x + board.width + SLOP && y + h <= board.y + board.height + SLOP;

    // 1. Выход фигуры за пределы доски
    for (const s of penpotUtils.findShapes((x) => x.parent === board && visible(x), board)) {
        if (!inBoard(s.x, s.y, s.width, s.height)) {
            add('outside-board', `${name}/${s.name}`,
                `(${Math.round(s.x)},${Math.round(s.y)}) ${Math.round(s.width)}×${Math.round(s.height)} не влезает в ${board.width}×${board.height}`);
        }
    }

    // 2. Фигура шире/выше родителя — верный признак наехавшей вёрстки
    for (const s of penpotUtils.findShapes((x) => x !== board && x.parent && visible(x), board)) {
        const p = s.parent;
        if (!p || !visible(p)) continue;
        if (s.width > p.width + SLOP || s.height > p.height + SLOP) {
            add('bigger-than-parent', `${name}/${s.name}`,
                `${Math.round(s.width)}×${Math.round(s.height)} > ${p.name} ${Math.round(p.width)}×${Math.round(p.height)}`);
        }
    }

    // 3. Наезд сиблингов внутри одного контейнера. Сравниваем только то, что
    //    что-то красит: у прозрачной плашки-обёртки наезда не видна.
    const containers = penpotUtils.findShapes((x) => isContainer(x) && visible(x), board);
    for (const c of containers) {
        const kids = c.children.filter((k) => visible(k) && hasPaint(k) && k.width > 1 && k.height > 1);
        for (let i = 0; i < kids.length; i++) {
            for (let j = i + 1; j < kids.length; j++) {
                const a = kids[i];
                const b = kids[j];
                const ox = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
                const oy = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
                if (ox > OVERLAP_MIN && oy > OVERLAP_MIN) {
                    add('overlap', `${name}/${c.name}`,
                        `${a.name} × ${b.name} на ${Math.round(ox)}×${Math.round(oy)}`,
                        { a: a.name, b: b.name, ox: Math.round(ox), oy: Math.round(oy) });
                }
            }
        }
    }

    // 4. Текст, вылезающий из родителя: сравниваем текстовые границы с боксом
    //    ближайшего контейнера, а не родителя вообще — иначе ругается на всё
    //    подряд, потому что колонка-обёртка всегда меньше доски.
    //    Размеры текста читаются только после await на самом тексте: до него
    //    width/height равны 1 px, и переполнение не видно. await на доске не
    //    помогает — он не ждёт текстовых потомков.
    for (const t of penpotUtils.findShapes((x) => x.type === 'text' && visible(x), board)) {
        await t.waitForLayoutUpdate();
        const b = t.textBounds || { x: t.x, y: t.y, width: t.width, height: t.height };
        let host = t.parent;
        while (host && host !== board) {
            if (isContainer(host) && host.flex) break;
            host = host.parent;
        }
        if (!host || host === board) continue;
        const over = {
            left: Math.round(host.x - b.x),
            right: Math.round((b.x + b.width) - (host.x + host.width)),
            top: Math.round(host.y - b.y),
            bottom: Math.round((b.y + b.height) - (host.y + host.height)),
        };
        const worst = Object.entries(over).filter(([, v]) => v > TEXT_SLOP);
        if (worst.length) {
            add('text-overflow', `${name}/${t.name}`,
                `«${t.characters.slice(0, 40)}» из ${host.name}: ${worst.map(([k, v]) => `${k} +${v}`).join(', ')}`,
                { host: host.name, over });
        }
    }

    // 5. Текст без заливки или с заливкой в цвет фона — нечитаемо, а скриншот
    //    этого не покажет: цвет есть, но совпадает с подложкой.
    for (const t of penpotUtils.findShapes((x) => x.type === 'text' && visible(x), board)) {
        const f = Array.isArray(t.fills) ? t.fills[0] : null;
        if (!f || !f.fillColor) { add('text-no-fill', `${name}/${t.name}`, 'нет заливки'); continue; }
        const host = t.parent;
        const bg = host && Array.isArray(host.fills) ? host.fills[0]?.fillColor : null;
        if (bg && bg.toLowerCase() === String(f.fillColor).toLowerCase()) {
            add('text-invisible', `${name}/${t.name}`, `цвет текста = фон ${bg}`);
        }
    }

    // 6. Ступенчатая сетка: отступы, кратные 4, иначе разъезжаются на 1-2 px
    for (const s of penpotUtils.findShapes((x) => x.parent === board && visible(x) && x.type === 'board', board)) {
        if (s.x % 4 !== 0 || s.y % 4 !== 0) {
            add('off-grid', `${name}/${s.name}`, `(${Math.round(s.x)},${Math.round(s.y)}) — не кратно 4`);
        }
    }
}

const byKind = {};
for (const p of problems) byKind[p.kind] = (byKind[p.kind] || 0) + 1;
return { total: problems.length, byKind, problems: problems.slice(0, 60) };