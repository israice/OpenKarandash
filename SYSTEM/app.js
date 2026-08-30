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
                    models: ['claude-opus-5', 'claude-sonnet-5', 'claude-fable-5', 'claude-haiku-4-5'],
                    defaultModel: 'claude-sonnet-5',
                    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
                    defaultEffort: 'medium',
                },
                {
                    id: 'codex',
                    name: 'Codex',
                    note: 'OpenAI',
                    models: ['gpt-5-codex', 'gpt-5', 'gpt-5-mini', 'o4-mini'],
                    defaultModel: 'gpt-5-codex',
                },
                {
                    id: 'opencode',
                    name: 'OpenCode',
                    note: 'локальные и сторонние модели',
                    models: ['qwen3-coder', 'kimi-k2', 'glm-4.6', 'deepseek-v3'],
                    defaultModel: 'qwen3-coder',
                },
            ];

            // подключение переживает перезагрузку страницы: id окружения, модель и
            // сессию CLI держим в localStorage, само окружение восстанавливаем на сервере
            const STORE_KEY = 'noname.claude';

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

            function saveClaudeState() {
                const state = connections.get('claude');
                try {
                    if (!state) localStorage.removeItem(STORE_KEY);
                    else localStorage.setItem(STORE_KEY, JSON.stringify({ ...state, sessionId: chatSessionId }));
                } catch {
                    // приватный режим или запрет на хранилище — работаем без сохранения
                }
            }

            function loadClaudeState() {
                try {
                    return JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
                } catch {
                    return null;
                }
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
            const chatSessionIdRow = document.getElementById('chatSessionIdRow');
            const chatSessionIdText = document.getElementById('chatSessionIdText');
            const chatSessionCopyBtn = document.getElementById('chatSessionCopy');
            const chatSessionProviderSelect = document.getElementById('chatSessionProviderSelect');
            const chatSessionModelSelect = document.getElementById('chatSessionModelSelect');
            const chatSessionEffortSelect = document.getElementById('chatSessionEffortSelect');
            const claudeProvider = PROVIDERS.find((p) => p.id === 'claude');

            // модель/effort из шапки сессии переопределяют connections.get('claude') —
            // sendToClaude берёт их оттуда, так что следующее сообщение в этой же
            // сессии (тот же sessionId) продолжится уже с новыми параметрами.
            // выбор провайдера пока информационный: реально сессия ведётся через
            // Claude CLI, остальные провайдеры лишь показывают свои модели/effort
            function renderSessionModelEffort(provider, state) {
                chatSessionModelSelect.innerHTML = '';
                for (const model of provider.models) {
                    const option = document.createElement('option');
                    option.value = model;
                    option.textContent = model;
                    option.selected = model === (provider.id === 'claude' ? state.model : provider.defaultModel);
                    chatSessionModelSelect.append(option);
                }

                chatSessionEffortSelect.innerHTML = '';
                chatSessionEffortSelect.hidden = !provider.efforts;
                if (provider.efforts) {
                    for (const effort of provider.efforts) {
                        const option = document.createElement('option');
                        option.value = effort;
                        option.textContent = effort;
                        option.selected = effort === (provider.id === 'claude' ? (state.effort || provider.defaultEffort) : provider.defaultEffort);
                        chatSessionEffortSelect.append(option);
                    }
                }
            }

            function renderSessionBarControls() {
                const state = connections.get('claude');
                // строка выбора провайдера/модели/effort видна, как только есть
                // подключение к claude, и до создания самой сессии — так пользователь
                // настраивает параметры заранее; строка с id остаётся скрытой отдельно
                chatSessionBar.hidden = !state || sessionList.hidden;
                chatSessionProviderSelect.innerHTML = '';
                chatSessionModelSelect.innerHTML = '';
                chatSessionEffortSelect.innerHTML = '';
                if (!state) return;

                for (const provider of PROVIDERS) {
                    const option = document.createElement('option');
                    option.value = provider.id;
                    option.textContent = provider.name;
                    option.selected = provider.id === 'claude';
                    chatSessionProviderSelect.append(option);
                }

                renderSessionModelEffort(claudeProvider, state);
            }

            chatSessionProviderSelect.addEventListener('change', () => {
                const provider = PROVIDERS.find((p) => p.id === chatSessionProviderSelect.value) || claudeProvider;
                renderSessionModelEffort(provider, connections.get('claude') || {});
            });

            chatSessionModelSelect.addEventListener('change', () => {
                const state = connections.get('claude');
                if (!state) return;
                state.model = chatSessionModelSelect.value;
                saveClaudeState();
            });

            chatSessionEffortSelect.addEventListener('change', () => {
                const state = connections.get('claude');
                if (!state) return;
                state.effort = chatSessionEffortSelect.value;
                saveClaudeState();
            });

            // отображаем не сам id, а название сессии (то же, что в левой панели) —
            // копируется при этом настоящий id, chatSessionId, а не то, что показано в спане.
            // для совсем новой сессии название ещё не известно клиенту (sessionTitles
            // наполняется из /api/sessions) — до этого момента показываем детерминированную
            // от id маску вида "Session <слово>-<слово>", updateSessionBarTitle подменит её,
            // как только loadSessions() подтянет настоящее название
            const SESSION_NAME_WORDS = ['amber', 'birch', 'cedar', 'coral', 'delta', 'ember', 'flint', 'grove', 'haven', 'indigo', 'jasper', 'karst', 'lumen', 'maple', 'nectar', 'onyx', 'pearl', 'quartz', 'raven', 'sable', 'terra', 'umber', 'violet', 'willow'];

            function maskSessionId(id) {
                let hash = 0;
                for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
                const a = SESSION_NAME_WORDS[hash % SESSION_NAME_WORDS.length];
                const b = SESSION_NAME_WORDS[(hash >>> 8) % SESSION_NAME_WORDS.length];
                return `Session ${a}-${b}`;
            }

            function updateSessionBarTitle() {
                if (!chatSessionId) return;
                const title = sessionTitles.get(chatSessionId);
                if (title) chatSessionIdText.textContent = title;
            }

            function setChatSessionId(id) {
                chatSessionId = id;
                chatSessionIdText.textContent = id ? (sessionTitles.get(id) || maskSessionId(id)) : '—';
                chatSessionIdText.title = id || '';
                chatSessionIdRow.hidden = !id;
                renderSessionBarControls();
                syncComposerBusy();
            }

            chatSessionCopyBtn.addEventListener('click', () => {
                if (!chatSessionId) return;
                navigator.clipboard.writeText(chatSessionId);
                chatSessionCopyBtn.classList.remove('chat__session-copy--copied');
                void chatSessionCopyBtn.offsetWidth; // рестарт анимации при повторном клике подряд
                chatSessionCopyBtn.classList.add('chat__session-copy--copied');
                chatSessionCopyBtn.textContent = 'Copied!';
                setTimeout(() => {
                    chatSessionCopyBtn.classList.remove('chat__session-copy--copied');
                    chatSessionCopyBtn.textContent = 'Copy';
                }, 1000);
            });

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
            function updateContextGauge(percent) {
                chatGaugeContext.textContent = percent == null ? 'Контекст: —' : `Контекст: ${percent}%`;
            }

            // поле ввода растёт под текст, Enter отправляет, Shift+Enter переносит строку
            const chatInput = document.getElementById('chatInput');

            chatInput.addEventListener('input', () => {
                chatInput.style.height = 'auto';
                chatInput.style.height = chatInput.scrollHeight + 'px';
                chatInput.style.overflowY = chatInput.scrollHeight > 160 ? 'auto' : 'hidden';
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
            // сама кнопка-переключатель — в sessions-toggle.js

            // id -> title, наполняется в renderSessions(); по нему бейдж в шапке чата
            // показывает настоящее название сессии, а не сам id
            const sessionTitles = new Map();

            const sessionList = document.getElementById('sessionList');
            const runningCountEl = document.getElementById('runningCount');

            // ---------- панель наблюдения на вкладке Home ----------

            const totalCountEl = document.getElementById('totalCount');
            const queuedCountEl = document.getElementById('queuedCount');
            const obsMessagesEl = document.getElementById('obsMessages');
            const obsTodayEl = document.getElementById('obsToday');
            const obsLastActiveEl = document.getElementById('obsLastActive');
            const obsRunningList = document.getElementById('obsRunningList');
            const obsRecentList = document.getElementById('obsRecentList');
            const obsConnectionText = document.getElementById('obsConnectionText');

            function formatWhen(iso) {
                const date = new Date(iso);
                if (Number.isNaN(date.getTime())) return '';

                const minutes = Math.round((Date.now() - date) / 60000);
                if (minutes < 1) return 'только что';
                if (minutes < 60) return `${minutes} мин назад`;
                if (minutes < 24 * 60) return `${Math.round(minutes / 60)} ч назад`;
                return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
            }

            // кнопка удаления поверх строки: вложить её в .session-item нельзя,
            // кнопка внутри кнопки — невалидная разметка, поэтому она соседний элемент
            function deleteButton(session) {
                const del = document.createElement('button');
                del.type = 'button';
                del.className = 'session-delete';
                del.dataset.deleteId = session.id;
                del.title = 'Удалить сессию';
                del.setAttribute('aria-label', `Удалить сессию: ${session.title}`);
                del.innerHTML = `
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <polyline points="3 6 5 6 21 6"></polyline>
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                    </svg>
                `;
                return del;
            }

            function renderSessions(sessions) {
                sessionList.innerHTML = '';
                for (const session of sessions) sessionTitles.set(session.id, session.title);

                if (sessions.length === 0) {
                    const empty = document.createElement('li');
                    empty.className = 'session-empty';
                    empty.textContent = 'Сессий пока нет';
                    sessionList.append(empty);
                    return;
                }

                for (const session of sessions) {
                    const item = document.createElement('li');
                    item.className = 'session-row';
                    const btn = document.createElement('button');
                    btn.type = 'button';
                    btn.className = 'session-item';
                    btn.dataset.sessionId = session.id;
                    if (session.running) btn.dataset.running = '1'; // сервер ещё ведёт эту работу
                    btn.setAttribute('aria-current', String(session.id === chatSessionId));
                    btn.innerHTML = `
                        <span class="session-item__thumb" aria-hidden="true"></span>
                        <span class="session-item__body">
                            <span class="session-item__title"></span>
                            <span class="session-item__meta">${formatWhen(session.updatedAt)} · ${session.messageCount} сообщ.</span>
                        </span>
                    `;
                    btn.querySelector('.session-item__title').textContent = session.title;
                    // src, а не background-image: браузер разбирает его как URL, а не как CSS,
                    // так что содержимое data-URL не может вырваться из синтаксиса стиля
                    if (session.thumb) {
                        const img = document.createElement('img');
                        img.className = 'session-item__thumb-img';
                        img.alt = '';
                        img.src = session.thumb;
                        btn.querySelector('.session-item__thumb').append(img);
                    }
                    item.append(btn, deleteButton(session));
                    sessionList.append(item);
                }

                applyRunningIndicator();
                renderObservation(sessions);
                updateSessionBarTitle(); // название текущей сессии могло только что стать известным
            }

            // одна строка списка «Активные» / «Последние сессии» на Home
            function obsListItem(session) {
                const li = document.createElement('li');
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'obs-list__item';
                btn.dataset.sessionId = session.id;
                if (session.running) btn.dataset.running = '1';

                const dot = document.createElement('span');
                dot.className = 'obs-list__dot' + (session.running ? ' obs-list__dot--running' : '');

                const title = document.createElement('span');
                title.className = 'obs-list__title';
                title.textContent = session.title;

                const meta = document.createElement('span');
                meta.className = 'obs-list__meta';
                meta.textContent = session.running
                    ? 'выполняется…'
                    : `${formatWhen(session.updatedAt)} · ${session.messageCount} сообщ.`;

                btn.append(dot, title, meta);
                li.append(btn);
                return li;
            }

            function renderObsList(el, sessions, emptyText) {
                el.innerHTML = '';
                if (sessions.length === 0) {
                    const li = document.createElement('li');
                    li.className = 'obs-list__empty';
                    li.textContent = emptyText;
                    el.append(li);
                    return;
                }
                for (const session of sessions) el.append(obsListItem(session));
            }

            // сводка процессов проекта на Home: считается из того же списка сессий,
            // что уже приходит с /api/sessions — отдельный запрос не нужен
            function renderObservation(sessions) {
                totalCountEl.textContent = sessions.length;
                obsMessagesEl.textContent = sessions.reduce((sum, s) => sum + s.messageCount, 0);

                const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
                obsTodayEl.textContent = sessions.filter((s) => new Date(s.updatedAt).getTime() >= dayAgo).length;
                obsLastActiveEl.textContent = sessions[0] ? formatWhen(sessions[0].updatedAt) : '—';

                renderObsList(obsRunningList, sessions.filter((s) => s.running), 'Сейчас ничего не выполняется');
                renderObsList(obsRecentList, sessions.slice(0, 6), 'Сессий пока нет');
            }

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

            for (const list of [obsRunningList, obsRecentList]) {
                list.addEventListener('click', (e) => {
                    const btn = e.target.closest('.obs-list__item');
                    if (!btn) return;
                    MissionTabs.show('chat');
                    openSession(btn.dataset.sessionId, btn.dataset.running === '1');
                });
            }

            async function loadSessions() {
                try {
                    const { sessions = [], queued = 0 } = await api('/api/sessions');
                    renderSessions(sessions);
                    queuedCountEl.textContent = queued;
                    return sessions;
                } catch {
                    renderSessions([]);
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
                saveClaudeState();

                chatRun += 1;
                chatList.innerHTML = '';
                chatEmpty.hidden = true;

                const { messages = [], contextPercent = null } = await api('/api/sessions/messages', { id });
                for (const message of messages) {
                    if (message.role === 'tool') addStep(message.text);
                    else addMessage(message.text, message.role === 'user' ? 'user' : 'assistant');
                }

                if (messages.length === 0) chatEmpty.hidden = false;
                updateContextGauge(contextPercent);

                for (const btn of sessionList.querySelectorAll('.session-item')) {
                    btn.setAttribute('aria-current', String(btn.dataset.sessionId === id));
                }

                // работа ещё идёт (страницу перезагрузили посреди неё) — досматриваем вживую
                if (running) {
                    setRunningSessionId(id);
                    attachSession(id, chatRun);
                }
            }

            sessionList.addEventListener('click', (e) => {
                // клик по превью открывает его на весь экран, повторный клик закрывает — превью не должно выбирать сессию
                const thumb = e.target.closest('.session-item__thumb-img');
                if (thumb) {
                    openShotLightbox(thumb.src);
                    return;
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

            // повторный клик по выбранной (синей) сессии снимает выбор — назад к чату default
            function deselectSession() {
                MissionGraph?.closeFilePanel(); // могла быть открыта панель редактирования файла
                setChatSessionId(null);
                saveClaudeState();
                chatRun += 1;
                chatList.innerHTML = chatDefaultHtml;
                chatEmpty.hidden = false;
                updateContextGauge(null);
                for (const btn of sessionList.querySelectorAll('.session-item')) {
                    btn.setAttribute('aria-current', 'false');
                }
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

                if (id === chatSessionId) {
                    setChatSessionId(null);
                    saveClaudeState();
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
                saveClaudeState();
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
                setChatSessionId(null);
                saveClaudeState();
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
            // поэтому страница умеет восстановить подключение по сохранённому id
            let reconnecting = null;

            function restoreServerConnection() {
                const state = connections.get('claude');
                if (!state) return Promise.resolve(false);
                if (!reconnecting) {
                    reconnecting = api('/api/claude/connect', { id: state.installId })
                        .then((r) => r.ok)
                        .catch(() => false)
                        .finally(() => { reconnecting = null; });
                }
                return reconnecting;
            }

            (async function restoreOnLoad() {
                const saved = loadClaudeState();
                if (saved?.installId) {
                    connections.set('claude', saved);
                    restoreServerConnection(); // сервер мог быть перезапущен — вернём ему окружение
                }
                renderObsConnection();

                // список сессий готов сразу при загрузке страницы
                const sessions = await loadSessions();

                // страницу перезагрузили (например, dev-автообновление) посреди работы той же
                // сессии, что была открыта — досматриваем её поток вживую, а не теряем индикатор.
                // в остальных случаях переписку показываем только по явному выбору в левом меню
                const resumed = saved?.sessionId && sessions.find((s) => s.id === saved.sessionId && s.running);
                if (resumed) {
                    MissionTabs.show('chat');
                    await openSession(resumed.id, true);
                } else {
                    setChatSessionId(null);
                    saveClaudeState();
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
                const step = document.createElement('div');
                step.className = 'chat__message chat__message--tool';
                step.textContent = text;
                if (before && before.parentNode === chatList) chatList.insertBefore(step, before);
                else chatList.append(step);
                chatMessages.scrollTop = chatMessages.scrollHeight;
                return step;
            }

            function addMessage(text, kind) {
                chatEmpty.hidden = true;

                const message = document.createElement('div');
                message.className = `chat__message chat__message--${kind}`;
                if (kind === 'assistant' && text) message.innerHTML = renderMarkdown(text);
                else message.textContent = text;
                chatList.append(message);
                chatMessages.scrollTop = chatMessages.scrollHeight;
                return message;
            }

            function setComposerBusy(busy) {
                chatSend.classList.toggle('chat__send--stop', busy);
                chatSend.textContent = busy ? 'Stop' : 'Send';
            }

            // останавливает CLI-процесс на сервере; поток сам закроется событием error/done
            function stopClaude() {
                api('/api/claude/stop', { sessionId: chatSessionId });
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

                chatInput.value = '';
                chatInput.style.height = 'auto';
                chatInput.style.overflowY = 'hidden';
                sendToClaude(text, mode);
            });

            // миниатюра элемента из режима Edit: сессии ещё нет, id придёт только
            // с первым событием потока — до тех пор снимок ждёт здесь
            let pendingThumb = null;

            // комментарий из режима Edit начинает отдельную сессию с этим вопросом.
            // вкладку на Chat не переключаем — пользователь сам перейдёт туда, если захочет
            function startCommentSession(prompt, thumb) {
                pendingThumb = thumb || null;
                setChatSessionId(null);
                saveClaudeState();
                chatRun += 1;
                chatList.innerHTML = '';
                for (const btn of sessionList.querySelectorAll('.session-item')) {
                    btn.setAttribute('aria-current', 'false');
                }
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

            async function streamAsk(body, onEvent) {
                const res = await fetch('/api/claude/ask', {
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
                    } else if (event.type === 'text') {
                        answered = true;
                        addMessage(event.text, 'assistant');
                        chatList.append(status); // строка ожидания остаётся последней
                        chatMessages.scrollTop = chatMessages.scrollHeight;
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
                        if (event.type === 'context') { updateContextGauge(event.percent); return; }
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
                const claude = connections.get('claude');
                if (!claude) {
                    addMessage('Claude не подключён. Откройте Settings и нажмите «Подключить».', 'error');
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

                    if (event.type === 'queued') {
                        // впереди работает другая сессия — ждём своей очереди
                        status.textContent = `В очереди: впереди ${event.ahead}`;
                        return;
                    }

                    if (event.type === 'session') {
                        // очередь дошла до нас — возвращаем индикатор ожидания
                        status.innerHTML = '<span class="chat__typing"><span></span><span></span><span></span></span>';

                        // id известен сразу — сессия появляется в списке до ответа
                        if (event.id !== chatSessionId) {
                            setChatSessionId(event.id);
                            saveClaudeState();
                            setRunningSessionId(event.id);
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

                    if (event.type === 'error' && event.error === 'Claude не подключён') {
                        notConnected = true; // повторим после восстановления окружения
                        return;
                    }

                    if (event.type === 'rate_limit') {
                        updateClaudeUsage(event.info);
                        return;
                    }

                    if (event.type === 'context') {
                        updateContextGauge(event.percent);
                        return;
                    }

                    render(event);
                };

                const ask = () => streamAsk({
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
                        const restored = await restoreServerConnection();
                        if (restored) await ask();
                        if (!restored || notConnected) {
                            addMessage('Claude не подключён. Откройте Settings и подключите заново.', 'error');
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



            // что берут вынесенные файлы: вкладки (tabs.js), Flow, Kanban, Edit, Settings
            window.App = {
                BOARD_COLUMNS,
                VIEWS,
                PROVIDERS,
                api,
                connections,
                saveClaudeState,
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
                getChatSessionId: () => chatSessionId,
            };
        })();
