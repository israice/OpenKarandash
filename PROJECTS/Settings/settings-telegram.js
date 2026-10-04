// Подключение Telegram: ключ бота и id людей через запятую, автосохранение с задержкой
// после последней правки и опрос состояния моста, пока окно на экране. Серверная половина —
// telegram-server.js.
//
// Отдельный файл: у Telegram своё состояние (маска ключа, свои таймеры) и общих узлов с
// провайдерами у него нет, кроме одного вызова api() и самого окна настроек.
//
// На верхнем уровне файла ничего не выполняется: settings.js зовёт init(...) и получает
// наружу renderTelegram, startTelegramRefresh и stopTelegramRefresh.
window.SettingsTelegram = (function () {

    function init({ settingsModal, api }) {
        // ---------- подключение Telegram ----------

        // Кнопка раскрывает под собой два поля — ключ бота и id людей через запятую;
        // оба сохраняются сами, с задержкой после последней правки, и уезжают
        // в .env (серверная половина — telegram-server.js). Сам ключ сервер наружу
        // не отдаёт: в поле лежит маска из точек, и она же уходит обратно, пока
        // поле не тронули, — значит, ключ в .env менять не надо
        const telegramConnectButton = settingsModal.querySelector('#telegramConnectButton');
        const telegramFields = settingsModal.querySelector('#telegramFields');
        const telegramTokenInput = settingsModal.querySelector('#telegramTokenInput');
        const telegramUsersInput = settingsModal.querySelector('#telegramUsersInput');
        const telegramStatus = settingsModal.querySelector('#telegramStatus');
        const telegramHint = settingsModal.querySelector('#telegramHint');

        const TELEGRAM_SAVE_DELAY = 700;
        let telegramSaveTimer = null;
        let telegramConnected = false;
        // трогали ли поле ключа в этом сеансе: пока нет — шлём null вместо значения,
        // и сервер оставляет ключ в .env как есть. Иначе правка одних только id
        // отправляла бы набранный ключ заново, а сервер на каждую букву гасил бы
        // опрос и снова ходил в getMe
        let telegramTokenTouched = false;

        function renderTelegram(info) {
            if (!info) return;
            // маска приходит с сервера и в поле выглядит точками — своё значение
            // затираем только тогда, когда человек его сейчас не набирает
            if (document.activeElement !== telegramTokenInput) telegramTokenInput.value = info.tokenMask || '';
            if (document.activeElement !== telegramUsersInput) telegramUsersInput.value = info.users || '';
            if (info.ok !== false) telegramTokenTouched = false;

            telegramConnected = Boolean(info.connected);
            telegramStatus.hidden = !info.connected;
            telegramStatus.textContent = info.connected ? 'Connected' : '';
            // кнопка ведёт себя как у остальных провайдеров: пока моста нет —
            // синий «Connect», у поднятого — обычный «Disconnect»
            telegramConnectButton.textContent = info.connected ? 'Disconnect' : 'Connect';
            telegramConnectButton.classList.toggle('provider__button--connect', !info.connected);
            // у подключённого провайдера его настройки видны всегда (как строка
            // с моделью), поэтому поля моста не прячем; у неподключённого их
            // раскрывает сама кнопка, и текущий выбор человека мы не сбиваем
            if (info.connected) telegramFields.hidden = false;
            telegramConnectButton.setAttribute('aria-expanded', String(!telegramFields.hidden));

            // подсказки под полями нет — строка занята только ошибкой сохранения
            telegramHint.textContent = info.error || '';
            telegramHint.classList.toggle('telegram__hint--error', Boolean(info.error));
        }

        async function saveTelegram(token = telegramTokenTouched ? telegramTokenInput.value : null) {
            renderTelegram(await api('/api/telegram/save', {
                token,
                users: telegramUsersInput.value,
            }));
        }

        // «этот ключ опрашивает кто-то ещё» — временная штука на стороне сервера
        // (пересменка после его же перезапуска), она гаснет сама за десятки секунд.
        // Открытая карточка об этом не узнаёт: сервер меняет состояние в памяти,
        // но никому его не шлёт, — поэтому спрашиваем сами, пока окно на экране
        const TELEGRAM_REFRESH_MS = 4000;
        let telegramRefreshTimer = null;

        function startTelegramRefresh() {
            clearInterval(telegramRefreshTimer);
            telegramRefreshTimer = setInterval(() => {
                api('/api/telegram/state').then(renderTelegram);
            }, TELEGRAM_REFRESH_MS);
        }

        function stopTelegramRefresh() {
            clearInterval(telegramRefreshTimer);
            telegramRefreshTimer = null;
        }
        for (const input of [telegramTokenInput, telegramUsersInput]) {
            input.addEventListener('input', () => {
                if (input === telegramTokenInput) telegramTokenTouched = true;
                clearTimeout(telegramSaveTimer);
                telegramSaveTimer = setTimeout(() => saveTelegram(), TELEGRAM_SAVE_DELAY);
            });
        }

        telegramConnectButton.addEventListener('click', async () => {
            // у поднятого моста кнопка отключает его: пустой ключ стирает строку
            // в .env и гасит опрос — id людей при этом остаются на месте
            if (telegramConnected) {
                clearTimeout(telegramSaveTimer);
                telegramTokenInput.value = '';
                await saveTelegram('');
                telegramFields.hidden = true;
                telegramConnectButton.setAttribute('aria-expanded', 'false');
                return;
            }
            const show = telegramFields.hidden;
            telegramFields.hidden = !show;
            telegramConnectButton.setAttribute('aria-expanded', String(show));
            if (show) telegramTokenInput.focus();
        });

        return { renderTelegram, startTelegramRefresh, stopTelegramRefresh };
    }

    return { init };
})();
