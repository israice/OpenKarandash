// Память о поломках исполнителей: поломка ложится в базу
// (SYSTEM/core/agent-cooldown.js, DOCS/decisions/071), и по этому списку видно,
// кто и когда ломался. Уже по одному этому списку пульт не дёргает исчерпанную
// модель и не включает платежи, когда известно, что им тоже плохо.
//
// Память — только запись: кого звать, решает человек в строке выбора над
// сессией, и подхвата, ради которого память заводилась, больше нет
// (DOCS/decisions/097). Модуль — тонкая обвязка того слоя: слова для человека
// и «до такого-то времени» для строки о поломке. Учёт живёт в agent-cooldown.js
const agentCooldown = require('../core/agent-cooldown.js');

// create({ db, reasonText }): reasonText — словами о причине кулдауна
// (telegram-letters-server.js: телефон читает его, а не код)
function create({ db, reasonText }) {
    const cooldowns = agentCooldown.create({ db });

    // причина кулдауна словами, что видит человек
    const words = (reason) => reasonText(reason);

    // «до такого-то времени» из строки ISO — для строки о поломке и письма-отказа
    function untilText(until) {
        try {
            return new Date(until).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
        } catch {
            return String(until || '');
        }
    }

    return { ...cooldowns, words, untilText };
}

module.exports = { create };