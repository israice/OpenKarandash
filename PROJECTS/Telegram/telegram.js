// Вкладка Telegram верхнего тулбара: место для телеграм-моста проекта
// (PROJECTS/Settings/telegram-server.js). Пока раздел пустой — на нём только
// подпись и подсказка, где живут ключ бота и список получателей.
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
            <h2 class="telegram__title">Telegram</h2>
            <p class="telegram__note">
                Мост в телеграм работает на сервере (PROJECTS/Settings/telegram-server.js):
                он шлёт последний ответ завершившейся сессии и принимает ответ обратно.
                Ключ бота и список получателей правятся в настройках.
            </p>
        </div>
    `;
    // вкладки лежат подряд в одном контейнере — встаём рядом с ними.
    // Разметки нет — вкладку показать некуда, дальше идти незачем
    const chatView = document.getElementById('chatView');
    if (!chatView) return;
    chatView.parentElement.insertBefore(view, chatView);

})();
