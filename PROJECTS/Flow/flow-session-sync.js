// Выпадающий список сессий слева в тулбаре Flow (см. #flowSessionSelect в SYSTEM/index.html):
// строит граф нод текущего канваса из сообщений выбранной сессии (SYSTEM/app.js). Сама
// сборка (белый текст — цепочка вправо, серый текст шагов — цепочка вниз под ним)
// живёт в PROJECTS/Flow/flow.js, здесь сбор данных и вызов MissionFlow.buildFromSession,
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

    async function rebuild(sessionId, flow, generation) {
        const { messages = [] } = await App.api('/api/sessions/messages', { id: sessionId });
        if (generation !== liveGeneration) return;
        MissionFlow.buildFromSession(flow, messages);
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
        let res;
        try {
            res = await fetch('/api/sessions/attach', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: sessionId }),
                signal: abort.signal,
            });
        } catch { return; }
        // обычный JSON вместо ndjson — сессия не выполняется, следить не за чем
        if (!res.headers.get('content-type')?.includes('ndjson')) return;

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

        const reader = res.body.getReader();
        for (;;) {
            let chunk;
            try { chunk = await reader.read(); } catch { break; }
            if (chunk.done) break;
            if (generation !== liveGeneration) { reader.cancel(); return; }
            scheduleRebuild();
        }
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

    (async () => {
        const sessions = await reloadList();
        if (select.value || !sessions.length) return;
        const newest = sessions.reduce((a, s) => (s.createdOrder > a.createdOrder ? s : a));
        select.value = newest.id;
        await flowReady;
        await whenFlowViewVisible();
        // select скрыт — активен flow, которому список сессий не показывается
        // (см. «321» в flow.js): молча перестраивать его канвас нельзя.
        // Если пользователь успел выбрать сессию сам — его выбор главнее
        if (select.hidden || select.value !== newest.id) return;
        syncFromSession(newest.id);
    })();
    select.addEventListener('change', () => {
        if (select.value) syncFromSession(select.value);
        else liveGeneration += 1; // сброс на плейсхолдер — за прежней сессией больше не следим
    });

    // новый ход по выбранной сессии мог начаться позже построения графа
    // (например, из вкладки Chat) — по сигналу app.js (setRunningSessionId)
    // перечитываем сообщения и подключаемся к свежему потоку
    document.body.addEventListener('session-running-changed', (e) => {
        if (e.detail?.id && e.detail.id === select.value && !select.hidden) syncFromSession(select.value);
    });
})();
