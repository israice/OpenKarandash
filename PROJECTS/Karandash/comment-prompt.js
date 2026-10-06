// Сборка запроса из комментария к элементу.
//
// Живёт отдельно от karandash.js: там режим (наведение, колесо, окно, снимок),
// а здесь — что из выбранного элемента уезжает в запрос. Список строк растёт
// (описание, место в коде, текущий вид, текст элемента, дерево фичи), и держать
// его в файле режима значит растить файл, который и так уже велик (решение 022).
//
// Каждая строка снимает один заход агента за файлом или браузером: описание
// element-desc.js, место и контекст element-code.js, числа element-style.js.
// Здесь только строки — как их собирать, знает тот, кто отвечает за каждую.
(function () {
    // у контейнеров в textContent лежит всё их содержимое — такой «текст элемента»
    // только зашумляет вопрос, поэтому берём его лишь у коротких элементов
    const TEXT_LIMIT = 120;

    // дерево фичи едет одной строкой, а не планом чтения: агенту нужно знать,
    // что эти файлы вообще есть и что он может их открыть, — а не обязаны читать
    function featureLine(context) {
        if (!context || !context.siblings.length) return null;
        return context.siblings.join(', ');
    }

    // строка `Control:` — состояние контрола в момент клика: что за элемент,
    // что в нём выбрано и как называются соседние пункты. В описание элемента
    // это уже вошло короткой строкой, но там оно прижато к селектору и теряется
    // среди классов, а здесь читается отдельным фактом — и снимает заход в файл
    // ради двух значений, которые стоили одного клика. Строка пропускается там,
    // где контрола нет (текст, контейнер): описывать нечего
    function controlLine(el) {
        const info = window.KarandashDesc.controlOf?.(el);
        if (!info || !info.control) return null;
        const parts = [`${info.control}`];
        if (info.selected) parts.push(`выбрано «${info.selected}»`);
        if (info.preview?.length) parts.push(`первые: ${info.preview.join(', ')}`);
        if (info.disabled) parts.push('неактивен');
        return parts.join(', ');
    }

    // found — пара из element-code.js: `place` (строка `Code:`) и `context`
    // (секция, соседи по фиче, обратные ссылки). Разделены, потому что в строку
    // `Code:` попадают все места, а контекст один — у того, где элемент создаётся
    function build(el, comment, found, hostFrame) {
        const place = found?.place || '';
        const context = found?.context || null;
        const text = (el.textContent || '').trim().replace(/\s+/g, ' ');
        const lines = [`UI element: ${window.KarandashDesc.describe(el, hostFrame)}`];
        const control = controlLine(el);
        if (control) lines.push(`Control: ${control}`);
        if (place) lines.push(`Code: ${place}`);
        // вычисленные стили — украшение: без этого файла (например, при горячей
        // перезагрузке между двумя скриптами) запрос уходит как раньше
        const look = window.KarandashStyle?.computed(el);
        if (look) lines.push(`Current look: ${look}`);
        if (text && text.length <= TEXT_LIMIT) lines.push(`Element text: ${text}`);
        if (context?.section) lines.push(`Section: ${context.section}`);
        const feature = featureLine(context);
        if (feature) lines.push(`Feature files: ${feature}`);
        if (context?.referrers?.length) lines.push(`Referenced by: ${context.referrers.join(', ')}`);
        lines.push(`Comment: ${comment}`);
        return lines.join('\n');
    }

    window.KarandashPrompt = { build };
})();
