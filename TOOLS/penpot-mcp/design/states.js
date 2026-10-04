// Правая колонка макета: состояния пунктов, правила поведения, палитра и токены.
const board = designBoard();
for (const n of ['States', 'Specs', 'Tokens']) {
    const s = penpotUtils.findShape((x) => x.name === n, board);
    if (s) s.remove();
}

const LX = 916;
const LW = 460;
const section = (y, eyebrow, title) => {
    text(board, 'Spec eyebrow ' + title, eyebrow, LX, y, { size: 11, weight: 600, tracking: 1.4, color: C.textMute });
    text(board, 'Spec title ' + title, title, LX, y + 20, { size: 20, weight: 600, tracking: -0.2 });
};

// 3 · Состояния
section(64, '3 · СОСТОЯНИЯ', 'Четыре вида пункта');

const STATES = [
    { key: 'По умолчанию', desc: 'прозрачный фон, подпись светлая, логотип в цвете агента' },
    { key: 'Наведение', desc: 'фон #1F232B, курсор, ничего не меняется по структуре' },
    { key: 'Выбрано', desc: 'фон #1B2634, обводка, акцентная черта слева, галочка справа' },
    { key: 'Недоступно (Add)', desc: 'пунктирная обводка, приглушённый текст, пункт не выбирается' },
];
const states = box(board, 'States', LX, 124, LW, 4 * 58 + 12, { fill: '#15181D', radius: 16, stroke: C.hairline });
STATES.forEach((s, i) => {
    const row = box(states, 'State ' + s.key, 16, 10 + i * 58, LW - 32, 48, {});
    const chip = box(row, 'State chip', 0, 8, 176, 32, {
        fill: i === 2 ? C.accentWash : i === 1 ? '#1F232B' : i === 3 ? null : '#171A20',
        radius: 10,
        stroke: i === 2 ? C.accentDeep : i === 3 ? C.hairline : null,
        dashed: i === 3,
    });
    const cf = penpotUtils.addFlexLayout(chip, 'row');
    cf.columnGap = 8;
    cf.alignItems = 'center';
    cf.leftPadding = 12;
    cf.horizontalSizing = 'auto';
    cf.verticalSizing = 'fill';
    text(chip, 'State name', s.key, null, null, { size: 12, weight: 500, color: i === 3 ? C.textDim : C.text });
    if (i === 2) icon(chip, 'check', null, null, 14, C.ok, 2, 'State check');
    // Подпись справа от плашки: ширину задаём от остатка строки, иначе текст
    // вылезает за карточку и за край доски. Карточка — на всю ширину колонки.
    text(row, 'State desc', s.desc, 196, 6, { size: 11.5, color: C.textDim, maxWidth: LW - 32 - 196, lineHeight: 1.35 });
});

// 4 · Правила
section(408, '4 · ПРАВИЛА', 'Что меняем в поведении');

const RULES = [
    ['Поиск', 'Фильтр по названию и по модели: «sonnet» находит Claude Code и Hermes Agent'],
    ['Группы', 'Сначала подключённые (их 1), потом каталог OpenRouter (50) — как в коде'],
    ['Вторичные подписи', 'Под именем — шлюз и число моделей либо «нет коннектора»'],
    ['Клавиатура', '↑ ↓ по списку, ↵ применить, / фокус в поиск, esc закрыть'],
    ['Add', 'Остаётся последним пунктом и остаётся заглушкой: виден, но не выбирается'],
    ['Пустой результат', 'Отдельный пустой состояние с подсказкой и сбросом фильтра'],
];
const rules = box(board, 'Specs', LX, 468, LW, RULES.length * 62 + 16, { fill: '#15181D', radius: 16, stroke: C.hairline });
RULES.forEach(([k, v], i) => {
    const row = box(rules, 'Rule ' + k, 16, 10 + i * 62, LW - 32, 52, {});
    text(row, 'Rule key', k, 0, 4, { size: 12.5, weight: 600, color: C.text });
    text(row, 'Rule desc', v, 0, 22, { size: 11.5, color: C.textDim, maxWidth: LW - 32 });
});

// 5 · Палитра
section(908, '5 · ПАЛИТРА И ТОКЕНЫ', 'Цвета и радиусы');

const swatches = [
    ['canvas', C.canvas], ['surface', C.surface], ['panel', C.panel], ['hairline', C.hairline],
    ['text', C.text], ['textDim', C.textDim], ['textMute', C.textMute],
    ['accent', C.accent], ['accentDeep', C.accentDeep], ['ok', C.ok], ['warn', C.warn],
];
// Образцы палитры — в два ряда: подписи длиннее самих плиток, в один ряд они
// наезжали друг на друга (это ловит lint, а на скриншоте почти не видно).
const sw = box(board, 'Tokens', LX, 968, LW, 128, { fill: '#15181D', radius: 16, stroke: C.hairline });
const PITCH = 72;
const PER_ROW = 6;
swatches.forEach(([name, hex], i) => {
    const col = i % PER_ROW;
    const row = Math.floor(i / PER_ROW);
    const x = 16 + col * PITCH;
    const y = 14 + row * 46;
    box(sw, 'Swatch ' + name, x, y, 28, 28, { fill: hex, radius: 8, stroke: C.hairline });
    text(sw, 'Swatch name ' + name, name, x, y + 32, { size: 8.5, color: C.textMute });
});
text(sw, 'Token note', 'color.* / space.* / radius.* — токены набора cli-dropdown, применяются к фигурам одним applyToken', 16, 104, { size: 10.5, color: C.textMute, maxWidth: LW - 32 });

return { states: STATES.length, rules: RULES.length, swatches: swatches.length };