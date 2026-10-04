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

// суммарные токены сессии (панель Chat) — коротко, с k/M, а не полным числом:
// в узкой боковой панели нет места на «1 234 567 tok»
function formatTokens(n) {
    const total = Number(n) || 0;
    if (total >= 1_000_000) return `${(total / 1_000_000).toFixed(1)}M tok`;
    if (total >= 1000) return `${(total / 1000).toFixed(1)}k tok`;
    return `${total} tok`;
}

// суммарное время работы сессии (сумма duration_ms по всем её ходам — см.
// sumSessionUsage в SYSTEM/core/sessions-db.js): это не «сколько сессия существует», а именно
// сколько CLI реально считал по всем её интеракциям вместе
function formatDuration(ms) {
    const totalSeconds = Math.round((Number(ms) || 0) / 1000);
    if (totalSeconds < 60) return `${totalSeconds}s`;

    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes < 60) return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;

    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return mins ? `${hours}h ${mins}m` : `${hours}h`;
}

module.exports = { formatWhen, formatTokens, formatDuration };
