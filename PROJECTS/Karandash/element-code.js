// Место выбранного элемента в коде: спрашиваем у сервера, где этот класс или id
// создаётся и в каком файле описан стилем, и добавляем ответ строкой «Code: …»
// к вопросу пользователя. Живёт отдельно от описания элемента и от самого режима
// наведения — это запрос к индексу, а не разбор DOM.
//
// Зачем: строка «UI element» говорит, ЧТО выбрано, но не ГДЕ это в коде. Раньше
// место находил сам агент поиском по имени класса, а имя класса в проекте
// встречается десятками раз, и на общих классах поиск уводил не туда
// (DOCS/decisions/087). Теперь приходит «SYSTEM/model-tag.js:120» — сразу
// файл и строка (DOCS/decisions/091).
//
// Названного файла мало, поэтому ответ несёт ещё и контекст места: секцию файла,
// в которой строки живут, остальные файлы фичи и то, кто ссылается на этот файл
// (DOCS/decisions/100). Без этого агент открывает файл целиком и идёт читать
// соседей по папке — то есть делает руками то, что индекс уже знает.
//
// Ответ может не прийти: сервер только что поднялся и индекс ещё не собран.
// Это не поломка — вопрос уходит без строки «Code», ровно как раньше.
(function () {
    // три места — больше и не нужно: столько элементов правят за раз, а каждая
    // лишняя строка в вопросе — это контекст, который агент обязан удержать
    const MAX_PLACES = 3;
    const LINES = 4; // сколько строк номера показываем у одного места

    function where(place) {
        const lines = place.lines.slice(0, LINES).join(',');
        const tail = place.lines.length > LINES ? ',…' : '';
        // слово «стиль» нужно, чтобы агент не полез править разметку там, где
        // нашлось только правило CSS, и наоборот
        const word = place.kind === 'style' ? 'стиль' : 'здесь создаётся';
        return `${place.file}:${lines}${tail} (${word})`;
    }

    // Стиль берём всегда, даже если он по ценности ниже: задача про элемент —
    // это в половине случаев задача про цвет и отступы, а без второй половины
    // ответа агент идёт искать нужный CSS-файл сам (DOCS/decisions/091)
    function pick(places) {
        const made = places.filter((p) => p.kind !== 'style').slice(0, MAX_PLACES - 1);
        const styled = places.filter((p) => p.kind === 'style').slice(0, 1);
        return [...made, ...styled].slice(0, MAX_PLACES);
    }

    // возвращаем пару, а не строку: строка `Code:` и контекст места попадают в
    // вопрос разными строками, и собирать их должен тот, кто задаёт его форму
    async function locate(el) {
        const names = window.KarandashDesc.hooksOf(el);
        if (!names.length) return { place: '', context: null };
        try {
            const res = await fetch('/api/karandash/element', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ names }),
            });
            const data = await res.json();
            if (!data.ok || !data.places || !data.places.length) return { place: '', context: null };
            const chosen = pick(data.places);
            // контекст берём у первого места — того, где элемент создаётся: у
            // CSS-файла своей фичи нет, и соседи по его папке к задаче не относятся
            const lead = chosen.find((p) => p.kind !== 'style') || chosen[0];
            return { place: chosen.map(where).join(', '), context: lead?.context || null };
        } catch {
            // сервер не ответил — вопрос уйдёт без места, как раньше
            return { place: '', context: null };
        }
    }

    window.KarandashCode = { locate };
})();
