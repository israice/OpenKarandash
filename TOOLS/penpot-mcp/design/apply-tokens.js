// Токены применяются к живым фигурам, а не только лежат в наборе: цвет,
// радиус и отступ приходят из cli-dropdown, и в коде шага литералов нет.
const menu = penpotUtils.findShape((s) => s.name === 'Menu', penpot.root);
const tokens = penpot.library.local.tokens;
const applied = [];
const problems = [];
const give = (shape, name, props) => {
    const token = penpotUtils.findTokenByName(name);
    if (!shape || !token) { problems.push(`нет ${name} или фигуры`); return; }
    shape.applyToken(token, props);
    applied.push(`${shape.name} ← ${name}`);
};

// Панель: радиус из токена, поверхности — из цветовых.
give(menu, 'radius.menu', ['borderRadiusTopLeft', 'borderRadiusTopRight', 'borderRadiusBottomLeft', 'borderRadiusBottomRight']);
const search = penpotUtils.findShape((s) => s.name === 'Search', menu);
give(search, 'color.surface', ['fill']);
const searchPlaceholder = penpotUtils.findShape((s) => s.name === 'Search placeholder', menu);
give(searchPlaceholder, 'color.textMute', ['fill']);

// Пункты: радиус пункта и цвет подписи состояния.
const selected = penpotUtils.findShape((s) => s.name === 'Item OpenCode', menu);
give(selected, 'radius.item', ['borderRadiusTopLeft', 'borderRadiusTopRight', 'borderRadiusBottomLeft', 'borderRadiusBottomRight']);
const selectedName = penpotUtils.findShape((s) => s.name === 'Kit item name', selected);
give(selectedName, 'color.text', ['fill']);
const selectedSub = penpotUtils.findShape((s) => s.name === 'Kit item sub', selected);
give(selectedSub, 'color.textMute', ['fill']);

// Заглушка Add — инстанс компонента, поэтому ищем её подписи по именам из
// components.js, а не по именам, что были до перехода на компоненты.
const add = penpotUtils.findShape((s) => s.name === 'Item Add', menu);
const addTitle = penpotUtils.findShape((s) => s.name === 'Kit add title', menu);
give(addTitle, 'color.textDim', ['fill']);

// Поиск, группы и подвал в том же духе: токены на ключевые поверхности, а не
// на всё подряд — иначе правка темы перестаёт быть управляемой.

// Акцентная черта выбранного пункта.
const accentBar = penpotUtils.findShape((s) => s.name === 'Kit item accent', selected);
give(accentBar, 'color.accent', ['fill']);

// Ждём применения: applyToken асинхронный, значения проявляются не сразу.
await new Promise((r) => setTimeout(r, 200));
const check = penpotUtils.findShape((s) => s.name === 'Search', menu);
// Молча пропущенный токен — это разъехавшаяся тема, а не мелочь: падаем.
if (problems.length) throw new Error(`apply-tokens: ${problems.join('; ')}`);
return { applied, searchFill: check?.fills?.[0]?.fillColor ?? null };