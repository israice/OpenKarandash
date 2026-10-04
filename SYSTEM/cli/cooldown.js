// Память о недоступных исполнителях: поломка ложится в базу
// (SYSTEM/core/agent-cooldown.js, DOCS/decisions/071), и следующий выбор исполнителя
// знает «кто сегодня недоступен и до какого времени», не повторяя ошибку. Уже по
// одному этому списку пульт не дёргает исчерпанную модель и не включает платежи,
// когда известно, что им тоже плохо.
//
// Модуль — тонкая обвязка того слоя: слова для человека и «до такого-то времени»
// для строки о замене. Учёт живёт в agent-cooldown.js, выключатель — в
// index.js рядом с остальными настройками агентского слоя.
const agentCooldown = require('../core/agent-cooldown.js');

// create({ db, enabled, reasonText }): reasonText — словами о причине кулдауна
// (telegram-letters-server.js: телефон читает его, а не код)
function create({ db, enabled, reasonText }) {
    const cooldowns = agentCooldown.create({ db, enabled });

    // причина кулдауна словами, что видела строка о замене
    const words = (reason) => reasonText(reason);

    // «до такого-то времени» из строки ISO — для строки о замене и письма-отказа
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