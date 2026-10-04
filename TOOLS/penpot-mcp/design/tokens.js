// Палитра, локальная библиотека и токены. Выполняется один раз: всё, что уже
// есть, переиспользуется, чтобы повторный запуск не спотыкался о «уже есть».
// Палитра и C приходят из helpers.js, который подставляется первым: здесь они
// уже объявлены, второй раз заводить нельзя. Этот шаг переносит палитру в
// локальную библиотеку файла и в набор токенов.

const lib = penpot.library.local;
for (const [name, hex] of Object.entries({
    'Canvas 900': C.canvas,
    'Surface 800': C.surface,
    'Panel 750': C.panel,
    'Hairline': C.hairline,
    'Text 100': C.text,
    'Text 60': C.textDim,
    'Text 40': C.textMute,
    'Accent': C.accent,
    'Accent deep': C.accentDeep,
    'Success': C.ok,
    'Warn': C.warn,
})) {
    if (!lib.colors.some((c) => c.name === name)) {
        const color = lib.createColor();
        color.name = name;
        color.color = hex;
    }
}

const set = lib.tokens.sets.find((s) => s.name === 'cli-dropdown') || lib.tokens.addSet({ name: 'cli-dropdown' });
if (!set.active) set.toggleActive();

const values = {
    'color.canvas': C.canvas,
    'color.surface': C.surface,
    'color.panel': C.panel,
    'color.hairline': C.hairline,
    'color.text': C.text,
    'color.textDim': C.textDim,
    'color.textMute': C.textMute,
    'color.accent': C.accent,
    'color.accentDeep': C.accentDeep,
    'color.ok': C.ok,
    'color.warn': C.warn,
    'radius.menu': 18,
    'radius.item': 12,
    'radius.pill': 999,
    'space.1': 4,
    'space.2': 8,
    'space.3': 12,
    'space.4': 16,
    'space.5': 24,
    'space.6': 32,
};
for (const [name, value] of Object.entries(values)) {
    const type = name.startsWith('color.') ? 'color'
        : name.startsWith('space.') ? 'spacing'
            : 'borderRadius';
    if (!penpotUtils.findTokenByName(name)) set.addToken({ type, name, value });
}

const board = penpotUtils.findShape((s) => s.name === 'CLI dropdown', penpot.root) || penpot.createBoard();
penpot.root.appendChild(board);
board.name = 'CLI dropdown';
// 1120, а не 1020: нижняя карточка с палитрой кончается на 1064, при 1020 она
// обрезалась краем доски.
board.resize(1440, 1120);
board.x = 420;
board.y = -40;
board.fills = [{ fillColor: C.canvas, fillOpacity: 1 }];
storage.design.boardId = board.id;

return { colors: lib.colors.length, tokens: set.tokens.length, board: board.id };