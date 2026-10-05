// Слой базы сессий: тонкий сборщик трёх частей. Сам он вынесен из server.js
// (DOCS/decisions/022), а когда дорос до семисот с лишним строк, разошёлся
// дальше — по той же причине и по тому же правилу, один файл — одна тема:
//
//   sessions-db-schema.js   файл SQLite, таблицы, миграции колонок
//   sessions-db-queries.js  заготовленные запросы и удаление
//   sessions-db-records.js  запись событий хода в ленту (Event Schema, решение 040)
//
// Наружу по-прежнему отдаётся ровно то же: open() возвращает те же имена, и
// server.js (а с ним весь остальной сервер) об их наборе ничего не знает.
//
// Зависимости приходят аргументом, как у createRoutes(deps) у фич: корень
// проекта, имя папки данных и разбор «какой CLI вёл сессию» (таблица AGENTS
// осталась в server.js). Тела функций не сдвинуты вправо намеренно: так
// перенесённый текст совпадает с прежним построчно, и его видно в
// `git diff --color-moved` без шума от отступов.
const { createSchema } = require('./sessions-db-schema.js');
const { createQueries } = require('./sessions-db-queries.js');
const { createRecords } = require('./sessions-db-records.js');

function open({ ROOT, DATA_DIR, agentNameByTarget }) {
    const schema = createSchema({ ROOT, DATA_DIR });
    const queries = createQueries(schema.db);
    const records = createRecords({ queries, agentNameByTarget });

    return { ...schema, ...queries, ...records };
}

module.exports = { open };