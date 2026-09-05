// Карта проекта и поиск, серверная половина — вход: сборка частей и маршруты.
// Вкладки Graph с полотном в проекте больше нет (DOCS/decisions/023), но всё
// остальное на месте: карта кормит поиск, память о сессиях и редактор файла.
// Сама работа разложена по темам в этой же папке (DOCS/decisions/022):
//   graph-vault.js  — карта проекта в виде vault, память о сессиях и общее состояние
//   graph-search.js — поисковый индекс (FTS5) и запрос к нему
//   graph-files.js  — чтение-правка файла из узла карты
// Здесь остаются init() (то, что нужно снаружи, приходит один раз), prepareVault()
// и createRoutes() — server.js только раскладывает готовую таблицу путей и
// берёт отсюда прежние имена: экспорты внизу не менялись при разъезде.
//
// Модуль ничего не знает про хранилище сессий: то, что ему нужно снаружи,
// приходит один раз через init().

const fs = require('fs');
const path = require('path');
const { readJson, sendJson } = require('../../SYSTEM/core/http.js');
const vault = require('./graph-vault.js');
const { rebuildSearchIndex, searchProject } = require('./graph-search.js');
const { MAX_EDIT_BYTES, readProjectFile, writeProjectFile } = require('./graph-files.js');

const { DATA_DIR, VAULT_DIR, VAULT, MAP_DIR, SESSION_DIR, state } = vault;
const { projectFiles, syncProjectMap, syncSessionNotes, dropStaleNotes, buildVaultGraph } = vault;

// { listSessions, listMessages, sessionTitle, onMapReady } — кладём в общее
// состояние (graph-vault.js), откуда его читают все модули вкладки
function init(options) {
    state.deps = options;
    return module.exports;
}

// vault заводим и наполняем при старте сервера, дальше обновляем после правок —
// к первому поиску и к первому открытию файла карта уже готова.
// Живёт во входе, а не в graph-vault.js: это единственное место, где карта
// (graph-vault.js) и индекс (graph-search.js) собираются вместе, — иначе
// модули require'или бы друг друга по кругу
function prepareVault() {
    try {
        fs.mkdirSync(VAULT, { recursive: true });
        syncProjectMap();
        syncSessionNotes();
        dropStaleNotes(path.join(VAULT, MAP_DIR)); // карта: файл исчез — заметка тоже
        dropStaleNotes(path.join(VAULT, SESSION_DIR)); // сессию удалили из списка — и заметку
    } catch (error) {
        console.error(`Failed to build the project map in the vault: ${error.message}`);
    }
    rebuildSearchIndex(); // индекс строим и при частичной карте: поиск лучше устаревшего ничего
    state.deps.onMapReady(); // карта пересобралась — страница заберёт её заново
}

// маршруты: карта проекта, поиск и файловая панель. Данных снаружи
// им не нужно — всё, чем они отвечают, живёт в этой же папке
function createRoutes() {
    return {
        '/api/obsidian/graph': (req, res) => {
            sendJson(res, buildVaultGraph());
        },

        '/api/file/read': async (req, res) => {
            const { path: target } = await readJson(req);
            sendJson(res, readProjectFile(target));
        },

        '/api/file/write': async (req, res) => {
            // в теле идёт весь файл целиком: index.html один весит больше
            // стандартного лимита readJson, поэтому лимит здесь свой
            const { path: target, text } = await readJson(req, MAX_EDIT_BYTES + 100_000);
            sendJson(res, writeProjectFile(target, text));
        },

        '/api/search': async (req, res) => {
            const { q, limit } = await readJson(req);
            sendJson(res, searchProject(q, limit));
        },
    };
}

module.exports = {
    DATA_DIR, // им пользуется server.js: и сторож файлов, и путь до базы сессий
    VAULT_DIR,
    init,
    createRoutes,
    prepareVault,
    projectFiles, // нужен сторожу файлов в server.js: состав папки проекта
};
