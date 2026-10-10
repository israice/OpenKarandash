// Состояние подключения к провайдеру (pi): список провайдеров и моделей,
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
// Список провайдеров — не перечисление, а одна известная по умолчанию запись.
// Выбор CLI в строке сессии (SYSTEM/model-cascade.js) приходит списком с
// сайта, и имя в нём может быть любым, поэтому провайдер на каждое имя
// заводится по требованию (providerById ниже). Само подключение и модели
// хранятся под ключом этого имени, так что переключение CLI в шапке не трогает
// состояние остальных.
//
// Конкретной модели в коде нет нигде: модель выбирают в строке над сессией, и
// её выбирает человек (см. SYSTEM/session-model-bar.js). Поле defaultModel у
// провайдера тоже убрано — раньше оно было вторым местом, где живёт модель
// (дефолт проекта плюс подстановка по каталогу при Connect), и выбор человека
// из шапки перебивался им на каждом подключении
export const DEFAULT_AGENT = 'OpenClaw';

export const PROVIDERS = [
    {
        id: 'OpenClaw',
        name: 'OpenClaw',
        note: 'local and third-party models',
        paid: false,
        // список моделей заранее не хардкодим — CLI отдаёт его сам
        // (`openclaw models list --all --json`) при подключении, см.
        // connectAgent в PROJECTS/Settings/settings-providers.js, который
        // наполняет этот массив по факту ответа сервера
        models: [],
    },
];

// index для быстрых поисков: PROVIDERS наполняется ещё и подключениями
// (registerProvider), поэтому карта строится отдельно от самого массива
const byProviderId = new Map(PROVIDERS.map((provider) => [provider.id, provider]));

// Провайдер по имени CLI: у слов из списка сайта собственного провайдера в
// проекте нет, а каскад выбора и подключение обязаны иметь где взять их
// состояние. Поэтому запись заводится по требованию и НЕ попадает в PROVIDERS:
// список провайдеров перечисляет подключённые и добавленные, а не все слова,
// которые человек когда-либо видел в выпадающем списке. В PROVIDERS запись
// добавляет connectAgent (PROJECTS/Settings/settings-providers.js) — тогда
// карточка CLI появляется в настройках вместе с подключением.
export function providerById(id) {
    const key = String(id || '');
    if (!key) return null;
    let provider = byProviderId.get(key);
    if (!provider) {
        provider = { id: key, name: key, note: '', paid: false, models: [] };
        byProviderId.set(key, provider);
    }
    return provider;
}

// Запись, заведённая по требованию, становится видимой в списке провайдеров:
// вызывается при подключении CLI, и только тогда
export function registerProvider(id) {
    const provider = providerById(id);
    if (provider && !PROVIDERS.includes(provider)) PROVIDERS.push(provider);
    return provider;
}

// подключение переживает перезагрузку страницы: id окружения, модель и
// сессию CLI держим в localStorage, само окружение восстанавливаем на сервере.
// свой ключ на каждого провайдера — чтобы они подключались независимо, и
// переключение CLI в шапке не трогало состояние того, кого человек убрал
const STORE_KEYS = { pi: 'noname.pi' };

// Ключ по имени CLI. Имена приходят списком с сайта и заранее не известны,
// поэтому ключ выводится из имени, а не ищется в таблице: у kilo и omp своего
// ключа в таблице не было бы, и их подключение не переживало бы перезагрузку
// страницы. Слаг — тот же, что у цели на сервере (SYSTEM/cli/any.js), поэтому
// два «kilo» с разным написанием не разъедутся по разным ключам
const slugOf = (name) => String(name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');

const storeKey = (providerId) => STORE_KEYS[providerId] || `noname.cli.${slugOf(providerId)}`;

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
        // имя может быть любым (список CLI приходит с сайта), поэтому проверяем
        // не таблицу ключей, а то, что это непустое слово
        return typeof id === 'string' && id.trim() ? id : null;
    } catch {
        return null;
    }
}

// Активация исключающая: выбранный остаётся один, остальные забываются и
// на клиенте, и в localStorage. Вызывать после успешного connect
export function activateExclusive(providerId) {
    for (const id of [...connections.keys()]) {
        if (id === providerId) continue;
        connections.delete(id);
        try { localStorage.removeItem(storeKey(id)); } catch { /* приватный режим */ }
    }
    saveActiveProvider(providerId);
}

// общий помощник сохранения/восстановления состояния провайдера —
// все провайдеры работают через него одинаково, каждый под своим ключом
export function saveProviderState(providerId) {
    const key = storeKey(providerId);
    const state = connections.get(providerId);
    try {
        if (!state) localStorage.removeItem(key);
        else localStorage.setItem(key, JSON.stringify({ ...state, sessionId: sessionsState.sessionId }));
    } catch {
        // приватный режим или запрет на хранилище — работаем без сохранения
    }
}

export function loadProviderState(providerId) {
    try {
        return JSON.parse(localStorage.getItem(storeKey(providerId)) || 'null');
    } catch {
        return null;
    }
}

// ---------- выбор уровней каскада: шлюз / поставщик / модель / глубина ----------
//
// Хранится здесь, рядом с подключением, потому что это выбор человека,
// переживающий перезагрузку страницы, и читают его и каскад
// (SYSTEM/model-cascade.js), и восстановление сессии.
//
// Поставщик отдельным списком не выбирается: это средний уровень пути модели,
// и в строке его нет (DOCS/decisions/118). Хранится он потому, что из
// сохранённого пути его надо разобрать обратно — пока каталог CLI пуст, список
// моделей строится склейкой из уровней (см. modelPath).
//
// Ключ один на всех, а не на каждый CLI: уровни — это «последнее, что человек
// поставил», и он должен быть виден у любого CLI из списка. Смена CLI в шапке
// не должна приносить свой набор шлюзов и поставщиков — иначе переключил CLI и
// получил другие значения. Поэтому выбор один, а привычное «у каждого своё»
// здесь означало бы ровно то расхождение, ради которого всё затевалось.
//
// Уровни помнятся по отдельности, а не одной склеенной строкой модели: человек
// меняет их по одному («поставил Anthropic, Gateway оставь openrouter»), и
// при следующем выборе CLI остальные два уровня обязаны остаться прежними
const LEVELS_KEY = 'noname.levels';

export function saveLevelChoice(levels) {
    try {
        // Дописываем уровень к уже сохранённому, а не заменяем всё: уровни
        // приходят по одному (смена модели не должна стирать effort, смена
        // effort — уровни пути), иначе каждая из них затирала бы соседнюю
        localStorage.setItem(LEVELS_KEY, JSON.stringify({ ...loadLevelChoice(), ...levels }));
    } catch {
        // приватный режим или запрет на хранилище — работаем без сохранения
    }
}

// Глубина размышления (пятый уровень каскада, SYSTEM/model-effort.js) — часть
// того же выбора человека, поэтому лежит в том же ключе, а не в своём: строка
// стоит в трёх местах, и effort должен показываться у них одинаковым
export function saveEffortChoice(effort) {
    saveLevelChoice({ effort: effort || null });
}

export function loadEffortChoice() {
    return loadLevelChoice().effort || null;
}

export function loadLevelChoice() {
    try {
        const levels = JSON.parse(localStorage.getItem(LEVELS_KEY) || 'null');
        return levels && typeof levels === 'object' ? levels : {};
    } catch {
        return {};
    }
}

// Состояние pi для вкладки Sessions. Ключ агента сменился вместе с CLI
// (DOCS/decisions/094), а сохранённое подключение осталось под старым именем —
// иначе после перезагрузки страницы провайдер читался бы как неподключённый, а
// строка выбора в шапке Sessions (она рисуется только при подключённом
// провайдере, см. renderSessionBarControls в model-cascade.js) пропадала бы до
// нажатия Connect. Поэтому старый ключ читается один раз и сразу забывается.
// id окружения при этом чужой (opencode-windows), но connect-cli это допускает:
// единственную найденную цель он принимает вместо сохранённого имени и
// возвращает серверу её настоящий id.
const LEGACY_STATE_KEYS = { pi: 'noname.opencode' };

export function loadPiState() {
    const current = loadProviderState('pi');
    if (current) return current;
    try {
        const legacy = JSON.parse(localStorage.getItem(LEGACY_STATE_KEYS.pi) || 'null');
        if (!legacy) return null;
        localStorage.removeItem(LEGACY_STATE_KEYS.pi);
        return legacy;
    } catch {
        return null;
    }
}

// используется во всех местах, где сохранение зависит не от конкретного
// провайдера, а от смены текущей сессии (chatSessionId) — сохраняем состояние
// всех провайдеров, лишний вызов на неподключённого просто удалит его ключ
export function saveAllProviderStates() {
    for (const id of [...connections.keys()]) saveProviderState(id);
}

export const connections = new Map();

// Провайдера по умолчанию здесь больше нет. Он был вторым ответом на вопрос
// «кем пойдёт ход» — подставным словом из кода, если человек ничего не
// выбирал, — и строка выбора в шапке показывала одно, а ход уходил к другому
// CLI. Единственный ответ теперь у строки над сессией (getActiveProviderId в
// SYSTEM/session-model-bar.js), и хода без выбора не бывает вовсе

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
// (см. contextWindowFor в SYSTEM/core/sessions-db.js) — используем это, чтобы датчик показывал
// реальное значение сразу при создании сессии, а не «—» весь первый ход
export function contextWindowForModel(model) {
    return typeof model === 'string' && /haiku/i.test(model) ? 200000 : 1000000;
}