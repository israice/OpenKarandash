// Какие CLI из списка сайта есть на этой машине.
//
// Уровень CLI в строке выбора (SYSTEM/cli-agents.js) перечисляет имена с сайта
// OpenRouter и ничего не говорит о том, что стоит на машине: там полсотни
// имён, а установлено бывает десяток. Раньше разницы на экране не было вовсе —
// выбираешь несуществующее имя, Gateway/Provider/Model встают на прочерки, и
// ошибка приходит только при отправке хода.
//
// Здесь — одна проверка на всех: имена уходят на сервер, тот запускает
// `--version` у каждого ПАРАЛЛЕЛЬНО и отвечает, кто ответил. По одному по
// очереди полсотни имён стоят около пятидесяти секунд (замерено на этой машине),
// параллельно — около пяти (тоже замерено), поэтому по очереди их и не
// спрашивают: замер сделан прямо через /api/agent/detect.
//
// Ответ кэшируется на TTL: страницу открывают часто, а состав установленных CLI
// меняется не чаще, чем человек что-то поставил. Пока кэш свеж, запусков вовсе.
const { readJson, sendJson } = require('../core/http.js');

// как долго считаем ответ годным. Пять минут: поставленный человеком CLI
// появится в подсветке сам, не дожидаясь перезагрузки страницы
const TTL_MS = 5 * 60 * 1000;

// Сколько имён спрашиваем за раз. Все сразу — это полсотни процессов разом, и
// проверка сама становится тем, что её вызвало; порциями она держится в узких
// рамках. Двенадцать — с запасом больше типичного числа установленных CLI
const BATCH = 12;

// Ответ на все имена сразу: { [имя]: { installed, version } }.
//
// Кэш общий на всех и на все запросы. Ключ по именам не делаем: имена с сайта
// меняются (раз в дни), а проверка стоит запусков процессов, и пересчитывать
// её на каждый чужой запрос означало бы запускать полсотни CLI снова и снова.
// Ответ неполный — имена, которых не было в прошлой разведке, — трактуется
// вызывающей стороной как «неизвестно», а не как «нет».
let cache = { at: 0, results: {} };

// createRoutes({ agents })
function createRoutes({ agents }) {
    // Проверка одного имени: detect() отдаёт список целей, а цель есть только
    // когда команда нашлась — в переменной окружения владельца или в PATH (см.
    // resolveCommand в any.js). Пустой список — честное «на этой машине нет».
    // Имена приходят с сайта и заранее не известны, поэтому на каждое заводится
    // свой коннектор (SYSTEM/cli/index.js, byName) — он и умеет искать команду
    async function probe(name) {
        const key = String(name || '').trim();
        if (!key) return null;
        try {
            const installs = await agents.byName(key).detect();
            if (!Array.isArray(installs) || !installs.length) {
                return [key, { installed: false, version: '' }];
            }
            return [key, { installed: true, version: String(installs[0].version || '') }];
        } catch {
            // CLI нашёлся, а `--version` упал: он установлен, и считать его
            // отсутствующим нельзя — иначе подсветки лишился бы ровно тот CLI,
            // который сломан, а именно его человеку и надо видеть. Разбитый
            // отвечает пустой версией, и это его отличает от несуществующего
            return [key, { installed: true, version: '', broken: true }];
        }
    }

    // порциями, а не все сразу — см. BATCH выше
    async function probeAll(names) {
        const found = {};
        const queue = names.map((name) => String(name || '').trim()).filter(Boolean);
        for (let i = 0; i < queue.length; i += BATCH) {
            const answered = await Promise.all(queue.slice(i, i + BATCH).map(probe));
            for (const entry of answered) {
                if (entry) found[entry[0]] = entry[1];
            }
        }
        return found;
    }

    return {
        // POST /api/agent/scan { names: [...] } → { ok, results, cached }
        //
        // Отдельный маршрут рядом с detect, а не замена ему: detect отвечает
        // про одно имя и его использует Connect, а здесь вопрос обо всех сразу
        // — строке выбора нужно знать, кого красить, до того как человек что-то
        // выбрал. Имена телом, а не в пути: их список с сайта меняется, и
        // добавление пятидесят первого CLI не должно добавлять маршрут
        '/api/agent/scan': async (req, res) => {
            const { names = [] } = await readJson(req);
            if (Date.now() - cache.at < TTL_MS) {
                sendJson(res, { ok: true, results: cache.results, cached: true });
                return;
            }
            const results = await probeAll(Array.isArray(names) ? names : []);
            cache = { at: Date.now(), results };
            sendJson(res, { ok: true, results, cached: false });
        },
    };
}

module.exports = { createRoutes };