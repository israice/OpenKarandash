// Settings: полностью самодостаточный файл. Создаёт свою разметку (кнопку-шестерёнку
// с выпадающим меню в шапке, окно настроек и окно выбора окружения Claude CLI) и ведёт
// всю логику провайдеров: подключение, выбор модели/effort, экран для скриншотов Karandash,
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
    settingsRoot.innerHTML = `
        <button
            type="button"
            class="icon-button settings__button"
            id="settingsButton"
            aria-haspopup="true"
            aria-expanded="false"
            aria-controls="settingsMenu"
            aria-label="Настройки"
            title="Настройки"
        >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="3"></circle>
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
            </svg>
        </button>

        <ul class="settings__menu" id="settingsMenu" role="menu" aria-labelledby="settingsButton" hidden>
            <li role="none"><button type="button" class="settings__item" role="menuitem">Заглушка_2</button></li>
            <li role="none"><button type="button" class="settings__item" role="menuitem">Заглушка_2</button></li>
            <li role="none"><div class="settings__separator"></div></li>
            <li role="none"><button type="button" class="settings__item" role="menuitem">Settings</button></li>
        </ul>
    `;
    topbar.append(settingsRoot);

    const settingsButton = settingsRoot.querySelector('#settingsButton');
    const settingsMenu = settingsRoot.querySelector('#settingsMenu');

    // ---------- разметка: окно выбора окружения Claude CLI ----------

    const pickerModal = document.createElement('div');
    pickerModal.className = 'modal modal--top';
    pickerModal.id = 'pickerModal';
    pickerModal.hidden = true;
    pickerModal.innerHTML = `
        <div class="modal__backdrop" data-close-modal></div>
        <div class="modal__dialog" role="dialog" aria-modal="true" aria-labelledby="pickerTitle">
            <div class="modal__header">
                <h2 class="modal__title" id="pickerTitle">Where should Claude CLI run?</h2>
                <button type="button" class="modal__close" data-close-modal aria-label="Close">&times;</button>
            </div>
            <p class="modal__hint" id="pickerHint"></p>
            <ul class="picker" id="pickerList"></ul>
        </div>
    `;
    document.body.append(pickerModal);

    // ---------- разметка: окно настроек ----------

    const settingsModal = document.createElement('div');
    settingsModal.className = 'modal';
    settingsModal.id = 'settingsModal';
    settingsModal.hidden = true;
    settingsModal.innerHTML = `
        <div class="modal__backdrop" data-close-modal></div>
        <div class="modal__dialog" role="dialog" aria-modal="true" aria-labelledby="settingsModalTitle">
            <div class="modal__header">
                <h2 class="modal__title" id="settingsModalTitle">Settings</h2>
                <button type="button" class="modal__close" data-close-modal aria-label="Close">&times;</button>
            </div>
            <p class="modal__hint">Connect an AI provider to pick a default model.</p>
            <div class="provider" id="defaultProviderRow">
                <div class="provider__model">
                    <span class="provider__model-label">Провайдер:</span>
                    <select class="provider__select provider__select--source" id="defaultProviderSelect" aria-label="Провайдер"></select>
                    <span class="provider__model-label">Модель:</span>
                    <select class="provider__select" id="defaultProviderModelSelect" aria-label="Модель по умолчанию"></select>
                </div>
            </div>
            <ul class="provider-list" id="providerList"></ul>
            <div class="provider screenshot-screen" id="screenshotScreenRow" hidden>
                <span class="provider__model-label">Screen for Karandash screenshots:</span>
                <select class="provider__select" id="screenshotScreenSelect" aria-label="Screen for screenshots"></select>
                <img class="screenshot-screen__preview" id="screenshotScreenPreview" alt="Selected screen preview" hidden style="cursor: zoom-in">
            </div>
            <!-- пока Hermes ставится, здесь виден ход установки; когда готов — строка о готовности -->
            <div id="hermesSetup"
                 hx-get="/api/fragment/hermes-setup"
                 hx-trigger="load, every 3s"
                 hx-swap="innerHTML"></div>

            <!-- выбор провайдера Hermes целиком рисует сервер: список провайдеров,
                 текущий выбор и подсказка про ключ живут там, а не в двух местах -->
            <div id="hermesProviderPanel"
                 hx-get="/api/fragment/hermes-provider"
                 hx-trigger="load, hermes-provider-changed from:body"
                 hx-swap="innerHTML"></div>
        </div>
    `;
    document.body.append(settingsModal);
    // htmx сам обходит только то, что было в документе при загрузке; это окно
    // собрано из строки уже после, поэтому его атрибуты надо показать явно
    window.htmx?.process(settingsModal);

    // кнопку «Установить» рисует серверный фрагмент, поэтому слушаем его контейнер,
    // а не саму кнопку, которую htmx подменяет
    settingsModal.addEventListener('click', (e) => {
        if (!e.target.closest('#hermesSetupStart')) return;
        api('/api/hermes/setup/start', {});
    });

    // сохранение провайдера: панель внутри — серверный фрагмент, поэтому слушаем
    // окно целиком, а не кнопку, которую htmx подменяет
    settingsModal.addEventListener('click', async (e) => {
        if (!e.target.closest('#hermesProviderSave')) return;
        const note = settingsModal.querySelector('#hermesProviderNote');
        const result = await api('/api/hermes/provider/set', {
            provider: settingsModal.querySelector('#hermesProviderSelect').value,
            model: settingsModal.querySelector('#hermesModelInput').value.trim() || null,
            apiKey: settingsModal.querySelector('#hermesKeyInput').value.trim() || null,
            // подзадачи уходят подагентам на этой модели; провайдер для них —
            // OpenRouter, там и живут бесплатные варианты
            workerModel: settingsModal.querySelector('#hermesWorkerInput')?.value.trim() || null,
            workerProvider: 'openrouter',
        });
        if (note) note.textContent = result.ok ? 'Сохранено.' : result.error;
        document.body.dispatchEvent(new CustomEvent('hermes-provider-changed'));
    });

    const providerList = settingsModal.querySelector('#providerList');
    const defaultProviderSelect = settingsModal.querySelector('#defaultProviderSelect');
    const defaultProviderModelSelect = settingsModal.querySelector('#defaultProviderModelSelect');
    const pickerList = pickerModal.querySelector('#pickerList');
    const pickerHint = pickerModal.querySelector('#pickerHint');
    const pickerTitle = pickerModal.querySelector('#pickerTitle');
    const screenshotScreenRow = settingsModal.querySelector('#screenshotScreenRow');
    const screenshotScreenSelect = settingsModal.querySelector('#screenshotScreenSelect');
    const screenshotScreenPreview = settingsModal.querySelector('#screenshotScreenPreview');

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

    settingsButton.addEventListener('click', () => openSettings());

    document.addEventListener('click', (e) => {
        if (!settingsRoot.contains(e.target)) closeMenu();
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
        else console.log('Выбрано:', label);
    });

    // ---------- витрина провайдер+модель, не зависит от подключения ----------

    // ponytail: показывает, какие провайдеры и модели вообще есть в системе — само
    // переключение никуда не бьёт, до появления мультипровайдерного роутинга.
    // Живёт вне #providerList и не завязана на connections, поэтому видна всегда,
    // а не только после подключения Claude
    function renderDefaultProviderModels() {
        defaultProviderModelSelect.innerHTML = '';
        const provider = App.PROVIDERS.find((p) => p.id === defaultProviderSelect.value);
        if (!provider) return;
        for (const model of provider.models) {
            const option = document.createElement('option');
            option.value = model;
            option.textContent = model === provider.defaultModel ? `${model} (default)` : model;
            option.selected = model === provider.defaultModel;
            defaultProviderModelSelect.append(option);
        }
    }

    function renderDefaultProviderRow() {
        const current = defaultProviderSelect.value;
        defaultProviderSelect.innerHTML = '';
        for (const provider of App.PROVIDERS) {
            const option = document.createElement('option');
            option.value = provider.id;
            option.textContent = provider.name;
            option.selected = provider.id === (current || 'claude');
            defaultProviderSelect.append(option);
        }
        renderDefaultProviderModels();
    }

    defaultProviderSelect.addEventListener('change', renderDefaultProviderModels);

    // ---------- список провайдеров ----------

    function renderProviders() {
        providerList.innerHTML = '';
        // строку «Модель: + effort» Claude показываем последней в списке, чтобы
        // она стояла прямо над Screen for Karandash screenshots, а не терялась
        // среди карточек остальных провайдеров
        let claudeModelItem = null;

        // делим провайдеров на платные и бесплатные (флаг App.PROVIDERS[].paid),
        // внутри каждой секции порядок остаётся как в исходном массиве
        const paidProviders = App.PROVIDERS.filter((p) => p.paid);
        const freeProviders = App.PROVIDERS.filter((p) => !p.paid);

        for (const [title, providers] of [['Платные', paidProviders], ['Бесплатные', freeProviders]]) {
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
                        ${state ? `<span class="provider__status">${state.note || 'Подключено'}</span>` : ''}
                        <button type="button"
                                class="provider__button ${state ? '' : 'provider__button--connect'}"
                                data-provider="${provider.id}">
                            ${state ? 'Отключить' : 'Подключить'}
                        </button>
                    </div>
                `;
                item.append(row);

                // выбор модели показываем только у подключённого провайдера
                if (state) {
                    if (provider.id === 'claude') {
                        const usageRow = document.createElement('div');
                        usageRow.className = 'provider__usage';
                        usageRow.innerHTML = App.renderUsageInline(state.usage);
                        item.append(usageRow);
                    }

                    // у Hermes и у связки списка моделей нет: Hermes выбирает модель
                    // сам по своему конфигу. Пустой выпадающий список выглядел бы
                    // поломкой, поэтому строку с моделью им просто не рисуем
                    if (!provider.models.length) {
                        providerList.append(item);
                        continue;
                    }

                    const modelRow = document.createElement('div');
                    modelRow.className = 'provider__model';

                    const label = document.createElement('span');
                    label.className = 'provider__model-label';
                    label.textContent = 'Модель:';

                    const select = document.createElement('select');
                    select.className = 'provider__select';
                    select.dataset.providerSelect = provider.id;
                    select.setAttribute('aria-label', `Модель для ${provider.name}`);

                    for (const model of provider.models) {
                        const option = document.createElement('option');
                        option.value = model;
                        option.textContent = model === provider.defaultModel
                            ? `${model} (default)`
                            : model;
                        option.selected = model === state.model;
                        select.append(option);
                    }

                    modelRow.append(label, select);

                    // effort пока умеет только Claude CLI (--effort)
                    if (provider.efforts) {
                        const effortSelect = document.createElement('select');
                        effortSelect.className = 'provider__select provider__select--effort';
                        effortSelect.dataset.providerEffortSelect = provider.id;
                        effortSelect.setAttribute('aria-label', `Effort для ${provider.name}`);

                        for (const effort of provider.efforts) {
                            const option = document.createElement('option');
                            option.value = effort;
                            option.textContent = effort === provider.defaultEffort
                                ? `${effort} (default)`
                                : effort;
                            option.selected = effort === (state.effort || provider.defaultEffort);
                            effortSelect.append(option);
                        }

                        modelRow.append(effortSelect);
                    }

                    const modelItem = document.createElement('li');
                    modelItem.className = 'provider';
                    modelItem.append(modelRow);

                    if (provider.id === 'claude') {
                        providerList.append(item);
                        claudeModelItem = modelItem;
                    } else {
                        providerList.append(item, modelItem);
                    }
                    continue;
                }

                providerList.append(item);
            }
        }

        if (claudeModelItem) providerList.append(claudeModelItem);

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

    async function connectClaude(install) {
        const result = await api('/api/agent/connect', { agent: 'claude', id: install.id });
        if (!result.ok) {
            showProviderError('claude', result.error);
            return;
        }

        const provider = App.PROVIDERS.find((p) => p.id === 'claude');
        App.connections.set('claude', {
            installId: result.id,
            label: result.label,
            version: result.version,
            model: App.connections.get('claude')?.model || provider.defaultModel,
            effort: App.connections.get('claude')?.effort || provider.defaultEffort,
            note: `${result.label} · CLI ${result.version}`,
        });
        App.saveClaudeState();
        App.renderSessionBarControls();
        renderProviders();
    }

    // Hermes сам решает, какой моделью работать (Settings → провайдер Hermes),
    // поэтому здесь запоминается только выбранная система запуска
    async function connectHermes(install) {
        const result = await api('/api/agent/connect', { agent: 'hermes', id: install.id });
        if (!result.ok) {
            showProviderError('hermes', result.error);
            return;
        }

        App.connections.set('hermes', {
            installId: result.id,
            label: result.label,
            version: result.version,
            model: null,
            note: `${result.label} · Hermes`,
        });
        App.saveProviderState('hermes');
        App.renderSessionBarControls();
        renderProviders();
    }

    // у OpenCode список моделей заранее не известен (нет хардкода) — сервер
    // реально спрашивает `opencode models` при подключении и отдаёт список ответом
    async function connectOpenCode(install) {
        const result = await api('/api/agent/connect', { agent: 'opencode', id: install.id });
        if (!result.ok) {
            showProviderError('opencode', result.error);
            return;
        }

        const provider = App.PROVIDERS.find((p) => p.id === 'opencode');
        provider.models = result.models || [];
        provider.defaultModel = provider.models[0];

        App.connections.set('opencode', {
            installId: result.id,
            label: result.label,
            version: result.version,
            model: App.connections.get('opencode')?.model || provider.defaultModel,
            note: `${result.label} · CLI ${result.version}`,
        });
        App.saveProviderState('opencode');
        App.renderSessionBarControls();
        renderProviders();
    }

    // окно выбора открывается, только когда найдено больше одного окружения;
    // providerLabel уходит и в заголовок, и в подсказку — общий вид для Claude и OpenCode
    function pickInstall(installs, onPick, providerLabel = 'CLI') {
        pickerTitle.textContent = `Where should ${providerLabel} run?`;
        pickerHint.textContent = 'CLI found in multiple environments — choose which one to use.';
        pickerList.innerHTML = '';

        for (const install of installs) {
            const item = document.createElement('li');
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'picker__item';
            btn.innerHTML = `<span>${install.label}</span><span class="picker__version">CLI ${install.version}</span>`;
            btn.addEventListener('click', () => {
                App.closeModal(pickerModal);
                onPick(install);
            });
            item.append(btn);
            pickerList.append(item);
        }

        App.openModal(pickerModal);
    }

    function showNotFound(providerLabel = 'Claude CLI') {
        pickerTitle.textContent = `Where should ${providerLabel} run?`;
        pickerHint.textContent = `${providerLabel} not found in Windows or WSL. Install it or set the path via the corresponding environment variable when starting the server.`;
        pickerList.innerHTML = '';
        App.openModal(pickerModal);
    }

    providerList.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-provider]');
        if (!btn) return;

        const id = btn.dataset.provider;

        if (App.connections.has(id)) {
            App.connections.delete(id);
            if (id === 'claude') {
                App.setChatSessionId(null);
                App.saveClaudeState();
            } else if (id === 'opencode' || id === 'hermes' || id === 'hermes-plan') {
                App.setChatSessionId(null);
                App.saveProviderState(id);
            }
            renderProviders();
            return;
        }

        // связка «Claude → Hermes» — не отдельный CLI: она работает ровно тогда,
        // когда подключены оба, поэтому подключать здесь нечего
        if (id === 'hermes-plan') {
            const ready = App.connections.has('claude') && App.connections.has('hermes');
            if (!ready) {
                showProviderError(id, 'Нужны оба: подключите Claude и Hermes');
                return;
            }
            App.connections.set('hermes-plan', {
                installId: 'pair',
                label: 'Claude → Hermes',
                version: 'связка',
                model: null,
                note: 'Claude планирует · Hermes выполняет',
            });
            App.saveProviderState('hermes-plan');
            App.renderSessionBarControls();
            renderProviders();
            return;
        }

        // Hermes ставится вместе с проектом, поэтому искать его негде: подключение —
        // это выбор системы (Windows или WSL), в которой его запускать
        if (id === 'hermes') {
            btn.disabled = true;
            btn.textContent = 'Ищу Hermes...';

            let installs = [];
            try {
                ({ installs = [] } = await api('/api/agent/detect', { agent: 'hermes' }));
            } catch (err) {
                renderProviders();
                showProviderError(id, `Сервер недоступен: ${err.message}`);
                return;
            }

            renderProviders();

            if (installs.length === 0) {
                showProviderError(id, 'Hermes ещё не установлен — ход установки виден в Settings');
            } else if (installs.length === 1) {
                connectHermes(installs[0]);
            } else {
                pickInstall(installs, connectHermes, 'Hermes');
            }
            return;
        }

        // у Claude подключение настоящее: ищем CLI в обоих окружениях
        if (id === 'claude') {
            btn.disabled = true;
            btn.textContent = 'Ищу Claude...';

            let installs = [];
            try {
                ({ installs = [] } = await api('/api/agent/detect', { agent: 'claude' }));
            } catch (err) {
                renderProviders();
                showProviderError(id, `Сервер недоступен: ${err.message}`);
                return;
            }

            renderProviders();

            if (installs.length === 0) showNotFound('Claude CLI');
            else if (installs.length === 1) connectClaude(installs[0]);
            else pickInstall(installs, connectClaude, 'Claude CLI');
            return;
        }

        // у OpenCode подключение тоже настоящее: тот же поток detect → connect,
        // список моделей приходит из ответа connect (`opencode models`)
        if (id === 'opencode') {
            btn.disabled = true;
            btn.textContent = 'Ищу OpenCode...';

            let installs = [];
            try {
                ({ installs = [] } = await api('/api/agent/detect', { agent: 'opencode' }));
            } catch (err) {
                renderProviders();
                showProviderError(id, `Сервер недоступен: ${err.message}`);
                return;
            }

            renderProviders();

            if (installs.length === 0) showNotFound('OpenCode CLI');
            else if (installs.length === 1) connectOpenCode(installs[0]);
            else pickInstall(installs, connectOpenCode, 'OpenCode CLI');
            return;
        }

        // остальные провайдеры пока переключаются без реального подключения
        const provider = App.PROVIDERS.find((p) => p.id === id);
        App.connections.set(id, { model: provider.defaultModel });
        renderProviders();
    });

    providerList.addEventListener('change', (e) => {
        const select = e.target.closest('[data-provider-select]');
        if (select) {
            App.connections.get(select.dataset.providerSelect).model = select.value;
            if (select.dataset.providerSelect === 'claude') {
                App.saveClaudeState();
                App.renderSessionBarControls();
            } else if (select.dataset.providerSelect === 'opencode') {
                App.saveProviderState('opencode');
                App.renderSessionBarControls();
            }
            return;
        }

        const effortSelect = e.target.closest('[data-provider-effort-select]');
        if (!effortSelect) return;
        App.connections.get(effortSelect.dataset.providerEffortSelect).effort = effortSelect.value;
        if (effortSelect.dataset.providerEffortSelect === 'claude') {
            App.saveClaudeState();
            App.renderSessionBarControls();
        }
    });

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
            option.textContent = `${screen.index + 1}: ${screen.name ? screen.name + ', ' : ''}${screen.width}×${screen.height}${screen.primary ? ' (основной)' : ''}`;
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

    // ---------- открытие окна настроек ----------

    function openSettings() {
        closeMenu();
        renderDefaultProviderRow();
        renderProviders();
        renderScreenshotScreen();
        App.openModal(settingsModal);
    }

    // что берёт app.js: обновление usage дергается из потока ответа Claude
    window.Settings = {
        refreshUsage(info) {
            const usageRow = providerList.querySelector('.provider__usage');
            if (usageRow) usageRow.innerHTML = App.renderUsageInline(info);
        },
    };

})();
