// Вкладка Kanban целиком: в неё встроен интерфейс beads-web (стили —
// PROJECTS/Kanban/kanban.css, серверная половина — PROJECTS/Kanban/kanban-server.js).
//
// Своей доски здесь больше нет: показывается настоящий beads-web из npm-пакета
// beads-kanban-ui, который наш сервер поднимает и гасит вместе с собой.
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
    // сам открыл beads-web». Восстановили вкладку — показываем кнопку, и решает
    // человек. Нажали Kanban руками — это и есть просьба, поднимаем сразу
    function offer() {
        board.innerHTML = '';
        const note = document.createElement('p');
        note.className = 'board__note';
        note.textContent = 'beads-web не запущен.';
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'board__start';
        button.textContent = 'Открыть доску';
        button.addEventListener('click', mount);
        board.append(note, button);
    }

    async function show(restored = false) {
        if (mounted) return; // кадр уже висит: перезагружать его при каждом заходе незачем
        if (restored) {
            offer();
            return;
        }
        await mount();
    }

    async function mount() {
        // бинарь доски поднимается по этому же запросу, если ещё не поднят,
        // а это до двадцати секунд — вкладка не должна стоять пустой
        message('beads-web запускается…');

        const { ok, url, error } = await App.api('/api/kanban/status');
        if (!ok) {
            message(error || 'beads-web недоступен');
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
