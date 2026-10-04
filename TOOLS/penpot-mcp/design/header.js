// Шапка макета и закрытое состояние: четыре уровня каскада в строке сессии.
const board = designBoard();

// Панель и правая колонка строятся другими шагами — их не трогаем: чистим только
// верхний уровень доски и оставляем то, что уже собрано.
const KEEP = ['Panel', 'Menu', 'States', 'Specs', 'Tokens'];
const keep = new Set(KEEP.map((n) => penpotUtils.findShape((s) => s.name === n, board)).filter(Boolean));
board.children.filter((s) => !keep.has(s)).forEach((s) => s.remove());
[...keep].forEach((s) => board.appendChild(s));

// Шапка макета
text(board, 'Board eyebrow', 'SESSION HEADER  ·  MODEL CASCADE', 64, 56, { size: 11, weight: 600, tracking: 1.6, color: C.accent });
text(board, 'Board title', 'CLI dropdown', 64, 78, { size: 34, weight: 600, tracking: -0.4 });
text(board, 'Board subtitle', 'Вместо нативного select на 51 пункт: поиск, две группы, иконки, вторичные подписи, состояния и клавиатура. Сверху — вид в шапке сессии, справа — состояния и правила.', 64, 130, { size: 13, color: C.textDim, maxWidth: 640 });

// Закрытое состояние
text(board, 'Section 1 eyebrow', '1 · ЗАКРЫТОЕ СОСТОЯНИЕ', 64, 212, { size: 11, weight: 600, tracking: 1.4, color: C.textMute });

const header = box(board, 'Header strip', 64, 236, 812, 62, { fill: C.surface, radius: 16, stroke: C.hairline });
const row = box(header, 'Pills row', 16, 14, 780, 34, {});
const rf = penpotUtils.addFlexLayout(row, 'row');
rf.columnGap = 7;
rf.alignItems = 'center';
rf.horizontalSizing = 'fill';
rf.verticalSizing = 'fix';

const levels = [
    { key: 'CLI', value: 'OpenCode', active: true },
    { key: 'Gateway', value: 'openrouter' },
    { key: 'Provider', value: '—' },
    { key: 'Model', value: 'opencode/claude-sonnet-5' },
];
for (const lv of levels) {
    const lab = text(row, 'Label ' + lv.key, lv.key + ':', null, null, { size: 12, color: C.textMute });
    const pill = box(row, 'Pill ' + lv.key, null, null, Math.max(lv.value.length * 7.4 + 48, 92), 32, {
        fill: lv.active ? C.accentWash : C.surface,
        radius: 16,
        stroke: lv.active ? C.accentDeep : C.hairline,
    });
    const pf = penpotUtils.addFlexLayout(pill, 'row');
    pf.columnGap = 7;
    pf.alignItems = 'center';
    pf.justifyContent = 'center';
    pf.leftPadding = 13;
    pf.rightPadding = 10;
    pf.horizontalSizing = 'auto';
    pf.verticalSizing = 'fill';
    text(pill, 'Value ' + lv.key, lv.value, null, null, { size: 12.5, weight: lv.active ? 500 : 400, color: lv.active ? C.text : C.textDim });
    icon(pill, 'chevron', null, null, 12, lv.active ? C.accent : C.textMute, 1.7, 'Chevron ' + lv.key);
    lab.parent.appendChild(pill);
}

// Кольцо фокуса вокруг пилюли CLI
box(board, 'Focus ring', 66, 238, 134, 58, { radius: 15, stroke: C.accent, strokeWidth: 1, dashed: true, opacity: 0.55 });
text(board, 'Header hint', 'Курсор на CLI — пилюля с обводкой #6EA8FE; дальше раскрывается список агентов', 64, 316, { size: 11.5, color: C.textMute });

return { header: header.id, levels: levels.length };