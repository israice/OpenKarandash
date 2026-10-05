// Провайдеры в окне настроек: список провайдеров с кнопками Connect/Disconnect,
// подключение CLI и выбор установки из нескольких найденных.
//
// Каскада выбора модели здесь нет: CLI, шлюз, поставщик, модель и глубину
// размышления выбирают в строке над сессией (#chatSessionBar), и это единственное
// место, где они выбираются (SYSTEM/session-model-bar.js). Настройки занимаются
// подключением, а выбором занимается шапка — поэтому два места не могут разойтись
// ни при каких перерисовках.
//
// На верхнем уровне файла ничего не выполняется: settings.js зовёт init(...) и получает
// наружу renderProviders.
window.SettingsProviders = (function () {

    function init({ settingsModal, pickerModal, api }) {
        const providerList = settingsModal.querySelector('#providerList');
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

// Подключение CLI по его слову из списка. Список моделей заранее не
        // известен (хардкода нет) — сервер реально спрашивает сам CLI и отдаёт
        // список ответом. Модели подключение не выбирает: единственное место,
// где выбирают, — строка в шапке сессии, и её выбор подключение обязано
        // пережить. Раньше здесь стоял свой перебор (выбор человека → дефолт
        // проекта → free-вариант → первая модель каталога), и каждый Connect
        // мог подменить модель на другую — то, что человек и выбрал, в ход не
        // уходило

        async function connectAgent(id, install) {
            const result = await api('/api/agent/connect', { agent: id, id: install.id });
            if (!result.ok) {
                showProviderError(id, result.error);
                return;
            }

            // Карточка появляется в списке провайдеров вместе с подключением:
            // до него запись заведена по требованию каскадом выбора и в список
            // не входит, иначе настройки перечисляли бы все слова из списка сайта
            const provider = App.registerProvider(id);
            provider.models = result.models || [];

            App.connections.set(id, {
                installId: result.id,
                label: result.label,
                version: result.version,
                model: App.modelOf(id) || null,
                note: `${result.label} · CLI ${result.version}`,
            });
            await activateOnly(id);
            // список моделей от CLI приехал: перерисовываем строку выбора в
            // шапке сессии, чтобы её уровни сузились до настоящих имён
            App.renderSessionBarControls();
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

            // Подключение настоящее у любого CLI из списка: тот же поток
            // detect → connect, список моделей приходит из ответа connect.
            // Слова берём те, что выбирают в строке выбора сессии (те же, что
            // уходят в CLI), поэтому Connect здесь — то же самое, что первый
            // ход с этим словом, только без самого хода
            btn.disabled = true;
            btn.textContent = `Looking for ${id}...`;

            let installs = [];
            try {
                ({ installs = [] } = await api('/api/agent/detect', { agent: id }));
            } catch (err) {
                renderProviders();
                showProviderError(id, `Server unavailable: ${err.message}`);
                return;
            }

            renderProviders();

            if (installs.length === 0) showNotFound(`${id} CLI`);
            else if (installs.length === 1) connectAgent(id, installs[0]);
            else pickInstall(installs, (install) => connectAgent(id, install), `${id} CLI`);
        });

        // Модель отсюда не выбирается: у кнопки остаётся один смысл — подключить
        // или отключить CLI. Выбор CLI, шлюза, поставщика, модели и глубины живёт
        // в строке над сессией (#chatSessionBar), и кнопка Connect лишь приводит
        // список моделей оттуда

        return { renderProviders };
    }

    return { init };
})();
