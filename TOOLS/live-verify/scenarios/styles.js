// Проверить стили элемента числами, а не снимком: фон и цвет выбранного и
// невыбранного пункта — четыре значения вместо дампа всех пунктов списка.
// Для правки CSS этого обычно достаточно.
//
// Параметры:
//   select=<селектор>  обязательный: элемент, стили которого проверяем
//                      (обычно селект: .provider__select--source и подобные)
//   view=<имя>         сначала открыть вкладку из App.VIEWS
//   props=<список>     какие свойства читать, через запятую (по умолчанию
//                      backgroundColor,color)
//   open=1             раскрыть список перед замером (фокус и стрелка вниз) —
//                      на нативный попов это не влияет, но проверяет, что
//                      уровень реагирует на клавиши
//   limit=<n>          сколько невыбранных пунктов показать (по умолчанию 1)
//
// Снимок сюда не нужен: раскрытый список нативного select в снимок не попадает,
// поэтому картинкой проверить цвет пункта нельзя (см. DOCS/agents/измерения.md).
async function scenario(P) {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    if (P.view) {
        const names = Object.keys(App.VIEWS);
        if (!names.includes(P.view)) return { ok: false, error: `Вкладки «${P.view}» нет`, known: names };
        MissionTabs.show(P.view);
        await wait(Number(P.wait) || 1500);
    }
    if (!P.select) return { ok: false, error: 'Нужен параметр select=<селектор>' };

    const hits = [...document.querySelectorAll(P.select)];
    if (!hits.length) return { ok: false, error: `По селектору ${P.select} ничего нет` };
    // несколько подходящих — берём тот, что виден: невидимый мог быть бы стилем
    // закрытого состояния, а проверять надо то, что человек видит
    const el = hits.find((n) => n.offsetParent !== null) || hits[0];

    const props = (P.props || 'backgroundColor,color').split(',').map((s) => s.trim()).filter(Boolean);
    const read = (node) => {
        if (!node) return null;
        const cs = getComputedStyle(node);
        const out = { text: (node.textContent || '').trim().slice(0, 40), selected: !!node.selected };
        for (const prop of props) out[prop] = cs[prop];
        return out;
    };

    const options = [...(el.options || [])];
    if (P.open === '1') {
        el.focus();
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
        await wait(300);
    }
    const checked = options.find((o) => o.selected) || options[0];
    const others = options.filter((o) => o !== checked);
    const add = options.find((o) => /\badd\b/i.test(o.className) || o.value === '::add');
    const limit = Math.max(0, Number(P.limit ?? 1));
    const shown = others.filter((o) => o !== add).slice(0, limit);

    return {
        ok: options.length > 0,
        found: hits.length,
        visible: el.offsetParent !== null,
        element: { tag: el.tagName.toLowerCase(), value: el.value, options: options.length },
        selected: read(checked),
        other: shown.map(read),
        add: read(add),
        note: options.length > 4 && limit < others.length ? `показаны не все ${options.length} пунктов — это норма` : undefined,
    };
}