// Какое событие живой перезагрузки послать в браузер на правку файлов.
//
// Точечное событие — только там, где границы компонента известны наверняка:
// шаблон фрагмента живёт ровно в одном месте страницы, таблица стилей подменяется
// целиком. Всё остальное — полная перезагрузка: лишний раз перезагрузить дешевле,
// чем молча оставить страницу с устаревшим кодом.
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

        const template = rel.match(/^SYSTEM\/templates\/(.+)\.eta$/);
        if (template) { events.add(`fragment:${template[1]}`); continue; }

        if (rel.endsWith('.css')) { events.add(`css:${rel}`); continue; }

        return ['reload']; // в пачке есть что-то ещё — точечные события уже не покрывают правку
    }
    return [...events];
}

module.exports = { reloadEvents };
