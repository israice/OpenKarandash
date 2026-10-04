// Выпадающий список сессий слева в тулбаре Flow (см. #flowSessionSelect в SYSTEM/index.html):
// строит граф нод текущего канваса из сообщений выбранной сессии (SYSTEM/app.js). Сама
// сборка (белый текст — цепочка вправо, серый текст шагов — цепочка вниз под ним)
// живёт в PROJECTS/Flow/flow-session-build.js, здесь сбор данных и вызов MissionFlow.buildFromSession,
// плюс живое обновление: если сессия сейчас выполняется, подключаемся к её потоку
// (/api/sessions/attach) и перестраиваем граф по мере появления новых сообщений.
(function () {
    const select = document.getElementById('flowSessionSelect');
    if (!select) return;

    function activeFlow() {
        const activeItem = document.querySelector('#flowNav .side-nav__item--active');
        return activeItem ? activeItem.dataset.flow : 'New';
    }

    // номер текущей подписки: выбор другой сессии (или сброс на плейсхолдер)
    // делает прежние живые перестройки устаревшими — они молча прекращаются
    let liveGeneration = 0;
    // обрыв прежнего потока при новой подписке: иначе соединение прошлого
    // attach висело бы до конца того хода, даже когда его события уже не нужны
    let liveAbort = null;
    // пока пользователь не выбрал сессию в списке руками, список сессий
    // «следует» за самой свежей: как только появляется более новая (см.
    // 'sessions-changed' ниже), канвас перестраивается на неё сам. Ручной
    // выбор в select (в том числе возврат на плейсхолдер) это следование
    // выключает — дальше решает только человек. select.value уже непустой
    // на старте означало бы, что выбор сделан не этим кодом — тогда тоже
    // не вмешиваемся (на практике select всегда стартует пустым)
    let followingLatest = !select.value;

    async function rebuild(sessionId, flow, generation) {
        const { messages = [] } = await App.api('/api/sessions/messages', { id: sessionId });
        // пока шёл запрос, пользователь мог уйти на другой пункт меню. Строить туда
        // нельзя: buildFromSession делает свой канвас активным (setActiveFlow), и ноды
        // чужой сессии показались бы поверх того канваса, который человек открыл
        if (generation !== liveGeneration || activeFlow() !== flow) return;
        MissionFlow.buildFromSession(flow, messages, sessionId);
    }

    // если сессия сейчас выполняется, сервер отдаёт её поток NDJSON — тот же
    // /api/sessions/attach, которым лента Chat досматривает идущую работу
    // (см. attachSession в SYSTEM/app.js). Содержимое событий не разбираем:
    // граф всё равно строится из /api/sessions/messages, событие — лишь сигнал,
    // что там появилось новое, поэтому перестраиваем не чаще раза в секунду
    async function watchLive(sessionId, flow, generation) {
        liveAbort?.abort();
        const abort = new AbortController();
        liveAbort = abort;
        let scheduled = false;
        const scheduleRebuild = () => {
            if (scheduled) return;
            scheduled = true;
            setTimeout(async () => {
                // пока вкладка Flow скрыта, строить нельзя (нулевые размеры сломали бы
                // zoom/pan — см. whenFlowViewVisible ниже); дожидаемся показа и строим
                await whenFlowViewVisible();
                // выбор устарел, select скрыт («321») или активен другой канвас —
                // молча перестраивать чужой канвас нельзя, наблюдение прекращается
                if (generation !== liveGeneration || select.hidden || activeFlow() !== flow) {
                    scheduled = false;
                    return;
                }
                await rebuild(sessionId, flow, generation);
                scheduled = false;
            }, 1000);
        };

        // закрытие потока ещё не конец хода: связь могла оборваться, сервер —
        // перезапуститься. Конец — это обычный JSON вместо ndjson; до него
        // переподключаемся, иначе страница молча переставала обновляться посреди
        // идущей работы (DOCS/decisions/046)
        const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        let attached = false;
        for (let failures = 0; failures < 8;) {
            let res;
            try {
                res = await fetch('/api/sessions/attach', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ id: sessionId }),
                    signal: abort.signal,
                });
            } catch {
                if (abort.signal.aborted) return;
                failures += 1;
                await pause(1500);
                continue;
            }
            if (generation !== liveGeneration) return;
            // обычный JSON вместо ndjson — сессия не выполняется, следить не за чем
            if (!res.headers.get('content-type')?.includes('ndjson')) break;
            attached = true;

            let progressed = false;
            const reader = res.body.getReader();
            for (;;) {
                let chunk;
                try { chunk = await reader.read(); } catch { break; }
                if (chunk.done) break;
                if (generation !== liveGeneration) { reader.cancel(); return; }
                progressed = true;
                scheduleRebuild();
            }
            if (abort.signal.aborted) return;
            failures = progressed ? 0 : failures + 1;
            await pause(300);
        }
        if (!attached) return;
        // поток закрылся — ход закончен, показываем итоговое состояние
        scheduleRebuild();
    }

    async function syncFromSession(sessionId) {
        const generation = ++liveGeneration;
        const flow = activeFlow();
        await rebuild(sessionId, flow, generation);
        watchLive(sessionId, flow, generation);
    }

    async function reloadList() {
        const { sessions = [] } = await App.api('/api/sessions');
        const current = select.value;
        select.innerHTML = '<option value="">Session…</option>';
        for (const s of sessions) {
            const option = document.createElement('option');
            option.value = s.id;
            option.textContent = s.title;
            select.append(option);
        }
        select.value = current;
        return sessions;
    }

    // список перечитывается при каждом открытии, чтобы не показывать устаревшее
    select.addEventListener('mousedown', reloadList);

    // при входе на страницу по умолчанию выбрана последняя созданная сессия
    // (createdOrder — порядок появления в БД; список отсортирован по updated_at,
    // поэтому первый элемент не годится), и канвас строится из её сообщений —
    // как если бы пользователь выбрал её в списке сам. Строим только после
    // события flow-ready (см. конец init в flow.js): раньше активный flow ещё
    // не восстановлен, и граф ушёл бы не в тот канвас. Подписка — до первого
    // await, чтобы не пропустить событие, пока грузится список сессий
    const flowReady = new Promise((resolve) => document.addEventListener('flow-ready', resolve, { once: true }));

    // построение меряет ноды и вписывает канвас в окно (autoLayoutAndFit), а у
    // скрытой вкладки все размеры нулевые и сохранился бы битый zoom/pan —
    // поэтому дожидаемся, пока #flowView действительно показан (tabs.js снимает hidden)
    function whenFlowViewVisible() {
        const view = document.getElementById('flowView');
        if (!view || !view.hidden) return Promise.resolve();
        return new Promise((resolve) => {
            const observer = new MutationObserver(() => {
                if (view.hidden) return;
                observer.disconnect();
                resolve();
            });
            observer.observe(view, { attributes: true, attributeFilter: ['hidden'] });
        });
    }

    // выбирает самую свежую сессию (createdOrder — порядок появления в БД,
    // список отсортирован по updated_at, поэтому первый элемент не годится)
    // и строит по ней канвас — как если бы пользователь выбрал её сам.
    // Общая для первого захода на страницу и для 'sessions-changed' ниже:
    // раньше это делалось только один раз при загрузке, и появившаяся уже
    // после этого новая сессия не попадала ни в список, ни на канвас
    async function followNewest(sessions) {
        if (!followingLatest || select.hidden || !sessions.length) return;
        const newest = sessions.reduce((a, s) => (s.createdOrder > a.createdOrder ? s : a));
        if (select.value === newest.id) return;
        select.value = newest.id;
        await flowReady;
        await whenFlowViewVisible();
        // пока ждали готовности канваса, следование могло выключиться (человек
        // успел выбрать сессию сам) или select — скрыться (см. «321» в flow-nav.js):
        // молча перестраивать чужой канвас нельзя
        if (!followingLatest || select.hidden || select.value !== newest.id) return;
        syncFromSession(newest.id);
    }

    (async () => {
        const sessions = await reloadList();
        await followNewest(sessions);
    })();
    select.addEventListener('change', () => {
        // ручной выбор в select — человек решил сам, дальше автослежение за
        // новыми сессиями (включая возврат на плейсхолдер) ему не указ
        followingLatest = false;
        if (select.value) syncFromSession(select.value);
        else liveGeneration += 1; // сброс на плейсхолдер — за прежней сессией больше не следим
    });

    // список сессий обновился где-то на странице (Chat опрашивает сервер раз
    // в 8с и шлёт это же событие сразу после своих действий — см. loadSessions
    // в PROJECTS/Sessions/sessions-panel.js). Раньше Flow это событие не слушал вовсе:
    // список слева и канвас не узнавали о новой сессии, пока её не открывали
    // тут вручную через mousedown на select
    document.body.addEventListener('sessions-changed', async () => {
        const sessions = await reloadList();
        await followNewest(sessions);
    });

    // переход на пункт меню, которому список сессий показывается: граф строится
    // заново прямо сейчас. Раньше это делалось один раз за загрузку страницы, и
    // канвас, открытый переключением пункта, оставался пустым до тех пор, пока
    // сессию не выберут в списке руками. Обработчик вешаем на #flowNav после
    // flow-nav.js — к этому моменту активный пункт уже сменился (см. setActiveFlow)
    document.getElementById('flowNav')?.addEventListener('click', (e) => {
        if (!e.target.closest('.side-nav__item') || e.target.closest('.side-nav__delete')) return;
        if (select.hidden || !select.value) return;
        syncFromSession(select.value);
    });

    // новый ход по выбранной сессии мог начаться позже построения графа
    // (например, из вкладки Chat) — по сигналу app.js (setRunningSessionId)
    // перечитываем сообщения и подключаемся к свежему потоку
    document.body.addEventListener('session-running-changed', (e) => {
        if (e.detail?.id && e.detail.id === select.value && !select.hidden) syncFromSession(select.value);
    });
})();
