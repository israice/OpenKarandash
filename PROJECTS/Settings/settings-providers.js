// Провайдеры и выбор модели в окне настроек: список провайдеров с кнопками
// Connect/Disconnect, подключение OpenCode, выбор установки CLI из нескольких
// найденных и оба каскада выбора модели (витрина и строка в карточке).
//
// Отдельный файл потому, что это самая объёмная часть раздела после разметки, и
// потому, что витрина и карточка делят между собой узлы двух строк выбора
// (showcaseRow и providerModelRow) — правило перерисовки соседнего ряда живёт
// рядом с обоими.
//
// На верхнем уровне файла ничего не выполняется: settings.js зовёт init(...) и получает
// наружу renderProviders, renderDefaultProviderRow и bindModelChoice.
window.SettingsProviders = (function () {

    function init({ settingsModal, pickerModal, api }) {
        const providerList = settingsModal.querySelector('#providerList');
        const defaultProviderRow = settingsModal.querySelector('#defaultProviderRow');
        // узлы двух каскадов в текущей отрисовке: нужны, чтобы перерисовывать при
        // выборе только соседний ряд, а не тот, где кликнули (см. bindModelChoice)
        let showcaseRow = null;
        let providerModelRow = null;
        const pickerList = pickerModal.querySelector('#pickerList');
        const pickerHint = pickerModal.querySelector('#pickerHint');
        const pickerTitle = pickerModal.querySelector('#pickerTitle');

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

        return { renderProviders, renderDefaultProviderRow, bindModelChoice };
    }

    return { init };
})();
