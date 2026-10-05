// Как выглядит элемент сейчас: числа, которые сам браузер посчитал.
//
// Строка «UI element» и «Code» называют, ЧТО выбрано и ГДЕ это в коде, но не
// говорят, как оно выглядит в этот момент. За стилевой задачей агент идёт за
// числами отдельно — в CSS-файл, а оттуда за вычисленными значениями ещё и в
// браузер (TOOLS/live-verify/run.mjs styles). На клике всё это уже известно и
// стоит ноль ходов, поэтому едет в запрос (DOCS/decisions/099).
//
// Живёт отдельно от element-desc.js (подпись и путь) и element-code.js (место в
// коде): это третий вопрос — про состояние, и он задаётся браузером, а не
// индексом. Дальше строку вклеивает karandash.js при отправке комментария.
(function () {
    // свойства, которые в правках выглядят первыми: цвет и фон (заметно глазом),
    // шрифт, отступы, рамка, скругление. Ширину и высоту отдаём отдельными
    // числами — их чаще читают как «ширину элемента», а не как CSS-свойство
    const PROPS = [
        ['background-color', 'фон'],
        ['color', 'цвет текста'],
        ['font-size', 'шрифт'],
        ['font-weight', 'жирность'],
        ['padding', 'внутренний отступ'],
        ['border-radius', 'скругление'],
        ['border', 'рамка'],
    ];

    // значения по умолчанию повторяют каждую вторую строку отчёта и ни о чём не
    // говорят: у почти любого элемента скругление нулевое, а рамки нет вовсе
    const DEFAULT = new Set(['none', 'normal', '0px']);

    // длина строки на каждое свойство: рамка в вычисленном виде длиннее всего
    // остального вместе взятого, а обрезанное «border: 1px solid rgb(51, 54,
    // 61)» хуже, чем полное значение целиком
    const VALUE_LIMIT = 40;

    function clip(value) {
        const text = String(value ?? '').trim();
        return text.length > VALUE_LIMIT ? `${text.slice(0, VALUE_LIMIT)}…` : text;
    }

    // все длины в значении нулевые — это «ничего не задано»: рамка 0px none
    // пишется везде, где рамки просто нет, и такой текст в отчёте только шумит
    function zeroLength(value) {
        const lengths = String(value).match(/-?[\d.]+px/g) || [];
        return lengths.length > 0 && lengths.every((l) => parseFloat(l) === 0);
    }

    // прямоугольник элемента: для задачи про ширину или расположение это то же
    // самое, что пришлось бы смотреть в браузере, и дешевле на два порядка
    function box(el) {
        const r = el.getBoundingClientRect();
        const round = (n) => Math.round(n);
        return `${round(r.width)}×${round(r.height)}`;
    }

    // предпросмотр стилей без layout не считает: скрытый элемент (hidden, дисплей
    // none) даёт нули, и в запрос уехал бы нулевой размер как настоящий
    function visible(el) {
        const rect = el.getBoundingClientRect();
        if (!rect.width && !rect.height) return false;
        const view = el.ownerDocument.defaultView;
        return !view || view.getComputedStyle(el).visibility !== 'hidden';
    }

    function computed(el) {
        if (!el || el.nodeType !== 1) return '';
        if (!visible(el)) return '';

        const view = el.ownerDocument.defaultView;
        if (!view) return '';
        const style = view.getComputedStyle(el);
        // значения, которые элемент просто унаследовал, ничего не говорят о его
        // стилях: шрифт 16px и жирность 400 у всех элементов страницы одинаковые,
        // и без этого сравнения строка выглядит как «здесь задано» — а задано
        // было в родителе или вообще нигде (DOCS/decisions/099)
        const parent = el.parentElement ? view.getComputedStyle(el.parentElement) : null;

        const parts = [];
        for (const [prop, name] of PROPS) {
            const value = style.getPropertyValue(prop);
            if (!value || DEFAULT.has(value) || zeroLength(value)) continue;
            if (parent && parent.getPropertyValue(prop) === value) continue;
            parts.push(`${name} ${clip(value)}`);
        }
        // прямоугольник и пустой результат — тоже результат: для задачи про ширину
        // «220×26» нужно, даже когда цветов и отступов не задано вовсе
        return [box(el), ...parts].join(', ');
    }

    window.KarandashStyle = { computed };
})();
