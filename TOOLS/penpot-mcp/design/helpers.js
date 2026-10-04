// Общие помощники дизайна. Этот файл не выполняется сам: build.mjs подставляет
// его начало в каждый шаг, поэтому шаги независимы друг от друга и порядок
// запуска не важен.
// Палитра и типографика приходят из theme.json (подставляется как THEME в
// build.mjs). storage переживает вызовы execute_code, поэтому недостающие
// ключи дописываем: иначе шаг, написанный раньше, отработает с неполной
// палитрой молча и уедет цветом.
const C_DEFAULT = (typeof THEME !== 'undefined' && THEME.color) || {
    canvas: '#111318', surface: '#1A1D24', panel: '#181B21', panelTop: '#20242C',
    hairline: '#262A33', text: '#EEF2F8', textDim: '#9AA1AD', textMute: '#6C7480',
    accent: '#6EA8FE', accentDeep: '#2F4A75', accentWash: '#1B2634', ok: '#5BD6A0', warn: '#E8B45C',
};
storage.design = storage.design || {};
storage.design.C = { ...C_DEFAULT, ...(storage.design.C || {}) };
const C = storage.design.C;
const FONT = (typeof THEME !== 'undefined' && THEME.type && THEME.type.family) || 'Inter';

// Типографические роли: 'eyebrow' вместо size/weight/tracking по месту. Так
// правка заголовка в theme.json меняет все надписи разом.
const T = (role) => (typeof THEME !== 'undefined' && THEME.type && THEME.type[role]) || {};
const R = (role) => (typeof THEME !== 'undefined' && THEME.radius && THEME.radius[role]) || 0;

// Иконки — SVG-строки: у Path в этом API нет fromSVG, зато createShapeFromSvg
// возвращает готовую группу с обводкой, которую потом можно перекрасить.
const ICONS = {
    chevron: 'M4 6.5 L8 10.5 L12 6.5',
    check: 'M3.5 8.5 L6.5 11.5 L12.5 4.5',
    search: 'M11 7.5 A3.5 3.5 0 1 1 4 7.5 A3.5 3.5 0 0 1 11 7.5 Z M12.6 12.6 L15.2 15.2',
    plug: 'M6 2.5 V6 M10 2.5 V6 M4 6 H12 V8.5 A4 4 0 0 1 4 8.5 Z M8 12.5 V14.5',
    plus: 'M8 3 V13 M3 8 H13',
    corner: 'M13 3 V9 A2 2 0 0 1 11 11 H5',
    clock: 'M8 2.5 A5.5 5.5 0 1 1 7.99 2.5 Z M8 5 V8.2 L10.2 9.6',
    bolt: 'M9 1.5 L4 9 H7.5 L6.5 14.5 L12 7 H8.5 Z',
};

const put = (parent, shape, x, y) => {
    parent.appendChild(shape);
    if (x !== null && x !== undefined) penpotUtils.setParentXY(shape, x, y);
    return shape;
};

// Фигура с заливкой/обводкой/радиусом/тенью. Контейнером может быть только
// board или group — прямоугольник потомков не принимает (appendChild падает).
const box = (parent, name, x, y, w, h, o = {}) => {
    const b = penpot.createBoard();
    b.name = name;
    b.resize(w, h);
    if (o.gradient) {
        b.fills = [{
            fillColorGradient: {
                type: 'linear',
                startX: 0, startY: 0, endX: o.gradientAngle === 'x' ? b.width : 0, endY: o.gradientAngle === 'x' ? 0 : b.height,
                width: o.gradientAngle === 'x' ? b.width : b.height,
                stops: o.gradient,
            },
        }];
    } else if (o.fill) b.fills = [{ fillColor: o.fill, fillOpacity: o.opacity ?? 1 }];
    else b.fills = [];
    if (o.stroke) b.strokes = [{ strokeColor: o.stroke, strokeWidth: o.strokeWidth ?? 1, strokeStyle: o.dashed ? 'dashed' : 'solid' }];
    const r = o.radius || 0;
    if (r) { b.borderRadiusTopLeft = r; b.borderRadiusTopRight = r; b.borderRadiusBottomLeft = r; b.borderRadiusBottomRight = r; }
    if (o.shadows) b.shadows = o.shadows;
    return put(parent, b, x, y);
};

const text = (parent, name, str, x, y, o = {}) => {
    const t = penpot.createText(str);
    t.name = name;
    t.fontFamily = o.font || FONT;
    t.fontSize = o.size ?? 13;
    t.fontWeight = String(o.weight ?? 400);
    t.letterSpacing = String(o.tracking ?? 0);
    t.fills = [{ fillColor: o.color ?? C.text, fillOpacity: 1 }];
    if (o.maxWidth) { t.resize(o.maxWidth, 12); t.growType = 'auto-height'; t.lineHeight = String(o.lineHeight ?? 1.45); }
    else if (o.height) { t.resize(o.height * 0.6, o.height); t.growType = 'auto-width'; }
    else t.growType = 'auto-width';
    if (o.align) t.align = o.align;
    if (o.verticalAlign) t.verticalAlign = o.verticalAlign;
    return put(parent, t, x, y);
};

const icon = (parent, kind, x, y, size, color, w = 1.6, name = null) => {
    const s = penpot.createShapeFromSvg(`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><path d="${ICONS[kind]}" fill="none" stroke="${color}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/></svg>`);
    s.name = name || `Icon ${kind}`;
    s.resize(size, size);
    return put(parent, s, x, y);
};

// Логотип агента: скруглённый квадрат с градиентом и первой буквой названия.
// Букву центрируем по фактической ширине, а не по той, что вернулась сразу:
// размеры текста считаются асинхронно, до await ширина равна 1 px.
const logo = async (parent, letter, x, y, size, from, to, name = null) => {
    const tile = box(parent, name || `Logo ${letter}`, x, y, size, size, {
        radius: Math.round(size * 0.29),
        gradient: [{ color: from, offset: 0 }, { color: to, offset: 1 }],
        shadow: [{ style: 'drop-shadow', color: { color: from, opacity: 0.35 }, offsetX: 0, offsetY: 2, blur: 8, spread: -2 }],
    });
    const t = text(tile, `Logo letter ${letter}`, letter, 0, 0, {
        size: Math.round(size * 0.5), weight: 600, color: '#0B0E13', align: 'center', verticalAlign: 'center',
    });
    await tile.waitForLayoutUpdate();
    penpotUtils.setParentXY(t, (size - t.width) / 2, (size - t.height) / 2);
    return tile;
};

// Тень панели: глубокая, чтобы меню читалось поверх шапки.
const panelShadow = [
    { style: 'drop-shadow', color: { color: '#000000', opacity: 0.5 }, offsetX: 0, offsetY: 24, blur: 56, spread: -12 },
    { style: 'drop-shadow', color: { color: '#000000', opacity: 0.35 }, offsetX: 0, offsetY: 4, blur: 12, spread: -4 },
];

const designBoard = () => penpotUtils.findShape((s) => s.name === 'CLI dropdown', penpot.root);