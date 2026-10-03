// Вкладка Telegram верхнего тулбара: чат-интерфейс телеграм-моста проекта
// (PROJECTS/Settings/telegram-server.js). Пока только разметка — лента и поле
// ввода без логики: подключение к мосту добавится отдельно.
//
// Файл самодостаточный: свою разметку он вставляет сам, стили лежат рядом
// (telegram.css), в SYSTEM/index.html остаются только точки подключения —
// кнопка тулбара, <link> и <script>. Грузится раньше app.js: тот на старте
// ищет #telegramView для App.VIEWS (DOCS/decisions/014).
(function () {

    const view = document.createElement('div');
    view.className = 'view view--telegram';
    view.id = 'telegramView';
    view.hidden = true;
    view.innerHTML = `
        <div class="telegram">
            <div class="telegram__main">
                <div class="telegram__messages" id="telegramMessages">
                    <!-- лента рисуется сервером (telegram-server.js + telegram-messages.eta):
                         те же сообщения, что мост отправляет человеку по notifyTurnFinished.
                         hx-swap="none" на инициаторе — сам ответ приходит oob-подменой ниже -->
                    <div hidden
                         hx-get="/api/fragment/telegram-messages"
                         hx-trigger="load, every 5s"
                         hx-swap="none"></div>
                    <!-- опрос фрагмента может не дойти до сервера (перезапуск/правка
                         server.js, сеть) — тогда лента молча остаётся такой, какой была,
                         и это неотличимо от «сообщений действительно нет». Показываем это
                         явно вместо тихой заглушки (см. htmx:sendError/htmx:responseError
                         ниже) -->
                    <p class="telegram__error" id="telegramError" hidden>⚠ Нет связи с сервером — лента может быть неактуальна</p>
                    <p class="telegram__empty" id="telegramEmpty">Сообщений пока нет</p>
                    <div class="telegram__list telegram__list--empty" id="telegramList"></div>
                </div>
                <form class="telegram__composer" id="telegramComposer">
                    <textarea class="telegram__input" id="telegramInput" rows="1" placeholder="Написать сообщение..." aria-label="Сообщение"></textarea>
                    <button type="submit" class="telegram__send">Отправить</button>
                </form>
            </div>
        </div>
    `;
    // Вкладки лежат подряд в body — встаём на прежнее место, перед вкладкой
    // Sessions. Якорь — #chatView: он и есть эта вкладка, и sessions-view.js
    // (он грузится раньше нас) к этому моменту её уже вставил. Смотреть надо
    // именно на неё, а не на #chatAnchor из разметки страницы: Sessions
    // вставляется перед якорем, и вставка «перед якорем» отодвинула бы нас
    // за неё. Разметки нет — вкладку показать некуда, дальше идти незачем
    const sessionsView = document.getElementById('chatView');
    if (!sessionsView) return;
    sessionsView.parentElement.insertBefore(view, sessionsView);

    // индикатор связи с сервером для опроса фрагмента: вешаем на
    // #telegramMessages — этот узел htmx не подменяет (подмена идёт oob-блоками
    // #telegramEmpty/#telegramList внутри него), поэтому слушатель переживает
    // все обновления и не нужен htmx:oobAfterSwap для переподхвата
    const messages = view.querySelector('#telegramMessages');
    const errorHint = view.querySelector('#telegramError');
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

    // горячая перезагрузка этого скрипта: снимаем вкладку, которую он нарисовал, —
    // свежая копия вставит свою на то же место
    window.App?.registerHotReload('PROJECTS/Telegram/telegram.js', () => view.remove());

})();
