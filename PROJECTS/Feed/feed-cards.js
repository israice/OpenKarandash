// Каркас карточек ленты Feed: сам аккордеон (одна раскрытая карточка на всю
// страницу), крупные текстовые блоки, картинки из результата инструмента и
// таблица «поле: значение». Отдельный файл потому, что это примитивы рисования,
// одинаковые и для карточки сообщения, и для сводной карточки сессии
// (feed-message-cards.js), — держать их вместе с разбором самих сообщений
// незачем: правка разметки карточки и правка разбора события должны быть
// разными правками.
//
// Аккордеон держит своё состояние (какая карточка сейчас раскрыта) внутри
// модуля и отдаёт его наружу через getOpenCard/setOpenCard: пересборка ленты в
// page.js тоже обязана знать, какая карточка открыта, иначе не сохранить
// раскрытие при подмене карточки на месте.
import { formatJsonValue, iconSvg } from './feed-format.js';

export function createFeedCards() {
    let openCard = null;

    function getOpenCard() { return openCard; }
    function setOpenCard(value) { openCard = value; }

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
    // нигде не сохранялись; теперь сервер кладёт их в tool_result_images
    // как JSON-массив data-URL (см. toolResultImages() в SYSTEM/core/sessions-db.js)
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

    return { addCard, addBlock, addImages, addKv, getOpenCard, setOpenCard };
}