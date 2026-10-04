// Живая перезагрузка: скрипт, который подмешивается в страницу, канал событий до
// неё и опрос файлов, по которому события вообще возникают.
//
// Один модуль на все три части, потому что они неразлучны: опрос без канала
// никому ничего не скажет, а канал без опроса молчит (DOCS/decisions/022).
// Всё, что модулю нужно от соседей, приходит аргументом create(): пересборка
// карты и «занят ли кто-то ходом» — это дела и состояние сервера, а не его.
const fs = require('fs');
const path = require('path');
const scan = require('./scan.js');
const { reloadEvents } = require('./reload.js');

// ---------- скрипт для страницы ----------

// скрипт подмешивается в HTML на лету, файлы проекта не трогаются
const RELOAD_SNIPPET = `
<script>
(function () {
    let source;
    let lost = false;
    let hold = false;   // идёт запрос к Claude — перезагрузка оборвала бы ответ
    let queued = false;

    // страница просит подождать, пока читает поток ответа
    window.__holdReload = (on) => {
        hold = on;
        if (!on && queued) location.reload();
    };

    function reload() {
        if (hold) queued = true;
        else location.reload();
    }

    // правка .eta трогает ровно один фрагмент — просим htmx перезапросить только его,
    // сохранив состояние остальной страницы. Контейнер ищем по его же hx-get: другого
    // источника этой разметки нет. Не нашли — правка не должна пропасть незамеченной
    function swapFragment(name) {
        const nodes = document.querySelectorAll('[hx-get="/api/fragment/' + name + '"]');
        if (!nodes.length || !window.htmx) { reload(); return; }
        nodes.forEach((node) => window.htmx.ajax('GET', '/api/fragment/' + name, {
            source: node,
            target: node,
            swap: node.getAttribute('hx-swap') || 'none',
        }));
    }

    // css правится чаще всего и перезагрузки не требует вовсе: меняем href у <link>,
    // страница со всем её состоянием остаётся на месте
    function swapStyles(file) {
        let found = false;
        document.querySelectorAll('link[rel="stylesheet"]').forEach((link) => {
            if ((link.getAttribute('href') || '').split('?')[0] !== file) return;
            found = true;
            link.setAttribute('href', file + '?v=' + Date.now());
        });
        if (!found) reload();
    }

    function connect() {
        source = new EventSource('/__reload');
        source.onmessage = (event) => {
            const data = event.data;
            // карта пересобирается позже самой правки, поэтому у неё своё событие:
            // страницу перезагружать незачем, достаточно забыть прежнюю карту
            if (data === 'map') { window.__onMapUpdate && window.__onMapUpdate(); return; }
            // точечные события: обновляем один фрагмент или одну таблицу стилей.
            // hold здесь не смотрим — в отличие от перезагрузки, поток ответа они не рвут
            if (data.startsWith('fragment:')) { swapFragment(data.slice(9)); return; }
            if (data.startsWith('css:')) { swapStyles(data.slice(4)); return; }
            // правка модуля страницы кнопки «+»: пересобираем только её саму.
            // false — такой страницы в интерфейсе нет (переименовали, удалили,
            // список ещё не пришёл), и тогда обычная полная перезагрузка
            if (data.startsWith('page:')) {
                if (!window.MissionPages || !window.MissionPages.rebuildPage(data.slice(5))) reload();
                return;
            }
            reload();
        };
        // связь восстановилась после перезапуска сервера — берём свежую страницу
        source.onopen = () => { if (lost) reload(); };
        source.onerror = () => { lost = true; source.close(); setTimeout(connect, 500); };
    }

    connect();
})();
</script>
`;

function create({
    root,                    // корень проекта — обход идёт от него
    serverFile,              // файл самого сервера: за ним следит надзорный процесс
    pollMs,                  // как часто сверяем время изменения файлов
    dataDir,                 // папка данных сервера (её имя задаёт модуль карты)
    listProjectFiles,        // состав файлов проекта — для карты, а не для страницы
    rebuildMap,              // пересборка карты проекта (vault)
    isBusy,                  // идёт ли сейчас ход: пересборку откладываем до его конца
}) {
    const clients = new Set();

    function notifyClients(event = 'reload') {
        for (const res of clients) res.write(`data: ${event}\n\n`);
    }

    // сколько вкладок держит канал: пустым он не даёт слать события в никуда
    const clientCount = () => clients.size;

    // подключение страницы к каналу (адрес /__reload отдаёт http-server.js)
    function connect(req, res) {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
        });
        res.write('retry: 1000\n\n');
        clients.add(res);
        req.on('close', () => clients.delete(res));
    }

    // fs.watch не даёт событий на некоторых ФС (диски Windows в WSL, сетевые шары),
    // поэтому следим за временем изменения файлов опросом — работает везде
    //
    // DATA целиком: vault переписывается при каждой пересборке, и сторож гонял бы
    // страницу по кругу — правка → пересборка → правка
    const SKIP = new Set([...scan.SKIP_NAMES, dataDir]);

    // Папки, правки в которых не трогают страницу и не гоняют пересборку карты.
    // Penpot живёт в контейнере: работа с макетом идёт через MCP и пишет файлы рядом
    // с канвасом (TOOLS/penpot-mcp/design, deploy/penpot) помимо самой страницы
    // PROJECTS/Penpot. Раньше любая из этих правок проходила как обычное изменение:
    // событие `reload` гасило страницу целиком, а следом запускалась пересборка vault.
    // Здесь важно, что список относительных путей, а не имён папок: в SKIP_NAMES
    // попадать нельзя, оттуда список общий с картой проекта (SYSTEM/core/scan.js),
    // и страница Penpot тогда исчезла бы из списка проектов.
    const RELOAD_SKIP = ['PROJECTS/Penpot', 'TOOLS/penpot-mcp', 'deploy/penpot']
        .map((rel) => path.join(root, ...rel.split('/')));

    // папка целиком пропускается, а не файлы по расширению: правка страницы идёт
    // через MCP-команды, и то, что зовёт их, лежит рядом с ними
    function isReloadSkipped(full) {
        return RELOAD_SKIP.some((dir) => full === dir || full.startsWith(dir + path.sep));
    }

    function snapshot(dir, acc = new Map()) {
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return acc; // папку не прочитать — не повод ронять сервер, просто не следим за ней
        }

        for (const entry of entries) {
            if (entry.name.startsWith('.') || SKIP.has(entry.name)) continue;

            const full = path.join(dir, entry.name);
            if (full === serverFile) continue; // за сервером следит надзорный процесс
            if (isReloadSkipped(full)) continue;

            if (entry.isDirectory()) {
                snapshot(full, acc);
                continue;
            }
            // один нечитаемый файл не должен прекращать обход остальных: битая ссылка,
            // файл занят другим процессом, права — всё это норма посреди рабочей папки
            try {
                acc.set(full, fs.statSync(full).mtimeMs);
            } catch { /* пропускаем — за ним просто не следим */ }
        }
        return acc;
    }

    // правки идут пачками — пересобираем карту после паузы, и не посреди запроса к агенту
    const MAP_DEBOUNCE_MS = 3000;
    let mapTimer = null;

    function scheduleMapUpdate() {
        if (mapTimer) clearTimeout(mapTimer);
        mapTimer = setTimeout(() => {
            mapTimer = null;
            if (isBusy()) {
                scheduleMapUpdate(); // агент ещё правит файлы — пересоберём, когда закончит
                return;
            }
            rebuildMap();
        }, MAP_DEBOUNCE_MS);
    }

    function start() {
        let previous = snapshot(root);
        let previousList = listProjectFiles().join('|');

        setInterval(() => {
            let current;
            try {
                current = snapshot(root);
            } catch {
                return; // файл исчез посреди обхода — проверим на следующем круге
            }

            // собираем не флаг, а список правок: по нему решается, хватит ли точечного
            // события. Удаление файла в список не попадает — его видно только по размеру
            const changed = [];
            for (const [file, mtime] of current) {
                if (previous.get(file) !== mtime) changed.push(file);
            }
            const removed = current.size !== previous.size && changed.length === 0;

            previous = current;
            if (changed.length || removed) {
                if (clients.size > 0) {
                    for (const event of reloadEvents(root, removed ? null : changed)) notifyClients(event);
                }
                scheduleMapUpdate();
                return;
            }

            // snapshot намеренно не видит скрытые файлы: .sessions.db переписывается на
            // каждом сообщении, и страница перезагружалась бы без конца. но в карту такие
            // файлы входят, поэтому отдельно следим за составом папки — без чтения mtime
            const list = listProjectFiles().join('|');
            if (list === previousList) return;
            previousList = list;
            scheduleMapUpdate(); // появился или исчез файл — перерисовываем карту, страницу не трогаем
        }, pollMs).unref();
    }

    return { snippet: RELOAD_SNIPPET, connect, notifyClients, clientCount, scheduleMapUpdate, start };
}

module.exports = { create };