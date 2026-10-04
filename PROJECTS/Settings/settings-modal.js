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
            bindModelChoice, renderDefaultProviderRow, renderProviders, renderScreenshotScreen,
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
        // новые free-модели из `opencode models --refresh` видны только после
        // Disconnect/Connect вручную, а каскад выбора модели выглядит frozen
        async function refreshConnectedModels() {
            const state = App.connections.get(App.DEFAULT_AGENT);
            if (!state?.installId) return;
            try {
                const result = await api('/api/agent/connect', { agent: App.DEFAULT_AGENT, id: state.installId });
                if (!result?.ok || !Array.isArray(result.models) || !result.models.length) return;
                const provider = App.PROVIDERS.find((p) => p.id === App.DEFAULT_AGENT);
                provider.models = result.models;
                // выбор человека (App.modelOf) главнее свежего списка: пока он в этом
                // списке, обновление моделей его не двигает. Иначе падает на дефолт
                // проекта, и этот откат тоже запоминается — иначе витрина, каскад
                // в карточке и строка выбора в шапке сессии разошлись бы на
                // следующем же открытии окна
                const wanted = App.modelOf(App.DEFAULT_AGENT);
                if (!result.models.includes(wanted)) {
                    provider.defaultModel = result.models.find((m) => m === App.DEFAULT_AGENT_MODEL)
                        || result.models.find((m) => /-free$/i.test(m) || /:free$/i.test(m))
                        || result.models.find((m) => m === 'opencode/big-pickle' || m === 'openrouter/openrouter/free')
                        || result.models[0];
                    App.saveModelChoice(App.DEFAULT_AGENT, provider.defaultModel);
                }
                if (!result.models.includes(state.model)) state.model = provider.defaultModel || result.models[0];
            } catch {
                // сервер недоступен — показываем закэшированный список как есть
            }
        }

        async function openSettings() {
            closeMenu();
            // подписка на чужой выбор модели — с первого открытия окна (здесь
            // window.App уже на месте, в отличие от верхнего уровня файла)
            bindModelChoice();
            // окно всегда открывается на вкладке Providers, даже если в прошлый
            // раз закрыли на другой — соответствует текущему содержимому по умолчанию
            settingsTabItems.forEach((btn) => {
                const active = btn.dataset.tab === 'Providers';
                btn.setAttribute('aria-selected', String(active));
                const panel = settingsModal.querySelector(`#${btn.getAttribute('aria-controls')}`);
                if (panel) panel.hidden = !active;
            });
            setSettingsHeaderVisibility(true);
            renderDefaultProviderRow();
            renderProviders();
            renderScreenshotScreen();
            api('/api/telegram/state').then(renderTelegram);
            startTelegramRefresh();
            App.openModal(settingsModal);
            // свежие модели дотягиваем уже поверх открытого окна: connect стоит
            // секунд (opencode опрашивает models.dev), держать закрытое окно ради
            // этого — заставлять человека ждать
            await refreshConnectedModels();
            if (!settingsModal.hidden) {
                renderDefaultProviderRow();
                renderProviders();
                App.renderSessionBarControls();
            }
        }

        return { openSettings };
    }

    return { init };
})();
