// Селекторы «кто этой нодой думает»: провайдер, модель и глубина рассуждения.
// У обычных узлов набор тот же, что у Секретаря, но выбор визуальный и в
// состояние не пишется; у карточки Секретаря выбор переживает перезагрузку —
// он и задаёт агента, которому сервер отдаёт ход.
(function () {
    window.FlowSelects = function (ctx) {
        const { flowGet, flowSet } = ctx;

        // провайдер/модель/effort у обычных узлов — тот же набор, что и у
        // Секретаря, но без сохранения в состоянии: как type/context/scope,
        // это визуальная заглушка, не переживающая перезагрузку
        function renderNodeModelEffort(n) {
            const providerSelect = n.querySelector('.flow-node__provider');
            const modelSelect = n.querySelector('.flow-node__model');
            const effortSelect = n.querySelector('.flow-node__effort');
            if (!providerSelect) return;
            const provider = App.PROVIDERS.find((p) => p.id === providerSelect.value) || App.PROVIDERS[0];

            modelSelect.innerHTML = '';
            for (const model of provider.models) {
                const option = document.createElement('option');
                option.value = model;
                option.textContent = model;
                option.selected = model === provider.defaultModel;
                modelSelect.append(option);
            }

            effortSelect.innerHTML = '';
            effortSelect.hidden = !provider.efforts;
            if (provider.efforts) {
                for (const effort of provider.efforts) {
                    const option = document.createElement('option');
                    option.value = effort;
                    option.textContent = effort;
                    option.selected = effort === provider.defaultEffort;
                    effortSelect.append(option);
                }
            }
        }

        function populateNodeAgentSelects(n) {
            const providerSelect = n.querySelector('.flow-node__provider');
            if (!providerSelect) return;
            for (const provider of App.PROVIDERS) {
                const option = document.createElement('option');
                option.value = provider.id;
                option.textContent = provider.name;
                providerSelect.append(option);
            }
            renderNodeModelEffort(n);
        }

        ctx.renderNodeModelEffort = renderNodeModelEffort;
        ctx.populateNodeAgentSelects = populateNodeAgentSelects;

        // категория «провайдер / модель / effort» ноды Секретаря — какой агент
        // её обслуживает. Выбор переживает перезагрузку (в отличие от прочих
        // нод) и читается сервером при отправке хода
        const providerSelect = document.getElementById('flowNodeSecretaryProvider');
        const modelSelect = document.getElementById('flowNodeSecretaryModel');
        const effortSelect = document.getElementById('flowNodeSecretaryEffort');

        const AGENT_KEY = 'flowNodeSecretaryAgent';
        function loadAgent() {
            return flowGet(AGENT_KEY, {});
        }
        function saveAgent(agent) {
            flowSet(AGENT_KEY, agent);
        }

        const saved = loadAgent();

        for (const provider of App.PROVIDERS) {
            const option = document.createElement('option');
            option.value = provider.id;
            option.textContent = provider.name;
            option.selected = provider.id === (saved.provider || App.PROVIDERS[0].id);
            providerSelect.append(option);
        }

        function renderModelAndEffort() {
            const provider = App.PROVIDERS.find((p) => p.id === providerSelect.value);
            modelSelect.innerHTML = '';
            for (const model of provider.models) {
                const option = document.createElement('option');
                option.value = model;
                option.textContent = model;
                option.selected = model === (saved.provider === provider.id && saved.model ? saved.model : provider.defaultModel);
                modelSelect.append(option);
            }

            effortSelect.innerHTML = '';
            effortSelect.hidden = !provider.efforts;
            if (provider.efforts) {
                for (const effort of provider.efforts) {
                    const option = document.createElement('option');
                    option.value = effort;
                    option.textContent = effort;
                    option.selected = effort === (saved.provider === provider.id && saved.effort ? saved.effort : provider.defaultEffort);
                    effortSelect.append(option);
                }
            }
        }

        renderModelAndEffort();

        function saveCurrentAgent() {
            saveAgent({ provider: providerSelect.value, model: modelSelect.value, effort: effortSelect.value });
        }
        providerSelect.addEventListener('change', () => {
            renderModelAndEffort();
            saveCurrentAgent();
        });
        modelSelect.addEventListener('change', saveCurrentAgent);
        effortSelect.addEventListener('change', saveCurrentAgent);
    };
})();
