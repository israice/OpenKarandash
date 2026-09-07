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

    // Заголовок «Manage Your Beads Projects» на списке проектов и строка под ним
    // (чужая рекомендация поставить Beads Orchestration Skill) нам не нужны:
    // вкладка и так подписана Kanban, а список открывается разве что кнопкой
    // «назад к проектам», и чужая ссылка нашей работы не касается. Видимыми их не
    // делает правило, дописанное к таблице стилей доски на нашем же прокси
    // (EXTRA_CSS в kanban-server.js): только оно успевает сработать до первой
    // отрисовки. Здесь — второй, поздний шаг: узлы вынимаются из документа совсем.
    //
    // Из исходников доски их не убрать: разметка вшита в бинарь, а вырезать узлы
    // из проксируемого HTML нельзя — React сверяет документ со своим деревом при
    // гидратации и вставит их обратно. Поэтому удаляем уже готовые узлы
    // изнутри: кадр нашего origin, и его документ доступен (тем же путём в него
    // заглядывает Karandash). Момент — событие load кадра: к нему
    // hydrateRoot(document) отработал, и React узлы не вернёт. Раньше нельзя, и
    // отсюда же деление обязанностей: до load их держит невидимыми стиль.
    // Клиентский переход Next события load не даёт — там узлы так и останутся
    // в документе, но скрытыми тем же правилом
    const BOARD_INTRO = ['main > h1.font-heading', 'main > p.text-center.text-zinc-400'];

    function dropBoardIntro(frame) {
        const doc = frame.contentDocument;
        if (!doc) return; // документ ещё не наш — заглянуть внутрь нечего
        for (const selector of BOARD_INTRO) doc.querySelector(selector)?.remove();
    }

    // Плавающая кнопка «Start feedback mode» — свой карандаш beads-web: для
    // комментариев к интерфейсу у нас есть Karandash, и вторая такая кнопка
    // поверх доски только мешает. Прячет её правило в EXTRA_CSS (kanban-server.js),
    // но одного его мало: таблицу стилей доски браузер держит в кэше и на
    // перезагрузку получает 304 — ответ без нашей дописки. Поэтому то же правило
    // кладём ещё и своим <style> внутрь документа кадра, где кэш ни при чём.
    // Удалить сам узел, как заголовок, нельзя: кнопка — живая часть дерева React,
    // её родитель перерисовывается и вернёт удалённое обратно.
    //
    // Класс у неё хэшированный (CSS-модуль внутри бинаря) и после обновления
    // пакета сменится — цепляемся за неизменную часть имени плюс запасной
    // селектор по title свёрнутого состояния. `!important` обязателен: своё
    // правило кнопка держит в другой таблице стилей, и чья окажется позже — не от нас
    //
    // Тем же <style> подменяется и подпись колонки «Open» — у нас она «New».
    // Слово вшито в бинарь; заголовок колонки — живая часть дерева React, и
    // переписанный руками текст вернулся бы на первой же перерисовке. Поэтому
    // своё слово рисует `::after`, а чужое гасится нулевым кеглем: узел остаётся
    // на месте, React ничего не замечает. Высота строки задана явно — иначе от
    // нулевого кегля строчный бокс схлопнется. Правило то же, что в EXTRA_CSS
    const FRAME_CSS = '[class*="toolbarContainer"],[title="Start feedback mode"]{display:none!important}'
        + 'h2.font-semibold.text-sm.text-blue-400{font-size:0;line-height:1.25rem}'
        + 'h2.font-semibold.text-sm.text-blue-400::after{content:"New";font-size:0.875rem}'
        + 'h2.font-semibold.text-sm.text-green-400{font-size:0;line-height:1.25rem}'
        + 'h2.font-semibold.text-sm.text-green-400::after{content:"Done";font-size:0.875rem}';

    function hideFeedbackButton(frame) {
        const doc = frame.contentDocument;
        if (!doc) return; // документ ещё не наш — заглянуть внутрь нечего
        if (doc.getElementById('kanbanFrameCss')) return; // после клиентского перехода стиль уже стоит
        const style = doc.createElement('style');
        style.id = 'kanbanFrameCss';
        style.textContent = FRAME_CSS;
        doc.head.append(style);
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
        frame.addEventListener('load', () => {
            dropBoardIntro(frame);
            hideFeedbackButton(frame);
        });
        board.append(frame);
        // подпись контейнера: когда карандашом выбирают сам кадр, а не элемент
        // внутри него, в окне комментария видно, что это встроенная доска
        board.setAttribute('aria-label', 'beads-web — встроенная доска Kanban');
        mounted = true;
    }

    // вкладку показывает tabs.js — он же зовёт show(), как у Graph и Book
    window.MissionKanban = { show };

})();
