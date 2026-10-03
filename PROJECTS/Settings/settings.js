// Settings: полностью самодостаточный файл. Создаёт свою разметку (кнопку-шестерёнку
// с выпадающим меню в шапке, окно настроек и окно выбора окружения CLI) и ведёт
// всю логику провайдеров: подключение, выбор модели, экран для скриншотов Karandash,
// вкладку по умолчанию. Общее состояние (PROVIDERS, connections, сохранение в
// localStorage, шапка активной сессии) остаётся в app.js — оно нужно ленте чата
// напрямую, а этот файл лишь читает и меняет его через window.App.
//
// Грузится раньше app.js (см. порядок <script> в index.html): app.js на старте
// сразу ищет #settingsModal/#pickerModal в DOM, поэтому их нужно успеть вставить
// первыми. Сам этот файл на своём верхнем уровне к window.App не обращается —
// только внутри обработчиков, которые сработают уже после того, как app.js его определит.
(function () {

    // ---------- разметка: кнопка-шестерёнка и меню ----------

    const topbar = document.querySelector('.topbar');

    const settingsRoot = document.createElement('div');
    settingsRoot.className = 'settings';
    settingsRoot.id = 'settings';
    settingsRoot.setAttribute('role', 'toolbar');
    settingsRoot.setAttribute('aria-label', 'Settings');
    settingsRoot.innerHTML = `
        <button
            type="button"
            class="icon-button settings__button"
            id="settingsButton"
            aria-haspopup="true"
            aria-expanded="false"
            aria-controls="settingsMenu"
            aria-label="Settings"
            title="Settings"
        >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="3"></circle>
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
            </svg>
        </button>

        <ul class="settings__menu" id="settingsMenu" role="menu" aria-labelledby="settingsButton" hidden>
            <li role="none"><button type="button" class="settings__item" role="menuitem">Login</button></li>
            <li role="none"><button type="button" class="settings__item" role="menuitem">Placeholder_2</button></li>
            <li role="none"><div class="settings__separator"></div></li>
            <li role="none"><button type="button" class="settings__item" role="menuitem">Settings</button></li>
        </ul>
    `;
    topbar.append(settingsRoot);

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
                <p class="modal__hint">Connect an AI provider to pick a default model.</p>
                <!-- витрина выбора модели: четыре уровня одним каскадом (createModelCascade) -->
                <div class="provider" id="defaultProviderRow"></div>
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

    // горячая перезагрузка этого скрипта: снимаем всё, что он нарисовал (кнопку в
    // топбаре и обе модалки), иначе свежая копия добавит вторую такую же поверх
    // первой. Дальше скрипт выполняется обычным порядком и рисует себя заново сам
    window.App?.registerHotReload('PROJECTS/Settings/settings.js', () => {
        settingsRoot.remove();
        pickerModal.remove();
        settingsModal.remove();
    });

    const settingsTabs = settingsModal.querySelector('#settingsTabs');
    const settingsTabItems = Array.from(settingsTabs.querySelectorAll('.settings-tabs__item'));
    const providerList = settingsModal.querySelector('#providerList');
    const defaultProviderRow = settingsModal.querySelector('#defaultProviderRow');
    // узлы двух каскадов в текущей отрисовке: нужны, чтобы перерисовывать при
    // выборе только соседний ряд, а не тот, где кликнули (см. bindModelChoice)
    let showcaseRow = null;
    let providerModelRow = null;
    const pickerList = pickerModal.querySelector('#pickerList');
    const pickerHint = pickerModal.querySelector('#pickerHint');
    const pickerTitle = pickerModal.querySelector('#pickerTitle');
    const screenshotScreenRow = settingsModal.querySelector('#screenshotScreenRow');
    const screenshotScreenSelect = settingsModal.querySelector('#screenshotScreenSelect');
    const screenshotScreenPreview = settingsModal.querySelector('#screenshotScreenPreview');
    const settingsModalTitle = settingsModal.querySelector('#settingsModalTitle');
    const settingsModalHeader = settingsModal.querySelector('.modal__header');

    // заголовок «Settings» относится только к вкладке Providers — на остальных
    // табах (Router/Network/Sandglass) его скрываем; кнопка закрытия при этом
    // остаётся на месте.
    function setSettingsHeaderVisibility(isProviders) {
        settingsModalTitle.hidden = !isProviders;
        settingsModalHeader.classList.toggle('modal__header--collapsed', !isProviders);
    }

    async function api(path, body) {
        const res = await fetch(path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body || {}),
        });
        return res.json();
    }

    // Эксклюзивная активация (043): включённый провайдер один — остальных гасим
    // и на клиенте, и на сервере, активный переживает reload/рестарт сервера
    async function activateOnly(id) {
        App.activateExclusive(id);
        App.saveActiveProvider(id);
        App.saveProviderState(id);
        const others = App.PROVIDERS.map((p) => p.id).filter((other) => other !== id);
        for (const other of others) {
            try { await api('/api/agent/disconnect', { agent: other }); } catch { /* сервер недоступен */ }
        }
    }

    async function deactivateProvider(id) {
        App.connections.delete(id);
        App.saveProviderState(id);
        if (App.loadActiveProvider() === id) App.saveActiveProvider(null);
        try { await api('/api/agent/disconnect', { agent: id }); } catch { /* сервер недоступен */ }
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

    // ---------- каскад CLI → шлюз → поставщик → модель ----------
    //
    // Сам каскад — четыре выпадающих списка по имени модели у CLI — живёт в
    // SYSTEM/providers.js вместе с сохранением выбора: та же строка стоит в
    // шапке сессии, и оба места обязаны быть одним и тем же выбором, поэтому
    // здесь мы только собираем строки из фабрики App.modelCascadeRow, а выбор
    // пишем общим App.applyModelChoice.

    // Выбор, сделанный в другом месте (например, в шапке сессии), приходит сюда
    // объявлением — оба каскада окна перерисовываются под него. Ряд, из
    // которого пришёл выбор, не трогаем: select уехал бы из-под курсора, не
    // дорисовав список. Подписка заводится один раз и при первом открытии
    // окна, когда window.App уже на месте: этот файл грузится раньше ядра.
    let modelChoiceBound = false;

    function bindModelChoice() {
        if (modelChoiceBound) return;
        modelChoiceBound = true;
        App.onModelChoice(({ sourceRow }) => {
            if (sourceRow !== showcaseRow) renderDefaultProviderRow();
            if (sourceRow !== providerModelRow) renderProviders();
        });
    }

    // витрина вверху вкладки Providers: все CLI сразу, жива независимо от
    // подключения — до Connect у OpenCode нет списка моделей, и каскад строится
    // по дефолтной строке проекта (openrouter/stealth/space-bunny-alpha)
    function renderDefaultProviderRow() {
        defaultProviderRow.innerHTML = '';
        showcaseRow = App.modelCascadeRow({
            cliIds: App.PROVIDERS.map((p) => p.id),
            model: App.modelOf(App.getActiveProviderId()),
            onChange: App.applyModelChoice,
        });
        defaultProviderRow.append(showcaseRow);
    }

    // ---------- список провайдеров ----------

    function renderProviders() {
        providerList.innerHTML = '';

        // делим провайдеров на платные и бесплатные (флаг App.PROVIDERS[].paid),
        // внутри каждой секции порядок остаётся как в исходном массиве
        const paidProviders = App.PROVIDERS.filter((p) => p.paid);
        const freeProviders = App.PROVIDERS.filter((p) => !p.paid);

        for (const [title, providers] of [['Paid', paidProviders], ['Free', freeProviders]]) {
            if (!providers.length) continue;

            const heading = document.createElement('li');
            heading.className = 'provider-list__heading';
            heading.textContent = title;
            providerList.append(heading);

            for (const provider of providers) {
                const state = App.connections.get(provider.id);

                const item = document.createElement('li');
                item.className = 'provider';

                const row = document.createElement('div');
                row.className = 'provider__row';
                row.innerHTML = `
                    <div>
                        <div class="provider__name">${provider.name}</div>
                        <div class="provider__note">${provider.note}</div>
                    </div>
                    <div class="provider__actions">
                        ${state ? `<span class="provider__status">${state.note || 'Connected'}</span>` : ''}
                        <button type="button"
                                class="provider__button ${state ? '' : 'provider__button--connect'}"
                                data-provider="${provider.id}">
                            ${state ? 'Disconnect' : 'Connect'}
                        </button>
                    </div>
                `;
                item.append(row);

                // выбор модели показываем только у подключённого провайдера: у
                // неподключённого его и выбирать нечем (списка от CLI нет), а
                // витрина наверху с теми же четырьмя уровнями жива всегда
                if (state) {
                    const modelItem = document.createElement('li');
                    modelItem.className = 'provider';
                    providerModelRow = App.modelCascadeRow({
                        // модель в карточке берётся тем же modelOf, что и в
                        // витрине и в шапке сессии: сохранённый выбор человека,
                        // а состояние подключения — лишь запасной вариант, когда
                        // выбора ещё нет
                        cliIds: [provider.id],
                        model: App.modelOf(provider.id),
                        // в карточке одного провайдера весь список агентов с
                        // OpenRouter лишний: уровень CLI здесь и так состоит
                        // из одного пункта (витрина и шапка сессии — там список
                        // есть, см. SYSTEM/model-cascade.js)
                        stubOptions: false,
                        onChange: App.applyModelChoice,
                    });
                    modelItem.append(providerModelRow);

                    providerList.append(item, modelItem);
                    continue;
                }

                providerList.append(item);
            }
        }

        App.renderObsConnection();
    }

    function showProviderError(id, message) {
        const row = providerList.querySelector(`[data-provider="${id}"]`)?.closest('.provider');
        if (!row) return;
        const error = document.createElement('div');
        error.className = 'provider__error';
        error.textContent = message;
        row.append(error);
    }

    // у OpenCode список моделей заранее не известен (нет хардкода) — сервер
    // реально спрашивает `opencode models --refresh` при подключении и отдаёт список ответом
    async function connectOpenCode(install) {
        const result = await api('/api/agent/connect', { agent: 'opencode', id: install.id });
        if (!result.ok) {
            showProviderError('opencode', result.error);
            return;
        }

        const provider = App.PROVIDERS.find((p) => p.id === 'opencode');
        provider.models = result.models || [];
        // Порядок выбора модели при подключении. Первым идёт выбор человека из
        // витрины или шапки сессии (App.saveModelChoice, переживает перезагрузку
        // страницы) — если CLI такую модель знает, она и остаётся. Иначе дефолт
        // проекта: Space Bunny Alpha через OpenRouter, как решил владелец. Модели
        // приходят от CLI списком, поэтому ищем её по имени; если и её нет
        // (CLI другого аккаунта) — падаем на бесплатную, как раньше: первой в
        // списке обычно идёт платная, а человеку нужен free-вариант
        const wanted = App.modelOf('opencode');
        provider.defaultModel = provider.models.find((m) => m === wanted)
            || provider.models.find((m) => m === App.DEFAULT_AGENT_MODEL)
            || provider.models.find((m) => /-free$/i.test(m) || /:free$/i.test(m))
            || provider.models.find((m) => m === 'opencode/big-pickle')
            || provider.models[0]
            || App.DEFAULT_AGENT_MODEL;

        App.connections.set('opencode', {
            installId: result.id,
            label: result.label,
            version: result.version,
            model: provider.defaultModel,
            note: `${result.label} · CLI ${result.version}`,
        });
        await activateOnly('opencode');
        App.renderSessionBarControls();
        // оба каскада сразу: у витрины после Connect появился настоящий список
        // моделей от CLI, а не одна дефолтная строка
        renderDefaultProviderRow();
        renderProviders();
    }

    // выбор между несколькими найденными установками CLI: тот же список, что и
    // у showNotFound, только со строками вместо пустоты
    function pickInstall(installs, onPick, providerLabel = 'CLI') {
        pickerTitle.textContent = `Where should ${providerLabel} run?`;
        pickerHint.textContent = 'CLI found in multiple environments — choose which one to use.';
        pickerList.innerHTML = '';

        for (const install of installs) {
            const item = document.createElement('li');
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'picker__item';
            // label и version приходят с сервера — кладём текстом, а не разметкой
            const label = document.createElement('span');
            label.textContent = install.label;
            const version = document.createElement('span');
            version.className = 'picker__version';
            version.textContent = `CLI ${install.version}`;
            btn.append(label, version);
            btn.addEventListener('click', () => {
                App.closeModal(pickerModal);
                onPick(install);
            });
            item.append(btn);
            pickerList.append(item);
        }

        App.openModal(pickerModal);
    }

    function showNotFound(providerLabel = 'CLI') {
        pickerTitle.textContent = `Where should ${providerLabel} run?`;
        pickerHint.textContent = `${providerLabel} not found on this machine. Install it, or set the path in the environment variable for that provider when starting the server.`;
        pickerList.innerHTML = '';
        App.openModal(pickerModal);
    }

    providerList.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-provider]');
        if (!btn) return;

        const id = btn.dataset.provider;

        if (App.connections.has(id)) {
            await deactivateProvider(id);
            App.setSessionId(null);
            App.saveProviderState(id);
            App.renderSessionBarControls();
            renderProviders();
            return;
        }

        // у OpenCode подключение тоже настоящее: тот же поток detect → connect,
        // список моделей приходит из ответа connect (`opencode models`)
        if (id === 'opencode') {
            btn.disabled = true;
            btn.textContent = 'Looking for OpenCode...';

            let installs = [];
            try {
                ({ installs = [] } = await api('/api/agent/detect', { agent: 'opencode' }));
            } catch (err) {
                renderProviders();
                showProviderError(id, `Server unavailable: ${err.message}`);
                return;
            }

            renderProviders();

            if (installs.length === 0) showNotFound('OpenCode CLI');
            else if (installs.length === 1) connectOpenCode(installs[0]);
            else pickInstall(installs, connectOpenCode, 'OpenCode CLI');
            return;
        }

    });

    // Смена модели в карточке приходит из самого каскада (modelCascadeRow →
    // applyModelChoice) — своего слушателя на providerList больше не нужно.

    // ---------- экран для скриншотов Karandash ----------

    // наглядное превью того, что реально снимет кнопка Karandash с выбранного
    // монитора — тот же снимок, что уходит в миниатюру сессии.
    // Кэшируем по индексу экрана: повторный выбор уже показанного экрана
    // не гоняет PowerShell заново, а сразу показывает то, что уже есть
    const screenshotThumbCache = new Map();
    const SCREENSHOT_LAST_THUMB_KEY = 'screenshotLastThumb';

    // последний снимок держим ещё и в localStorage: при открытии Settings
    // показываем его сразу, пока свежий кадр только грузится с сервера —
    // иначе на пустом кэше окно превью на секунду остаётся пустым
    try {
        const lastThumb = localStorage.getItem(SCREENSHOT_LAST_THUMB_KEY);
        if (lastThumb) {
            screenshotScreenPreview.src = lastThumb;
            screenshotScreenPreview.hidden = false;
        }
    } catch {}

    async function renderScreenshotPreview(index) {
        if (screenshotThumbCache.has(index)) {
            screenshotScreenPreview.src = screenshotThumbCache.get(index);
            screenshotScreenPreview.hidden = false;
            return;
        }
        const { ok, thumb } = await api('/api/screenshot');
        if (ok) {
            screenshotThumbCache.set(index, thumb);
            screenshotScreenPreview.src = thumb;
            screenshotScreenPreview.hidden = false;
            try { localStorage.setItem(SCREENSHOT_LAST_THUMB_KEY, thumb); } catch {}
        } else if (!screenshotScreenPreview.src) {
            screenshotScreenPreview.hidden = true;
        }
    }

    // список мониторов приходит от сервера (PowerShell), поэтому подгружаем
    // его при каждом открытии Settings — состав экранов может меняться
    async function renderScreenshotScreen() {
        const { screens, current } = await api('/api/screenshot/screens');
        if (!screens || screens.length === 0) {
            screenshotScreenRow.hidden = true;
            return;
        }
        screenshotScreenRow.hidden = false;
        screenshotScreenSelect.innerHTML = '';
        for (const screen of screens) {
            const option = document.createElement('option');
            option.value = screen.index;
            option.textContent = `${screen.index + 1}: ${screen.name ? screen.name + ', ' : ''}${screen.width}×${screen.height}${screen.primary ? ' (primary)' : ''}`;
            option.selected = screen.index === current;
            screenshotScreenSelect.append(option);
        }
        renderScreenshotPreview(current);
    }

    screenshotScreenSelect.addEventListener('change', async () => {
        const index = Number(screenshotScreenSelect.value);
        await api('/api/screenshot/screen', { index });
        renderScreenshotPreview(index);
    });

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

    // ---------- вкладка Sandglass: обратный отсчёт (пока заглушка) ----------
    // 1 день 2 часа 30 минут 12 секунд — стартовое значение-заглушка, тикает
    // раз в секунду до нуля и останавливается; уровень песка в SVG следует
    // за долей прошедшего времени этого же счётчика (renderSandglassSand)
    const SANDGLASS_INITIAL_SECONDS = 24 * 3600 + 2 * 3600 + 30 * 60 + 12;
    let sandglassSecondsLeft = SANDGLASS_INITIAL_SECONDS;
    let sandglassTimer = null;
    const sandglassCountdownEl = settingsModal.querySelector('#sandglassCountdown');
    const sandglassEl = settingsModal.querySelector('.sandglass');

    function formatSandglass(totalSeconds) {
        const s = Math.max(0, totalSeconds);
        const days = Math.floor(s / 86400);
        const hours = Math.floor((s % 86400) / 3600);
        const minutes = Math.floor((s % 3600) / 60);
        const seconds = s % 60;
        const pad = (n) => String(n).padStart(2, '0');
        return `${days}d ${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
    }

    // доля прошедшего времени (0 в начале — верх полон, 1 у нуля — низ полон);
    // сам рисунок (3D-рендер, PROJECTS/Settings/settings-sandglass.js) читает
    // это значение из data-elapsed каждый кадр и сам двигает кучи и струйку —
    // этот файл про сам рендер ничего не знает, только пишет долю
    function renderSandglassSand() {
        if (!sandglassEl) return;
        const total = SANDGLASS_INITIAL_SECONDS || 1;
        const elapsed = Math.min(1, Math.max(0, 1 - sandglassSecondsLeft / total));
        sandglassEl.dataset.elapsed = String(elapsed);
    }

    function renderSandglassCountdown() {
        if (sandglassCountdownEl) sandglassCountdownEl.textContent = formatSandglass(sandglassSecondsLeft);
        renderSandglassSand();
    }

    function startSandglassCountdown() {
        if (sandglassTimer) return;
        renderSandglassCountdown();
        sandglassTimer = setInterval(() => {
            if (sandglassSecondsLeft <= 0) {
                clearInterval(sandglassTimer);
                sandglassTimer = null;
                return;
            }
            sandglassSecondsLeft -= 1;
            renderSandglassCountdown();
        }, 1000);
    }

    function stopSandglassCountdown() {
        clearInterval(sandglassTimer);
        sandglassTimer = null;
    }

    // App.closeModal общий на все окна и про Telegram не знает — ловим закрытие
    // по смене атрибута hidden, а не заводим отдельный колбэк в app.js
    new MutationObserver(() => {
        if (settingsModal.hidden) {
            stopTelegramRefresh();
            stopSandglassCountdown();
        }
    }).observe(settingsModal, { attributes: true, attributeFilter: ['hidden'] });

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

})();
