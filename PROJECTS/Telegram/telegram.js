// Вкладка Telegram верхнего тулбара: чат-интерфейс телеграм-моста проекта
// (PROJECTS/Settings/telegram-server.js). Скрипт больше не строит разметку:
// она приходит с сервера (telegram-view.eta, заглушка в index.html), а он
// только вешает обработчики и следит за связью с сервером.
//
// Грузится раньше app.js: тот на старте ищет #telegramView для App.VIEWS
// (DOCS/decisions/014); сам элемент уже есть в разметке страницы.
(function () {

    const messages = document.getElementById('telegramMessages');
    if (!messages) return;
    const errorHint = document.getElementById('telegramError');

    // индикатор связи с сервером для опроса фрагмента: вешаем на
    // #telegramMessages — этот узел htmx не подменяет (подмена идёт oob-блоками
    // #telegramEmpty/#telegramList внутри него), поэтому слушатель переживает
    // все обновления и не нужен htmx:oobAfterSwap для переподхвата
    messages.addEventListener('htmx:sendError', () => { errorHint.hidden = false; });
    messages.addEventListener('htmx:responseError', () => { errorHint.hidden = false; });
    messages.addEventListener('htmx:afterRequest', (e) => {
        if (e.detail && e.detail.successful) errorHint.hidden = true;
    });

    // без этого лента при открытии вкладки остаётся проскроленной наверх —
    // список рисуется старыми сверху/новыми снизу (как в мессенджере), а
    // браузер по умолчанию ставит scrollTop на 0. Держим низ так же, как
    // это делает лента чата (chat-feed.js): при первой загрузке — всегда,
    // при последующих обновлениях — только если пользователь и так был у
    // низа (не сбрасываем чтение истории новым опросом каждые 5с). Снимок
    // «у низа ли» нужно брать ДО подмены (htmx:beforeRequest), иначе после
    // oob-подмены scrollHeight уже другой и проверка всегда соврёт
    const SCROLL_NEAR_BOTTOM_PX = 80;
    let firstLoad = true;
    let wasNearBottom = true;
    function isNearBottom() {
        return messages.scrollHeight - messages.scrollTop - messages.clientHeight <= SCROLL_NEAR_BOTTOM_PX;
    }
    messages.addEventListener('htmx:beforeRequest', () => { wasNearBottom = isNearBottom(); });
    messages.addEventListener('htmx:oobAfterSwap', () => {
        if (!firstLoad && !wasNearBottom) return;
        firstLoad = false;
        messages.scrollTop = messages.scrollHeight;
    });

})();
