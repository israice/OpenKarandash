// Окно настроек целиком: заголовок, который прячется на не-провайдерских вкладках,
// остановка таймеров при закрытии окна, панель табов и само открытие со свежим списком
// моделей. Отдельный файл: это единственное место, где сходятся все части раздела —
// провайдеры, скриншоты, Telegram и Sandglass, — и поэтому его читают целиком.
//
// На верхнем уровне файла ничего не выполняется: settings.js зовёт init(...) и получает
// наружу openSettings.
window.SettingsModal = (function () {

    function init({
            settingsModal, api, closeMenu,
            renderProviders, renderScreenshotScreen,
            renderTelegram, startTelegramRefresh, stopTelegramRefresh,
            startSandglassCountdown, stopSandglassCountdown,
        }) {
        const settingsTabs = settingsModal.querySelector('#settingsTabs');
        const settingsTabItems = Array.from(settingsTabs.querySelectorAll('.settings-tabs__item'));
        const settingsModalTitle = settingsModal.querySelector('#settingsModalTitle');
        const settingsModalHeader = settingsModal.querySelector('.modal__header');

        // заголовок «Settings» относится только к вкладке Providers — на остальных
        // табах (Router/Network/Sandglass) его скрываем; кнопка закрытия при этом
        // остаётся на месте.
        function setSettingsHeaderVisibility(isProviders) {
            settingsModalTitle.hidden = !isProviders;
            settingsModalHeader.classList.toggle('modal__header--collapsed', !isProviders);
        }
        // App.closeModal общий на все окна и про Telegram не знает — ловим закрытие
        // по смене атрибута hidden, а не заводим отдельный колбэк в app.js
        new MutationObserver(() => {
            if (settingsModal.hidden) {
                stopTelegramRefresh();
                stopSandglassCountdown();
            }
        }).observe(settingsModal, { attributes: true, attributeFilter: ['hidden'] });
        // ---------- панель табов окна настроек ----------

        settingsTabs.addEventListener('click', (e) => {
            const item = e.target.closest('.settings-tabs__item');
            if (!item) return;
            const tab = item.dataset.tab;
            settingsTabItems.forEach((btn) => {
                const active = btn === item;
                btn.setAttribute('aria-selected', String(active));
                const panel = settingsModal.querySelector(`#${btn.getAttribute('aria-controls')}`);
                if (panel) panel.hidden = !active;
            });
            setSettingsHeaderVisibility(tab === 'Providers');
            if (tab === 'Sandglass') startSandglassCountdown();
        });
        // ---------- открытие окна настроек ----------

        // свежий список моделей подтягиваем при каждом открытии окна — иначе
        // новые free-модели из `pi --list-models` видны только после
        // Disconnect/Connect вручную, а строка выбора в шапке сессии выглядит
        // frozen. Списком этим пользуется только шапка: выбора модели настройки
        // не делают. Раньше открытие окна попутно решал, какая модель «должна»
        // быть, и записывало это в хранилище — то есть само открытие настроек
        // меняло модель хода. Теперь список только наполняет списки строки
        // выбора, а её выбор остаётся тем, что поставил человек
        async function refreshConnectedModels() {
            const cliId = App.getActiveProviderId();
            const state = cliId ? App.connections.get(cliId) : null;
            if (!cliId || !state?.installId) return;
            try {
                const result = await api('/api/agent/connect', { agent: cliId, id: state.installId });
                if (!result?.ok || !Array.isArray(result.models) || !result.models.length) return;
                const provider = App.providerById(cliId);
                if (provider) provider.models = result.models;
            } catch {
                // сервер недоступен — показываем закэшированный список как есть
            }
        }

        async function openSettings() {
            closeMenu();
            // окно всегда открывается на вкладке Providers, даже если в прошлый
            // раз закрыли на другой — соответствует текущему содержимому по умолчанию
            settingsTabItems.forEach((btn) => {
                const active = btn.dataset.tab === 'Providers';
                btn.setAttribute('aria-selected', String(active));
                const panel = settingsModal.querySelector(`#${btn.getAttribute('aria-controls')}`);
                if (panel) panel.hidden = !active;
            });
            setSettingsHeaderVisibility(true);
            renderProviders();
            renderScreenshotScreen();
            api('/api/telegram/state').then(renderTelegram);
            startTelegramRefresh();
            App.openModal(settingsModal);
            // свежие модели дотягиваем уже поверх открытого окна: connect стоит
            // секунд (pi опрашивает каталог моделей), держать закрытое окно ради
            // этого — заставлять человека ждать. Список нужен строке выбора в
            // шапке сессии: её уровни сужаются до настоящих имён моделей CLI
            await refreshConnectedModels();
            if (!settingsModal.hidden) {
                renderProviders();
                App.renderSessionBarControls();
            }
        }

        return { openSettings };
    }

    return { init };
})();
