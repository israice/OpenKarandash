// Состояние подключения к провайдерам (Claude/Codex/OpenCode): списки моделей,
// сохранение и восстановление в localStorage, лимиты подписки, селекты
// провайдера/модели/effort в шапке сессии, датчик контекста. Вынесено из
// SYSTEM/app.js (DOCS/decisions/022); наружу это по-прежнему уходит через
// window.App (его собирает app.js), внутри вкладки Chat — импортом отсюда.
//
// Из состояния вкладки Chat нужны id текущей сессии (он сохраняется вместе с
// провайдером) и узлы шапки сессии. Импорт под именем chatState, потому что
// локальные `state` здесь — записи connections, как и было в app.js
import { state as chatState } from '../PROJECTS/Chat/chat-state.js';

// списки моделей — заготовка под реальные данные провайдеров
export const PROVIDERS = [
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
        id: 'opencode',
        name: 'OpenCode',
        note: 'local and third-party models',
        paid: false,
        // список моделей заранее не хардкодим — CLI отдаёт его сам
        // (`opencode models`) при подключении, см. connectOpenCode в settings.js,
        // который наполняет этот массив по факту ответа сервера
        models: [],
        defaultModel: undefined,
    },
    {
        id: 'pi',
        name: 'pi',
        note: 'many providers through one CLI',
        paid: false,
        // как у OpenCode, список моделей заранее не хардкодим: он зависит от
        // того, куда залогинен сам CLI, и приходит ответом на connect
        // (`pi --list-models`), см. connectPi в settings.js
        models: [],
        defaultModel: undefined,
        // pi умеет уровень размышления флагом --thinking — те же значения,
        // что и --effort у Claude
        efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        defaultEffort: 'medium',
    },
];
// Hermes в этом списке нет намеренно: он работает под капотом — сервер сам
// ведёт запросы к Claude через агента Hermes, когда тот поднят, а Hermes
// пользуется тем claude, что подключён здесь (DOCS/decisions/029)

// подключение переживает перезагрузку страницы: id окружения, модель и
// сессию CLI держим в localStorage, само окружение восстанавливаем на сервере.
// свой ключ и свой POST на восстановление — на провайдера, чтобы Claude и
// OpenCode подключались независимо друг от друга
const STORE_KEYS = { claude: 'noname.claude', codex: 'noname.codex', opencode: 'noname.opencode', pi: 'noname.pi' };
const STORE_KEY = STORE_KEYS.claude;

// общий помощник сохранения/восстановления состояния провайдера —
// Claude и OpenCode работают через него одинаково, каждый под своим ключом
export function saveProviderState(providerId) {
    const key = STORE_KEYS[providerId];
    if (!key) return;
    const state = connections.get(providerId);
    try {
        if (!state) localStorage.removeItem(key);
        else localStorage.setItem(key, JSON.stringify({ ...state, sessionId: chatState.chatSessionId }));
    } catch {
        // приватный режим или запрет на хранилище — работаем без сохранения
    }
}

export function loadProviderState(providerId) {
    const key = STORE_KEYS[providerId];
    if (!key) return null;
    try {
        return JSON.parse(localStorage.getItem(key) || 'null');
    } catch {
        return null;
    }
}

export function saveClaudeState() { saveProviderState('claude'); }
export function loadClaudeState() { return loadProviderState('claude'); }
export function saveOpenCodeState() { saveProviderState('opencode'); }
export function loadOpenCodeState() { return loadProviderState('opencode'); }

// используется во всех местах, где сохранение зависит не от конкретного
// провайдера, а от смены текущей сессии (chatSessionId) — сохраняем состояние
// обоих провайдеров, лишний вызов на неподключённого просто удалит его ключ
export function saveAllProviderStates() {
    saveClaudeState();
    saveProviderState('codex');
    saveOpenCodeState();
    saveProviderState('pi');
}

export const connections = new Map();

// лимиты подписки живут отдельно от model/effort: обновляются на каждый
// ответ CLI, а не только при подключении
export function updateClaudeUsage(info) {
    const claude = connections.get('claude');
    if (!claude) return;
    claude.usage = info;
    saveClaudeState(); // иначе лимиты теряются при live-reload страницы

    // модалка настроек (PROJECTS/Settings/settings.js) может быть закрыта —
    // тогда просто обновляем данные в connections, renderProviders перечитает их
    // при следующем открытии
    window.Settings?.refreshUsage?.(info);
}

// модель/effort из шапки сессии переопределяют connections.get(provider.id) —
// sendToClaude берёт их оттуда, так что следующее сообщение в этой же
// сессии (тот же sessionId) продолжится уже с новыми параметрами.
// выбор провайдера в шапке теперь настоящий: sendToClaude/stopClaude
// реально бьют в /api/<provider>/ask и /api/<provider>/stop по нему
export function renderSessionModelEffort(provider, state) {
    chatState.chatSessionModelSelect.innerHTML = '';
    for (const model of provider.models) {
        const option = document.createElement('option');
        option.value = model;
        option.textContent = model;
        option.selected = model === (state.model || provider.defaultModel);
        chatState.chatSessionModelSelect.append(option);
    }

    chatState.chatSessionEffortSelect.innerHTML = '';
    chatState.chatSessionEffortSelect.hidden = !provider.efforts;
    if (provider.efforts) {
        for (const effort of provider.efforts) {
            const option = document.createElement('option');
            option.value = effort;
            option.textContent = effort;
            option.selected = effort === (state.effort || provider.defaultEffort);
            chatState.chatSessionEffortSelect.append(option);
        }
    }
}

// провайдер по умолчанию — первый подключённый в этом порядке
const DEFAULT_ORDER = ['claude', 'codex', 'opencode', 'pi'];
export function defaultProviderId() {
    return DEFAULT_ORDER.find((id) => connections.has(id)) || 'claude';
}

// отдаёт провайдера, с которым сейчас реально ведётся диалог: то, что выбрано
// в строке шапки сессии, а до её появления — провайдер по умолчанию
export function getActiveProviderId() {
    if (!chatState.chatSessionBar.hidden && chatState.chatSessionProviderSelect.value) return chatState.chatSessionProviderSelect.value;
    return defaultProviderId();
}

// модель, которой пойдёт следующий ход, — то же, что в шапке сессии: выбор
// в ней настоящий (см. обработчик change в chat.js). Ею подписывается ответ в
// ленте, пока он стримится (SYSTEM/model-tag.js); у строк, уже лежащих в базе,
// подпись берётся из их собственного поля model
export function getActiveModel() {
    if (!chatState.chatSessionBar.hidden && chatState.chatSessionModelSelect.value) {
        return chatState.chatSessionModelSelect.value;
    }
    return connections.get(getActiveProviderId())?.model || null;
}

export function renderSessionBarControls() {
    // строка выбора провайдера/модели/effort видна, как только подключён
    // хотя бы один провайдер, и до создания самой сессии — так пользователь
    // настраивает параметры заранее; строка с id остаётся скрытой отдельно
    const connectedProviders = PROVIDERS.filter((p) => connections.has(p.id));
    chatState.chatSessionBar.hidden = connectedProviders.length === 0 || chatState.sessionList.hidden;
    chatState.chatSessionProviderSelect.innerHTML = '';
    chatState.chatSessionModelSelect.innerHTML = '';
    chatState.chatSessionEffortSelect.innerHTML = '';
    if (connectedProviders.length === 0) return;

    const chosenId = defaultProviderId();
    for (const provider of connectedProviders) {
        const option = document.createElement('option');
        option.value = provider.id;
        option.textContent = provider.name;
        option.selected = provider.id === chosenId;
        chatState.chatSessionProviderSelect.append(option);
    }

    const activeProvider = connectedProviders.find((p) => p.id === chosenId);
    renderSessionModelEffort(activeProvider, connections.get(chosenId));
}

export function formatResetTime(unixSeconds) {
    return new Date(unixSeconds * 1000).toLocaleString('ru-RU', {
        day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
    });
}

// показывается сразу над строкой выбора модели, без клика — как только Claude подключён
export function renderUsageInline(usage) {
    const windows = usage?.unifiedWindows;
    if (!windows) {
        return '<div class="provider__usage-empty">Data will appear after the first request</div>';
    }

    const row = (label, win) => !win ? '' : `
        <div class="provider__usage-row">
            <span class="provider__usage-label">${label}</span>
            <span class="provider__usage-value">${Math.round(win.utilization * 100)}%</span>
        </div>
        <div class="provider__usage-reset">resets: ${formatResetTime(win.resetsAt)}</div>
    `;
    return row('5 hours', windows.five_hour) + row('7 days', windows.seven_day);
}

// окно показываем в человекочитаемом виде (1M / 200K), а не сырым числом токенов
export function formatContextWindow(window) {
    if (!window) return null;
    if (window % 1000000 === 0) return `${window / 1000000}M`;
    if (window % 1000 === 0) return `${window / 1000}K`;
    return String(window);
}
export function updateContextGauge(percent, window) {
    if (percent == null) { chatState.chatGaugeContext.textContent = 'Context: —'; return; }
    const windowLabel = formatContextWindow(window);
    chatState.chatGaugeContext.textContent = windowLabel
        ? `Context: ${percent}% of ${windowLabel}`
        : `Context: ${percent}%`;
}
// окно контекста зависит только от модели и известно ещё до первого ответа
// (см. contextWindowFor в server.js) — используем это, чтобы датчик показывал
// реальное значение сразу при создании сессии, а не «—» весь первый ход
export function contextWindowForModel(model) {
    return typeof model === 'string' && /haiku/i.test(model) ? 200000 : 1000000;
}
