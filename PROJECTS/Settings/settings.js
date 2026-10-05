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

    // Слушатели файла — на одном сигнале, и снимаются разом: шестерёнка и её меню
    // теперь из шаблона верхнего меню (SYSTEM/topbar.eta) и переживают горячую
    // перезагрузку этого файла. Без снятия второй экземпляр навесил бы на них свои
    // обработчики поверх старых, и меню открывалось бы со второго раза.
    const listeners = new AbortController();
    const ON = { signal: listeners.signal };

    // Разметку рисует settings-markup.js: он подключён раньше всех и отдал функцию
    // mount(), а не готовые узлы — при горячей перезагрузке settings.js разметка
    // должна появиться заново (иначе свежая копия добавит вторую поверх первой).
    const { settingsRoot, settingsButton, settingsMenu, pickerModal, settingsModal } = window.SettingsMarkup.mount();

    // Открытие окна живёт в settings-modal.js и появляется только в конце файла,
    // а вызвать его можно из меню-шестерёнки выше. Поэтому через переменную: сначала
    // пусто, после сборки частей — готовая функция (слушатели сработают позже).
    let openSettings = null;

    // горячая перезагрузка этого скрипта: снимаем всё, что он нарисовал (обе
    // модалки) и свои слушатели, иначе свежая копия добавит вторые модалки поверх
    // первых, а на общих узлах — вторые обработчики. Дальше скрипт выполняется
    // обычным порядком и рисует себя заново сам. Шестерёнку в топбаре не снимаем:
    // она теперь из шаблона (SYSTEM/topbar.eta), и снятая уехала бы из меню до
    // перерисовки страницы.
    //
    // Через очередь на окне, а не через window.App: этот файл подключён раньше
    // app.js, и App там ещё undefined — вызов через App молча ничего не делал, а
    // правка файла перезагружала страницу целиком.
    (window.__hotReloads || (window.__hotReloads = [])).push([
        'PROJECTS/Settings/settings.js',
        () => {
            listeners.abort();
            pickerModal.remove();
            settingsModal.remove();
        },
        null,
        null,
    ]);

    // Мои поставщики. Каждый публикует init() и ничего не рисует сам — окно
    // настроек собираю я, поэтому правка поставщика должна перерисовать окно,
    // а не страницу. Объявляю здесь, а не в поставщиках: кто кого рисует, знает
    // тот, кто рисует (DOCS/decisions/090).
    //
    // Ключ записи — сам поставщик: dependent кладётся под ключом первого
    // элемента, а «кто рисует этот файл» — это второй. Регистрация идёт через
    // очередь на окне, а не через window.App: этот файл подключён раньше app.js.
    for (const supplier of [
        'settings-providers.js',
        'settings-screenshot.js',
        'settings-telegram.js',
        'settings-sandglass-tab.js',
        'settings-modal.js',
    ]) {
        (window.__hotReloads || (window.__hotReloads = [])).push([
            `PROJECTS/Settings/${supplier}`,
            null,
            null,
            'PROJECTS/Settings/settings.js',
        ]);
    }

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
    }, ON);

    document.addEventListener('click', (e) => {
        if (settingsRoot.contains(e.target)) return;
        // кнопка карандаша переключает свой отдельный режим (PROJECTS/Karandash/karandash.js) —
        // клик по ней не должен закрывать уже открытое меню настроек, только Esc
        const karandashButton = document.getElementById('karandashButton');
        if (karandashButton && e.composedPath().includes(karandashButton)) return;
        closeMenu();
    }, ON);

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !settingsMenu.hidden) {
            closeMenu();
            settingsButton.focus();
        }
    }, ON);

    settingsMenu.addEventListener('click', (e) => {
        const item = e.target.closest('.settings__item');
        if (!item) return;
        const label = item.textContent.trim();
        closeMenu();
        if (label === 'Settings') openSettings();
        else console.log('Selected:', label);
    }, ON);

    // ---------- части раздела ----------

    // Порядок вызовов повторяет прежний порядок кода в этом файле: сначала список
    // провайдеров, потом скриншоты и Telegram, потом счётчик Sandglass, и
    // последним окно настроек — оно зовёт их всех при открытии.
    const providers = window.SettingsProviders.init({ settingsModal, pickerModal, api });
    const screenshot = window.SettingsScreenshot.init({ settingsModal, api });
    const telegram = window.SettingsTelegram.init({ settingsModal, api });
    const sandglassTab = window.SettingsSandglassTab.init({ settingsModal });

    const modal = window.SettingsModal.init({
        settingsModal,
        api,
        closeMenu,
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
