// Версия страницы: единственный источник истины — последняя строка DEV LOG в
// VERSION.md. Отдельный модуль, потому что её читают в двух разных местах:
// подстановка в разметку при отдаче файла (http-server.js) и предпросмотр
// ветки (core/branch-preview.js).
//
// Рядом с версией подставляется и коммит (data-head на <html>). Это не украшение:
// по нему страница решает, перезагружать ли её. Правило «перезагрузка раз в
// коммит» (DOCS/decisions/117) держит именно сравнение: сервер шлёт в канал
// свой коммит, а страница — тот, каким загрузилась сама. Пока коммиты совпадают,
// вкладка молчит: перезапуск сервера, открытая заново вкладка и событие,
// пришедшее в ту же секунду, не выглядят новым коммитом.
const fs = require('fs');
const path = require('path');
const { escapeHtml } = require('./http.js');
const gitHead = require('./git-head.js');
// верхнее меню страницы — тоже подстановка, и по той же причине здесь, а не в
// http-server.js: предпросмотр ветки должен показать то же меню, а он заходит
// в renderPage мимо первого. Сам шаблон и его маршрут — SYSTEM/topbar-server.js
const topbar = require('../topbar-server.js');
const sessionsServer = require('../../PROJECTS/Sessions/sessions-server.js');
const telegramServer = require('../../PROJECTS/Settings/telegram-server.js');
const bookServer = require('../../PROJECTS/Book/book-server.js');
const settingsServer = require('../../PROJECTS/Settings/settings-server.js');

// корень проекта на два уровня выше: модуль лежит в SYSTEM/core
const ROOT = path.join(__dirname, '..', '..');

function currentVersion() {
    try {
        const text = fs.readFileSync(path.join(ROOT, 'VERSION.md'), 'utf8');
        const matches = text.match(/^v\d+\.\d+\.\d+.*$/gm);
        return matches ? matches[matches.length - 1].split(' ')[0] : '';
    } catch {
        return '';
    }
}

// коммит, которым собрана страница. Хеш не длинный — короткого хватает: он
// попадает в атрибут data-head и в канал перезагрузки, а различать надо всего
// два состояния — «загружено этим» и «загружено предыдущим»
function currentHead() {
    return gitHead.head(ROOT);
}

// строки VERSION.md попадают прямо в HTML, а в сообщениях коммитов встречается
// разметка (например «inline <script>») — без экранирования она рвёт страницу
// список версий для модального окна: новые сверху
function versionHistory() {
    try {
        const text = fs.readFileSync(path.join(ROOT, 'VERSION.md'), 'utf8');
        const lines = text.match(/^v\d+\.\d+\.\d+.*$/gm) || [];
        return lines.reverse().map((line) => `<li class="version-list__item">${escapeHtml(line)}</li>`).join('');
    } catch {
        return '';
    }
}

// подстановки страницы и хвост перед </body>: одинаковы для главной копии и для
// предпросмотра ветки, поэтому живут одной функцией, а не двумя похожими
// ({{TOPBAR}} — разметка верхнего меню, SYSTEM/topbar.eta). Замена через функцию,
// а не строкой: в разметке меню есть «$», а строка замены в replace() считает
// «$&» и «$'» своей подстановкой
function renderPage(html, tail) {
    const page = html
        .replace('{{TOPBAR}}', () => topbar.render())
        .replace('{{SESSION_VIEW}}', () => sessionsServer.renderView())
        .replace('{{TELEGRAM_VIEW}}', () => telegramServer.renderView())
        .replace('{{BOOK_VIEW}}', () => bookServer.renderView())
        .replace('{{SETTINGS_MODAL}}', () => settingsServer.renderView())
        .replace('{{APP_VERSION}}', currentVersion())
        .replace('{{APP_HEAD}}', currentHead())
        .replace('{{VERSION_LIST}}', versionHistory());
    if (!tail) return page;
    return page.includes('</body>') ? page.replace('</body>', `${tail}</body>`) : page + tail;
}

module.exports = { currentVersion, currentHead, versionHistory, renderPage };