// Отбор по ленте Feed: поиск по строке события, списки источников/видов/
// инструментов и проверка «отбор сейчас включён». Отдельный файл потому, что
// это работа со значениями события, а не рисование: она нужна и при перерисовке
// ленты, и при наполнении списков, и при смене сессии, и правится отдельно от
// разметки карточек. Поля поиска и списки приходят аргументом — модуль их не
// создаёт, страница владеет ими сама.
import { escapeAttr } from './feed-format.js';

export function createFeedFilter({ searchInput, sourceSelect, eventSelect, toolSelect }) {
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

    return { matchesFilter, filterActive, refillFilterOptions };
}