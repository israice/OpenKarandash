// Библиотека компонентов: то, из чего дальше собираются экраны.
//
// Лежит на отдельной доске «Kit» рядом с макетом. Главные экземпляры — обычные
// фигуры; компонент создаётся из них, а на макете ставятся уже инстансы
// (component.instance()), где состояние переключается через switchVariant.
// Поэтому новый экран — это раскладка инстансов, а не рисование с нуля.
const board = penpotUtils.findShape((s) => s.name === 'Kit', penpot.root);
if (board) board.remove();

const kit = box(penpot.root, 'Kit', 2100, -40, 1200, 1180, { fill: C.canvas });
text(kit, 'Kit title', 'Kit · компоненты', 48, 40, { size: 24, weight: 600, tracking: -0.2 });
text(kit, 'Kit hint', 'Главные экземпляры. На макете ставятся инстансы: меняешь состояние через switchVariant, а не рисуешь заново.', 48, 76, { size: 12, color: C.textDim, maxWidth: 900 });

const made = [];
const component = (name, shapes) => {
    const lib = penpot.library.local;
    const exists = lib.components.find((c) => c.name === name);
    if (exists) return exists;
    const c = lib.createComponent(shapes);
    c.name = name;
    made.push(name);
    return c;
};

// ── Пункт меню: четыре состояния одним компонентом с осью State
const ITEM_W = 428;
const ITEM_H = 56;

const menuItem = (state) => {
    const selected = state === 'Selected';
    const hover = state === 'Hover';
    const off = state === 'Disabled';

    const it = box(kit, `Kit item ${state}`, 48, 140 + ['Default', 'Hover', 'Selected', 'Disabled'].indexOf(state) * (ITEM_H + 12), ITEM_W, ITEM_H, {
        fill: selected ? C.accentWash : hover ? '#1F232B' : null,
        radius: 12,
        stroke: selected ? C.accentDeep : null,
        dashed: off,
    });

    if (selected) box(it, 'Kit item accent', 0, 12, 3, 32, { fill: C.accent, radius: 2 });

    // Логотип: тот же плиточный квадрат, что и на макете, но без привязки к
    // конкретному агенту — инстанс перекрашивается через fill.
    const tile = box(it, 'Kit item logo', 14, 14, 28, 28, {
        radius: 8,
        gradient: [{ color: '#8FC0FF', offset: 0 }, { color: '#3B6FD4', offset: 1 }],
    });
    const letter = text(tile, 'Kit item letter', 'A', 0, 0, { size: 14, weight: 600, color: '#0B0E13', align: 'center', verticalAlign: 'center' });
    penpotUtils.setParentXY(letter, 14 - letter.width / 2, 14 - letter.height / 2);

    const col = box(it, 'Kit item text', 58, 11, 300, 34, {});
    const cf = penpotUtils.addFlexLayout(col, 'column');
    cf.rowGap = 1;
    cf.horizontalSizing = 'fix';
    cf.verticalSizing = 'auto';
    const name = text(col, 'Kit item name', 'OpenCode', null, null, { size: 13.5, weight: selected ? 600 : 500, color: off ? C.textMute : C.text });
    const sub = text(col, 'Kit item sub', 'свой коннектор · 12 моделей', null, null, { size: 11, color: off ? C.textMute : C.textMute });

    if (selected) icon(it, 'Kit item check', null, 20, 16, C.ok, 2, 'Kit item check icon');

    return it;
};

const states = ['Default', 'Hover', 'Selected', 'Disabled'];
// Сначала каждый экземпляр становится отдельным компонентом, потом они
// собираются в группу вариантов: createComponent не берёт фигуры, которые уже
// лежат внутри variant-контейнера.
const itemComponents = states.map((state) => component('Menu item ' + state, [menuItem(state)]));
const itemVariants = penpotUtils.createVariantContainer(
    itemComponents.map((c, i) => ({ shape: c.mainInstance(), properties: { State: states[i] } })),
);
itemVariants.name = 'Menu item';
// Контейнер вариантов создаётся в мировых координатах и в доску не попадает —
// возвращаем его внутрь Kit и ставим относительно неё.
kit.appendChild(itemVariants);
penpotUtils.setParentXY(itemVariants, 48, 140);

// ── Пилюля выбора уровня каскада: Idle / Active
const pill = (state) => {
    const active = state === 'Active';
    const p = box(kit, `Kit pill ${state}`, 48, 430 + ['Idle', 'Active'].indexOf(state) * 46, 220, 32, {
        fill: active ? C.accentWash : C.surface,
        radius: 16,
        stroke: active ? C.accentDeep : C.hairline,
    });
    const f = penpotUtils.addFlexLayout(p, 'row');
    f.columnGap = 7;
    f.alignItems = 'center';
    f.justifyContent = 'center';
    f.leftPadding = 13;
    f.rightPadding = 10;
    f.horizontalSizing = 'auto';
    f.verticalSizing = 'fill';
    text(p, 'Kit pill value', 'OpenCode', null, null, { size: 12.5, weight: active ? 500 : 400, color: active ? C.text : C.textDim });
    icon(p, 'Kit pill chevron', null, null, 12, active ? C.accent : C.textMute, 1.7, 'Kit pill chevron icon');
    return p;
};
const pillComponents = ['Idle', 'Active'].map((state) => component('Select pill ' + state, [pill(state)]));
const pillVariants = penpotUtils.createVariantContainer(
    pillComponents.map((c, i) => ({ shape: c.mainInstance(), properties: { State: ['Idle', 'Active'][i] } })),
);
pillVariants.name = 'Select pill';
kit.appendChild(pillVariants);
penpotUtils.setParentXY(pillVariants, 48, 500);

// ── Поиск
const search = box(kit, 'Kit search', 48, 700, 428, 44, { fill: C.surface, radius: 12, stroke: C.hairline });
const sf = penpotUtils.addFlexLayout(search, 'row');
sf.columnGap = 10;
sf.alignItems = 'center';
sf.leftPadding = 13;
sf.rightPadding = 10;
sf.horizontalSizing = 'fix';
sf.verticalSizing = 'fix';
icon(search, 'Kit search icon', null, null, 16, C.textMute, 1.5, 'Kit search icon path');
text(search, 'Kit search placeholder', 'Найти агента…', null, null, { size: 13, color: C.textMute });
component('Search field', [search]);

// ── Подпись раздела
const sectionLabel = box(kit, 'Kit section', 48, 764, 404, 22, {});
text(sectionLabel, 'Kit section title', 'КАТАЛОГ OPENROUTER', 0, 4, { size: 10.5, weight: 600, tracking: 1.2, color: C.textMute });
text(sectionLabel, 'Kit section hint', '50', null, 4, { size: 10.5, color: C.textMute, align: 'right' });
component('Section label', [sectionLabel]);

// ── Подсказка клавиатуры
const kbd = box(kit, 'Kit kbd', 48, 806, 26, 22, { fill: '#20242C', radius: 6, stroke: C.hairline });
const kf = penpotUtils.addFlexLayout(kbd, 'row');
kf.alignItems = 'center';
kf.justifyContent = 'center';
kf.horizontalSizing = 'fix';
kf.verticalSizing = 'fix';
text(kbd, 'Kit kbd label', '/', null, null, { size: 11, weight: 500, color: C.textDim });
component('Kbd hint', [kbd]);

// ── Карточка
const card = box(kit, 'Kit card', 48, 848, 428, 72, { fill: '#15181D', radius: 16, stroke: C.hairline });
component('Card', [card]);

// ── Заглушка Add: в коде пункт есть, но выбрать его нельзя, поэтому отдельный
// компонент, а не вариант Menu item — здесь другая структура (иконка слева,
// две подписи) и пунктир вместо заливки.
const addItem = box(kit, 'Kit add', 48, 940, 428, 48, { radius: R('item'), stroke: C.hairline, dashed: true });
const addF = penpotUtils.addFlexLayout(addItem, 'row');
addF.columnGap = 10;
addF.alignItems = 'center';
addF.leftPadding = 14;
addF.rightPadding = 12;
addF.horizontalSizing = 'fix';
addF.verticalSizing = 'fill';
icon(addItem, 'Kit add icon', null, null, 16, C.accent, 1.6, 'Kit add icon path');
const addCol = box(addItem, 'Kit add text', null, 9, 300, 30, {});
const addColF = penpotUtils.addFlexLayout(addCol, 'column');
addColF.rowGap = 1;
addColF.horizontalSizing = 'fix';
addColF.verticalSizing = 'auto';
text(addCol, 'Kit add title', 'Add CLI', null, null, { size: 13, weight: 500, color: C.textDim });
text(addCol, 'Kit add sub', 'заглушка — действия нет, пункт не выбирается', null, null, { size: 11, color: C.textMute });
addItem.appendChild(addCol);
component('Menu item add', [addItem]);

// ── Подпись раздела с подсказкой справа (варианты не нужны, но состояние
//    «есть счётчик / нет счётчика» встречается на разных экранах)
const divider = box(kit, 'Kit divider', 48, 1004, 428, 1, { fill: C.hairline });
component('Divider', [divider]);

// ── Пустое состояние: список есть, но фильтр ничего не нашёл
const empty = box(kit, 'Kit empty', 48, 1024, 428, 64, { fill: null, radius: R('item'), stroke: C.hairline, dashed: true });
const emptyF = penpotUtils.addFlexLayout(empty, 'row');
emptyF.columnGap = 10;
emptyF.alignItems = 'center';
emptyF.horizontalSizing = 'fix';
emptyF.verticalSizing = 'fill';
emptyF.leftPadding = 14;
const emptyCol = box(empty, 'Kit empty text', null, 12, 340, 40, {});
const emptyColF = penpotUtils.addFlexLayout(emptyCol, 'column');
emptyColF.rowGap = 1;
emptyColF.horizontalSizing = 'fix';
emptyColF.verticalSizing = 'auto';
text(emptyCol, 'Kit empty title', 'Ничего не нашлось', null, null, { size: 13, weight: 500, color: C.textDim });
text(emptyCol, 'Kit empty sub', 'сбросить фильтр', null, null, { size: 11, color: C.accent });
empty.appendChild(emptyCol);
component('Empty state', [empty]);

return {
    components: penpot.library.local.components.map((c) => c.name),
    created: made,
    kit: kit.id,
};