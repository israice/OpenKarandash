// Живая часть ленты Feed: загрузка снимка, досматривание потока NDJSON
// (/api/sessions/attach, тот же, что у ленты Chat) и догрузка изменившихся
// карточек. Отдельный файл потому, что это работа с сетью и с временем жизни
// подписки, а не разбор события и не рисование: правка того, как часто
// перечитывается лента, не должна трогать ни разбор ролей, ни сборку страницы.
// Номер подписки (liveGeneration) и её AbortController живут здесь же — иначе
// отмена подписки при пересборке страницы была бы в другом файле.
export function createFeedLive({ messages, empty, resetFeed, applyFeed }) {
    // номер текущей подписки: выбор другой сессии делает и прежний поток,
    // и отложенные обновления устаревшими — они молча прекращаются
    // (тот же приём, что в PROJECTS/Flow/flow-session-sync.js)
    let liveGeneration = 0;
    let liveAbort = null;

    function atBottom() {
        return messages.scrollHeight - messages.scrollTop - messages.clientHeight < 40;
    }

    async function fetchFeed(id, generation) {
        let response;
        try {
            response = await App.api('/api/sessions/messages', { id });
        } catch {
            return null;
        }
        return generation === liveGeneration ? response : null;
    }

    async function loadFeed(id) {
        liveGeneration += 1;
        liveAbort?.abort();
        liveAbort = null;
        const generation = liveGeneration;

        resetFeed();
        empty.hidden = true;
        if (!id) {
            empty.textContent = 'Select a session from the list above';
            empty.hidden = false;
            return;
        }
        const response = await fetchFeed(id, generation);
        if (generation !== liveGeneration) return;
        if (!response) {
            empty.textContent = 'Failed to load the session';
            empty.hidden = false;
            return;
        }
        applyFeed(response);
        // после отрисовки — сразу вниз, к последним сообщениям
        messages.scrollTop = messages.scrollHeight;
        requestAnimationFrame(() => { messages.scrollTop = messages.scrollHeight; });
        watchLive(id, generation);
    }

    async function refreshFeed(id, generation) {
        const stick = atBottom();
        const response = await fetchFeed(id, generation);
        if (!response || generation !== liveGeneration) return;
        applyFeed(response);
        // доскроллить вниз только если пользователь и так стоял внизу: иначе
        // живое обновление выдёргивало бы его из места, которое он читает
        if (stick) messages.scrollTop = messages.scrollHeight;
    }

    // ход по выбранной сессии мог начаться позже загрузки ленты (например,
    // из вкладки Chat) — по сигналу app.js (setRunningSessionId) подключаемся
    // к свежему потоку и дочитываем то, что уже успело появиться
    function subscribeRunning(id) {
        liveGeneration += 1;
        const generation = liveGeneration;
        refreshFeed(id, generation);
        watchLive(id, generation);
    }

    // слушатель на body снимется сам по signal, а вот поток ленты живёт своей
    // жизнью в watchLive — обрываем его тем же сигналом
    function abortLive() {
        liveAbort?.abort();
    }

    // если сессия сейчас выполняется, сервер отдаёт её поток NDJSON — тот же
    // /api/sessions/attach, которым лента Chat досматривает идущую работу
    // (см. attachSession в SYSTEM/app.js). Содержимое событий не разбираем:
    // карточки всё равно строятся из /api/sessions/messages, событие — лишь
    // сигнал, что там появилось новое, поэтому дозагружаем не чаще раза в секунду
    async function watchLive(id, generation) {
        liveAbort?.abort();
        const abort = new AbortController();
        liveAbort = abort;
        let scheduled = false;
        const scheduleRefresh = () => {
            if (scheduled) return;
            scheduled = true;
            setTimeout(() => {
                scheduled = false;
                if (generation !== liveGeneration) return;
                refreshFeed(id, generation);
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
                    body: JSON.stringify({ id }),
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
                scheduleRefresh();
            }
            if (abort.signal.aborted) return;
            failures = progressed ? 0 : failures + 1;
            await pause(300);
        }
        if (!attached) return;
        // поток закрылся — ход закончен, показываем итоговое состояние
        scheduleRefresh();
    }

    return { loadFeed, subscribeRunning, abortLive };
}