// Страница «Feed» кнопки «+» (см. SYSTEM/new-button.js): выпадающий список
// сессий — в топбаре, отдельной группой в той же строке, что и табы (стиль —
// flow-canvas__zoom как у панели зума Flow), под ним — лента выбранной сессии
// (как в Chat, но встроена прямо в страницу, без перехода на вкладку Chat).
// По умолчанию лента открыта на самом низу.
//
// Страница живёт в своей папке целиком (DOCS/decisions/014, DOCS/decisions/016):
// разметку панели строит этот файл, стили лежат рядом (page.css, его подключает
// загрузчик по имени), в SYSTEM/index.html про страницу нет ни строчки. Иначе
// index.html знал бы про папку, которую пользователь в любой момент удаляет
// кнопкой меню тулбара.
//
// Всё, что модуль делает, он делает внутри build: рисует в page и panel, а
// слушателей и потоки подписывает на signal. Тогда пересборка одной этой
// страницы (правка файла на живую) снимает её без следа — см. new-button.js.
//
// Лента живая: пока по выбранной сессии идёт ход, страница подписана на её поток
// (/api/sessions/attach) и дочитывает /api/sessions/messages, дорисовывая новые
// карточки по мере их появления, — раньше она рисовалась один раз снимком и до
// перезагрузки страницы (или переключения сессии) ничего нового не показывала.
//
// В отличие от ленты в Chat, здесь каждый шаг — раскрывающаяся карточка-
// аккордеон (раскрыта не больше одной сразу, новая открытая закрывает
// предыдущую), и в теле карточки — вообще все поля, которые отдаёт
// /api/sessions/messages (см. server.js listMessages/finishExchange):
// текст, toolInput/toolResult целиком, модель/effort, токены/кэш/стоимость/
// длительность хода, stopReason, tool_use_id/parent_tool_use_id. Первая
// карточка — сводка по самой сессии (contextPercent/sessionInfo/rateLimit/
// usage), которая раньше на странице не появлялась вовсе.
//
// Поля рисуются от данных, а не от зашитого в код списка: строка появляется
// только там, где сервер значение действительно прислал, а всё, что он прислал
// сверх известных полей, показывается сырым именем ключа (см. fillKv). Раньше
// было ровно наоборот — пустые поля занимали место прочерком «—», а новое поле
// протокола пропадало молча, потому что его не было в списке.

const LAST_SESSION_KEY = 'sessionFeed.lastSessionId';

function fmtTime(iso) { return iso ? new Date(iso).toLocaleString('ru-RU') : '—'; }
function fmtNum(n) { return (n === null || n === undefined) ? '—' : Number(n).toLocaleString('ru-RU'); }
function fmtCost(usd) { return (usd === null || usd === undefined) ? '—' : `$${Number(usd).toFixed(4)}`; }
function fmtDuration(ms) { return (ms === null || ms === undefined) ? '—' : `${(ms / 1000).toFixed(1)}s`; }
function fmtPercent(p) { return (p === null || p === undefined) ? '—' : `${p}%`; }
function fmtBool(v) { return v ? 'yes' : 'no'; }
// rate limit шлёт время сброса unix-секундами, а заполненность окна — долей 0…1
function fmtEpoch(sec) { return new Date(sec * 1000).toLocaleString('ru-RU'); }
function fmtShare(v) { return `${Math.round(v * 100)}%`; }
function truncate(s, n) { return s && s.length > n ? `${s.slice(0, n)}…` : (s || '');}

// toolInput приходит уже сериализованным в JSON (см. server.js recordStep) —
// распечатываем читаемо, если получится, иначе показываем как есть.
// Обычный JSON.stringify(…, null, 2) экранирует переносы строк внутри значений
// как «\n» — для многострочных полей вроде old_string/new_string (правки кода
// в toolInput) это превращает содержимое в одну нечитаемую строку. Поэтому
// многострочные строковые значения печатаем отдельным блоком с настоящими
// переносами строк, а не через JSON.stringify — сами данные при этом не меняются,
// меняется только то, как они выводятся на экран.
function formatJsonValue(value, indent) {
    const pad = '  '.repeat(indent);
    const childPad = '  '.repeat(indent + 1);
    if (value === null || value === undefined) return 'null';
    if (Array.isArray(value)) {
        if (value.length === 0) return '[]';
        const items = value.map((v) => `${childPad}${formatJsonValue(v, indent + 1)}`);
        return `[\n${items.join(',\n')}\n${pad}]`;
    }
    if (typeof value === 'object') {
        const keys = Object.keys(value);
        if (keys.length === 0) return '{}';
        const items = keys.map((k) => `${childPad}${JSON.stringify(k)}: ${formatJsonValue(value[k], indent + 1)}`);
        return `{\n${items.join(',\n')}\n${pad}}`;
    }
    if (typeof value === 'string' && value.includes('\n')) {
        const lines = value.split('\n').map((line) => childPad + line);
        return `"""\n${lines.join('\n')}\n${childPad}"""`;
    }
    return JSON.stringify(value);
}
function prettyJson(raw) {
    if (!raw) return '';
    try { return formatJsonValue(JSON.parse(raw), 0); } catch { return raw; }
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

// известные поля сообщения (см. listMessages в server.js) — подпись и то,
// как значение показать. Порядок здесь = порядок строк в карточке
const MESSAGE_SPECS = [
    ['createdAt', 'Time', fmtTime],
    // Event Schema (DOCS/decisions/040): кто прислал строку и что это было.
    // Стоят сразу за временем — это первое, что нужно знать о событии.
    // У строк, записанных до появления этих полей, они пустые и не рисуются
    ['source', 'Source'],
    ['actor', 'Actor'],
    ['eventType', 'Event type'],
    ['provider', 'Provider'],
    ['taskId', 'Task'],
    ['attemptId', 'Attempt'],
    ['model', 'Model'],
    ['effort', 'Effort'],
    ['inputTokens', 'Tokens (in)', fmtNum],
    ['outputTokens', 'Tokens (out)', fmtNum],
    ['cacheReadTokens', 'Tokens (cache read)', fmtNum],
    ['cacheCreationTokens', 'Tokens (cache write)', fmtNum],
    ['costUsd', 'Turn cost', fmtCost],
    ['durationMs', 'Turn duration', fmtDuration],
    ['stopReason', 'Stop reason'],
    ['toolUseId', 'tool_use_id'],
    ['parentToolUseId', 'parent_tool_use_id'],
    ['mode', 'Mode'],
    ['toolError', 'tool_error', fmtBool],
];
const TEXT_SPEC = ['text', 'Label (text)'];
// поля, которые карточка рисует не строкой таблицы, а иначе: блоком,
// картинкой или в заголовке — в таблице их дублировать не нужно
const MESSAGE_EXCLUDE = ['role', 'text', 'toolName', 'toolInput', 'toolResult', 'toolResultImages', 'inputSent', 'resultMeta', 'extraMeta', 'raw'];

const META_SPECS = [
    ['target', 'CLI (target)'],
    ['contextPercent', 'Context used', fmtPercent],
    ['contextWindow', 'Context window (tokens)', fmtNum],
    // строки, которые заместила пересборка хода по истории Hermes. Сами они
    // сохранены (DOCS/decisions/040) — здесь видно, что замена вообще была
    ['replacedCount', 'Replaced by rebuild', fmtNum],
];
const META_EXCLUDE = ['ok', 'messages', 'sessionInfo', 'rateLimit', 'usage', 'thumb'];
const INFO_SPECS = [
    ['cwd', 'Working directory (cwd)'],
    ['permissionMode', 'Permission mode'],
    ['model', 'Model (from init)'],
    ['apiKeySource', 'API key source'],
    ['claudeCodeVersion', 'Claude Code version'],
    ['outputStyle', 'Output style'],
    ['fastModeState', 'Fast mode'],
    ['fastModeDisabledReason', 'Fast mode: disabled reason'],
    ['analyticsDisabled', 'Analytics disabled', fmtBool],
    ['productFeedbackDisabled', 'Product feedback disabled', fmtBool],
    ['initUuid', 'Init event UUID'],
    ['messagingSocketPath', 'Messaging socket'],
];
// списки из init показываем и числом в таблице, и составом отдельным блоком
const LIST_SPECS = [
    ['tools', 'Tools allowed'],
    ['mcpServers', 'MCP servers connected'],
    ['slashCommands', 'Slash commands available'],
    ['terminalSlashCommands', 'Terminal slash commands'],
    ['agents', 'Subagents available'],
    ['skills', 'Skills available'],
    ['plugins', 'Plugins connected'],
    ['capabilities', 'Runtime capabilities'],
];
const COUNT_SPECS = LIST_SPECS.map(([key, label]) => [key, label, (v) => fmtNum(v.length)]);
const INFO_EXCLUDE = [...LIST_SPECS.map(([key]) => key), 'memoryPaths'];
const RATE_SPECS = [
    ['status', 'Limit: status'],
    ['rateLimitType', 'Limit: type'],
    ['overageStatus', 'Limit: overage status'],
    ['overageDisabledReason', 'Limit: overage disabled reason'],
    ['isUsingOverage', 'Limit: overage in use', fmtBool],
    ['resetsAt', 'Limit: reset (overall)', fmtEpoch],
];
// подписи окон лимита; окно, которого здесь нет, покажется своим ключом,
// а не пропадёт — набор окон задаёт сервер Anthropic, не мы
const WINDOW_LABELS = { five_hour: '5 hours', seven_day: '7 days' };
const USAGE_SPECS = [
    ['inputTokens', 'Tokens (in)', fmtNum],
    ['outputTokens', 'Tokens (out)', fmtNum],
    ['cacheReadTokens', 'Tokens (cache read)', fmtNum],
    ['cacheCreationTokens', 'Tokens (cache write)', fmtNum],
    ['costUsd', 'Total session cost', fmtCost],
    ['durationMs', 'Total session duration', fmtDuration],
];

export default function build(page, { panel, signal }) {
    page.classList.add('generated-page--sessions');

    // панель выбора сессии — в выданном слоте топбара: показывает и убирает его
    // загрузчик, наше дело только наполнить. Вид одолжен у панели зума Flow
    // (.flow-canvas__zoom), своих правил на него в page.css нет
    panel.classList.add('flow-canvas__zoom', 'btn-group');
    panel.setAttribute('role', 'toolbar');
    panel.setAttribute('aria-label', 'Page tools');
    panel.innerHTML = `
        <select class="flow-canvas__zoom-select" id="sessionFeedSelect" title="Session whose feed is shown below">
            <option value="">— select a session —</option>
        </select>
        <button type="button" class="flow-canvas__zoom-btn btn-group__btn" id="sessionFeedCopyId" title="Copy session id">⧉</button>
    `;
    const select = panel.querySelector('#sessionFeedSelect');
    const copyIdBtn = panel.querySelector('#sessionFeedCopyId');

    // Отбор по ленте. Живёт над списком, а не в топбаре: там панель узкая и
    // делится с табами. Поле поиска ищет по всему, что есть у события, включая
    // сырую запись, — иначе пришлось бы заводить по фильтру на каждое поле;
    // выпадающие списки строятся из того, что реально встретилось в сессии
    // (см. refillFilterOptions), поэтому новый источник появится в них сам
    const filters = document.createElement('div');
    filters.className = 'session-feed__filters';
    filters.innerHTML = `
        <input type="search" class="session-feed__search" id="sessionFeedSearch"
               placeholder="Поиск по ленте: текст, инструмент, поручение, сырое событие" aria-label="Поиск по ленте">
        <select class="session-feed__filter" id="sessionFeedSource" aria-label="Источник"><option value="">Источник: любой</option></select>
        <select class="session-feed__filter" id="sessionFeedEvent" aria-label="Вид события"><option value="">Событие: любое</option></select>
        <select class="session-feed__filter" id="sessionFeedTool" aria-label="Инструмент"><option value="">Инструмент: любой</option></select>
        <button type="button" class="session-feed__filter-reset" id="sessionFeedReset" title="Сбросить отбор">Сбросить</button>
        <span class="session-feed__count" id="sessionFeedCount"></span>
    `;
    page.appendChild(filters);

    const searchInput = filters.querySelector('#sessionFeedSearch');
    const sourceSelect = filters.querySelector('#sessionFeedSource');
    const eventSelect = filters.querySelector('#sessionFeedEvent');
    const toolSelect = filters.querySelector('#sessionFeedTool');
    const resetBtn = filters.querySelector('#sessionFeedReset');
    const countLabel = filters.querySelector('#sessionFeedCount');

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
    // на самой карточке, см. CSS .session-feed__card--* .session-feed__card-icon).
    // model — плашка модели рядом с названием роли: та же разметка, что над
    // ответом в Sessions и на ноде Flow (SYSTEM/model-tag.js, 039)
    function addCard(container, { icon, title, subtitle, model, extraClass }, fillBody) {
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

        const modelTag = window.ModelTag?.tag(model);
        if (modelTag) titleWrap.appendChild(modelTag);

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
    // (toolInput/toolResult/text/thinking) внутри тела карточки; пустого
    // блока с прочерком не бывает — нечего показать, значит блока нет
    function addBlock(container, label, text, extraClass) {
        if (!text) return;
        const block = document.createElement('div');
        block.className = `session-feed__block${extraClass ? ` ${extraClass}` : ''}`;
        const heading = document.createElement('div');
        heading.className = 'session-feed__block-label';
        heading.textContent = label;
        const body = document.createElement('pre');
        body.className = 'session-feed__block-body';
        body.textContent = text;
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
        heading.textContent = `Images (${images.length})`;
        container.appendChild(heading);
        for (const src of images) {
            const img = document.createElement('img');
            img.className = 'session-feed__thumb';
            img.src = src;
            img.alt = 'Image from the tool result';
            container.appendChild(img);
        }
    }

    // строку рисуем, только если значение есть. false и 0 — это данные,
    // а не пустота: «tool_error: нет» и «токенов: 0» видеть надо
    function hasValue(v) {
        if (v === null || v === undefined) return false;
        if (typeof v === 'string') return v.trim() !== '';
        if (Array.isArray(v)) return v.length > 0;
        return true;
    }

    // ключ в spec может быть путём («unifiedWindows.five_hour.resetsAt»),
    // чтобы вложенные объекты не требовали отдельной таблицы
    function getPath(source, path) {
        let value = source;
        for (const part of path.split('.')) {
            if (value === null || value === undefined) return undefined;
            value = value[part];
        }
        return value;
    }

    function kvRow(dl, label, text, extraClass) {
        const dt = document.createElement('dt');
        dt.textContent = label;
        const dd = document.createElement('dd');
        dd.textContent = text;
        if (extraClass) { dt.classList.add(extraClass); dd.classList.add(extraClass); }
        dl.append(dt, dd);
    }

    // одна группа таблицы «поле: значение»: сначала известные поля из specs
    // ([путь, подпись, форматтер?]) в заданном порядке, затем — все прочие
    // ключи объекта, о которых код ещё не знает, сырым именем ключа. Так
    // таблица показывает ровно то, что прислал сервер: пустого места нет,
    // но и новое поле протокола не теряется. exclude — ключи, которые
    // карточка рисует иначе (крупным блоком, картинкой, в заголовке).
    function fillKv(dl, source, specs, exclude) {
        const data = source || {};
        const skip = new Set(exclude || []);
        for (const [path] of specs) skip.add(path.split('.')[0]);
        for (const [path, label, format] of specs) {
            const raw = getPath(data, path);
            if (!hasValue(raw)) continue;
            const text = format ? format(raw) : String(raw);
            if (!hasValue(text)) continue;
            kvRow(dl, label, text);
        }
        for (const key of Object.keys(data)) {
            if (skip.has(key)) continue;
            const raw = data[key];
            if (!hasValue(raw)) continue;
            kvRow(dl, key, typeof raw === 'object' ? formatJsonValue(raw, 0) : String(raw), 'session-feed__kv--raw');
        }
    }

    // groups — [{ source, specs, exclude }]; несколько источников кладём в
    // одну <dl>, чтобы колонка подписей была общей и ничего не разъезжалось
    function addKv(container, groups) {
        const dl = document.createElement('dl');
        dl.className = 'session-feed__kv';
        for (const { source, specs, exclude } of groups) fillKv(dl, source, specs, exclude);
        if (dl.children.length === 0) return;
        container.appendChild(dl);
    }

    // карточка-сводка по всей сессии: contextPercent/sessionInfo/rateLimit/usage —
    // раньше эти поля вообще не читались на этой странице
    function addSessionMetaCard(container, meta) {
        const info = meta.sessionInfo || {};
        const rate = meta.rateLimit || {};
        const windows = rate.unifiedWindows || {};
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
            title: 'Whole session',
            subtitle: `context ${fmtPercent(meta.contextPercent)} · ${fmtCost(usage.costUsd)}`,
            extraClass: 'session-feed__card--meta',
        }, (body) => {
            // окна лимита строим по тем, что реально пришли: появится новое —
            // покажется само, своим ключом, а не потеряется
            const windowSpecs = Object.keys(windows).flatMap((key) => [
                [`unifiedWindows.${key}.utilization`, `Limit ${WINDOW_LABELS[key] || key}: used`, fmtShare],
                [`unifiedWindows.${key}.resetsAt`, `Limit ${WINDOW_LABELS[key] || key}: reset`, fmtEpoch],
            ]);
            addKv(body, [
                { source: meta, specs: META_SPECS, exclude: META_EXCLUDE },
                { source: info, specs: INFO_SPECS, exclude: INFO_EXCLUDE },
                { source: { tools, mcpServers, slashCommands, terminalSlashCommands, agents, skills, plugins, capabilities }, specs: COUNT_SPECS },
                { source: rate, specs: [...RATE_SPECS, ...windowSpecs], exclude: ['unifiedWindows'] },
                { source: usage, specs: USAGE_SPECS },
            ]);
            addBlock(body, `Allowed tools (${tools.length})`, tools.join(', '));
            addBlock(body, `MCP servers (${mcpServers.length})`, mcpServers.join(', '));
            addBlock(body, `Slash commands (${slashCommands.length})`, slashCommands.join(', '));
            addBlock(body, `Terminal slash commands (${terminalSlashCommands.length})`, terminalSlashCommands.join(', '));
            addBlock(body, `Subagents (${agents.length})`, agents.join(', '));
            addBlock(body, `Skills (${skills.length})`, skills.join(', '));
            addBlock(body, `Runtime capabilities (${capabilities.length})`, capabilities.join(', '));
            addBlock(body, `Plugins (${plugins.length})`, plugins.length ? prettyJson(JSON.stringify(plugins)) : '');
            if (info.memoryPaths) addBlock(body, 'Memory paths (memory_paths)', prettyJson(JSON.stringify(info.memoryPaths)));
            if (meta.thumb) {
                const thumbLabel = document.createElement('div');
                thumbLabel.className = 'session-feed__block-label';
                thumbLabel.textContent = 'Preview (thumb)';
                const img = document.createElement('img');
                img.className = 'session-feed__thumb';
                img.src = meta.thumb;
                img.alt = 'Session preview';
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
        // withText — роли, где message.text не уходит в отдельный блок,
        // а служит короткой меткой (инструмент, хук, системное событие)
        const kv = (body, withText) => addKv(body, [{
            source: message,
            specs: withText ? [TEXT_SPEC, ...MESSAGE_SPECS] : MESSAGE_SPECS,
            exclude: MESSAGE_EXCLUDE,
        }]);

        // сырое событие показываем у карточки любой роли, а не только у той,
        // которую сервер не разобрал: в нём и лежит страховка от неполного
        // разбора (DOCS/decisions/040, этап 2). Обёртка нужна, чтобы блок
        // добавлялся сам во всех ветках — иначе новую ветку забудут дописать
        const card = (opts, fillBody) => addCard(container, opts, (body) => {
            fillBody(body);
            if (message.raw) addBlock(body, 'Raw event (raw)', prettyJson(message.raw));
        });

        if (message.role === 'tool') {
            card({
                icon: 'tool',
                title: message.toolName || 'Tool',
                subtitle: message.toolError ? 'error' : fmtTime(message.createdAt),
                extraClass: `session-feed__card--tool session-feed__card--dense${message.toolError ? ' session-feed__card--error' : ''}`,
            }, (body) => {
                kv(body, true);
                addBlock(body, 'Arguments (toolInput)', prettyJson(message.toolInput));
                addBlock(body, 'Result (toolResult)', message.toolResult, message.toolError ? 'session-feed__block--error' : '');
                addImages(body, message.toolResultImages);
                if (message.extraMeta) addBlock(body, 'Extra metadata (caller etc.)', prettyJson(message.extraMeta));
            });
            return;
        }

        if (message.role === 'hook') {
            card({
                icon: 'hook',
                title: message.toolName || message.text || 'Hook',
                subtitle: message.toolError ? 'error' : fmtTime(message.createdAt),
                extraClass: `session-feed__card--hook session-feed__card--dense${message.toolError ? ' session-feed__card--error' : ''}`,
            }, (body) => {
                kv(body, true);
                addBlock(body, 'hook_id / hook_event (toolInput)', prettyJson(message.toolInput));
                addBlock(body, 'Hook output (stdout/stderr/output)', message.toolResult, message.toolError ? 'session-feed__block--error' : '');
                if (message.extraMeta) addBlock(body, 'Extra metadata (extra_meta)', prettyJson(message.extraMeta));
            });
            return;
        }

        if (message.role === 'thinking') {
            card({
                icon: 'thinking',
                title: 'Reasoning',
                subtitle: `${truncate(message.text, 60)} · ${fmtTime(message.createdAt)}`,
                extraClass: 'session-feed__card--thinking session-feed__card--dense',
            }, (body) => {
                kv(body, false);
                addBlock(body, 'Reasoning text', message.text);
                if (message.extraMeta) addBlock(body, 'Extra metadata (signature etc.)', prettyJson(message.extraMeta));
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
                system: 'System event',
                unknown: 'Unrecognized event',
                top_level: 'Event of unknown type',
            };
            card({
                icon: message.role === 'top_level' ? 'unknown' : message.role,
                // у пометки хода (server.js recordNotice) имя источника — в toolName,
                // а что произошло — в text: в заголовке нужны оба
                title: [message.toolName, message.text !== message.toolName ? truncate(message.text, 120) : '']
                    .filter(Boolean).join(' — ') || titleByRole[message.role],
                subtitle: fmtTime(message.createdAt),
                extraClass: `session-feed__card--${message.role === 'top_level' ? 'unknown' : message.role} session-feed__card--dense`,
            }, (body) => {
                kv(body, true);
                addBlock(body, 'Raw event (toolInput)', prettyJson(message.toolInput));
                // откуда строка: id сообщения Hermes, дочерняя сессия помощника и т.п.
                if (message.extraMeta) addBlock(body, 'Extra metadata (extra_meta)', prettyJson(message.extraMeta));
            });
            return;
        }

        const kind = message.role === 'user' ? 'user' : 'assistant';
        const isError = message.stopReason === 'error';
        // ответ, данный внутри вызова помощника (parent_tool_use_id), — не ответ основной модели
        const who = kind === 'user' ? 'You' : (message.parentToolUseId ? 'Subagent' : 'Assistant');
        card({
            icon: kind,
            title: `${who}${isError ? ' · turn error' : ''}`,
            subtitle: `${truncate(message.text, 60)} · ${fmtTime(message.createdAt)}`,
            // подпись моделью — по полю самой строки: ход мог вести другая
            // модель, а выбранная в шапке сессии относится к следующему ходу
            model: kind === 'assistant' ? message.model : null,
            extraClass: `session-feed__card--${kind}${isError ? ' session-feed__card--error' : ''}`,
        }, (body) => {
            // пометка суждения о ходе — первой строкой тела карточки: то же,
            // что в Sessions и на ноде Flow, одним общим SYSTEM/judgment-badge.js
            const mark = window.TurnJudgment?.badge(message.resultMeta);
            if (mark) body.append(mark);
            kv(body, false);
            addBlock(body, 'Text', message.text);
            // в Chat-режиме модели уходит не этот текст, а он же с приклеенной
            // спереди CHAT_PREAMBLE (server.js) — показываем реально отправленное,
            // если оно записано и отличается от того, что видно в чате
            if (message.inputSent && message.inputSent !== message.text) {
                addBlock(body, 'Actually sent to the model (input_sent)', message.inputSent);
            }
            // всё, что событие result присылает сверх уже разложенных по колонкам
            // usage/cost/duration — тайминги, отказы в разрешении, статистика
            // субагентов и т.д. (см. server.js, resultMeta) — целиком, одним JSON
            if (message.resultMeta) {
                addBlock(body, 'Turn diagnostics (result_meta)', prettyJson(message.resultMeta));
            }
            if (message.extraMeta) addBlock(body, 'Extra metadata (extra_meta)', prettyJson(message.extraMeta));
        });
    }

    function renderOptions() {
        const placeholder = '<option value="">— select a session —</option>';
        select.innerHTML = placeholder + sessions.map((session) => {
            const label = `${session.title} · ${new Date(session.updatedAt).toLocaleString('ru-RU')}`;
            // id и подпись идут в разметку через escapeAttr: кавычка в id рвала
            // атрибут, а одного замещения '<' подписи не хватало
            return `<option value="${escapeAttr(session.id)}">${escapeAttr(label)}</option>`;
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
        // по умолчанию (пока пользователь ничего не выбрал сам) — самая
        // последняя созданная сессия, а не пустой плейсхолдер; sessions уже
        // отсортированы по updated_at DESC (см. listSessions в server.js),
        // так что первая в списке и есть самая свежая
        if (!currentId && sessions.length > 0) currentId = sessions[0].id;
        renderOptions();
    }

    // ---------- лента: снимок и живое дополнение ----------
    // Обновление не перерисовывает ленту целиком: для каждой карточки хранится
    // JSON её сообщения, и трогаются только те, где данные действительно
    // изменились (последний ход сервер дописывает уже после появления карточки,
    // см. finishExchange). Иначе живое обновление схлопывало бы раскрытый
    // аккордеон и сбивало скролл каждую секунду.
    let cards = [];     // карточки сообщений, по порядку
    let cardKeys = [];  // JSON тех же сообщений на момент отрисовки
    let metaCard = null;
    let metaKey = null;
    // последний ответ сервера целиком: смена отбора перерисовывает ленту из
    // него, не дёргая сервер заново
    let lastResponse = null;

    // ключ сводной карточки — всё, что пришло с сервера, кроме самих сообщений
    function metaKeyOf(response) {
        const { messages: _ignored, ...rest } = response;
        return JSON.stringify(rest);
    }

    // addCard умеет только appendChild в переданный контейнер, поэтому для
    // вставки в нужное место собираем карточку во временный узел
    function buildCard(fill) {
        const holder = document.createElement('div');
        fill(holder);
        return holder.firstElementChild;
    }

    // подмена карточки на месте с сохранением раскрытия: если старая была
    // открыта, «нажимаем» заголовок новой — состояние аккордеона (openCard)
    // при этом выставляет сам обработчик, а не мы руками
    function replaceCard(oldCard, newCard) {
        const wasOpen = openCard && oldCard.contains(openCard.header);
        if (wasOpen) openCard = null;
        oldCard.replaceWith(newCard);
        if (wasOpen) newCard.querySelector('.session-feed__card-header').click();
    }

    function resetFeed() {
        list.innerHTML = '';
        cards = [];
        cardKeys = [];
        metaCard = null;
        metaKey = null;
        openCard = null;
    }

    // что искать в строке: всё, что человек может вспомнить о событии —
    // его текст, имя инструмента, аргументы и результат, источник, поручение
    // и сырая запись. Дешевле собрать одну строку, чем перебирать поля
    function haystack(m) {
        return [
            m.text, m.toolName, m.toolInput, m.toolResult, m.inputSent,
            m.source, m.actor, m.eventType, m.provider, m.taskId, m.attemptId,
            m.model, m.mode, m.role, m.raw, m.extraMeta,
        ].filter(Boolean).join(' ').toLowerCase();
    }

    function matchesFilter(m) {
        if (sourceSelect.value && (m.source || '') !== sourceSelect.value) return false;
        if (eventSelect.value && (m.eventType || '') !== eventSelect.value) return false;
        if (toolSelect.value && (m.toolName || '') !== toolSelect.value) return false;
        const q = searchInput.value.trim().toLowerCase();
        if (!q) return true;
        return haystack(m).includes(q);
    }

    function filterActive() {
        return Boolean(searchInput.value.trim() || sourceSelect.value || eventSelect.value || toolSelect.value);
    }

    // значения берём из самой сессии, а не из зашитого списка: неизвестный вид
    // события пишется как есть (DOCS/decisions/012), и в отборе он тоже должен
    // появиться сам. Выбранное значение не теряем, даже если оно отфильтровано
    function refillFilterOptions(items) {
        for (const [select, key, label] of [
            [sourceSelect, 'source', 'Источник: любой'],
            [eventSelect, 'eventType', 'Событие: любое'],
            [toolSelect, 'toolName', 'Инструмент: любой'],
        ]) {
            const values = [...new Set(items.map((m) => m[key]).filter(Boolean))].sort();
            if (select.value && !values.includes(select.value)) values.push(select.value);
            const signature = JSON.stringify(values);
            if (select.dataset.signature === signature) continue;
            select.dataset.signature = signature;
            const chosen = select.value;
            select.innerHTML = `<option value="">${label}</option>`
                + values.map((v) => `<option value="${escapeAttr(v)}">${escapeAttr(v)}</option>`).join('');
            select.value = chosen;
        }
    }

    function escapeAttr(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // смена отбора перерисовывает ленту целиком: набор карточек меняется не
    // с конца, и построчное сравнение здесь только запутало бы
    function reapplyFilter() {
        if (!lastResponse) return;
        resetFeed();
        applyFeed(lastResponse);
    }

    function applyFeed(response) {
        lastResponse = response;
        const all = response.messages || [];
        refillFilterOptions(all);
        const items = filterActive() ? all.filter(matchesFilter) : all;
        countLabel.textContent = filterActive() ? `показано ${items.length} из ${all.length}` : '';

        const nextMetaKey = metaKeyOf(response);
        if (nextMetaKey !== metaKey) {
            const card = buildCard((holder) => addSessionMetaCard(holder, response));
            if (metaCard) replaceCard(metaCard, card);
            else list.prepend(card);
            metaCard = card;
            metaKey = nextMetaKey;
        }

        for (let i = 0; i < items.length; i += 1) {
            const key = JSON.stringify(items[i]);
            if (i < cards.length && cardKeys[i] === key) continue;
            const card = buildCard((holder) => addMessageCard(holder, items[i]));
            if (i < cards.length) {
                replaceCard(cards[i], card);
            } else {
                list.appendChild(card);
            }
            cards[i] = card;
            cardKeys[i] = key;
        }
        // сообщений стало меньше, чем нарисовано, — лишние карточки убираем
        while (cards.length > items.length) {
            const card = cards.pop();
            cardKeys.pop();
            if (openCard && card.contains(openCard.header)) openCard = null;
            card.remove();
        }

        empty.hidden = items.length > 0;
        // пустая лента из-за отбора и пустая сессия — разные вещи, и человек
        // не должен гадать, почему ничего не видно
        if (items.length === 0) {
            empty.textContent = filterActive()
                ? `Под отбор ничего не подошло (событий в сессии: ${all.length})`
                : 'No messages in this session yet';
        }
    }

    // отбор применяем на ходу: поиск — по мере набора, списки — сразу по выбору
    for (const el of [searchInput, sourceSelect, eventSelect, toolSelect]) {
        el.addEventListener(el === searchInput ? 'input' : 'change', reapplyFilter, { signal });
    }
    resetBtn.addEventListener('click', () => {
        searchInput.value = '';
        sourceSelect.value = '';
        eventSelect.value = '';
        toolSelect.value = '';
        reapplyFilter();
    }, { signal });

    // номер текущей подписки: выбор другой сессии делает и прежний поток,
    // и отложенные обновления устаревшими — они молча прекращаются
    // (тот же приём, что в PROJECTS/Flow/flow-session-sync.js)
    let liveGeneration = 0;
    let liveAbort = null;

    function atBottom() {
        return messages.scrollHeight - messages.scrollTop - messages.clientHeight < 40;
    }

    async function fetchFeed(id, generation) {
        let response;
        try {
            response = await App.api('/api/sessions/messages', { id });
        } catch {
            return null;
        }
        return generation === liveGeneration ? response : null;
    }

    async function loadFeed(id) {
        liveGeneration += 1;
        liveAbort?.abort();
        liveAbort = null;
        const generation = liveGeneration;

        resetFeed();
        empty.hidden = true;
        if (!id) {
            empty.textContent = 'Select a session from the list above';
            empty.hidden = false;
            return;
        }
        const response = await fetchFeed(id, generation);
        if (generation !== liveGeneration) return;
        if (!response) {
            empty.textContent = 'Failed to load the session';
            empty.hidden = false;
            return;
        }
        applyFeed(response);
        // после отрисовки — сразу вниз, к последним сообщениям
        messages.scrollTop = messages.scrollHeight;
        requestAnimationFrame(() => { messages.scrollTop = messages.scrollHeight; });
        watchLive(id, generation);
    }

    async function refreshFeed(id, generation) {
        const stick = atBottom();
        const response = await fetchFeed(id, generation);
        if (!response || generation !== liveGeneration) return;
        applyFeed(response);
        // доскроллить вниз только если пользователь и так стоял внизу: иначе
        // живое обновление выдёргивало бы его из места, которое он читает
        if (stick) messages.scrollTop = messages.scrollHeight;
    }

    // если сессия сейчас выполняется, сервер отдаёт её поток NDJSON — тот же
    // /api/sessions/attach, которым лента Chat досматривает идущую работу
    // (см. attachSession в SYSTEM/app.js). Содержимое событий не разбираем:
    // карточки всё равно строятся из /api/sessions/messages, событие — лишь
    // сигнал, что там появилось новое, поэтому дозагружаем не чаще раза в секунду
    async function watchLive(id, generation) {
        liveAbort?.abort();
        const abort = new AbortController();
        liveAbort = abort;
        let scheduled = false;
        const scheduleRefresh = () => {
            if (scheduled) return;
            scheduled = true;
            setTimeout(() => {
                scheduled = false;
                if (generation !== liveGeneration) return;
                refreshFeed(id, generation);
            }, 1000);
        };

        // закрытие потока ещё не конец хода: связь могла оборваться, сервер —
        // перезапуститься. Конец — это обычный JSON вместо ndjson; до него
        // переподключаемся, иначе страница молча переставала обновляться посреди
        // идущей работы (DOCS/decisions/046)
        const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        let attached = false;
        for (let failures = 0; failures < 8;) {
            let res;
            try {
                res = await fetch('/api/sessions/attach', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ id }),
                    signal: abort.signal,
                });
            } catch {
                if (abort.signal.aborted) return;
                failures += 1;
                await pause(1500);
                continue;
            }
            if (generation !== liveGeneration) return;
            // обычный JSON вместо ndjson — сессия не выполняется, следить не за чем
            if (!res.headers.get('content-type')?.includes('ndjson')) break;
            attached = true;

            let progressed = false;
            const reader = res.body.getReader();
            for (;;) {
                let chunk;
                try { chunk = await reader.read(); } catch { break; }
                if (chunk.done) break;
                if (generation !== liveGeneration) { reader.cancel(); return; }
                progressed = true;
                scheduleRefresh();
            }
            if (abort.signal.aborted) return;
            failures = progressed ? 0 : failures + 1;
            await pause(300);
        }
        if (!attached) return;
        // поток закрылся — ход закончен, показываем итоговое состояние
        scheduleRefresh();
    }

    select.addEventListener('change', () => {
        currentId = select.value || null;
        try {
            if (currentId) localStorage.setItem(LAST_SESSION_KEY, currentId);
            else localStorage.removeItem(LAST_SESSION_KEY);
        } catch {}
        loadFeed(currentId);
    });

    // ход по выбранной сессии мог начаться позже загрузки ленты (например,
    // из вкладки Chat) — по сигналу app.js (setRunningSessionId) подключаемся
    // к свежему потоку и дочитываем то, что уже успело появиться
    document.body.addEventListener('session-running-changed', (e) => {
        if (!currentId || e.detail?.id !== currentId) return;
        liveGeneration += 1;
        const generation = liveGeneration;
        refreshFeed(currentId, generation);
        watchLive(currentId, generation);
    }, { signal });

    // слушатель на body снимется сам по signal, а вот поток ленты живёт своей
    // жизнью в watchLive — обрываем его тем же сигналом
    signal.addEventListener('abort', () => liveAbort?.abort(), { once: true });

    copyIdBtn.addEventListener('click', () => {
        if (!select.value) return;
        navigator.clipboard.writeText(select.value);
        const original = copyIdBtn.textContent;
        copyIdBtn.textContent = '✅';
        setTimeout(() => { copyIdBtn.textContent = original; }, 1000);
    });

    // список перечитывается при каждом открытии выпадающего списка — как у Flow
    // (flow-session-sync.js): раньше он читался один раз при сборке страницы, и
    // сессия, начатая позже, в Feed не появлялась до перезагрузки, хотя Sessions
    // и Flow её уже показывали
    select.addEventListener('mousedown', () => { loadSessions(); }, { signal });

    loadSessions().then(() => loadFeed(currentId));
}
