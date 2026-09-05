// Вкладка Kanban целиком: в неё встроен интерфейс beads-web (стили —
// PROJECTS/Kanban/kanban.css, серверная половина — PROJECTS/Kanban/kanban-server.js).
//
// Своей доски здесь больше нет: показывается настоящий beads-web из npm-пакета
// beads-kanban-ui, который наш сервер поднимает по первому заходу на вкладку.
// Наш перезапуск доска переживает — после него вкладка подхватывает ту же, а не
// заводит вторую (DOCS/decisions/021).
//
// Он приходит отдельным документом (его Next.js вызывает hydrateRoot(document) —
// то есть забирает себе весь документ целиком, в чужой <div> его разметку не
// вложить), поэтому вкладка отдаёт ему свой кадр на всю высоту. Адрес кадра —
// нашего же origin (сервер проксирует доску), иначе Karandash не может заглянуть
// внутрь и подсвечивает её одним прямоугольником. Подробности — DOCS/decisions/021.
(function () {

    const board = document.getElementById('board');
    let mounted = false;

    function message(text) {
        board.innerHTML = '';
        const note = document.createElement('p');
        note.className = 'board__note';
        note.textContent = text;
        board.append(note);
    }

    // Доска — сторонний процесс, и поднимает его наш запрос статуса. Поэтому
    // само по себе открытие вкладки его не заводит, если вкладку не выбирали:
    // после `node server.js` страница перезагружается сама и возвращается на
    // последнее место, и молчаливый запуск чужого бинаря читался бы как «сервер
    // сам открыл beads-web». Восстановили вкладку — спрашиваем без просьбы
    // (probe): доска пережила наш перезапуск — сразу показываем её, не заводя
    // ничего заново; не пережила — показываем кнопку, и решает человек. Нажали
    // Kanban руками — это и есть просьба, поднимаем сразу
    function offer() {
        board.innerHTML = '';
        const note = document.createElement('p');
        note.className = 'board__note';
        note.textContent = 'beads-web не запущен.';
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'board__start';
        button.textContent = 'Открыть доску';
        button.addEventListener('click', () => mount());
        board.append(note, button);
    }

    async function show(restored = false) {
        if (mounted) return; // кадр уже висит: перезагружать его при каждом заходе незачем
        await mount({ probe: restored });
    }

    async function mount({ probe = false } = {}) {
        // бинарь доски поднимается по этому же запросу, если ещё не поднят,
        // а это до двадцати секунд — вкладка не должна стоять пустой. С probe
        // ждать нечего: сервер только смотрит, жива ли уже поднятая доска
        if (!probe) message('beads-web запускается…');

        const { ok, url, error, disabled } = await App.api('/api/kanban/status', { probe });
        if (!ok) {
            // выключенная в .env доска кнопкой не лечится — там нужен текст причины
            if (probe && !disabled) offer();
            else message(error || 'beads-web недоступен');
            return;
        }

        board.innerHTML = '';
        const frame = document.createElement('iframe');
        frame.className = 'board__frame';
        frame.src = url;
        frame.title = 'beads-web';
        board.append(frame);
        // подпись контейнера: когда карандашом выбирают сам кадр, а не элемент
        // внутри него, в окне комментария видно, что это встроенная доска
        board.setAttribute('aria-label', 'beads-web — встроенная доска Kanban');
        mounted = true;
    }

    // вкладку показывает tabs.js — он же зовёт show(), как у Graph и Book
    window.MissionKanban = { show };

})();
