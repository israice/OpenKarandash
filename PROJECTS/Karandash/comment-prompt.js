// Сборка запроса из комментария к элементу.
//
// Живёт отдельно от karandash.js: там режим (наведение, колесо, окно, снимок),
// а здесь — что из выбранного элемента уезжает в запрос. Список строк растёт
// (описание, место в коде, текущий вид, текст элемента), и держать его в файле
// режима значит растить файл, который и так уже велик (DOCS/decisions/022).
//
// Каждая строка снимает один заход агента за файлом или браузером: описание
// element-desc.js, место в коде element-code.js, числа element-style.js. Здесь
// только строки — как их собирать, знает тот, кто отвечает за каждую.
(function () {
    // у контейнеров в textContent лежит всё их содержимое — такой «текст элемента»
    // только зашумляет вопрос, поэтому берём его лишь у коротких элементов
    const TEXT_LIMIT = 120;

    function build(el, comment, place, hostFrame) {
        const text = (el.textContent || '').trim().replace(/\s+/g, ' ');
        const lines = [`UI element: ${window.KarandashDesc.describe(el, hostFrame)}`];
        if (place) lines.push(`Code: ${place}`);
        // вычисленные стили — украшение: без этого файла (например, при горячей
        // перезагрузке между двумя скриптами) запрос уходит как раньше
        const look = window.KarandashStyle?.computed(el);
        if (look) lines.push(`Current look: ${look}`);
        if (text && text.length <= TEXT_LIMIT) lines.push(`Element text: ${text}`);
        lines.push(`Comment: ${comment}`);
        return lines.join('\n');
    }

    window.KarandashPrompt = { build };
})();
