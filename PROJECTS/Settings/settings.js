// Settings: полностью самодостаточный файл. Создаёт свою разметку (кнопку-шестерёнку
// с выпадающим меню в шапке, окно настроек и окно выбора окружения Claude CLI) и ведёт
// всю логику провайдеров: подключение, выбор модели/effort, экран для скриншотов Edit,
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
            <ul class="provider-list" id="providerList"></ul>
            <div class="provider screenshot-screen" id="screenshotScreenRow" hidden>
                <span class="provider__model-label">Screen for Edit screenshots:</span>
                <select class="provider__select" id="screenshotScreenSelect" aria-label="Screen for screenshots"></select>
                <img class="screenshot-screen__preview" id="screenshotScreenPreview" alt="Selected screen preview" hidden style="cursor: zoom-in">
            </div>
            <div class="provider">
                <span class="provider__model-label">Default tab:</span>
                <select class="provider__select" id="defaultViewSelect" aria-label="Default tab">
                    <option value="graph">🕸️ Graph</option>
                    <option value="flow">🌊 Flow</option>
                    <option value="kanban">🗂️ Kanban</option>
                    <option value="chat">💬 PROJECTS</option>
                    <option value="home">🏠 Home</option>
                </select>
            </div>
        </div>
    `;
    document.body.append(settingsModal);

    const providerList = settingsModal.querySelector('#providerList');
    const pickerList = pickerModal.querySelector('#pickerList');
    const pickerHint = pickerModal.querySelector('#pickerHint');
    const screenshotScreenRow = settingsModal.querySelector('#screenshotScreenRow');
    const screenshotScreenSelect = settingsModal.querySelector('#screenshotScreenSelect');
    const screenshotScreenPreview = settingsModal.querySelector('#screenshotScreenPreview');
    const defaultViewSelect = settingsModal.querySelector('#defaultViewSelect');

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

    // ---------- список провайдеров ----------

    function renderProviders() {
        providerList.innerHTML = '';

        for (const provider of App.PROVIDERS) {
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

                const modelRow = document.createElement('div');
                modelRow.className = 'provider__model';

                // ponytail: список провайдеров пока витринный, переключение не подключено — до появления мультипровайдерного роутинга
                const sourceSelect = document.createElement('select');
                sourceSelect.className = 'provider__select provider__select--source';
                sourceSelect.setAttribute('aria-label', 'Провайдер');
                for (const p of App.PROVIDERS) {
                    const option = document.createElement('option');
                    option.value = p.id;
                    option.textContent = p.name;
                    option.selected = p.id === provider.id;
                    sourceSelect.append(option);
                }
                modelRow.append(sourceSelect);

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
                providerList.append(item, modelItem);
                continue;
            }

            providerList.append(item);
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

    async function connectClaude(install) {
        const result = await api('/api/claude/connect', { id: install.id });
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

    // окно выбора открывается, только когда найдено больше одного окружения
    function pickInstall(installs) {
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
                connectClaude(install);
            });
            item.append(btn);
            pickerList.append(item);
        }

        App.openModal(pickerModal);
    }

    function showNotFound() {
        pickerHint.textContent = 'Claude CLI not found in Windows or WSL. Install it or set the path via the CLAUDE_BIN environment variable when starting the server.';
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
            }
            renderProviders();
            return;
        }

        // у Claude подключение настоящее: ищем CLI в обоих окружениях
        if (id === 'claude') {
            btn.disabled = true;
            btn.textContent = 'Ищу Claude...';

            let installs = [];
            try {
                ({ installs = [] } = await api('/api/claude/detect'));
            } catch (err) {
                renderProviders();
                showProviderError(id, `Сервер недоступен: ${err.message}`);
                return;
            }

            renderProviders();

            if (installs.length === 0) showNotFound();
            else if (installs.length === 1) connectClaude(installs[0]);
            else pickInstall(installs);
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

    // ---------- экран для скриншотов Edit ----------

    // наглядное превью того, что реально снимет кнопка Edit с выбранного
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

    // ---------- вкладка по умолчанию ----------

    defaultViewSelect.value = document.body.dataset.defaultView || 'home';
    defaultViewSelect.addEventListener('change', async () => {
        await api('/api/default-view', { view: defaultViewSelect.value });
        document.body.dataset.defaultView = defaultViewSelect.value;
    });

    // ---------- открытие окна настроек ----------

    function openSettings() {
        closeMenu();
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
