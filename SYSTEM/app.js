// Ядро Mission Control: подключение к провайдерам (состояние, на которое опирается
// лента чата), панель сессий, лента сообщений. Само окно настроек и вся его разметка —
// в PROJECTS/Settings/settings.js, он и грузится первым (см. порядок <script> в
// index.html), поэтому здесь можно сразу же находить #settingsModal/#pickerModal в DOM.

        (function () {


            // ---------- состояние подключения к провайдерам ----------

            // списки моделей — заготовка под реальные данные провайдеров
            const PROVIDERS = [
                {
                    id: 'claude',
                    name: 'Claude',
                    note: 'Anthropic',
                    paid: true,
                    models: ['claude-opus-5', 'claude-sonnet-5', 'claude-fable-5', 'claude-haiku-4-5'],
                    defaultModel: 'claude-sonnet-5',
                    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
                    defaultEffort: 'medium',
                },
                {
                    id: 'codex',
                    name: 'Codex',
                    note: 'OpenAI',
                    paid: true,
                    models: ['gpt-5-codex', 'gpt-5', 'gpt-5-mini', 'o4-mini'],
                    defaultModel: 'gpt-5-codex',
                },
                {
                    id: 'hermes',
                    name: 'Hermes',
                    note: 'оркестратор: сам планирует и помнит',
                    paid: false,
                    // модель Hermes выбирает сам по своему конфигу (Settings → провайдер
                    // Hermes), поэтому списка моделей на клиенте нет
                    models: [],
                    defaultModel: undefined,
                },
                {
                    id: 'opencode',
                    name: 'OpenCode',
                    note: 'локальные и сторонние модели',
                    paid: false,
                    // список моделей заранее не хардкодим — CLI отдаёт его сам
                    // (`opencode models`) при подключении, см. connectOpenCode в settings.js,
                    // который наполняет этот массив по факту ответа сервера
                    models: [],
                    defaultModel: undefined,
                },
                // связка, а не CLI: подключать нечего, она доступна ровно тогда,
                // когда подключены и Claude, и Hermes. Стоит последней, чтобы не
                // выглядеть заменой кому-то из них
                {
                    id: 'hermes-plan',
                    name: 'Связка: Claude → Hermes',
                    note: 'Claude составляет задание, Hermes выполняет его дешёвыми моделями. Нужны оба подключения',
                    paid: false,
                    models: [],
                    defaultModel: undefined,
                },
            ];

            // подключение переживает перезагрузку страницы: id окружения, модель и
            // сессию CLI держим в localStorage, само окружение восстанавливаем на сервере.
            // свой ключ и свой POST на восстановление — на провайдера, чтобы Claude и
            // OpenCode подключались независимо друг от друга
            const STORE_KEYS = { claude: 'noname.claude', opencode: 'noname.opencode', hermes: 'noname.hermes', 'hermes-plan': 'noname.hermes-plan' };
            const STORE_KEY = STORE_KEYS.claude;

            // общий помощник для POST-запросов к серверу — им пользуются и остальные
            // файлы через window.App.api, каждый второй экран так или иначе ходит на сервер
            async function api(path, body) {
                const res = await fetch(path, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body || {}),
                });
                return res.json();
            }

            // общий помощник сохранения/восстановления состояния провайдера —
            // Claude и OpenCode работают через него одинаково, каждый под своим ключом
            function saveProviderState(providerId) {
                const key = STORE_KEYS[providerId];
                if (!key) return;
                const state = connections.get(providerId);
                try {
                    if (!state) localStorage.removeItem(key);
                    else localStorage.setItem(key, JSON.stringify({ ...state, sessionId: chatSessionId }));
                } catch {
                    // приватный режим или запрет на хранилище — работаем без сохранения
                }
            }

            function loadProviderState(providerId) {
                const key = STORE_KEYS[providerId];
                if (!key) return null;
                try {
                    return JSON.parse(localStorage.getItem(key) || 'null');
                } catch {
                    return null;
                }
            }

            function saveClaudeState() { saveProviderState('claude'); }
            function loadClaudeState() { return loadProviderState('claude'); }
            function saveOpenCodeState() { saveProviderState('opencode'); }
            function loadOpenCodeState() { return loadProviderState('opencode'); }

            // используется во всех местах, где сохранение зависит не от конкретного
            // провайдера, а от смены текущей сессии (chatSessionId) — сохраняем состояние
            // обоих провайдеров, лишний вызов на неподключённого просто удалит его ключ
            function saveAllProviderStates() {
                saveClaudeState();
                saveOpenCodeState();
            }

            const connections = new Map();

            // лимиты подписки живут отдельно от model/effort: обновляются на каждый
            // ответ CLI, а не только при подключении
            function updateClaudeUsage(info) {
                const claude = connections.get('claude');
                if (!claude) return;
                claude.usage = info;
                saveClaudeState(); // иначе лимиты теряются при live-reload страницы

                // модалка настроек (PROJECTS/Settings/settings.js) может быть закрыта —
                // тогда просто обновляем данные в connections, renderProviders перечитает их
                // при следующем открытии
                window.Settings?.refreshUsage?.(info);
            }

            const chatSessionBar = document.getElementById('chatSessionBar');
            const chatSessionProviderSelect = document.getElementById('chatSessionProviderSelect');
            const chatSessionModelSelect = document.getElementById('chatSessionModelSelect');
            const chatSessionEffortSelect = document.getElementById('chatSessionEffortSelect');
            const claudeProvider = PROVIDERS.find((p) => p.id === 'claude');

            // модель/effort из шапки сессии переопределяют connections.get(provider.id) —
            // sendToClaude берёт их оттуда, так что следующее сообщение в этой же
            // сессии (тот же sessionId) продолжится уже с новыми параметрами.
            // выбор провайдера в шапке теперь настоящий: sendToClaude/stopClaude
            // реально бьют в /api/<provider>/ask и /api/<provider>/stop по нему
            function renderSessionModelEffort(provider, state) {
                chatSessionModelSelect.innerHTML = '';
                for (const model of provider.models) {
                    const option = document.createElement('option');
                    option.value = model;
                    option.textContent = model;
                    option.selected = model === (state.model || provider.defaultModel);
                    chatSessionModelSelect.append(option);
                }

                chatSessionEffortSelect.innerHTML = '';
                chatSessionEffortSelect.hidden = !provider.efforts;
                if (provider.efforts) {
                    for (const effort of provider.efforts) {
                        const option = document.createElement('option');
                        option.value = effort;
                        option.textContent = effort;
                        option.selected = effort === (state.effort || provider.defaultEffort);
                        chatSessionEffortSelect.append(option);
                    }
                }
            }

            // отдаёт провайдера, с которым сейчас реально ведётся диалог: то, что выбрано
            // в строке шапки сессии, а до её появления — первый подключённый провайдер
            function getActiveProviderId() {
                if (!chatSessionBar.hidden && chatSessionProviderSelect.value) return chatSessionProviderSelect.value;
                if (connections.has('claude')) return 'claude';
                if (connections.has('opencode')) return 'opencode';
                return 'claude';
            }

            function renderSessionBarControls() {
                // строка выбора провайдера/модели/effort видна, как только подключён
                // хотя бы один провайдер, и до создания самой сессии — так пользователь
                // настраивает параметры заранее; строка с id остаётся скрытой отдельно
                const connectedProviders = PROVIDERS.filter((p) => connections.has(p.id));
                chatSessionBar.hidden = connectedProviders.length === 0 || sessionList.hidden;
                chatSessionProviderSelect.innerHTML = '';
                chatSessionModelSelect.innerHTML = '';
                chatSessionEffortSelect.innerHTML = '';
                if (connectedProviders.length === 0) return;

                const defaultProviderId = connections.has('claude') ? 'claude' : connectedProviders[0].id;
                for (const provider of connectedProviders) {
                    const option = document.createElement('option');
                    option.value = provider.id;
                    option.textContent = provider.name;
                    option.selected = provider.id === defaultProviderId;
                    chatSessionProviderSelect.append(option);
                }

                const activeProvider = connectedProviders.find((p) => p.id === defaultProviderId);
                renderSessionModelEffort(activeProvider, connections.get(defaultProviderId));
            }

            chatSessionProviderSelect.addEventListener('change', () => {
                const provider = PROVIDERS.find((p) => p.id === chatSessionProviderSelect.value) || claudeProvider;
                renderSessionModelEffort(provider, connections.get(provider.id) || {});
            });

            chatSessionModelSelect.addEventListener('change', () => {
                const providerId = chatSessionProviderSelect.value || 'claude';
                const state = connections.get(providerId);
                if (!state) return;
                state.model = chatSessionModelSelect.value;
                saveProviderState(providerId);
            });

            chatSessionEffortSelect.addEventListener('change', () => {
                const providerId = chatSessionProviderSelect.value || 'claude';
                const state = connections.get(providerId);
                if (!state) return;
                state.effort = chatSessionEffortSelect.value;
                saveProviderState(providerId);
            });

            function setChatSessionId(id) {
                chatSessionId = id;
                renderSessionBarControls();
                syncComposerBusy();
                syncSessionSelection(); // список сессий рисует сервер, aria-current — единственное, что знает только браузер
                loadChatDraft(id);
                chatInput.focus();
            }

            // недописанный текст в композере переживает обновление страницы — свой черновик
            // на каждую сессию (id === null — общий слот для «сессия не выбрана»/«новая сессия»)
            const CHAT_DRAFT_PREFIX = 'chatDraft:';

            function chatDraftKey(id) {
                return CHAT_DRAFT_PREFIX + (id || '__none__');
            }

            function saveChatDraft() {
                const key = chatDraftKey(chatSessionId);
                const text = chatInput.value;
                if (text) localStorage.setItem(key, text);
                else localStorage.removeItem(key);
            }

            function loadChatDraft(id) {
                chatInput.value = localStorage.getItem(chatDraftKey(id)) || '';
                chatInput.style.height = 'auto';
                chatInput.style.height = chatInput.scrollHeight + 'px';
                chatInput.style.overflowY = chatInput.scrollHeight > 160 ? 'auto' : 'hidden';
            }

            function clearChatDraft(id) {
                localStorage.removeItem(chatDraftKey(id));
            }

            // оба окна физически создаёт PROJECTS/Settings/settings.js (грузится раньше
            // app.js, см. порядок <script> в index.html) — здесь только общая логика
            // закрытия модалок, одна для всех окон проекта
            const modal = document.getElementById('settingsModal');
            const pickerModal = document.getElementById('pickerModal');

            function formatResetTime(unixSeconds) {
                return new Date(unixSeconds * 1000).toLocaleString('ru-RU', {
                    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
                });
            }

            // показывается сразу над строкой выбора модели, без клика — как только Claude подключён
            function renderUsageInline(usage) {
                const windows = usage?.unifiedWindows;
                if (!windows) {
                    return '<div class="provider__usage-empty">Данные появятся после первого запроса</div>';
                }

                const row = (label, win) => !win ? '' : `
                    <div class="provider__usage-row">
                        <span class="provider__usage-label">${label}</span>
                        <span class="provider__usage-value">${Math.round(win.utilization * 100)}%</span>
                    </div>
                    <div class="provider__usage-reset">сброс: ${formatResetTime(win.resetsAt)}</div>
                `;
                return row('5 часов', windows.five_hour) + row('7 дней', windows.seven_day);
            }

            function openModal(el) {
                el.hidden = false;
                el.querySelector('.modal__close').focus();
            }


            function closeModal(el) {
                el.hidden = true;
                if (el === modal) {
                    document.getElementById('settingsButton').focus();
                }
            }

            // модальное окно подтверждения взамен нативного confirm() — та же
            // разметка .modal/.modal__dialog, что у остальных окон, поэтому стиль
            // не расходится; строится на лету и убирается за собой, чтобы им можно
            // было пользоваться из любого файла (flow.js, sessions и т.п.) без
            // добавления своего <div> в index.html под каждый вызов
            function confirmModal(message, opts = {}) {
                return new Promise((resolve) => {
                    const el = document.createElement('div');
                    el.className = 'modal modal--top';
                    el.innerHTML = `
                        <div class="modal__backdrop"></div>
                        <div class="modal__dialog modal__dialog--confirm" role="alertdialog" aria-modal="true" aria-labelledby="confirmModalTitle">
                            <div class="modal__header">
                                <h2 class="modal__title" id="confirmModalTitle"></h2>
                            </div>
                            <p class="modal__hint"></p>
                            <div class="modal__confirm-actions">
                                <button type="button" class="modal__btn" data-confirm="cancel"></button>
                                <button type="button" class="modal__btn modal__btn--danger" data-confirm="ok"></button>
                            </div>
                        </div>
                    `;
                    el.querySelector('.modal__title').textContent = opts.title || 'Подтвердите действие';
                    el.querySelector('.modal__hint').textContent = message;
                    el.querySelector('[data-confirm="cancel"]').textContent = opts.cancelText || 'Отмена';
                    el.querySelector('[data-confirm="ok"]').textContent = opts.confirmText || 'Удалить';
                    document.body.append(el);

                    function cleanup(result) {
                        el.remove();
                        document.removeEventListener('keydown', onKey);
                        resolve(result);
                    }
                    el.addEventListener('click', (e) => {
                        if (e.target.closest('.modal__backdrop') || e.target.closest('[data-confirm="cancel"]')) cleanup(false);
                        else if (e.target.closest('[data-confirm="ok"]')) cleanup(true);
                    });
                    function onKey(e) {
                        if (e.key !== 'Escape') return;
                        cleanup(false);
                    }
                    document.addEventListener('keydown', onKey);
                    el.querySelector('[data-confirm="ok"]').focus();
                });
            }

            // Профиль каждого исполнителя на шкале: чем он владеет и что из этого
            // задействовано именно в текущей задаче (used) — это решает глава компании,
            // наводя курсор на иконку.
            const WORKER_INFO = {
                secretary: {
                    emoji: '🗂️', name: 'Секретарь', role: 'Приём и разбор задачи',
                    competencies: ['Приоритизация', 'Формулировка ТЗ', 'Маршрутизация'],
                    mcp: ['Notion', 'Slack'],
                    tools: ['Todo-лист', 'Шаблоны ТЗ'],
                    skills: ['intake-triage'],
                    used: ['Приоритизация', 'Маршрутизация', 'Todo-лист', 'intake-triage'],
                },
                researcher: {
                    emoji: '🔎', name: 'Исследователь', role: 'Поиск первопричины',
                    competencies: ['Анализ логов', 'Дебаг', 'Чтение чужого кода'],
                    mcp: ['GitHub', 'Sentry'],
                    tools: ['grep/rg', 'Профилировщик'],
                    skills: ['root-cause-analysis'],
                    used: ['Анализ логов', 'Дебаг', 'GitHub', 'grep/rg', 'root-cause-analysis'],
                },
                architect: {
                    emoji: '🧭', name: 'Архитектор', role: 'Проектирование решения',
                    competencies: ['Системный дизайн', 'Оценка рисков'],
                    mcp: ['Notion'],
                    tools: ['Диаграммы'],
                    skills: ['design-review'],
                    used: ['Системный дизайн', 'design-review'],
                },
                designer: {
                    emoji: '🎨', name: 'Дизайнер', role: 'UI/UX для правки',
                    competencies: ['Интерфейсы', 'Доступность'],
                    mcp: ['Figma'],
                    tools: ['Figma'],
                    skills: ['ui-review'],
                    used: [],
                },
                developer: {
                    emoji: '🛠️', name: 'Разработчик', role: 'Реализация правки (сейчас в работе)',
                    competencies: ['Node.js', 'Отладка гонок', 'Автотесты'],
                    mcp: ['GitHub', 'Context7'],
                    tools: ['VS Code', 'node:sqlite'],
                    skills: ['bugfix', 'test-writing'],
                    used: ['Node.js', 'Отладка гонок', 'Автотесты', 'GitHub', 'node:sqlite', 'bugfix', 'test-writing'],
                },
                tester: {
                    emoji: '🧪', name: 'Тестировщик', role: 'Следующий: прогон регрессии',
                    competencies: ['Регрессионное тестирование', 'Граничные случаи'],
                    mcp: ['GitHub Actions'],
                    tools: ['Playwright'],
                    skills: ['regression-suite'],
                    used: ['Регрессионное тестирование', 'GitHub Actions', 'Playwright', 'regression-suite'],
                },
                writer: {
                    emoji: '📝', name: 'Технический писатель', role: 'Описание изменений',
                    competencies: ['Changelog', 'Документация'],
                    mcp: ['Notion'],
                    tools: ['Markdown'],
                    skills: ['release-notes'],
                    used: [],
                },
                reviewer: {
                    emoji: '✅', name: 'Проверяющий', role: 'Финальная приёмка',
                    competencies: ['Код-ревью', 'Оценка соответствия ТЗ'],
                    mcp: ['GitHub'],
                    tools: ['code-review'],
                    skills: ['final-approval'],
                    used: [],
                },
            };

            function renderWorkerTags(items, used) {
                return items.map((item) => `<span class="worker-tooltip__tag${used.has(item) ? ' is-used' : ''}">${item}</span>`).join('');
            }

            function renderWorkerTooltip(info) {
                const used = new Set(info.used);
                return `
                    <div class="worker-tooltip__head">
                        <span class="worker-tooltip__emoji">${info.emoji}</span>
                        <div>
                            <div class="worker-tooltip__name">${info.name}</div>
                            <div class="worker-tooltip__role">${info.role}</div>
                        </div>
                    </div>
                    <div class="worker-tooltip__section">
                        <p class="worker-tooltip__label">Компетенции</p>
                        <div class="worker-tooltip__tags">${renderWorkerTags(info.competencies, used)}</div>
                    </div>
                    <div class="worker-tooltip__section">
                        <p class="worker-tooltip__label">MCP</p>
                        <div class="worker-tooltip__tags">${renderWorkerTags(info.mcp, used)}</div>
                    </div>
                    <div class="worker-tooltip__section">
                        <p class="worker-tooltip__label">Инструменты</p>
                        <div class="worker-tooltip__tags">${renderWorkerTags(info.tools, used)}</div>
                    </div>
                    <div class="worker-tooltip__section">
                        <p class="worker-tooltip__label">Skills</p>
                        <div class="worker-tooltip__tags">${renderWorkerTags(info.skills, used)}</div>
                    </div>
                    <p class="worker-tooltip__hint">Подсвечено — задействовано в этой задаче</p>
                `;
            }

            const workerTooltip = document.getElementById('workerTooltip');

            document.querySelectorAll('.task-card__progress-worker').forEach((el) => {
                const info = WORKER_INFO[el.dataset.worker];
                if (!info) return;

                el.addEventListener('mouseenter', () => {
                    workerTooltip.innerHTML = renderWorkerTooltip(info);
                    const rect = el.getBoundingClientRect();
                    workerTooltip.classList.add('is-visible');
                    const tipRect = workerTooltip.getBoundingClientRect();
                    let left = rect.left + rect.width / 2 - tipRect.width / 2;
                    left = Math.max(8, Math.min(left, window.innerWidth - tipRect.width - 8));
                    let top = rect.top - tipRect.height - 10;
                    if (top < 8) top = rect.bottom + 10;
                    workerTooltip.style.left = `${left}px`;
                    workerTooltip.style.top = `${top}px`;
                });

                el.addEventListener('mouseleave', () => {
                    workerTooltip.classList.remove('is-visible');
                });
            });

            const shotLightbox = document.getElementById('shotLightbox');
            const shotLightboxImg = document.getElementById('shotLightboxImg');

            // единственное место в проекте, которое открывает превью скриншота на весь экран —
            // им пользуются и task-card__shot, и screenshotScreenPreview, и миниатюры сессий
            function openShotLightbox(src, alt = '') {
                shotLightboxImg.src = src;
                shotLightboxImg.alt = alt;
                shotLightbox.hidden = false;
            }

            function closeShotLightbox() {
                shotLightbox.hidden = true;
                shotLightboxImg.src = '';
            }

            document.addEventListener('click', (e) => {
                const img = e.target.closest('.task-card__shot img, #screenshotScreenPreview');
                if (!img || img.hidden) return;
                openShotLightbox(img.src, img.alt);
            });

            shotLightbox.addEventListener('click', closeShotLightbox);

            const versionModal = document.getElementById('versionModal');
            document.getElementById('appVersionButton').addEventListener('click', () => openModal(versionModal));

            // окна графа живут в graph.js, но закрываются общим кодом — берём их по id
            const fileModal = document.getElementById('fileModal');

            for (const el of [modal, pickerModal, versionModal, fileModal]) {
                el.addEventListener('click', (e) => {
                    if (e.target.closest('[data-close-modal]')) closeModal(el);
                });
            }

            // Esc закрывает верхнее из открытых окон
            document.addEventListener('keydown', (e) => {
                if (e.key !== 'Escape') return;
                if (!shotLightbox.hidden) { closeShotLightbox(); }
                else if (!fileModal.hidden) closeModal(fileModal);
                else if (!pickerModal.hidden) closeModal(pickerModal);
                else if (!versionModal.hidden) closeModal(versionModal);
                else if (!modal.hidden) closeModal(modal);
            });

            // ---------- переключение вида Session ----------

            const VIEWS = {
                home: document.getElementById('defaultView'),
                graph: document.getElementById('graphView'),
                flow: document.getElementById('flowView'),
                kanban: document.getElementById('kanbanView'),
                book: document.getElementById('bookView'),
                hermes: document.getElementById('hermesView'),
                chat: document.getElementById('chatView'),
            };

            const BOARD_COLUMNS = ['New', 'In Progress', 'Checking', 'Validator', 'Done'];

            // ширина нативного скроллбара нужна, чтобы composer/session-bar совпадали по ширине
            // с .chat__messages, где место под скроллбар зарезервировано через scrollbar-gutter
            const sbProbe = document.createElement('div');
            sbProbe.style.cssText = 'position:absolute;top:-9999px;width:100px;height:100px;overflow:scroll;';
            document.body.appendChild(sbProbe);
            document.documentElement.style.setProperty('--sbw', (sbProbe.offsetWidth - sbProbe.clientWidth) + 'px');
            sbProbe.remove();

            // панель датчиков над композером — сейчас только контекст, место под будущие.
            // видна всегда: до первого ответа показывает «Контекст: —»
            const chatGaugeContext = document.getElementById('chatGaugeContext');
            // окно показываем в человекочитаемом виде (1M / 200K), а не сырым числом токенов
            function formatContextWindow(window) {
                if (!window) return null;
                if (window % 1000000 === 0) return `${window / 1000000}M`;
                if (window % 1000 === 0) return `${window / 1000}K`;
                return String(window);
            }
            function updateContextGauge(percent, window) {
                if (percent == null) { chatGaugeContext.textContent = 'Контекст: —'; return; }
                const windowLabel = formatContextWindow(window);
                chatGaugeContext.textContent = windowLabel
                    ? `Контекст: ${percent}% из ${windowLabel}`
                    : `Контекст: ${percent}%`;
            }
            // окно контекста зависит только от модели и известно ещё до первого ответа
            // (см. contextWindowFor в server.js) — используем это, чтобы датчик показывал
            // реальное значение сразу при создании сессии, а не «—» весь первый ход
            function contextWindowForModel(model) {
                return typeof model === 'string' && /haiku/i.test(model) ? 200000 : 1000000;
            }

            // поле ввода растёт под текст, Enter отправляет, Shift+Enter переносит строку
            const chatInput = document.getElementById('chatInput');

            chatInput.addEventListener('input', () => {
                chatInput.style.height = 'auto';
                chatInput.style.height = chatInput.scrollHeight + 'px';
                chatInput.style.overflowY = chatInput.scrollHeight > 160 ? 'auto' : 'hidden';
                saveChatDraft();
            });

            // Enter переносит строку, отправляет Ctrl+Enter (на Mac — Cmd+Enter)
            chatInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    document.getElementById('chatComposer').requestSubmit();
                }
            });

            // режим отправки: обе опции видны, активная помечена aria-checked
            const chatMode = document.getElementById('chatMode');
            const modeOptions = [...chatMode.querySelectorAll('.segmented__option')];

            function setMode(mode) {
                chatMode.dataset.active = mode;

                for (const option of modeOptions) {
                    const active = option.dataset.mode === mode;
                    option.setAttribute('aria-checked', String(active));
                    option.tabIndex = active ? 0 : -1;
                }

                chatInput.placeholder = mode === 'Action'
                    ? 'Опишите действие...'
                    : 'Напишите сообщение...';
            }

            chatMode.addEventListener('click', (e) => {
                const option = e.target.closest('.segmented__option');
                if (option) setMode(option.dataset.mode);
            });

            // стрелками переключаемся между опциями, как в обычной группе радиокнопок
            chatMode.addEventListener('keydown', (e) => {
                if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
                e.preventDefault();
                const current = modeOptions.findIndex((o) => o.dataset.mode === chatMode.dataset.active);
                const next = modeOptions[(current + (e.key === 'ArrowRight' ? 1 : -1) + modeOptions.length) % modeOptions.length];
                setMode(next.dataset.mode);
                next.focus();
            });

            setMode('Action');

            // ---------- панель Sessions на странице Chat ----------
            // разметку списка строит сервер (SYSTEM/templates/chat-sessions.eta,
            // роут /api/fragment/chat-sessions), htmx подменяет #sessionList целиком
            // по hx-swap-oob — значит сам узел периодически заменяется новым, и
            // держать на него константную ссылку нельзя: обработчик htmx:oobAfterSwap
            // ниже переподхватывает актуальный узел сразу после подмены

            let sessionList = document.getElementById('sessionList');
            const sessionsPanel = document.getElementById('sessionsPanel');
            const runningCountEl = document.getElementById('runningCount');

            // ---------- панель наблюдения на вкладке Home ----------

            // счётчики и списки панели рисует сервер (шаблон
            // SYSTEM/templates/home-observation.eta, роут /api/fragment/home-observation),
            // htmx подменяет их по hx-swap-oob. Здесь остаётся только строка
            // провайдера — она известна одному браузеру
            const obsConnectionText = document.getElementById('obsConnectionText');
            const observationEl = document.querySelector('.observation');

            // aria-current — единственное в списке сессий, что знает только браузер
            // (сервер рендерит разметку без понятия о том, какая сессия сейчас открыта)
            function syncSessionSelection() {
                for (const btn of sessionList.querySelectorAll('.session-item')) {
                    btn.setAttribute('aria-current', String(btn.dataset.sessionId === chatSessionId));
                }
            }

            // htmx подменяет #sessionList целиком (hx-swap-oob) — старый узел живой
            // ссылке, которую держат остальные функции файла, больше не принадлежит,
            // поэтому переподхватываем актуальный и досчитываем то, что знает только браузер.
            // Новый узел всегда приходит со scrollTop = 0, поэтому при активных
            // сессиях (они обновляются чаще, см. hx-trigger) список каждую подмену
            // дёргало наверх прямо во время прокрутки. htmx убирает старый узел из DOM
            // ДО события oobAfterSwap, а scrollTop у отсоединённого узла уже читается
            // как 0 — поэтому позицию нужно снять раньше, на oobBeforeSwap, пока узел
            // ещё живой, и применить её позже, когда придёт новый
            // пока палец/курсор жмёт на строку (мусорка, копирование id), подмену
            // нужно отложить: htmx создаёт НОВЫЕ узлы кнопок, а клик засчитывается
            // браузером только если mousedown и mouseup случились на одном и том же
            // узле — если подмена попадёт между ними, клик молча пропадёт, а кнопка
            // (видимая только через :hover/opacity) как будто "закроется" сама
            let sessionsPointerDown = false;
            sessionsPanel.addEventListener('pointerdown', () => { sessionsPointerDown = true; });
            window.addEventListener('pointerup', () => { sessionsPointerDown = false; });
            window.addEventListener('pointercancel', () => { sessionsPointerDown = false; });

            let sessionListScrollBeforeSwap = 0;
            document.body.addEventListener('htmx:oobBeforeSwap', (e) => {
                if (e.target.id !== 'sessionList') return;
                if (sessionsPointerDown) { e.detail.shouldSwap = false; return; }
                sessionListScrollBeforeSwap = e.target.scrollTop;
            });
            document.body.addEventListener('htmx:oobAfterSwap', (e) => {
                if (e.target.id !== 'sessionList') return;
                sessionList = e.target;
                sessionList.scrollTop = sessionListScrollBeforeSwap;
                syncSessionSelection();
                applyRunningIndicator();
            });

            // клики по строкам сессии вешаем на неизменяемую панель, а не на сам
            // #sessionList — тот периодически подменяется htmx целиком, и слушатель
            // на нём пережил бы только первую отрисовку
            sessionsPanel.addEventListener('click', (e) => {
                // клик по превью открывает его на весь экран, повторный клик закрывает — превью не должно выбирать сессию
                const thumb = e.target.closest('.session-item__thumb-img');
                if (thumb) {
                    openShotLightbox(thumb.src);
                    return;
                }

                const copy = e.target.closest('.session-copy');
                if (copy) {
                    navigator.clipboard.writeText(copy.dataset.copyId);
                    copy.classList.remove('session-copy--copied');
                    void copy.offsetWidth; // рестарт анимации при повторном клике подряд
                    copy.classList.add('session-copy--copied');
                    setTimeout(() => copy.classList.remove('session-copy--copied'), 1000);
                    return; // клик по копированию не должен открывать сессию
                }

                const del = e.target.closest('.session-delete');
                if (del) {
                    removeSession(del.dataset.deleteId);
                    return; // клик по мусорке не должен открывать сессию
                }

                const btn = e.target.closest('.session-item');
                if (btn && btn.dataset.sessionId) {
                    if (btn.getAttribute('aria-current') === 'true') {
                        deselectSession();
                    } else {
                        openSession(btn.dataset.sessionId, btn.classList.contains('session-item--running'));
                    }
                }
            });

            function renderObsConnection() {
                const state = connections.get('claude');
                if (state?.note) {
                    obsConnectionText.textContent = `${state.note} · модель ${state.model}`;
                    obsConnectionText.classList.remove('obs-connection__text--off');
                } else {
                    obsConnectionText.textContent = 'Не подключено · подключите провайдера в настройках';
                    obsConnectionText.classList.add('obs-connection__text--off');
                }
            }

            // слушаем контейнер, а не сами списки: htmx подменяет <ul> целиком,
            // и обработчик, повешенный на них, пережил бы только первое обновление
            observationEl?.addEventListener('click', (e) => {
                const btn = e.target.closest('.obs-list__item');
                if (!btn) return;
                MissionTabs.show('chat');
                openSession(btn.dataset.sessionId, btn.dataset.running === '1');
            });

            async function loadSessions() {
                try {
                    const { sessions = [] } = await api('/api/sessions');
                    // сам список рисует сервер: этот же 'sessions-changed' слушают и
                    // home-observation, и chat-sessions — оба фрагмента подтянутся сразу,
                    // не дожидаясь очередного опроса по таймеру
                    document.body.dispatchEvent(new CustomEvent('sessions-changed'));
                    return sessions;
                } catch {
                    return [];
                }
            }

            // черновик новой сессии: показывается в списке сразу, до первого сообщения,
            // и исчезает сам, когда список перерисуется с реальными данными с сервера
            function insertSessionPlaceholder() {
                sessionList.querySelector('.session-item--placeholder')?.closest('li').remove();
                sessionList.querySelector('.session-empty')?.remove();

                for (const btn of sessionList.querySelectorAll('.session-item')) {
                    btn.setAttribute('aria-current', 'false');
                }

                const item = document.createElement('li');
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'session-item session-item--placeholder';
                btn.setAttribute('aria-current', 'true');
                btn.innerHTML = `
                    <span class="session-item__thumb" aria-hidden="true"></span>
                    <span class="session-item__body">
                        <span class="session-item__title">New</span>
                        <span class="session-item__meta">черновик</span>
                    </span>
                `;
                item.append(btn);
                sessionList.prepend(item);
                applyRunningIndicator();
            }

            // переключение на другую сессию: показываем её переписку и продолжаем её же
            async function openSession(id, running = false) {
                MissionGraph?.closeFilePanel(); // могла быть открыта панель редактирования файла
                sessionList.querySelector('.session-item--placeholder')?.closest('li').remove();
                setChatSessionId(id);
                saveAllProviderStates();

                chatRun += 1;
                chatList.innerHTML = '';
                chatEmpty.hidden = true;

                const { messages = [], contextPercent = null, contextWindow = null } = await api('/api/sessions/messages', { id });
                for (const message of messages) {
                    if (message.role === 'tool') addStep(message.text);
                    else addMessage(message.text, message.role === 'user' ? 'user' : 'assistant');
                }

                if (messages.length === 0) chatEmpty.hidden = false;
                updateContextGauge(contextPercent, contextWindow);

                // работа ещё идёт (страницу перезагрузили посреди неё) — досматриваем вживую
                if (running) {
                    setRunningSessionId(id);
                    attachSession(id, chatRun);
                }
            }

            // повторный клик по выбранной (синей) сессии снимает выбор — назад к чату default
            function deselectSession() {
                MissionGraph?.closeFilePanel(); // могла быть открыта панель редактирования файла
                setChatSessionId(null);
                saveAllProviderStates();
                chatRun += 1;
                chatList.innerHTML = chatDefaultHtml;
                chatEmpty.hidden = false;
                updateContextGauge(null);
            }

            // удаление сессии из базы. если удалили открытую — лента чистится,
            // иначе следующий вопрос ушёл бы в --resume несуществующей сессии
            async function removeSession(id) {
                if (!id) return;
                if (!(await confirmModal('Удалить эту сессию из базы? Действие необратимо.', { title: 'Удалить сессию' }))) return;

                const { ok, error } = await api('/api/sessions/delete', { id });
                if (!ok) {
                    alert(error || 'Не удалось удалить сессию');
                    await loadSessions();
                    return;
                }

                clearChatDraft(id);

                if (id === chatSessionId) {
                    setChatSessionId(null);
                    saveAllProviderStates();
                    chatRun += 1;
                    chatList.innerHTML = '';
                    chatEmpty.hidden = false;
                }

                await loadSessions();
            }

            // новая сессия: чистим ленту, следующий вопрос начнёт свою историю в CLI,
            // а в списке сразу появляется черновик — реальная сессия придёт с сервера позже
            document.getElementById('sessionNew').addEventListener('click', () => {
                setChatSessionId(null);
                saveAllProviderStates();
                chatRun += 1;
                chatList.innerHTML = '';
                chatEmpty.hidden = false;
                insertSessionPlaceholder();
                document.getElementById('chatInput').focus();
            });

            // обнулить базу сессий: чистим список и текущую переписку
            document.getElementById('sessionReset').addEventListener('click', async () => {
                if (!(await confirmModal('Удалить все сессии из базы? Действие необратимо.', { title: 'Удалить все сессии' }))) return;

                await api('/api/sessions/reset');
                for (const key of Object.keys(localStorage)) {
                    if (key.startsWith(CHAT_DRAFT_PREFIX)) localStorage.removeItem(key);
                }
                setChatSessionId(null);
                saveAllProviderStates();
                chatRun += 1;
                chatList.innerHTML = '';
                chatEmpty.hidden = false;
                await loadSessions();
            });

            // ---------- лента сообщений ----------

            const chatList = document.getElementById('chatList');
            const chatDefaultHtml = chatList.innerHTML; // карточка «Секретарь» — вид «Чата Пользователя» без выбранной сессии
            const chatEmpty = document.getElementById('chatEmpty');
            const chatMessages = document.getElementById('chatMessages');
            const chatSend = document.querySelector('.chat__send');

            // прокручиваем вниз только если пользователь и так был у низа ленты —
            // иначе новые блоки во время стрима сбрасывали его к последнему сообщению.
            // Проверять «у низа ли пользователь» нужно ДО того, как в ленту добавится
            // новый блок — иначе scrollHeight уже вырастет на высоту этого блока,
            // и даже если пользователь стоял у самого низа, дистанция окажется большой.
            const CHAT_SCROLL_NEAR_BOTTOM_PX = 80;
            function isChatNearBottom() {
                const distanceFromBottom = chatMessages.scrollHeight - chatMessages.scrollTop - chatMessages.clientHeight;
                return distanceFromBottom <= CHAT_SCROLL_NEAR_BOTTOM_PX;
            }
            function scrollChatToBottom() {
                chatMessages.scrollTop = chatMessages.scrollHeight;
            }

            let chatSessionId = null; // CLI продолжает диалог по нему
            let chatRun = 0; // номер текущего запроса: старый перестаёт писать в ленту

            // индикатор «сессия ещё выполняется» в списке слева
            const PENDING_SESSION_ID = '__pending__'; // запрос уже идёт, но id придёт позже
            let runningSessionId = null;

            function applyRunningIndicator() {
                for (const btn of sessionList.querySelectorAll('.session-item')) {
                    const id = btn.dataset.sessionId || (btn.classList.contains('session-item--placeholder') ? PENDING_SESSION_ID : null);
                    const active = btn.dataset.running === '1' || (id !== null && id === runningSessionId);
                    btn.classList.toggle('session-item--running', active);
                }
                const runningCount = sessionList.querySelectorAll('.session-item--running').length;
                runningCountEl.textContent = runningCount;
                document.getElementById('chatButton')?.classList.toggle('icon-button--running', runningCount > 0);
                const chatButtonBadge = document.getElementById('chatButtonBadge');
                if (chatButtonBadge) chatButtonBadge.textContent = runningCount;
            }

            function setRunningSessionId(id) {
                runningSessionId = id;
                applyRunningIndicator();
                syncComposerBusy();
            }

            // Stop-кнопка нужна только той сессии, что сейчас реально выполняется —
            // при переключении на другую сессию busy-состояние пересчитывается заново
            function syncComposerBusy() {
                const viewingId = chatSessionId || PENDING_SESSION_ID;
                setComposerBusy(runningSessionId !== null && runningSessionId === viewingId);
            }

            // сервер держит выбранное окружение в памяти и теряет его при перезапуске,
            // поэтому страница умеет восстановить подключение по сохранённому id —
            // общая функция на оба провайдера, только с разным API-префиксом
            const reconnecting = {};

            function restoreServerConnection(providerId = 'claude') {
                const state = connections.get(providerId);
                if (!state) return Promise.resolve(false);
                if (!reconnecting[providerId]) {
                    reconnecting[providerId] = api('/api/agent/connect', { agent: providerId, id: state.installId })
                        .then((r) => r.ok)
                        .catch(() => false)
                        .finally(() => { reconnecting[providerId] = null; });
                }
                return reconnecting[providerId];
            }

            (async function restoreOnLoad() {
                const savedClaude = loadClaudeState();
                if (savedClaude?.installId) {
                    connections.set('claude', savedClaude);
                    restoreServerConnection('claude'); // сервер мог быть перезапущен — вернём ему окружение
                }

                const savedOpenCode = loadOpenCodeState();
                if (savedOpenCode?.installId) {
                    connections.set('opencode', savedOpenCode);
                    restoreServerConnection('opencode');
                }

                renderObsConnection();

                // список сессий готов сразу при загрузке страницы
                const sessions = await loadSessions();

                // последнюю открытую сессию подгружаем всегда, чтобы переход на вкладку Chat
                // (кнопка chatButton) сразу показывал её, а не пустой экран. Если страницу
                // перезагрузили посреди работы той же сессии (например, dev-автообновление) —
                // ещё и переключаемся на вкладку сами, чтобы не терять индикатор в процессе
                const saved = savedClaude?.sessionId ? savedClaude : savedOpenCode;
                const found = saved?.sessionId && sessions.find((s) => s.id === saved.sessionId);
                if (found) {
                    await openSession(found.id, found.running);
                    if (found.running) MissionTabs.show('chat');
                } else {
                    setChatSessionId(null);
                    saveAllProviderStates();
                }
            })();

            // список сессий (боковая панель на всех экранах + панель наблюдения на Home)
            // обновляется сам, пока вкладка открыта
            setInterval(loadSessions, 8000);

            function escapeHtml(s) {
                return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
            }

            // ответ ассистента приходит в markdown — рендерим его в HTML, чтобы списки
            // и абзацы легли отдельными блоками, а не одной slitной строкой pre-wrap
            function renderMarkdown(text) {
                const codeBlocks = [];
                // код прячем до разбора остального — звёздочки/решётки внутри не должны считаться разметкой
                let src = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
                    codeBlocks.push(`<pre><code>${escapeHtml(code.replace(/\n$/, ''))}</code></pre>`);
                    return `⁣${codeBlocks.length - 1}⁣`;
                });

                src = escapeHtml(src);
                src = src.replace(/`([^`]+)`/g, '<code>$1</code>');
                src = src.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
                src = src.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>');
                src = src.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

                const out = [];
                let list = null; // 'ul' | 'ol' | null
                let para = [];

                const flushPara = () => {
                    if (para.length) { out.push(`<p>${para.join('<br>')}</p>`); para = []; }
                };
                const closeList = () => {
                    if (list) { out.push(`</${list}>`); list = null; }
                };

                for (const rawLine of src.split('\n')) {
                    const line = rawLine.trim();
                    const codeRef = line.match(/^⁣\d+⁣$/);
                    const heading = line.match(/^(#{1,6})\s+(.*)/);
                    const bullet = line.match(/^[-*]\s+(.*)/);
                    const numbered = line.match(/^\d+[.)]\s+(.*)/);

                    // пустая строка закрывает абзац, но не список — иначе список из пунктов,
                    // разделённых пустыми строками, распадается на несколько <ol>, и нумерация
                    // каждый раз начинается заново (1 1 1 вместо 1 2 3)
                    if (!line) { flushPara(); continue; }

                    if (codeRef) {
                        // плейсхолдер код-блока — целый блок сам по себе, не абзац
                        flushPara(); closeList();
                        out.push(line);
                    } else if (heading) {
                        flushPara(); closeList();
                        const level = heading[1].length;
                        out.push(`<h${level}>${heading[2]}</h${level}>`);
                    } else if (bullet) {
                        flushPara();
                        if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; }
                        out.push(`<li>${bullet[1]}</li>`);
                    } else if (numbered) {
                        flushPara();
                        if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; }
                        out.push(`<li>${numbered[1]}</li>`);
                    } else {
                        closeList();
                        para.push(line);
                    }
                }
                flushPara();
                closeList();

                return out.join('').replace(/⁣(\d+)⁣/g, (_, i) => codeBlocks[i]);
            }

            // строка шага: что Claude сделал (Read index.html, Bash npm test)
            function addStep(text, before) {
                const stick = isChatNearBottom();
                const step = document.createElement('div');
                step.className = 'chat__message chat__message--tool';
                step.textContent = text;
                if (before && before.parentNode === chatList) chatList.insertBefore(step, before);
                else chatList.append(step);
                if (stick) scrollChatToBottom();
                return step;
            }

            // строка рассуждения (event.type === 'thinking', см. server.js emit):
            // раньше текст в неё вообще не попадал — событие тихо отбрасывалось
            // в makeRenderer, а в ленте не оставалось никакого следа рассуждения
            function addThinkingStep(text, before) {
                const stick = isChatNearBottom();
                const step = document.createElement('div');
                step.className = 'chat__message chat__message--thinking';
                step.textContent = text;
                step.title = text;
                if (before && before.parentNode === chatList) chatList.insertBefore(step, before);
                else chatList.append(step);
                if (stick) scrollChatToBottom();
                return step;
            }

            function addMessage(text, kind) {
                const stick = isChatNearBottom();
                chatEmpty.hidden = true;

                const message = document.createElement('div');
                message.className = `chat__message chat__message--${kind}`;
                if (kind === 'assistant' && text) message.innerHTML = renderMarkdown(text);
                else message.textContent = text;
                chatList.append(message);
                if (stick) scrollChatToBottom();
                return message;
            }

            function setComposerBusy(busy) {
                chatSend.classList.toggle('chat__send--stop', busy);
                chatSend.textContent = busy ? 'Stop' : 'Send';
            }

            // останавливает CLI-процесс на сервере; поток сам закроется событием error/done.
            // очередь и запущенные процессы общие на все CLI, поэтому маршрут один
            // и провайдера указывать не нужно
            function stopClaude() {
                api('/api/agent/stop', { sessionId: chatSessionId });
            }

            document.getElementById('chatComposer').addEventListener('submit', (e) => {
                e.preventDefault();

                if (chatSend.classList.contains('chat__send--stop')) {
                    stopClaude();
                    return;
                }

                const text = chatInput.value.trim();
                if (!text) return;

                const mode = chatMode.dataset.active;

                clearChatDraft(chatSessionId);
                chatInput.value = '';
                chatInput.style.height = 'auto';
                chatInput.style.overflowY = 'hidden';
                sendToClaude(text, mode);
            });

            // миниатюра элемента из режима Karandash: сессии ещё нет, id придёт только
            // с первым событием потока — до тех пор снимок ждёт здесь
            let pendingThumb = null;

            // комментарий из режима Karandash начинает отдельную сессию с этим вопросом.
            // вкладку на Chat не переключаем — пользователь сам перейдёт туда, если захочет
            function startCommentSession(prompt, thumb) {
                pendingThumb = thumb || null;
                setChatSessionId(null);
                saveAllProviderStates();
                chatRun += 1;
                chatList.innerHTML = '';
                setMode('Action');
                sendToClaude(prompt, 'Action');
            }

            // ответ приходит потоком NDJSON: по событию в строке
            async function readNdjson(res, onEvent) {
                const reader = res.body.getReader();
                const decoder = new TextDecoder();
                let tail = '';

                for (;;) {
                    const { value, done } = await reader.read();
                    if (done) break;

                    tail += decoder.decode(value, { stream: true });
                    const lines = tail.split('\n');
                    tail = lines.pop();

                    for (const line of lines) {
                        if (line.trim()) onEvent(JSON.parse(line));
                    }
                }
            }

            // маршрут один на всех: какой CLI звать, сервер берёт из поля agent
            // в теле. Формат событий тоже общий (session|tool|text|context|error|done),
            // поэтому readNdjson/makeRenderer ниже не различают провайдеров
            async function streamAsk(body, onEvent) {
                const res = await fetch('/api/agent/ask', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                });
                await readNdjson(res, onEvent);
            }

            // строка ожидания с тремя точками — она же показывает текущий шаг
            function addPendingStatus() {
                const status = addMessage('', 'assistant');
                status.classList.add('chat__message--pending');
                status.innerHTML = '<span class="chat__typing"><span></span><span></span><span></span></span>';
                return status;
            }

            // отрисовка событий потока — одна и та же для своего запроса
            // и для подключения к работе, которая уже идёт
            function makeRenderer(status) {
                let answered = false;

                return (event) => {
                    if (event.type === 'tool') {
                        // каждое действие остаётся своей строкой в ленте, а не заменяет предыдущую
                        addStep(`${event.name} ${event.detail}`.trim(), status);
                    } else if (event.type === 'thinking') {
                        // текст рассуждения, а не просто отметка, что оно было
                        addThinkingStep(event.text, status);
                    } else if (event.type === 'text') {
                        answered = true;
                        const stick = isChatNearBottom();
                        addMessage(event.text, 'assistant');
                        chatList.append(status); // строка ожидания остаётся последней
                        if (stick) scrollChatToBottom();
                    } else if (event.type === 'error') {
                        addMessage(event.error, 'error');
                    } else if (event.type === 'done') {
                        if (!answered && event.text) addMessage(event.text, 'assistant');
                        loadSessions(); // в списке обновилось число сообщений
                    }
                };
            }

            // сессия всё ещё выполняется (страницу перезагрузили посреди работы) —
            // досматриваем её ленту вживую
            async function attachSession(id, run) {
                const res = await fetch('/api/sessions/attach', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ id }),
                });

                // поток идёт с типом application/x-ndjson; обычный JSON означает,
                // что работа уже закончилась и подключаться не к чему
                if (!res.headers.get('content-type')?.includes('ndjson')) {
                    setRunningSessionId(null);
                    loadSessions();
                    return;
                }

                const status = addPendingStatus();
                setComposerBusy(true);
                const render = makeRenderer(status);

                // как и в sendToClaude: пока довоспроизводим чужой поток, автообновление подождёт,
                // иначе очередной dev-reload оборвёт чтение раньше, чем страница успеет его показать
                window.__holdReload?.(true);

                try {
                    await readNdjson(res, (event) => {
                        if (event.type === 'rate_limit') { updateClaudeUsage(event.info); return; }
                        if (event.type === 'context') { updateContextGauge(event.percent, event.window); return; }
                        if (run === chatRun) render(event);
                    });
                } finally {
                    window.__holdReload?.(false);
                    status.remove();
                    setRunningSessionId(null);
                    if (run === chatRun) setComposerBusy(false);
                }
            }

            async function sendToClaude(text, mode = 'Action') {
                const run = ++chatRun;
                // провайдер берём из строки шапки сессии — туда же уходит запрос
                const providerId = getActiveProviderId();
                const provider = PROVIDERS.find((p) => p.id === providerId);
                const claude = connections.get(providerId);
                if (!claude) {
                    addMessage(`${provider ? provider.name : 'Провайдер'} не подключён. Откройте Settings и нажмите «Подключить».`, 'error');
                    return;
                }

                addMessage(text, 'user');

                const status = addPendingStatus();
                setComposerBusy(true);
                setRunningSessionId(chatSessionId || PENDING_SESSION_ID);

                let notConnected = false;
                const render = makeRenderer(status);

                // Claude из чата правит файлы проекта — автообновление подождёт,
                // иначе перезагрузка оборвёт чтение потока и ответ пропадёт
                window.__holdReload?.(true);

                const handle = (event) => {
                    // ленту уже очистили под другую сессию — этот запрос дорабатывает
                    // на сервере, но в чат больше не пишет
                    if (run !== chatRun) return;

                    if (event.type === 'session') {
                        status.innerHTML = '<span class="chat__typing"><span></span><span></span><span></span></span>';

                        // id известен сразу — сессия появляется в списке до ответа
                        if (event.id !== chatSessionId) {
                            setChatSessionId(event.id);
                            saveProviderState(providerId);
                            setRunningSessionId(event.id);
                            // окно модели известно сразу — не ждём первого 'context' от CLI,
                            // чтобы датчик не висел на «—» весь первый ход новой сессии
                            updateContextGauge(0, contextWindowForModel(claude.model));
                            if (pendingThumb) {
                                const thumb = pendingThumb;
                                pendingThumb = null;
                                api('/api/sessions/thumb', { id: event.id, thumb }).then(loadSessions);
                            } else {
                                loadSessions();
                            }
                        }
                        return;
                    }

                    // формулировка ошибки идёт от сервера ("Claude не подключён" /
                    // "OpenCode не подключён" и т.п.) — ловим по общему признаку,
                    // а не по конкретному имени провайдера
                    if (event.type === 'error' && typeof event.error === 'string' && event.error.includes('не подключён')) {
                        notConnected = true; // повторим после восстановления окружения
                        return;
                    }

                    if (event.type === 'rate_limit') {
                        updateClaudeUsage(event.info);
                        return;
                    }

                    if (event.type === 'context') {
                        updateContextGauge(event.percent, event.window);
                        return;
                    }

                    render(event);
                };

                const ask = () => streamAsk({
                    agent: providerId,
                    prompt: text,
                    model: claude.model,
                    effort: claude.effort,
                    sessionId: chatSessionId,
                    mode,
                }, handle);

                try {
                    await ask();

                    // сервер перезапустился и забыл окружение — восстановим и повторим
                    if (notConnected) {
                        notConnected = false;
                        const restored = await restoreServerConnection(providerId);
                        if (restored) await ask();
                        if (!restored || notConnected) {
                            addMessage(`${provider ? provider.name : 'Провайдер'} не подключён. Откройте Settings и подключите заново.`, 'error');
                        }
                    }
                } catch (err) {
                    addMessage(`Не удалось получить ответ: ${err.message}`, 'error');
                } finally {
                    window.__holdReload?.(false);
                    setRunningSessionId(null);
                    status.remove();
                    if (run === chatRun) {
                        setComposerBusy(false);
                        chatInput.focus();
                    }
                }
            }



            // что берут вынесенные файлы: вкладки (tabs.js), Flow, Kanban, Karandash, Settings
            window.App = {
                BOARD_COLUMNS,
                VIEWS,
                PROVIDERS,
                api,
                connections,
                saveClaudeState,
                saveProviderState,
                setChatSessionId,
                renderSessionBarControls,
                renderObsConnection,
                renderUsageInline,
                chatMessages,
                openModal,
                confirmModal,
                closeModal,
                deselectSession,
                startCommentSession,
                openSession,
                getChatSessionId: () => chatSessionId,
            };
        })();
