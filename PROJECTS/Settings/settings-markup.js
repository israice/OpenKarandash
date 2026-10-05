// Разметка окна Settings вынесена в отдельный файл: два её куска (окно выбора
// окружения CLI и окно настроек с четырьмя вкладками) — половина прежнего
// settings.js. Логики здесь нет вообще.
//
// Кнопку-шестерёнку с её меню скрипт не рисует: они лежат в SYSTEM/topbar.eta рядом
// с остальным верхним меню, а вторая копия в тулбаре — это как раз тот дубль,
// из-за которого шестерёнка и кнопка Karandash оказывались на странице по две.
// Берём их из шаблона, ровно как Karandash берёт свою кнопку (karandash.js).
//
// Подключён с defer раньше settings.js: app.js на старте сразу ищет
// #settingsModal/#pickerModal в DOM (порядок <script> в SYSTEM/index.html), а рисовать их
// обязан кто-то до ядра. Сама разметка едет функцией mount(), а не прямо в файле: при
// горячей перезагрузке settings.js разметка должна нарисоваться заново (свежий экземпляр
// зовёт mount() сам), иначе свежая копия добавит вторую такую же поверх первой.
window.SettingsMarkup = (function () {

    function mount() {
        // ---------- разметка: кнопка-шестерёнка и меню — из шаблона ----------

        const settingsRoot = document.getElementById('settings');
        const settingsButton = settingsRoot.querySelector('#settingsButton');
        const settingsMenu = settingsRoot.querySelector('#settingsMenu');

        // ---------- разметка: окно выбора окружения CLI ----------

        const pickerModal = document.createElement('div');
        pickerModal.className = 'modal modal--top';
        pickerModal.id = 'pickerModal';
        pickerModal.hidden = true;
        pickerModal.innerHTML = `
        <div class="modal__backdrop" data-close-modal></div>
        <div class="modal__dialog" role="dialog" aria-modal="true" aria-labelledby="pickerTitle">
            <div class="modal__header">
                <h2 class="modal__title" id="pickerTitle">Where should the CLI run?</h2>
            </div>
            <p class="modal__hint" id="pickerHint"></p>
            <ul class="picker" id="pickerList"></ul>
        </div>
    `;
        document.body.append(pickerModal);

        // ---------- разметка: окно настроек ----------

        const settingsModal = document.createElement('div');
        // modal--top-align: диалог настроек не центрируется по высоте, а прибит к верху
        // контейнера (сразу под топбаром) — иначе смена вкладки на менее высокую
        // (Router/Network/Sandglass) утягивает всё окно вниз вслед за центровкой
        settingsModal.className = 'modal modal--top-align';
        settingsModal.id = 'settingsModal';
        settingsModal.hidden = true;
        settingsModal.innerHTML = `
        <div class="modal__backdrop" data-close-modal></div>
        <div class="modal__dialog" role="dialog" aria-modal="true" aria-labelledby="settingsModalTitle">
            <div class="settings-tabs" id="settingsTabs" role="tablist" aria-label="Settings sections">
                <button type="button" class="settings-tabs__item" role="tab" aria-selected="true" aria-controls="settingsTabProviders" data-tab="Providers">Providers</button>
                <button type="button" class="settings-tabs__item" role="tab" aria-selected="false" aria-controls="settingsTabRouter" data-tab="Router">Router</button>
                <button type="button" class="settings-tabs__item" role="tab" aria-selected="false" aria-controls="settingsTabNetwork" data-tab="Network">Network</button>
                <button type="button" class="settings-tabs__item" role="tab" aria-selected="false" aria-controls="settingsTabSandglass" data-tab="Sandglass">Sandglass</button>
            </div>
            <div class="modal__header">
                <h2 class="modal__title" id="settingsModalTitle">Settings</h2>
            </div>
            <div class="settings-tab-content" id="settingsTabProviders" role="tabpanel">
                <p class="modal__hint">Connect an AI CLI here, then pick who and which model to run with in the bar above a session.</p>
                <ul class="provider-list" id="providerList"></ul>
                <div class="provider screenshot-screen" id="screenshotScreenRow" hidden>
                    <span class="provider__model-label">Screen for Karandash screenshots:</span>
                    <select class="provider__select" id="screenshotScreenSelect" aria-label="Screen for screenshots"></select>
                    <img class="screenshot-screen__preview" id="screenshotScreenPreview" alt="Selected screen preview" hidden style="cursor: zoom-in">
                </div>
                <div class="provider provider--telegram" id="telegramRow">
                    <div class="provider__row">
                        <div class="telegram__title">
                            <!-- иконка взята как есть из Simple Icons (MIT, simpleicons.org/icons/telegram) -->
                            <svg class="telegram__icon" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
                                <path fill="currentColor" d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/>
                            </svg>
                            <div>
                                <div class="provider__name">Telegram</div>
                                <div class="provider__note">Sends the answer to a finished session and takes your reply back into it.</div>
                            </div>
                        </div>
                        <div class="provider__actions">
                            <span class="provider__status telegram__status" id="telegramStatus" hidden>Connected</span>
                            <button type="button"
                                    class="provider__button provider__button--connect"
                                    id="telegramConnectButton"
                                    aria-expanded="false"
                                    aria-controls="telegramFields">Connect</button>
                        </div>
                    </div>
                    <div class="telegram__fields" id="telegramFields" hidden>
                        <label class="telegram__field">
                            <span class="telegram__field-label">API key</span>
                            <input type="password" class="telegram__input" id="telegramTokenInput"
                                   placeholder="123456789:AA..." autocomplete="off" spellcheck="false"
                                   aria-label="Telegram bot API key">
                        </label>
                        <label class="telegram__field">
                            <span class="telegram__field-label">User ids</span>
                            <input type="text" class="telegram__input" id="telegramUsersInput"
                                   placeholder="12345678, 87654321" autocomplete="off" spellcheck="false"
                                   aria-label="Telegram user ids, comma separated">
                        </label>
                        <div class="telegram__hint" id="telegramHint"></div>
                    </div>
                </div>
            </div>
            <div class="settings-tab-content" id="settingsTabRouter" role="tabpanel" hidden>
                <p class="modal__hint">Coming soon.</p>
            </div>
            <div class="settings-tab-content" id="settingsTabNetwork" role="tabpanel" hidden>
                <p class="modal__hint">Coming soon.</p>
            </div>
            <div class="settings-tab-content" id="settingsTabSandglass" role="tabpanel" hidden>
                <div class="sandglass" data-elapsed="0">
                    <div class="sandglass__countdown" id="sandglassCountdown">1d 02:30:12</div>
                    <!-- свои песочные часы: 3D-рендер на three.js вместо SVG (перенос формы и
                         повадки из https://github.com/khanmjk/Hourglass_Fable5, без их отдельного
                         физического движка — облегчённая версия, см. PROJECTS/Settings/settings-sandglass.js).
                         Контракт между этим файлом и тем модулем — атрибут data-elapsed на .sandglass:
                         сюда пишется доля прошедшего времени счётчика выше (renderSandglassSand),
                         рендер читает её каждый кадр и двигает верхнюю/нижнюю кучу и струйку сам -->
                    <canvas class="hourglass" width="96" height="96" role="img" aria-label="Hourglass with sand falling to the bottom, showing time left until the countdown above reaches zero"></canvas>
                </div>
            </div>
        </div>
    `;
        document.body.append(settingsModal);
        return { settingsRoot, settingsButton, settingsMenu, pickerModal, settingsModal };
    }

    return { mount };
})();
