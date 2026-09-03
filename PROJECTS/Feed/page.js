// Страница кнопки 6 (см. SYSTEM/new-button.js): выпадающий список сессий —
// в топбаре, отдельной группой в той же строке, что и табы (#sessionFeedPanel
// в index.html, стиль — flow-canvas__zoom как у панели зума Flow), под ним —
// лента выбранной сессии (как в Chat, но встроена прямо в страницу, без
// перехода на вкладку Chat). По умолчанию лента открыта на самом низу.
// Вынесена в отдельный файл, чтобы содержимое конкретной сгенерированной
// страницы не путалось с логикой создания самих кнопок-страниц.
//
// В отличие от ленты в Chat, здесь каждый шаг — раскрывающаяся карточка-
// аккордеон (раскрыта не больше одной сразу, новая открытая закрывает
// предыдущую), и в теле карточки — вообще все поля, которые отдаёт
// /api/sessions/messages (см. server.js listMessages/finishExchange):
// текст, toolInput/toolResult целиком, модель/effort, токены/кэш/стоимость/
// длительность хода, stopReason, tool_use_id/parent_tool_use_id. Первая
// карточка — сводка по самой сессии (contextPercent/sessionInfo/rateLimit/
// usage), которая раньше на странице не появлялась вовсе.
(function () {
    const LAST_SESSION_KEY = 'sessionFeed.lastSessionId';

    function fmtTime(iso) { return iso ? new Date(iso).toLocaleString('ru-RU') : '—'; }
    function fmtNum(n) { return (n === null || n === undefined) ? '—' : Number(n).toLocaleString('ru-RU'); }
    function fmtCost(usd) { return (usd === null || usd === undefined) ? '—' : `$${Number(usd).toFixed(4)}`; }
    function fmtDuration(ms) { return (ms === null || ms === undefined) ? '—' : `${(ms / 1000).toFixed(1)} с`; }
    function fmtPercent(p) { return (p === null || p === undefined) ? '—' : `${p}%`; }
    function truncate(s, n) { return s && s.length > n ? `${s.slice(0, n)}…` : (s || '');}

    // toolInput приходит уже сериализованным в JSON (см. server.js recordStep) —
    // распечатываем читаемо, если получится, иначе показываем как есть
    function prettyJson(raw) {
        if (!raw) return '';
        try { return JSON.stringify(JSON.parse(raw), null, 2); } catch { return raw; }
    }

    // маленькие однотипные иконки (не эмодзи — свои SVG в стиле остального
    // тулбара, см. .icon-button в index.html: 24×24 viewBox, stroke=currentColor,
    // stroke-width 2, скруглённые концы) — по одной на тип карточки, чтобы роль
    // читалась по форме и цвету чипа, а не по случайному эмодзи-глифу
    const ICON_PATHS = {
        user: '<circle cx="12" cy="8" r="4"/><path d="M4 20c0-4.4 3.6-7 8-7s8 2.6 8 7"/>',
        assistant: '<path d="M21 15a2 2 0 0 1-2 2H8l-4 4V5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2z"/>',
        thinking: '<path d="M13 2 4 14h6l-1 8 9-12h-6z"/>',
        tool: '<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>',
        hook: '<path d="M10.5 13.5a4 4 0 0 0 6 .4l2-2a4 4 0 0 0-5.6-5.6l-1.1 1.1"/><path d="M13.5 10.5a4 4 0 0 0-6-.4l-2 2a4 4 0 0 0 5.6 5.6l1.1-1.1"/>',
        system: '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="2" y1="14" x2="6" y2="14"/><line x1="10" y1="8" x2="14" y2="8"/><line x1="18" y1="16" x2="22" y2="16"/>',
        unknown: '<circle cx="12" cy="12" r="9"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2-3 4"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
        meta: '<circle cx="12" cy="12" r="9"/><line x1="12" y1="16" x2="12" y2="11"/><line x1="12" y1="8" x2="12.01" y2="8"/>',
    };
    function iconSvg(name) {
        const inner = ICON_PATHS[name] || ICON_PATHS.unknown;
        return `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
    }

    function build(page) {
        page.classList.add('generated-page--sessions');
        page.textContent = '';

        const select = document.getElementById('sessionFeedSelect');
        const copyIdBtn = document.getElementById('sessionFeedCopyId');

        const messages = document.createElement('div');
        messages.className = 'chat__messages';
        messages.style.cssText = 'flex:1;min-height:0;';
        page.appendChild(messages);

        const empty = document.createElement('p');
        empty.className = 'chat__empty';
        messages.appendChild(empty);

        const list = document.createElement('div');
        list.className = 'chat__list session-feed__cards';
        messages.appendChild(list);

        let sessions = [];
        let currentId = null;
        try { currentId = localStorage.getItem(LAST_SESSION_KEY) || null; } catch { currentId = null; }

        // аккордеон на всю страницу: одновременно раскрыта максимум одна карточка,
        // сбрасывается при каждой перезагрузке ленты (список карточек пересоздаётся)
        let openCard = null;

        function closeCard(card) {
            card.wrap.classList.remove('session-feed__card-wrap--open');
            card.header.setAttribute('aria-expanded', 'false');
        }

        // icon — ключ из ICON_PATHS, определяет и глиф, и цвет чипа (через extraClass
        // на самой карточке, см. CSS .session-feed__card--* .session-feed__card-icon)
        function addCard(container, { icon, title, subtitle, extraClass }, fillBody) {
            const card = document.createElement('div');
            card.className = `session-feed__card${extraClass ? ` ${extraClass}` : ''}`;

            const header = document.createElement('button');
            header.type = 'button';
            header.className = 'session-feed__card-header';
            header.setAttribute('aria-expanded', 'false');

            if (icon) {
                const iconEl = document.createElement('span');
                iconEl.className = 'session-feed__card-icon';
                iconEl.innerHTML = iconSvg(icon);
                header.appendChild(iconEl);
            }

            const titleWrap = document.createElement('span');
            titleWrap.className = 'session-feed__card-titlewrap';

            const titleEl = document.createElement('span');
            titleEl.className = 'session-feed__card-title';
            titleEl.textContent = title;
            titleWrap.appendChild(titleEl);

            if (subtitle) {
                const subEl = document.createElement('span');
                subEl.className = 'session-feed__card-sub';
                subEl.textContent = subtitle;
                titleWrap.appendChild(subEl);
            }

            const chevron = document.createElement('span');
            chevron.className = 'session-feed__card-chevron';
            chevron.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>';

            header.append(titleWrap, chevron);

            const wrap = document.createElement('div');
            wrap.className = 'session-feed__card-wrap';
            const body = document.createElement('div');
            body.className = 'session-feed__card-body';
            wrap.appendChild(body);
            fillBody(body);

            const entry = { header, wrap };
            header.addEventListener('click', () => {
                const isOpen = wrap.classList.contains('session-feed__card-wrap--open');
                if (openCard && openCard !== entry) closeCard(openCard);
                if (isOpen) {
                    closeCard(entry);
                    openCard = null;
                } else {
                    wrap.classList.add('session-feed__card-wrap--open');
                    header.setAttribute('aria-expanded', 'true');
                    openCard = entry;
                }
            });

            card.append(header, wrap);
            container.appendChild(card);
            return card;
        }

        // общий вид «подпись сверху — текст снизу» для крупных текстовых кусков
        // (toolInput/toolResult/text/thinking) внутри тела карточки
        function addBlock(container, label, text, extraClass) {
            const block = document.createElement('div');
            block.className = `session-feed__block${extraClass ? ` ${extraClass}` : ''}`;
            const heading = document.createElement('div');
            heading.className = 'session-feed__block-label';
            heading.textContent = label;
            const body = document.createElement('pre');
            body.className = 'session-feed__block-body';
            body.textContent = text || '—';
            block.append(heading, body);
            container.appendChild(block);
        }

        // картинки из toolResultImages (скриншоты и т.п.) — до этой правки
        // toolResultText на сервере заменял их меткой «[image]», сами байты
        // нигде не сохранялись; теперь server.js кладёт их в tool_result_images
        // как JSON-массив data-URL (см. toolResultImages() в server.js)
        function addImages(container, raw) {
            if (!raw) return;
            let images;
            try { images = JSON.parse(raw); } catch { return; }
            if (!Array.isArray(images) || images.length === 0) return;
            const heading = document.createElement('div');
            heading.className = 'session-feed__block-label';
            heading.textContent = `Изображения (${images.length})`;
            container.appendChild(heading);
            for (const src of images) {
                const img = document.createElement('img');
                img.className = 'session-feed__thumb';
                img.src = src;
                img.alt = 'Изображение из результата инструмента';
                container.appendChild(img);
            }
        }

        // таблица «поле: значение» — сюда идут все скалярные метаданные хода,
        // ничего не пропускаем: даже пустые поля показываем как «—», чтобы было
        // видно, что сервер именно ничего не прислал, а не что мы это скрыли
        function addKv(container, pairs) {
            const dl = document.createElement('dl');
            dl.className = 'session-feed__kv';
            for (const [k, v] of pairs) {
                const dt = document.createElement('dt');
                dt.textContent = k;
                const dd = document.createElement('dd');
                dd.textContent = v;
                dl.append(dt, dd);
            }
            container.appendChild(dl);
        }

        // карточка-сводка по всей сессии: contextPercent/sessionInfo/rateLimit/usage —
        // раньше эти поля вообще не читались на этой странице
        function addSessionMetaCard(container, meta) {
            const info = meta.sessionInfo || {};
            const rate = meta.rateLimit || {};
            const windows = rate.unifiedWindows || {};
            const fiveHour = windows.five_hour || {};
            const sevenDay = windows.seven_day || {};
            const usage = meta.usage || {};
            const tools = Array.isArray(info.tools) ? info.tools : [];
            const mcpServers = Array.isArray(info.mcpServers) ? info.mcpServers : [];
            const slashCommands = Array.isArray(info.slashCommands) ? info.slashCommands : [];
            const terminalSlashCommands = Array.isArray(info.terminalSlashCommands) ? info.terminalSlashCommands : [];
            const agents = Array.isArray(info.agents) ? info.agents : [];
            const skills = Array.isArray(info.skills) ? info.skills : [];
            const capabilities = Array.isArray(info.capabilities) ? info.capabilities : [];
            const plugins = Array.isArray(info.plugins) ? info.plugins : [];

            addCard(container, {
                icon: 'meta',
                title: 'Сессия целиком',
                subtitle: `контекст ${fmtPercent(meta.contextPercent)} · ${fmtCost(usage.costUsd)}`,
                extraClass: 'session-feed__card--meta',
            }, (body) => {
                addKv(body, [
                    ['CLI (target)', meta.target || '—'],
                    ['Контекст занят', fmtPercent(meta.contextPercent)],
                    ['Рабочая папка (cwd)', info.cwd || '—'],
                    ['Режим разрешений', info.permissionMode || '—'],
                    ['Модель (из init)', info.model || '—'],
                    ['Источник API-ключа', info.apiKeySource || '—'],
                    ['Версия Claude Code', info.claudeCodeVersion || '—'],
                    ['Стиль вывода (output_style)', info.outputStyle || '—'],
                    ['Fast mode', info.fastModeState || '—'],
                    ['Fast mode: причина отключения', info.fastModeDisabledReason || '—'],
                    ['Аналитика отключена', info.analyticsDisabled == null ? '—' : (info.analyticsDisabled ? 'да' : 'нет')],
                    ['Отзывы о продукте отключены', info.productFeedbackDisabled == null ? '—' : (info.productFeedbackDisabled ? 'да' : 'нет')],
                    ['UUID события init', info.initUuid || '—'],
                    ['Сокет для сообщений', info.messagingSocketPath || '—'],
                    ['Инструментов разрешено', fmtNum(tools.length)],
                    ['MCP-серверов подключено', fmtNum(mcpServers.length)],
                    ['Слэш-команд доступно', fmtNum(slashCommands.length)],
                    ['Терминальных слэш-команд', fmtNum(terminalSlashCommands.length)],
                    ['Субагентов доступно', fmtNum(agents.length)],
                    ['Скиллов доступно', fmtNum(skills.length)],
                    ['Плагинов подключено', fmtNum(plugins.length)],
                    ['Возможностей рантайма (capabilities)', fmtNum(capabilities.length)],
                    ['Лимит: статус', rate.status || '—'],
                    ['Лимит: тип', rate.rateLimitType || '—'],
                    ['Лимит: overage статус', rate.overageStatus || '—'],
                    ['Лимит: overage причина отказа', rate.overageDisabledReason || '—'],
                    ['Лимит: overage используется', rate.isUsingOverage == null ? '—' : (rate.isUsingOverage ? 'да' : 'нет')],
                    ['Лимит: сброс (общий)', rate.resetsAt ? new Date(rate.resetsAt * 1000).toLocaleString('ru-RU') : '—'],
                    ['Лимит 5 часов: использовано', fiveHour.utilization != null ? `${Math.round(fiveHour.utilization * 100)}%` : '—'],
                    ['Лимит 5 часов: сброс', fiveHour.resetsAt ? new Date(fiveHour.resetsAt * 1000).toLocaleString('ru-RU') : '—'],
                    ['Лимит 7 дней: использовано', sevenDay.utilization != null ? `${Math.round(sevenDay.utilization * 100)}%` : '—'],
                    ['Лимит 7 дней: сброс', sevenDay.resetsAt ? new Date(sevenDay.resetsAt * 1000).toLocaleString('ru-RU') : '—'],
                    ['Токены (вход)', fmtNum(usage.inputTokens)],
                    ['Токены (выход)', fmtNum(usage.outputTokens)],
                    ['Токены (кэш чтение)', fmtNum(usage.cacheReadTokens)],
                    ['Токены (кэш запись)', fmtNum(usage.cacheCreationTokens)],
                    ['Стоимость всей сессии', fmtCost(usage.costUsd)],
                    ['Длительность всей сессии', fmtDuration(usage.durationMs)],
                ]);
                addBlock(body, `Разрешённые инструменты (${tools.length})`, tools.join(', '));
                addBlock(body, `MCP-серверы (${mcpServers.length})`, mcpServers.join(', '));
                addBlock(body, `Слэш-команды (${slashCommands.length})`, slashCommands.join(', '));
                addBlock(body, `Терминальные слэш-команды (${terminalSlashCommands.length})`, terminalSlashCommands.join(', '));
                addBlock(body, `Субагенты (${agents.length})`, agents.join(', '));
                addBlock(body, `Скиллы (${skills.length})`, skills.join(', '));
                addBlock(body, `Возможности рантайма (${capabilities.length})`, capabilities.join(', '));
                addBlock(body, `Плагины (${plugins.length})`, plugins.length ? prettyJson(JSON.stringify(plugins)) : '');
                if (info.memoryPaths) addBlock(body, 'Пути памяти (memory_paths)', prettyJson(JSON.stringify(info.memoryPaths)));
                if (meta.thumb) {
                    const thumbLabel = document.createElement('div');
                    thumbLabel.className = 'session-feed__block-label';
                    thumbLabel.textContent = 'Превью (thumb)';
                    const img = document.createElement('img');
                    img.className = 'session-feed__thumb';
                    img.src = meta.thumb;
                    img.alt = 'Превью сессии';
                    body.append(thumbLabel, img);
                }
            });
        }

        // одна карточка на сообщение — заголовок для быстрой ориентации без
        // раскрытия, тело — все поля целиком (текст/аргументы/результат/
        // модель/токены/стоимость/stopReason/id вызовов), ничего не обрезаем
        // и не прячем: до этой правки страница показывала только message.text
        // (для tool — короткую метку вида "Bash ..."), остальное приходило
        // с сервера, но на экране не появлялось
        function addMessageCard(container, message) {
            const common = [
                ['Время', fmtTime(message.createdAt)],
                ['Модель', message.model || '—'],
                ['Effort', message.effort || '—'],
                ['Токены (вход)', fmtNum(message.inputTokens)],
                ['Токены (выход)', fmtNum(message.outputTokens)],
                ['Токены (кэш чтение)', fmtNum(message.cacheReadTokens)],
                ['Токены (кэш запись)', fmtNum(message.cacheCreationTokens)],
                ['Стоимость хода', fmtCost(message.costUsd)],
                ['Длительность хода', fmtDuration(message.durationMs)],
                ['Stop reason', message.stopReason || '—'],
                ['tool_use_id', message.toolUseId || '—'],
                ['parent_tool_use_id', message.parentToolUseId || '—'],
                ['Режим (mode)', message.mode || '—'],
            ];

            if (message.role === 'tool') {
                addCard(container, {
                    icon: 'tool',
                    title: message.toolName || 'Инструмент',
                    subtitle: message.toolError ? 'ошибка' : fmtTime(message.createdAt),
                    extraClass: `session-feed__card--tool session-feed__card--dense${message.toolError ? ' session-feed__card--error' : ''}`,
                }, (body) => {
                    addKv(body, [['Метка (text)', message.text || '—'], ...common, ['tool_error', message.toolError ? 'да' : 'нет']]);
                    addBlock(body, 'Аргументы (toolInput)', prettyJson(message.toolInput));
                    addBlock(body, 'Результат (toolResult)', message.toolResult, message.toolError ? 'session-feed__block--error' : '');
                    addImages(body, message.toolResultImages);
                    if (message.extraMeta) addBlock(body, 'Доп. метаданные (caller и т.п.)', prettyJson(message.extraMeta));
                });
                return;
            }

            if (message.role === 'hook') {
                addCard(container, {
                    icon: 'hook',
                    title: message.toolName || message.text || 'Хук',
                    subtitle: message.toolError ? 'ошибка' : fmtTime(message.createdAt),
                    extraClass: `session-feed__card--hook session-feed__card--dense${message.toolError ? ' session-feed__card--error' : ''}`,
                }, (body) => {
                    addKv(body, [['Метка (text)', message.text || '—'], ...common, ['tool_error', message.toolError ? 'да' : 'нет']]);
                    addBlock(body, 'hook_id / hook_event (toolInput)', prettyJson(message.toolInput));
                    addBlock(body, 'Вывод хука (stdout/stderr/output)', message.toolResult, message.toolError ? 'session-feed__block--error' : '');
                });
                return;
            }

            if (message.role === 'thinking') {
                addCard(container, {
                    icon: 'thinking',
                    title: 'Рассуждение',
                    subtitle: `${truncate(message.text, 60)} · ${fmtTime(message.createdAt)}`,
                    extraClass: 'session-feed__card--thinking session-feed__card--dense',
                }, (body) => {
                    addKv(body, common);
                    addBlock(body, 'Текст рассуждения', message.text);
                    if (message.extraMeta) addBlock(body, 'Доп. метаданные (подпись и т.п.)', prettyJson(message.extraMeta));
                });
                return;
            }

            // system/unknown/top_level — три уровня перехвата на сервере
            // (server.js: recordSystemEvent/recordUnknownPart/recordTopLevelEvent):
            // неразобранный подтип system-события, неразобранный тип части ответа,
            // и, наконец, вообще неразобранный верхнеуровневый event.type (например,
            // control_response/interrupt-хендшейк, который CLI заявляет в
            // capabilities, но живым тестом не проверялся) — раньше любой из этих
            // трёх случаев пропадал молча, теперь виден целиком сырым JSON
            if (message.role === 'system' || message.role === 'unknown' || message.role === 'top_level') {
                const titleByRole = {
                    system: 'Системное событие',
                    unknown: 'Неопознанное событие',
                    top_level: 'Событие неизвестного типа',
                };
                addCard(container, {
                    icon: message.role === 'top_level' ? 'unknown' : message.role,
                    title: message.toolName || message.text || titleByRole[message.role],
                    subtitle: fmtTime(message.createdAt),
                    extraClass: `session-feed__card--${message.role === 'top_level' ? 'unknown' : message.role} session-feed__card--dense`,
                }, (body) => {
                    addKv(body, [['Метка (text)', message.text || '—'], ...common]);
                    addBlock(body, 'Сырое событие (toolInput)', prettyJson(message.toolInput));
                });
                return;
            }

            const kind = message.role === 'user' ? 'user' : 'assistant';
            const isError = message.stopReason === 'error';
            addCard(container, {
                icon: kind,
                title: `${kind === 'user' ? 'Вы' : 'Ассистент'}${isError ? ' · ошибка хода' : ''}`,
                subtitle: `${truncate(message.text, 60)} · ${fmtTime(message.createdAt)}`,
                extraClass: `session-feed__card--${kind}${isError ? ' session-feed__card--error' : ''}`,
            }, (body) => {
                addKv(body, common);
                addBlock(body, 'Текст', message.text);
                // в Chat-режиме модели уходит не этот текст, а он же с приклеенной
                // спереди CHAT_PREAMBLE (server.js) — показываем реально отправленное,
                // если оно записано и отличается от того, что видно в чате
                if (message.inputSent && message.inputSent !== message.text) {
                    addBlock(body, 'Реально отправлено модели (input_sent)', message.inputSent);
                }
                // всё, что событие result присылает сверх уже разложенных по колонкам
                // usage/cost/duration — тайминги, отказы в разрешении, статистика
                // субагентов и т.д. (см. server.js, resultMeta) — целиком, одним JSON
                if (message.resultMeta) {
                    addBlock(body, 'Диагностика хода (result_meta)', prettyJson(message.resultMeta));
                }
            });
        }

        function renderOptions() {
            const placeholder = '<option value="">— выберите сессию —</option>';
            select.innerHTML = placeholder + sessions.map((session) => {
                const label = `${session.title} · ${new Date(session.updatedAt).toLocaleString('ru-RU')}`;
                return `<option value="${session.id}">${label.replace(/</g, '&lt;')}</option>`;
            }).join('');
            select.value = currentId || '';
        }

        async function loadSessions() {
            try {
                const { sessions: list = [] } = await App.api('/api/sessions', {});
                sessions = list;
            } catch {
                sessions = [];
            }
            if (currentId && !sessions.some((session) => session.id === currentId)) currentId = null;
            renderOptions();
        }

        async function loadFeed(id) {
            list.innerHTML = '';
            openCard = null;
            empty.hidden = true;
            if (!id) {
                empty.textContent = 'Выберите сессию из списка выше';
                empty.hidden = false;
                return;
            }
            try {
                const response = await App.api('/api/sessions/messages', { id });
                const items = response.messages || [];
                addSessionMetaCard(list, response);
                if (items.length === 0) {
                    empty.textContent = 'В этой сессии пока нет сообщений';
                    empty.hidden = false;
                } else {
                    for (const message of items) addMessageCard(list, message);
                }
            } catch {
                empty.textContent = 'Не удалось загрузить сессию';
                empty.hidden = false;
            }
            // после отрисовки — сразу вниз, к последним сообщениям
            messages.scrollTop = messages.scrollHeight;
            requestAnimationFrame(() => { messages.scrollTop = messages.scrollHeight; });
        }

        select.addEventListener('change', () => {
            currentId = select.value || null;
            try {
                if (currentId) localStorage.setItem(LAST_SESSION_KEY, currentId);
                else localStorage.removeItem(LAST_SESSION_KEY);
            } catch {}
            loadFeed(currentId);
        });

        if (copyIdBtn) {
            copyIdBtn.addEventListener('click', () => {
                if (!select.value) return;
                navigator.clipboard.writeText(select.value);
                const original = copyIdBtn.textContent;
                copyIdBtn.textContent = '✅';
                setTimeout(() => { copyIdBtn.textContent = original; }, 1000);
            });
        }

        loadSessions().then(() => loadFeed(currentId));
    }

    window.SessionFeedPage = { build };
})();
