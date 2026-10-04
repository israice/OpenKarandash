// Settings: вход в раздел. Сам файл самодостаточным быть перестал — он держит одну
// вещь: разметку (её рисует settings-markup.js) плюс то, чем её наполняют и кто этим
// управляет: меню-шестерёнка, общий api(), горячая перезагрузка и сборка частей
// раздела. Сами части вынесены по темам в соседние файлы с init(...):
//   settings-providers.js      список провайдеров, Connect/Disconnect, оба каскада
//   settings-screenshot.js     экран для скриншотов Karandash
//   settings-telegram.js       подключение Telegram
//   settings-sandglass-tab.js  обратный отсчёт вкладки Sandglass
//   settings-modal.js          окно настроек, его вкладки и открытие
//   settings-sandglass.js      3D-рендер песочных часов (ES-модуль, отдельно)
// Общее состояние (PROVIDERS, connections, сохранение в localStorage, шапка активной
// сессии) остаётся в app.js — оно нужно ленте чата напрямую, а эти файлы лишь читают
// и меняют его через window.App.
//
// Грузится раньше app.js (см. порядок <script> в index.html): app.js на старте
// сразу ищет #settingsModal/#pickerModal в DOM, поэтому разметку должен успеть
// вставить settings-markup.js — первый в списке. Сам этот файл на своём верхнем
// уровне к window.App не обращается — только внутри обработчиков, которые сработают
// уже после того, как app.js его определит.
(function () {

    // Разметку рисует settings-markup.js: он подключён раньше всех и отдал функцию
    // mount(), а не готовые узлы — при горячей перезагрузке settings.js разметка
    // должна появиться заново (иначе свежая копия добавит вторую поверх первой).
    const { settingsRoot, settingsButton, settingsMenu, pickerModal, settingsModal } = window.SettingsMarkup.mount();

    // Открытие окна живёт в settings-modal.js и появляется только в конце файла,
    // а вызвать его можно из меню-шестерёнки выше. Поэтому через переменную: сначала
    // пусто, после сборки частей — готовая функция (слушатели сработают позже).
    let openSettings = null;

    // горячая перезагрузка этого скрипта: снимаем всё, что он нарисовал (кнопку в
    // топбаре и обе модалки), иначе свежая копия добавит вторую такую же поверх
    // первой. Дальше скрипт выполняется обычным порядком и рисует себя заново сам
    window.App?.registerHotReload('PROJECTS/Settings/settings.js', () => {
        settingsRoot.remove();
        pickerModal.remove();
        settingsModal.remove();
    });

    async function api(path, body) {
        const res = await fetch(path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body || {}),
        });
        return res.json();
    }

    // ---------- меню-шестерёнка ----------

    function openMenu() {
        settingsMenu.hidden = false;
        settingsButton.setAttribute('aria-expanded', 'true');
    }

    function closeMenu() {
        settingsMenu.hidden = true;
        settingsButton.setAttribute('aria-expanded', 'false');
    }

    settingsButton.addEventListener('click', () => {
        if (settingsMenu.hidden) openMenu();
        else closeMenu();
    });

    document.addEventListener('click', (e) => {
        if (settingsRoot.contains(e.target)) return;
        // кнопка карандаша переключает свой отдельный режим (PROJECTS/Karandash/karandash.js) —
        // клик по ней не должен закрывать уже открытое меню настроек, только Esc
        const karandashButton = document.getElementById('karandashButton');
        if (karandashButton && e.composedPath().includes(karandashButton)) return;
        closeMenu();
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !settingsMenu.hidden) {
            closeMenu();
            settingsButton.focus();
        }
    });

    settingsMenu.addEventListener('click', (e) => {
        const item = e.target.closest('.settings__item');
        if (!item) return;
        const label = item.textContent.trim();
        closeMenu();
        if (label === 'Settings') openSettings();
        else console.log('Selected:', label);
    });

    // ---------- части раздела ----------

    // Порядок вызовов повторяет прежний порядок кода в этом файле: сначала список
    // провайдеров (в нём же витрина выбора модели), потом скриншоты и Telegram, потом
    // счётчик Sandglass, и последним окно настроек — оно зовёт их всех при открытии.
    const providers = window.SettingsProviders.init({ settingsModal, pickerModal, api });
    const screenshot = window.SettingsScreenshot.init({ settingsModal, api });
    const telegram = window.SettingsTelegram.init({ settingsModal, api });
    const sandglassTab = window.SettingsSandglassTab.init({ settingsModal });

    const modal = window.SettingsModal.init({
        settingsModal,
        api,
        closeMenu,
        bindModelChoice: providers.bindModelChoice,
        renderDefaultProviderRow: providers.renderDefaultProviderRow,
        renderProviders: providers.renderProviders,
        renderScreenshotScreen: screenshot.renderScreenshotScreen,
        renderTelegram: telegram.renderTelegram,
        startTelegramRefresh: telegram.startTelegramRefresh,
        stopTelegramRefresh: telegram.stopTelegramRefresh,
        startSandglassCountdown: sandglassTab.startSandglassCountdown,
        stopSandglassCountdown: sandglassTab.stopSandglassCountdown,
    });
    openSettings = modal.openSettings;

})();
