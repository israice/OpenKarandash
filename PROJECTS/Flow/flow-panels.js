// Правая колонка личной ноды: панель MCP со списком серверов и девять панелей
// описания профиля (Soul, System Prompt, Thinking, Tools, Permissions, Model,
// Skills, Agents, Memory). Тексты панелей лежат в состоянии Flow и общие на все
// ноды одной роли: душа у миньона одна, а карточек с ней на канвасе может быть
// несколько.
//
// Наборы полей QA и Backend developer различаются только значениями, поэтому
// здесь они разведены по ключам ROOT_FIELDS: renderFieldPanel получает список
// полей и ключ хранения, а по какой роне мы — по id личной ноды.
(function () {
    window.FlowPanels = function (ctx) {
        const { flowGet, flowSet } = ctx;

        // MCP-серверы, которыми обычно пользуется тестировщик: пункт меню
        // «MCP» личной ноды QA показывает вместо правой колонки этот список.
        // Настоящего подключения за кнопкой пока нет — она только помечает
        // сервер выбранным, отметки живут во flow_state (см. MCP_STATE_KEY)
        const QA_MCPS = [
            { id: 'playwright', name: 'Playwright', hint: 'Browser: clicks, screenshots, traces' },
            { id: 'puppeteer', name: 'Puppeteer', hint: 'Headless Chrome automation' },
            { id: 'chrome-devtools', name: 'Chrome DevTools', hint: 'Console, network, performance' },
            { id: 'lighthouse', name: 'Lighthouse', hint: 'Performance and accessibility audits' },
            { id: 'axe', name: 'Axe a11y', hint: 'Accessibility rule checks' },
            { id: 'http', name: 'HTTP client', hint: 'REST calls and response checks' },
            { id: 'postman', name: 'Postman', hint: 'Collections and API test runs' },
            { id: 'k6', name: 'k6', hint: 'Load and stress scenarios' },
            { id: 'sqlite', name: 'SQLite', hint: 'Test data and fixtures' },
            { id: 'postgres', name: 'Postgres', hint: 'Queries against the app database' },
            { id: 'filesystem', name: 'Filesystem', hint: 'Reports, logs and artifacts' },
            { id: 'github', name: 'GitHub', hint: 'Issues, pull requests, checks' },
            { id: 'jira', name: 'Jira', hint: 'Bug tickets and test tasks' },
            { id: 'testrail', name: 'TestRail', hint: 'Test cases and runs' },
            { id: 'sentry', name: 'Sentry', hint: 'Errors from the running app' },
            { id: 'slack', name: 'Slack', hint: 'Reporting results to the team' },
        ];
        // отмеченные серверы — общие на все ноды QA: список один и тот же,
        // держать его отдельно на каждой карточке смысла нет
        const MCP_STATE_KEY = 'flowQaMcp';
        // пока отметок не ставили, подключённым считается тот сервер, который
        // и правда прописан в профиле (PROJECTS/Flow/profiles/QA/mcp.json)
        const MCP_DEFAULT = ['playwright'];

        // те же интеграции, но для бэкенд-разработчика: список свой, ключ
        // хранения свой (flowBackendMcp) — общий с QA был бы неверен, раз
        // отметки должны жить раздельно по ролям
        const BACKEND_MCPS = [
            { id: 'github', name: 'GitHub', hint: 'Issues, pull requests, code review' },
            { id: 'postgres', name: 'Postgres', hint: 'Schema, queries, migrations' },
            { id: 'sqlite', name: 'SQLite', hint: 'Local dev database' },
            { id: 'redis', name: 'Redis', hint: 'Cache and background job queues' },
            { id: 'docker', name: 'Docker', hint: 'Container builds and compose stacks' },
            { id: 'kubernetes', name: 'Kubernetes', hint: 'Deploys and rollouts' },
            { id: 'http', name: 'HTTP client', hint: 'REST calls and integration checks' },
            { id: 'openapi', name: 'OpenAPI', hint: 'API schema and contract checks' },
            { id: 'sentry', name: 'Sentry', hint: 'Errors from the running server' },
            { id: 'grafana', name: 'Grafana', hint: 'Metrics and dashboards' },
            { id: 'aws', name: 'AWS', hint: 'Cloud resources and deploys' },
            { id: 'stripe', name: 'Stripe', hint: 'Billing and payment webhooks' },
            { id: 'slack', name: 'Slack', hint: 'Deploy and incident notifications' },
            { id: 'jira', name: 'Jira', hint: 'Backlog and sprint tickets' },
        ];
        const BACKEND_MCP_STATE_KEY = 'flowBackendMcp';
        // по умолчанию подключённым считается тот, что и правда прописан в
        // config.yaml профиля (см. PROJECTS/Flow/profiles/Backend developer/config.yaml)
        const BACKEND_MCP_DEFAULT = ['github'];

        const MCP_BY_ROOT = {
            flowNodeQaRoot: { list: QA_MCPS, stateKey: MCP_STATE_KEY, def: MCP_DEFAULT },
            flowNodeBackendRoot: { list: BACKEND_MCPS, stateKey: BACKEND_MCP_STATE_KEY, def: BACKEND_MCP_DEFAULT },
        };
        // у профиля без своей записи (Secretary, UI developer, HR) интеграций
        // нет — раньше такая карточка молча брала запись QA: рисовала его
        // список и писала отметки в его же ключ
        const NO_MCP = { list: [], stateKey: null, def: [] };
        function mcpConfigFor(n) {
            return MCP_BY_ROOT[n.id] || NO_MCP;
        }
        function connectedMcps(n) {
            const cfg = mcpConfigFor(n);
            return cfg.stateKey ? flowGet(cfg.stateKey, cfg.def) : cfg.def;
        }
        // честная пустая панель вместо чужих данных: строка-подсказка тем же
        // классом, каким подписаны панели в разметке
        function renderEmptyPanel(list, text) {
            list.textContent = '';
            const note = document.createElement('div');
            note.className = 'flow-node__panel-hint';
            note.textContent = text;
            list.append(note);
        }
        // кнопка рядом с сервером: подключает, а у подключённого — отключает
        function setMcpButton(btn, connected) {
            btn.textContent = connected ? 'Disconnect' : 'Connect';
            btn.classList.toggle('flow-node__mcp-toggle--on', connected);
            btn.setAttribute('aria-pressed', connected ? 'true' : 'false');
        }
        function renderMcpPanel(n) {
            const list = n.querySelector('.flow-node__mcp-list');
            if (!list) return;
            const cfg = mcpConfigFor(n);
            if (cfg === NO_MCP) {
                renderEmptyPanel(list, 'No integrations are set up for this profile yet.');
                return;
            }
            const connected = connectedMcps(n);
            list.textContent = '';
            for (const mcp of cfg.list) {
                const row = document.createElement('div');
                row.className = 'flow-node__mcp';
                row.dataset.mcp = mcp.id;
                // поиск идёт и по названию, и по описанию — держим их одной
                // готовой строкой, чтобы не собирать её на каждый набранный символ
                row.dataset.search = (mcp.name + ' ' + mcp.hint).toLowerCase();
                const text = document.createElement('span');
                text.className = 'flow-node__mcp-text';
                const name = document.createElement('span');
                name.className = 'flow-node__mcp-name';
                name.textContent = mcp.name;
                const hint = document.createElement('span');
                hint.className = 'flow-node__mcp-hint';
                hint.textContent = mcp.hint;
                text.append(name, hint);
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'flow-node__mcp-toggle';
                setMcpButton(btn, connected.includes(mcp.id));
                row.append(text, btn);
                list.append(row);
            }
        }

        // потолок высоты поля панели: выше него поле не растёт, текст уходит
        // под собственную прокрутку — иначе одно длинное поле вытягивает ноду
        const FIELD_MAX_HEIGHT = 160;

        // поле панели тянется под свой текст: сначала высота сбрасывается,
        // иначе scrollHeight помнит прежнюю и поле только растёт
        function autoGrowField(input) {
            input.style.height = 'auto';
            const full = input.scrollHeight;
            input.style.height = Math.min(full, FIELD_MAX_HEIGHT) + 'px';
            input.style.overflowY = full > FIELD_MAX_HEIGHT ? 'auto' : 'hidden';
        }

        // панели с короткими полями (Soul, System Prompt, Thinking) устроены
        // одинаково: подписанные textarea, текст общий на все ноды QA. Разница
        // только в наборе полей, ключе хранения и префиксе классов — их и
        // передаём. Ключ лежит на самом поле (data-store), поэтому сохранение
        // ниже одно на обе панели
        function renderFieldPanel(n, prefix, fields, stateKey) {
            const list = n.querySelector('.flow-node__' + prefix + '-list');
            if (!list) return;
            const saved = flowGet(stateKey, {});
            list.textContent = '';
            for (const field of fields) {
                const row = document.createElement('label');
                row.className = 'flow-node__' + prefix;
                const name = document.createElement('span');
                name.className = 'flow-node__' + prefix + '-name';
                name.textContent = field.label;
                const input = document.createElement('textarea');
                input.className = 'flow-node__' + prefix + '-input';
                input.rows = 1;
                input.dataset.field = field.id;
                input.dataset.store = stateKey;
                input.placeholder = field.hint;
                // пока поле не трогали, показываем заготовку профиля QA (field.value):
                // карточка сразу описывает работника, а не стоит пустой. Стёртое
                // руками поле хранится как пустая строка — ?? её и бережёт,
                // иначе заготовка возвращалась бы после каждого открытия панели
                input.value = saved[field.id] ?? field.value ?? '';
                row.append(name, input);
                list.append(row);
                // высота считается уже в дереве страницы: у поля вне документа
                // scrollHeight нулевой
                autoGrowField(input);
            }
        }

        ctx.renderEmptyPanel = renderEmptyPanel;
        ctx.renderFieldPanel = renderFieldPanel;
        ctx.renderMcpPanel = renderMcpPanel;
        ctx.mcpConfigFor = mcpConfigFor;
        ctx.connectedMcps = connectedMcps;
        ctx.setMcpButton = setMcpButton;
        ctx.autoGrowField = autoGrowField;
    };
})();
