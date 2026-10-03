// Состояние подключения к провайдеру (OpenCode): список провайдеров и моделей,
// подключения, сохранение и восстановление в localStorage, датчик контекста.
// Вынесено из SYSTEM/app.js (DOCS/decisions/022); наружу это по-прежнему уходит
// через window.App (его собирает app.js), внутри вкладки Sessions — импортом
// отсюда.
//
// Сам выбор агента и модели (каскад из четырёх уровней и строка выбора в шапке
// сессии) живёт рядом, в SYSTEM/model-cascade.js: он нужен и настройкам, и
// сессиям, а здесь — только то, что под ним хранится.
//
// Из состояния вкладки Sessions нужен id текущей сессии — он сохраняется вместе
// с провайдером. Импорт под именем sessionsState, потому что локальные `state`
// здесь — записи connections, как и было в app.js
import { state as sessionsState } from '../PROJECTS/Sessions/sessions-state.js';

// список моделей — заготовка под реальные данные провайдеров
//
// Агент и модель по умолчанию (решение владельца): OpenCode с Space Bunny Alpha
// через OpenRouter. Список моделей у OpenCode приходит от CLI при подключении,
// поэтому имя дефолтной модели живёт здесь одной строкой — и connectOpenCode
// в settings.js выбирает её из ответа CLI, если CLI её знает.
export const DEFAULT_AGENT = 'opencode';
export const DEFAULT_AGENT_MODEL = 'openrouter/stealth/space-bunny-alpha';

export const PROVIDERS = [
    {
        id: 'opencode',
        name: 'OpenCode',
        note: 'local and third-party models',
        paid: false,
        // список моделей заранее не хардкодим — CLI отдаёт его сам
        // (`opencode models`) при подключении, см. connectOpenCode в settings.js,
        // который наполняет этот массив по факту ответа сервера
        models: [],
        // агент и модель по умолчанию проекта: OpenCode на Space Bunny Alpha
        // через OpenRouter (см. DEFAULT_AGENT_MODEL выше)
        defaultModel: DEFAULT_AGENT_MODEL,
    },
];
// В списке один провайдер — OpenCode: строки выбора агента в шапке сессии и
// списка провайдеров в Settings остаются (по одному варианту выбора не видно,
// а место на будущее нужно), но новых агентов владелец больше не заводит —
// решение 2026-10-01 (DOCS/decisions/075). Новых агентов владелец больше не
// заводит; Hermes с Docker убран из проекта целиком (DOCS/decisions/077)

// подключение переживает перезагрузку страницы: id окружения, модель и
// сессию CLI держим в localStorage, само окружение восстанавливаем на сервере.
// свой ключ на каждого провайдера — чтобы они подключались независимо
const STORE_KEYS = { opencode: 'noname.opencode' };

// Активный провайдер — один на всех: выбор в Settings перебивает остальных
// (DOCS/decisions/043: ход ведёт выбранный агент). Ключ переживает reload
// страницы и перезапуск сервера — localStorage сервер не чистит
const ACTIVE_KEY = 'noname.activeProvider';

export function saveActiveProvider(providerId) {
    try {
        if (!providerId) localStorage.removeItem(ACTIVE_KEY);
        else localStorage.setItem(ACTIVE_KEY, JSON.stringify(providerId));
    } catch {
        // приватный режим — работаем без сохранения
    }
}

export function loadActiveProvider() {
    try {
        const id = JSON.parse(localStorage.getItem(ACTIVE_KEY) || 'null');
        return typeof id === 'string' && STORE_KEYS[id] ? id : null;
    } catch {
        return null;
    }
}

// Активация исключающая: выбранный остаётся один, остальные забываются и
// на клиенте, и в localStorage. Вызывать после успешного connect
export function activateExclusive(providerId) {
    for (const id of Object.keys(STORE_KEYS)) {
        if (id === providerId) continue;
        connections.delete(id);
        try { localStorage.removeItem(STORE_KEYS[id]); } catch { /* приватный режим */ }
    }
    saveActiveProvider(providerId);
}

// общий помощник сохранения/восстановления состояния провайдера —
// все провайдеры работают через него одинаково, каждый под своим ключом
export function saveProviderState(providerId) {
    const key = STORE_KEYS[providerId];
    if (!key) return;
    const state = connections.get(providerId);
    try {
        if (!state) localStorage.removeItem(key);
        else localStorage.setItem(key, JSON.stringify({ ...state, sessionId: sessionsState.sessionId }));
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

export function loadOpenCodeState() { return loadProviderState('opencode'); }

// используется во всех местах, где сохранение зависит не от конкретного
// провайдера, а от смены текущей сессии (chatSessionId) — сохраняем состояние
// всех провайдеров, лишний вызов на неподключённого просто удалит его ключ
export function saveAllProviderStates() {
    for (const id of Object.keys(STORE_KEYS)) saveProviderState(id);
}

export const connections = new Map();

// провайдер по умолчанию — сохранённый активный, если он ещё подключён;
// иначе первый подключённый в этом порядке (OpenCode — решение владельца).
// Без учёта active reload всегда возвращал первый по списку — баг «над чатом
// не тот, кого выбрали»
const DEFAULT_ORDER = [DEFAULT_AGENT];
export function defaultProviderId() {
    const active = loadActiveProvider();
    if (active && connections.has(active)) return active;
    return DEFAULT_ORDER.find((id) => connections.has(id)) || active || DEFAULT_AGENT;
}

// окно показываем в человекочитаемом виде (1M / 200K), а не сырым числом токенов
export function formatContextWindow(window) {
    if (!window) return null;
    if (window % 1000000 === 0) return `${window / 1000000}M`;
    if (window % 1000 === 0) return `${window / 1000}K`;
    return String(window);
}
export function updateContextGauge(percent, window) {
    if (percent == null) { sessionsState.gaugeContext.textContent = 'Context: —'; return; }
    const windowLabel = formatContextWindow(window);
    sessionsState.gaugeContext.textContent = windowLabel
        ? `Context: ${percent}% of ${windowLabel}`
        : `Context: ${percent}%`;
}
// окно контекста зависит только от модели и известно ещё до первого ответа
// (см. contextWindowFor в server.js) — используем это, чтобы датчик показывал
// реальное значение сразу при создании сессии, а не «—» весь первый ход
export function contextWindowForModel(model) {
    return typeof model === 'string' && /haiku/i.test(model) ? 200000 : 1000000;
}