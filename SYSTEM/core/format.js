// «5 мин назад» для серверных фрагментов. Раньше это считал браузер в app.js;
// после переезда панелей на htmx время форматирует тот, кто рисует разметку, —
// а рисуют её две разные фичи (панель наблюдения Home, список сессий Chat),
// поэтому функция лежит в общем core, а не в одной из них.
function formatWhen(iso) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';

    const minutes = Math.round((Date.now() - date.getTime()) / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes} min ago`;
    if (minutes < 24 * 60) return `${Math.round(minutes / 60)} h ago`;
    return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

module.exports = { formatWhen };
