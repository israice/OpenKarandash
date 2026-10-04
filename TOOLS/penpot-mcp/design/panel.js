// Раскрытое состояние: сама панель выбора CLI.
const board = designBoard();
const old = penpotUtils.findShape((s) => s.name === 'Menu', board);
if (old) old.remove();

text(board, 'Section 2 eyebrow', '2 · РАСКРЫТОЕ СОСТОЯНИЕ', 64, 402, { size: 11, weight: 600, tracking: 1.4, color: C.textMute });

// Ножка от пилюли CLI к панели
box(board, 'Menu stem', 130, 322, 2, 12, { fill: C.accentDeep });

const menu = box(board, 'Menu', 64, 334, 452, 640, {
    fill: C.panel,
    radius: 18,
    stroke: C.hairline,
    shadows: panelShadow,
});
// Панель позиционируется вручную: у flex-колонки дети сбрасывали бы заданные
// координаты. Внутри пунктов и строк — наоборот, flex (см. helpers).
const m = menu;

// Поиск
const search = box(menu, 'Search', 12, 12, 428, 44, { fill: C.surface, radius: 12, stroke: C.hairline });
const sf = penpotUtils.addFlexLayout(search, 'row');
sf.columnGap = 10;
sf.alignItems = 'center';
sf.leftPadding = 13;
sf.rightPadding = 10;
icon(search, 'search', null, null, 16, C.textMute, 1.5, 'Search icon');
text(search, 'Search placeholder', 'Найти агента…', null, null, { size: 13, color: C.textMute });
// Подсказка «/» — с фиксированным размером: при auto-колонка схлопывается по
// содержимому и вытягивается по высоте родителя.
const kbd = box(search, 'Kbd hint', null, null, 26, 22, { fill: '#20242C', radius: 6, stroke: C.hairline });
const kf = penpotUtils.addFlexLayout(kbd, 'row');
kf.alignItems = 'center';
kf.justifyContent = 'center';
kf.horizontalSizing = 'fix';
kf.verticalSizing = 'fix';
text(kbd, 'Kbd label', '/', null, null, { size: 11, weight: 500, color: C.textDim });
text(search, 'Search count', '51', null, null, { size: 11.5, color: C.textMute });

const AGENTS = [
    { name: 'OpenCode', sub: 'свой коннектор · 12 моделей', color: ['#8FC0FF', '#3B6FD4'], state: 'Selected' },
    { name: 'Claude Code', sub: 'Anthropic · 14 моделей', color: ['#F0B48A', '#C4713F'], state: 'Hover' },
    { name: 'Codex', sub: 'OpenAI · 8 моделей', color: ['#9BE8C0', '#43B583'], state: 'Default' },
    { name: 'Hermes Agent', sub: 'свой коннектор · 21 модель', color: ['#C9B0FF', '#7E5BE0'], state: 'Default' },
    { name: 'Kilo Code', sub: 'Anthropic · 14 моделей', color: ['#FFD37A', '#DD9F31'], state: 'Default' },
    { name: 'Cline', sub: 'нет коннектора', color: ['#7FE3D4', '#2B9E90'], state: 'Default' },
];

// Пункты — инстансы компонента «Menu item», а не рисование заново: состояние
// переключается через switchVariant, содержимое переопределяется на инстансе.
const lib = penpot.library.local;
const itemComponent = lib.components.find((c) => c.name === 'Menu item');

const item = (parent, y, a) => {
    if (!itemComponent) throw new Error('нет компонента Menu item: прогони build.mjs целиком');
    const inst = itemComponent.instance();
    inst.name = `Item ${a.name}`;
    parent.appendChild(inst);
    penpotUtils.setParentXY(inst, 12, y);

    // Переопределения инстанса: подписи и цвет плитки — то, что различается у
    // разных агентов. Сама структура (радиус, акцентная черта, галочка) от
    // компонента не отклоняется.
    storage.design.errors = [];
    const step = (what, fn) => {
        try { fn(); } catch (e) { storage.design.errors.push(`${a.name}/${what}: ${e.message.slice(0, 120)}`); }
    };
    step('switch', () => inst.switchVariant(0, a.state));
    step('name', () => {
        for (const t of penpotUtils.findShapes((s) => s.type === 'text', inst)) {
            if (t.name === 'Kit item name') t.characters = a.name;
        }
    });
    step('sub', () => {
        for (const t of penpotUtils.findShapes((s) => s.type === 'text', inst)) {
            if (t.name === 'Kit item sub') {
                t.characters = a.sub;
                if (a.sub.startsWith('нет')) t.fills = [{ fillColor: C.warn, fillOpacity: 1 }];
            }
        }
    });
    step('tile', () => {
        const tile = penpotUtils.findShape((s) => s.name === 'Kit item logo', inst);
        tile.fills = [{
            fillColorGradient: {
                type: 'linear', startX: 0, startY: 0, endX: 0, endY: tile.height, width: tile.height,
                stops: [{ color: a.color[0], offset: 0 }, { color: a.color[1], offset: 1 }],
            },
        }];
    });
    step('letter', () => {
        const letter = penpotUtils.findShape((s) => s.name === 'Kit item letter', inst);
        letter.characters = a.name[0];
    });
    return inst;
};

// Группы
const groupHead = (parent, y, title, hint) => {
    const row = box(parent, 'Group ' + title, 24, y, 404, 22, {});
    text(row, 'Group title', title, 0, 4, { size: 10.5, weight: 600, tracking: 1.2, color: C.textMute });
    text(row, 'Group hint', hint, null, 4, { size: 10.5, color: C.textMute, align: 'right' });
    return row;
};

let y = 68;
const head1 = box(menu, 'Group head installed', 24, y, 404, 22, {});
text(head1, 'Group title', 'ПОДКЛЮЧЁННЫЕ', 0, 4, { size: 10.5, weight: 600, tracking: 1.2, color: C.textMute });
text(head1, 'Group hint', '1', null, 4, { size: 10.5, color: C.textMute, align: 'right' });
y += 26;
item(menu, y, AGENTS[0]);
y += 60;
box(menu, 'Divider', 12, y, 428, 1, { fill: C.hairline });
y += 12;

const head2 = box(menu, 'Group head catalog', 24, y, 404, 22, {});
text(head2, 'Group title', 'КАТАЛОГ OPENROUTER', 0, 4, { size: 10.5, weight: 600, tracking: 1.2, color: C.textMute });
text(head2, 'Group hint', '50', null, 4, { size: 10.5, color: C.textMute, align: 'right' });
y += 26;
for (const a of AGENTS.slice(1)) { item(menu, y, a); y += 60; }

// Заглушка Add — инстанс компонента: в коде пункт есть, но выбрать нельзя,
// поэтому отдельный компонент, а не вариант Menu item.
y += 4;
const add = lib.components.find((c) => c.name === 'Menu item add')?.instance();
if (!add) throw new Error('нет компонента Menu item add');
add.name = 'Item Add';
menu.appendChild(add);
penpotUtils.setParentXY(add, 12, y);

// Подвал: клавиатура
y += 62;
const foot = box(menu, 'Footer', 12, y, 428, 34, {});
const ff = penpotUtils.addFlexLayout(foot, 'row');
ff.columnGap = 12;
ff.alignItems = 'center';
ff.leftPadding = 4;
ff.horizontalSizing = 'fill';
ff.verticalSizing = 'fix';
const hints = [['↑ ↓', 'выбрать'], ['↵', 'применить'], ['esc', 'закрыть']];
// Подсказки клавиатуры: каждая — своя колонка с ключом и подписью. Размеры
// фиксированные: у auto-колонок считаются от содержимого, и колонки
// наезжают друг на друга.
for (const [key, label] of hints) {
    // Стартовая ширина ненулевая: resize(0, …) Penpot не принимает, а дальше
    // колонку пересчитывает flex по содержимому.
    const h = box(foot, 'Hint ' + label, null, null, 24, 22, {});
    const hf = penpotUtils.addFlexLayout(h, 'row');
    hf.columnGap = 6;
    hf.alignItems = 'center';
    hf.horizontalSizing = 'auto';
    hf.verticalSizing = 'fix';
    text(h, 'Key ' + key, key, null, 0, { size: 10.5, weight: 500, color: C.textDim });
    text(h, 'Key label', label, null, 0, { size: 10.5, color: C.textMute });
    foot.appendChild(h);
}
// Отметка «обновляется раз в час» — в правый край подвала, мимо потока:
// свойства layoutChild только читаются, поэтому позицию задаём снаружи.
const stamp = text(foot, 'Footer stamp', 'обновляется раз в час', null, null, { size: 10.5, color: C.textMute, align: 'right' });
foot.appendChild(stamp);

// Порядок в колонке задаётся порядком создания: дети flex-панели идут так,
// как их клали в children. Поэтому всё выше создаётся уже вложенным в menu.
text(board, 'Menu hint', 'Ширина 452 · высота по содержимому · список прокручивается, группы липнут к верху', 64, 994, { size: 11.5, color: C.textMute });

return { menu: menu.id, items: AGENTS.length };