// Метка строки ленты: цветной тег слева — имя инструмента у шага,
// «thinking» у блока размышления, «prompt» у промпта хода.
//
// Отдельный файл не по привычке, а по долгу: тег нужен трём разным строкам
// (шаг, мысль, промпт), и пока он жил в шаге, мысль и промпт зависели от
// чужой темы. Отсюда и круг: шаг закрывает блок мыслей (closeThinking), а мысль
// брала тег шага — шаг и мысль зависели друг от друга (DOCS/decisions/022).
// Тег ни от кого не зависит, и круг рассыпался.
//
// Оттенок считаем от имени хэшем — одно и то же имя (read_file, Bash, thinking)
// всегда того же цвета, а разные визуально различаются, без ручного списка
// инструментов всех CLI. Оттенок берётся всегда от name: у метки «↳ thinking»
// он тот же, что у «thinking», иначе мысли субагента красились бы иначе
export function makeTag(label, name = label) {
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
    const hue = hash % 360;
    const tag = document.createElement('span');
    tag.className = 'chat-tag';
    tag.style.color = `hsl(${hue}, 70%, 68%)`;
    tag.style.background = `hsl(${hue}, 45%, 18%)`;
    tag.textContent = label;
    return tag;
}
