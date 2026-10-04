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
// /api/sessions/messages (см. listMessages/finishExchange в SYSTEM/core/sessions-db.js):
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

// Страница разъехалась по темам (DOCS/decisions/022): сборка страницы и
// состояние ленты остались здесь, форматирование значений — feed-format.js,
// списки подписей полей — feed-fields.js, примитивы карточек — feed-cards.js,
// разбор событий по ролям — feed-message-cards.js, отбор — feed-filter.js,
// живая подписка на поток сессии — feed-live.js.
import { escapeAttr } from './feed-format.js';
import { createFeedCards } from './feed-cards.js';
import { createFeedMessageCards } from './feed-message-cards.js';
import { createFeedFilter } from './feed-filter.js';
import { createFeedLive } from './feed-live.js';

const LAST_SESSION_KEY = 'sessionFeed.lastSessionId';

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
    messages.className = 'chat-messages';
    messages.style.cssText = 'flex:1;min-height:0;';
    page.appendChild(messages);

    const empty = document.createElement('p');
    empty.className = 'chat-empty';
    messages.appendChild(empty);

    const list = document.createElement('div');
    list.className = 'chat-list session-feed__cards';
    messages.appendChild(list);

    let sessions = [];
    let currentId = null;
    try { currentId = localStorage.getItem(LAST_SESSION_KEY) || null; } catch { currentId = null; }

// примитивы карточек (аккордеон, крупные блоки, таблица «поле: значение») и
    // разбор событий по ролям живут в соседних модулях; здесь остаётся сборка
    // страницы и состояние ленты. Раскрытая карточка — тоже состояние модуля
    // карточек, страница только спрашивает и сбрасывает его (см. getOpenCard)
    const { addCard, addBlock, addImages, addKv, getOpenCard, setOpenCard } = createFeedCards();
    const { addSessionMetaCard, addMessageCard } = createFeedMessageCards({ addCard, addBlock, addImages, addKv });

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
        // отсортированы по updated_at DESC (см. listSessions в SYSTEM/core/sessions-db.js),
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
        const open = getOpenCard();
        const wasOpen = open && oldCard.contains(open.header);
        if (wasOpen) setOpenCard(null);
        oldCard.replaceWith(newCard);
        if (wasOpen) newCard.querySelector('.session-feed__card-header').click();
    }

    function resetFeed() {
        list.innerHTML = '';
        cards = [];
        cardKeys = [];
        metaCard = null;
        metaKey = null;
        setOpenCard(null);
    }

    // отбор по ленте (поиск, источник, вид события, инструмент) — в feed-filter.js
    const { matchesFilter, filterActive, refillFilterOptions } = createFeedFilter({
        searchInput, sourceSelect, eventSelect, toolSelect,
    });

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
            const open = getOpenCard();
            if (open && card.contains(open.header)) setOpenCard(null);
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

    // живая часть ленты: снимок, досматривание потока сессии и догрузка
    // изменившихся карточек — в feed-live.js (там же номер подписки и её
    // AbortController); здесь остаётся только подписаться на него
    const { loadFeed, subscribeRunning, abortLive } = createFeedLive({ messages, empty, resetFeed, applyFeed });

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
        subscribeRunning(currentId);
    }, { signal });

    // слушатель на body снимется сам по signal, а вот поток ленты живёт своей
    // жизнью в feed-live.js — обрываем его тем же сигналом
    signal.addEventListener('abort', () => abortLive(), { once: true });

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
