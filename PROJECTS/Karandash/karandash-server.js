// Кнопка Karandash, серверная половина: снимок экрана для миниатюры сессии
// и выбор монитора, с которого его делать. Здесь же её маршруты (createRoutes
// внизу файла) — вся кнопка Karandash собрана в одной папке, server.js только
// раскладывает готовую таблицу путей.
//
// Скриншот делается через node-screenshots (нативный бинарный модуль), а не
// PowerShell — это убирает эвристику антивируса (ScriptContainedMaliciousContent)
// на System.Drawing + ручное JPEG-кодирование.

const { readJson, sendJson } = require('../../SYSTEM/core/http.js');
// индекс хуков лежит в карте проекта (PROJECTS/Graph): он отдаёт место элемента
// в коде по его именам. Здесь только маршрут — сама работа идёт оттуда, иначе
// и indexes, и поиск по коду жили бы в двух местах с разными ответами
const { findHooks } = require('../Graph/graph-search.js');
// контекст места: секция файла, соседи по фиче, обратные ссылки — то, что иначе
// добывается поиском по vault (PROJECTS/Graph/graph-context.js)
const { contextOf } = require('../Graph/graph-context.js');

const { Monitor } = require('node-screenshots');

const SCREENSHOT_WIDTH = 480;

// список подключённых экранов — для настройки в Settings, откуда выбирают,
// с какого монитора кнопка Karandash снимает миниатюру
async function listScreens() {
    try {
        const monitors = await Monitor.all();
        return monitors.map((m, i) => ({
            index: i,
            width: m.width(),
            height: m.height(),
            primary: m.isPrimary(),
            name: m.name() || `Monitor ${i} (${m.width()}x${m.height()})`,
        }));
    } catch {
        return [];
    }
}

// снимок экрана для миниатюры сессии: node-screenshots захватывает указанный
// монитор, масштабирует до SCREENSHOT_WIDTH и возвращает base64 JPEG
async function captureScreenshot(screenIndex) {
    const index = Number.isInteger(screenIndex) && screenIndex >= 0 ? screenIndex : 0;
    try {
        const monitors = await Monitor.all();
        if (index >= monitors.length) return null;
        const m = monitors[index];
        const img = await m.captureImage();
        const h = Math.max(1, Math.round(img.height / img.width * SCREENSHOT_WIDTH));
        const thumb = await img.crop(0, 0, SCREENSHOT_WIDTH, h);
        const jpeg = await thumb.toJpeg();
        const base64 = jpeg.toString('base64');
        return base64 ? `data:image/jpeg;base64,${base64}` : null;
    } catch {
        return null;
    }
}

// какой монитор снимать, хранится в .env (SCREENSHOT_SCREEN) — записать туда
// умеет только SYSTEM/core/env.js, поэтому setEnvValue приходит снаружи
function createRoutes({ setEnvValue }) {
    const currentScreen = () => Number(process.env.SCREENSHOT_SCREEN) || 0;

    return {
        // снимок экрана из режима Karandash: клиент просит его сразу после отправки
        // комментария, пока выбранный элемент ещё обведён рамкой
        '/api/screenshot': async (req, res) => {
            const thumb = await captureScreenshot(currentScreen());
            if (!thumb) {
                sendJson(res, { ok: false, error: 'Failed to take a screenshot' });
                return;
            }
            sendJson(res, { ok: true, thumb });
        },

        // список мониторов и текущий выбор — для настройки в Settings
        '/api/screenshot/screens': async (req, res) => {
            sendJson(res, { screens: await listScreens(), current: currentScreen() });
        },

        '/api/screenshot/screen': async (req, res) => {
            const { index } = await readJson(req);
            if (!Number.isInteger(index) || index < 0) {
                sendJson(res, { ok: false, error: 'Invalid screen index' });
                return;
            }
            setEnvValue('SCREENSHOT_SCREEN', String(index));
            sendJson(res, { ok: true });
        },

        // место выбранного элемента в коде: клиент отдаёт имена (id и классы),
        // ответ — файлы и строки, где этот элемент создаётся и где описан стилем.
        // Без этого модель получает только селектор и ищет место сама — по одному
        // имени класса на проект приходится десяток упоминаний (решение 091).
        //
        // К файлам и строкам добавляется контекст места (PROJECTS/Graph/graph-context.js):
        // секция файла, в которой строки живут, остальные файлы фичи и то, кто
        // ссылается на этот файл. Названного файла мало: у клика по кнопке карандаш
        // за файлом тянётся ещё полкарты, и без этого агент читает всё подряд (100)
        //
        // Индекс пуст (сервер только что поднялся, файлы ещё не прочитаны) —
        // это не поломка: клиент просто оставит строку элемента как была
        '/api/karandash/element': async (req, res) => {
            const { names } = await readJson(req);
            const list = Array.isArray(names) ? names.filter((n) => typeof n === 'string').slice(0, 6) : [];
            if (!list.length) {
                sendJson(res, { ok: true, places: [] });
                return;
            }
            try {
                const places = findHooks(list, 8);
                sendJson(res, {
                    ok: true,
                    places: places.map((place) => ({
                        ...place,
                        context: contextOf(place.file, place.lines[0]),
                    })),
                });
            } catch (error) {
                sendJson(res, { ok: false, error: `Hook index failed: ${error.message}` });
            }
        },
    };
}

module.exports = { createRoutes, captureScreenshot, listScreens };