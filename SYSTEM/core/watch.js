// Живая перезагрузка: канал до страницы, её скрипт и опрос коммитов, по которому
// в канале возникает событие.
//
// Правило одно: страница показывает то, чем собрана основная копия, и меняется
// ровно тогда, когда меняется коммит. Не по сохранению файла — правило стоило
// дороже, чем давало: правка незакоммиченного кода перерисовывала интерфейс на
// том, чего в проекте ещё нет, а правка заметки или вкладки настроек гасила
// открытую страницу (DOCS/decisions/011, 090 — заменены решением 117).
//
// Что осталось в канале, кроме перезагрузки, — обновление данных: карта после
// пересборки и лента сессий из соседней вкладки. Это не про код страницы, и
// привязывать её к коммиту нельзя: после хода агента лента должна поехать сразу.
//
// Решение «стоит ли перезагружаться» принимает страница, а не сервер: событие
// несёт текущий коммит, а страница знает тот, каким загрузилась (data-head в
// SYSTEM/index.html). Совпали — вкладка не трогается. Отсюда три вещи, которые
// иначе стоили бы отдельных механизмов: вкладка, открытая после коммита, не
// перезагружается вхолостую; перезапуск сервера не выглядит коммитом; два
// события подряд не дают двух перезагрузок.
//
// fs.watch не даёт событий на некоторых ФС (диски Windows в WSL, сетевые шары),
// поэтому коммит сверяется опросом — работает везде.
const gitHead = require('./git-head.js');

// ---------- скрипт для страницы ----------

// скрипт подмешивается в HTML на лету, файлы проекта не трогаются
const RELOAD_SNIPPET = `
<script>
(function () {
    let source;
    let hold = false;   // идёт запрос к Claude — перезагрузка оборвала бы ответ
    let queued = false;

    function showUpdateNotice(message) {
        const notice = document.createElement('div');
        notice.setAttribute('role', 'status');
        notice.setAttribute('aria-live', 'polite');
        notice.textContent = message;
        Object.assign(notice.style, {
            position: 'fixed', right: '16px', bottom: '16px', zIndex: '10000',
            width: 'calc(100% - 32px)', maxWidth: '420px', padding: '12px 16px',
            borderRadius: '8px', background: '#20242b', color: '#fff',
            boxShadow: '0 4px 18px #0005', font: '14px/1.4 system-ui, sans-serif',
        });
        document.body.append(notice);
        setTimeout(() => notice.remove(), 12000);
    }

    try {
        if (sessionStorage.getItem('openkarandash-update-notice') === 'installed') {
            sessionStorage.removeItem('openkarandash-update-notice');
            showUpdateNotice('OpenKarandash was updated from GitHub.');
        }
    } catch {}

    function onUpdate(status) {
        if (status === 'available') {
            showUpdateNotice('A GitHub update is available. It will be applied after active sessions finish.');
        } else if (status === 'installed') {
            try { sessionStorage.setItem('openkarandash-update-notice', 'installed'); } catch {}
            showUpdateNotice('Update downloaded. The application is restarting safely.');
        } else if (status.startsWith('blocked:')) {
            const reason = status.slice(8);
            const messages = {
                branch: 'Update available; automatic pull only runs on the main deployment branch.',
                'waiting-version': 'Update available; waiting for its version entry to reach GitHub.',
                'changed-during-drain': 'Another GitHub commit arrived during the safe update window; it will be checked again.',
                dependencies: 'Update requires dependency changes; rebuild the Docker image to continue.',
                'local-changes': 'Update available, but local changes were found. They were not overwritten.',
                diverged: 'Update available, but the local main branch has diverged from GitHub.',
                failed: 'GitHub update could not be checked or applied. See the server log.',
            };
            showUpdateNotice(messages[reason] || 'GitHub update is blocked; see the server log.');
        }
    }

    // страница просит подождать, пока читает поток ответа
    window.__holdReload = (on) => {
        hold = on;
        if (!on && queued) location.reload();
    };

    function reload() {
        if (hold) queued = true;
        else location.reload();
    }

    // новый коммит. Событие несёт коммит сервера, а страница знает свой
    // (data-head в SYSTEM/index.html): совпали — она уже показывает этот коммит
    // и трогаться не должна. Сюда же попадает первый head: при подключении:
    // им канал отвечает «каким коммитом я сейчас», и вкладка, пережившая
    // перезапуск сервера, узнаёт, что показывает уже неактуальный код
    function onHead(head) {
        if (!head) return; // сервер не знает коммита — сравнивать не с чем
        if (head === document.documentElement.dataset.head) return;
        reload();
    }

    // лента сессий в соседней вкладке: сервер шлёт её событием, когда ход начался
    // не здесь. Это данные, а не код, поэтому подменяем один фрагмент и сохраняем
    // состояние остальной страницы. Контейнер ищем по его же hx-get: другого
    // источника этой разметки нет. Не нашли — перезагружаем страницу
    function swapFragment(name) {
        const nodes = document.querySelectorAll('[hx-get="/api/fragment/' + name + '"]');
        if (!nodes.length || !window.htmx) { reload(); return; }
        nodes.forEach((node) => window.htmx.ajax('GET', '/api/fragment/' + name, {
            source: node,
            target: node,
            swap: node.getAttribute('hx-swap') || 'none',
        }));
    }

    function connect() {
        source = new EventSource('/__reload');
        source.onmessage = (event) => {
            const data = event.data;
            if (data.startsWith('update:')) { onUpdate(data.slice(7)); return; }
            // карта пересобирается позже самого коммита, поэтому у неё своё
            // событие: страницу перезагружать незачем, достаточно забыть прежнюю карту
            if (data === 'map') { window.__onMapUpdate && window.__onMapUpdate(); return; }
            // hold здесь не смотрим: в отличие от перезагрузки, поток ответа
            // подмена фрагмента не рвёт
            if (data.startsWith('fragment:')) { swapFragment(data.slice(9)); return; }
            if (data.startsWith('head:')) { onHead(data.slice(5)); return; }
            reload();
        };
        // Связь порвалась (перезапуск сервера, сеть) и вернётся. Само по себе это
        // не повод перезагружать страницу: перезапуск не меняет код, и раньше он
        // выглядел новым изменением. Повод — новый коммит, а его пришлёт сервер:
        // если он пришёл, пока связь была порвана, наверстает следующая отправка
        source.onerror = () => { source.close(); setTimeout(connect, 500); };
    }

    connect();
})();
</script>
`;

function create({
    root,                    // корень проекта: по нему читается его коммит
    pollMs,                  // как часто сверяем коммит
    onCommit,                // новый коммит: пересобрать карту проекта
}) {
    const clients = new Set();

    function notifyClients(event = 'reload') {
        for (const res of clients) res.write(`data: ${event}\n\n`);
    }

    // сколько вкладок держит канал: пустым он не даёт слать события в никуда
    const clientCount = () => clients.size;

    // коммит, которым собрана основная копия: его кладём в data-head страницы и
// в канал, и по нему же страница решает, перезагружаться ли ей
    const currentHead = () => gitHead.head(root);

    // подключение страницы к каналу (адрес /__reload отдаёт http-server.js)
    //
    // Первым событием уходит текущий коммит, и только подключившейся вкладке.
    // Без этого события вкладка, пережившая перезапуск сервера, осталась бы со
    // старым кодом навсегда: уведомление о новом коммите пришло бы, пока связи
    // не было. Всем остальным его слать нельзя — чужое подключение выглядело бы
    // для них как новое изменение, и переподключение одного окна перезагружало
    // бы остальные
    function connect(req, res) {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
        });
        res.write('retry: 1000\n\n');
        clients.add(res);
        res.write(`data: head:${currentHead()}\n\n`);
        req.on('close', () => clients.delete(res));
    }

    // Опрос коммита вместо обхода файлов. Раньше здесь снимались mtime всех файлов
    // дерева, и по ним выбиралось, какое событие слать (правило было отдельным
    // модулем SYSTEM/core/reload.js). Обход на каждом круге съедал event loop, а
    // правило стоило дороже, чем давало: правка незакоммиченного кода
    // перерисовывала страницу на том, чего в проекте ещё нет. Теперь читаются
    // два файла (.git/HEAD и ссылка), а событие одно
    function start() {
let previous = currentHead();
        setInterval(() => {
            const current = currentHead();
            // пусто — это не «коммит сменился», а «прочитать не вышло»: иначе один
            // неудачный момент молча уронил бы отметку, и следующая правка дала бы
            // странице перезагрузку, которой не было
            if (!current || current === previous) return;
            previous = current;
            notifyClients(`head:${current}`);
            onCommit(); // файлы на диске другие — карта прежняя
        }, pollMs).unref();
    }

    return { snippet: RELOAD_SNIPPET, connect, notifyClients, clientCount, start };
}

module.exports = { create };