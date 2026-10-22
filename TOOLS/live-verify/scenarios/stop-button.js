// Stop-кнопка у активной сессии: Send становится Stop, пока сессия идёт, —
// даже когда ход начался НЕ из этой вкладки (соседняя вкладка, Telegram, Flow).
// До правки 2026-10-22 кнопка знала только о ходе, начатом этой вкладкой:
// у чужого хода она оставалась Send, хотя сессия в списке горела оранжевым
// кругом. Жалоба владельца: «перестала отображаться кнопка стоп у каждой из
// сессий которая активна».
//
// Как проверяется: ход идёт через прямой вызов /api/agent/ask (тот же путь,
// что у соседней вкладки и у телеграм-моста), а вкладка открывает его через
// App.openSession(id, false) — то есть знает о ходе только по кругу в списке,
// ровно как живой человек, у которого сессия заработала сама.
//
// Параметры:
//   agent=<имя>     CLI для пробного хода (по умолчанию opencode)
//   model=<id>      модель; без неё — та, что выбрана у человека в интерфейсе
//   cleanup=1       удалить пробные сессии (заголовок с метки), ход не начиная
//
// Что сценарий меняет: заводит пробную сессию и короткий ход в ней; ход
// останавливает сам. Настоящие сессии человека не трогает.
async function scenario(P) {
    const MARK = '[live-verify]';
    const postJson = async (url, body) => (await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
    })).json();
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));

    if (P.cleanup) {
        const { sessions = [] } = await postJson('/api/sessions', {});
        const mine = sessions.filter((s) => String(s.title || '').startsWith(MARK));
        const deleted = [];
        for (const s of mine) deleted.push({ id: s.id, ...(s.running ? { ok: false, error: 'ещё идёт' } : await postJson('/api/sessions/delete', { id: s.id })) });
        return { ok: deleted.every((d) => d.ok), deleted };
    }

    MissionTabs.show('chat');
    await wait(500);

    const agent = P.agent || 'opencode';
    const model = P.model || (await App.getActiveModel?.()) || null;

    // ход начинаем не из вкладки: сервер должен помнить окружение, иначе ход
    // не пойдёт — после перезапуска сервера оно теряется
    const startTurn = async () => {
        const body = { agent, mode: 'Chat', prompt: `${MARK} Ответь одним словом: ок.`, ...(model ? { model } : {}) };
        const res = await fetch('/api/agent/ask', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let first = '';
        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            first += decoder.decode(value, { stream: true });
            if (first.includes('\n')) break;
        }
        const session = (first.match(/"type":"session","id":"([^"]+)"/) || [])[1] || null;
        if (session) return { session, error: null };
        if (!/is not connected/.test(first)) return { session: null, error: first.slice(0, 200) };
        reader.cancel().catch(() => {});
        // сервер забыл окружение после перезапуска — подключаем то же, что выбрано у человека
        const detected = await postJson('/api/agent/detect', { agent });
        const target = (detected.installs || [])[0]?.id;
        if (!target) return { session: null, error: `Окружение ${agent} не найдено` };
        const conn = await postJson('/api/agent/connect', { agent, id: target });
        if (!conn.ok) return { session: null, error: conn.error };
        return { session: null, error: 'подключили, повторите прогон' };
    };

    const started = await startTurn();
    if (!started.session) return { ok: false, error: started.error || 'Ход не начался' };
    const sid = started.session;

    // вкладка открывает сессию, не зная о ходе: так узнать о нём можно
    // только по кругу в списке
    await App.openSession(sid, false);
    await wait(1500);

    const send = () => document.querySelector('.chat-send');
    const before = { text: send()?.textContent, cls: send()?.className, viewed: App.getSessionId?.() };
    const circle = document.querySelector(`.session-item[data-session-id="${sid}"]`)?.className || '';

    // ждём обновления списка: сервер шлёт его сразу, как только ход начался
    let text = before.text;
    for (let i = 0; i < 20 && text !== 'Stop'; i++) {
        await wait(500);
        text = send()?.textContent;
    }

    const after = { text, cls: send()?.className };
    const stopped = await postJson('/api/agent/stop', { sessionId: sid });

    return {
        ok: after.text === 'Stop',
        session: sid,
        before, after, circle,
        stopped: stopped?.ok !== false,
        note: 'кнопка Stop должна появиться по кругу в списке, а не по памяти вкладки',
    };
}
