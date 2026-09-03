// Какое событие живой перезагрузки послать в браузер на правку файлов.
//
// Точечное событие — только там, где границы компонента известны наверняка:
// шаблон фрагмента живёт ровно в одном месте страницы, таблица стилей подменяется
// целиком, страница кнопки «+» снимается и собирается заново целиком (её модуль
// не оставляет за собой ничего, см. договор в SYSTEM/new-button.js). Всё
// остальное — полная перезагрузка: лишний раз перезагрузить дешевле, чем молча
// оставить страницу с устаревшим кодом.
//
// Вынесено из server.js отдельным модулем, чтобы у правила была проверка в смоуке:
// сервер там поднимается с NO_RELOAD=1 и через HTTP это не потрогать.
const path = require('path');

// files — абсолютные пути изменившихся файлов; null или пустой список (например,
// файл удалили — его в списке нет) означает «границы правки неизвестны»
function reloadEvents(root, files) {
    if (!files || !files.length) return ['reload'];

    const events = new Set();
    for (const file of files) {
        const rel = path.relative(root, file).split(path.sep).join('/');

        // шаблон фрагмента лежит в папке своей фичи (PROJECTS/Home/home-observation.eta),
        // а зовётся по имени файла: оно же имя маршрута /api/fragment/<имя>
        const template = rel.match(/([^/]+)\.eta$/);
        if (template) { events.add(`fragment:${template[1]}`); continue; }

        // PROJECTS/<папка>/page.js — страница кнопки «+» целиком; у встроенных
        // разделов файла с таким именем нет, так что под правило попадают только они
        const page = rel.match(/^PROJECTS\/([^/]+)\/page\.js$/);
        if (page) { events.add(`page:${page[1]}`); continue; }

        if (rel.endsWith('.css')) { events.add(`css:${rel}`); continue; }

        return ['reload']; // в пачке есть что-то ещё — точечные события уже не покрывают правку
    }
    return [...events];
}

module.exports = { reloadEvents };
