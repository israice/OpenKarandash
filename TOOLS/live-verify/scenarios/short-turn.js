// Короткий настоящий ход на сервере пользователя: /api/agent/ask, поток NDJSON до конца, затем
// сверка показанного вживую с тем, что легло в базу (/api/sessions/messages). Каждому живому
// tool / thinking / text должна отвечать строка; потеря здесь — потеря в Sessions, Feed и Flow.
//
// Параметры:
//   agent=<имя>     opencode (по умолчанию) — агент с бесплатными моделями
//   target=<id>     окружение для connect; без него — первое найденное (см. connect-cli.js)
//   model=<id>      модель; без неё — первая бесплатная из ответа connect
//   prompt=<текст>  что спросить; к началу дописывается метка, по ней же работает уборка
//   mode=Chat|Action  по умолчанию Chat; у OpenCode это режим
//                   инструментов НЕ ограничивает (SYSTEM/cli/opencode.js, ask): там
//                   безвредность хода держится на самом вопросе — не проси ничего править
//   session=<id>    продолжить существующую сессию вместо новой
//   timeout=<сек>   сколько ждать ход (по умолчанию 240); вышло — ход останавливается /api/agent/stop
//   paid=1          разрешить модель без признака free (и ход агентом, у которого
//                   бесплатных моделей нет) — только когда проверяется именно этот
//                   путь и дешевле его не вызвать
//   cleanup=1       хода не начинать: удалить пробные сессии (заголовок с метки), кроме идущих
//
// Результат: id сессии — с ним дальше three-views.js session=<id>, а в конце cleanup=1.
//
// Что сценарий меняет: заводит сессию (видна пользователю в списке, пока её не уберёт cleanup=1);
// без model= зовёт /api/agent/connect и этим переключает активное окружение агента на сервере
// (см. connect-cli.js); ответ завершившегося хода сервер шлёт пользователю в Telegram, если мост
// настроен (notifyTurnFinished в SYSTEM/core/run-turn.js) — поэтому ход один и короткий, не пачкой.
async function scenario(P) {
    const MARK = '[live-verify]';
    const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    const postJson = async (url, body) => (await post(url, body)).json();
    const isFree = (m) => /(:free|-free|\/free)$/i.test(m) || m === 'opencode/big-pickle';

    if (P.cleanup) {
        const { sessions = [] } = await postJson('/api/sessions');
        const mine = sessions.filter((s) => String(s.title || '').startsWith(MARK));
        const deleted = [];
        for (const s of mine) deleted.push({ id: s.id, ...(s.running ? { ok: false, error: 'ещё идёт' } : await postJson('/api/sessions/delete', { id: s.id })) });
        return { ok: deleted.every((d) => d.ok), deleted };
    }

    const agent = P.agent || 'opencode';
    const paid = P.paid === '1';
    if (agent !== 'opencode' && !paid) {
        return { ok: false, error: `Пробный ход — только OpenCode или бесплатной моделью. agent=${agent} тратит деньги пользователя: paid=1, если проверяется именно этот путь` };
    }

    // connect нужен ради списка моделей; с готовой моделью сначала пробуем без него —
    // так не переключается окружение, которое выбрал пользователь
    let model = P.model || null;
    let connected = null;
    const connect = async () => {
        let target = P.target;
        if (!target) target = ((await postJson('/api/agent/detect', { agent })).installs || [])[0]?.id;
        if (!target) return { ok: false, error: `Окружение ${agent} не найдено` };
        const result = await postJson('/api/agent/connect', { agent, id: target });
        if (result.ok) connected = { id: result.id, version: result.version };
        return result;
    };
    if (!model && agent === 'opencode') {
        const result = await connect();
        if (!result.ok) return { ok: false, error: result.error };
        model = (result.models || []).find(isFree) || null;
        if (!model) return { ok: false, error: 'Бесплатной модели в списке нет', connected, models: (result.models || []).slice(0, 20) };
    }
    if (model && !isFree(model) && !paid) return { ok: false, error: `Модель ${model} не похожа на бесплатную; paid=1, если это намеренно` };

    const prompt = `${MARK} ${P.prompt || 'Ответь одним словом: ок. Ничего не читай и не запускай.'}`;
    const request = { agent, mode: P.mode || 'Chat', prompt, ...(model ? { model } : {}), ...(P.session ? { sessionId: P.session } : {}) };

    // один ход: читаем поток построчно и считаем виды событий
    const turn = async () => {
        const live = { types: {}, errors: [], notices: [], answer: '' };
        const started = Date.now();
        const deadline = new Promise((resolve) => setTimeout(() => resolve('timeout'), (Number(P.timeout) || 240) * 1000));
        const res = await post('/api/agent/ask', request);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let tail = '';
        for (;;) {
            const chunk = await Promise.race([reader.read(), deadline]);
            if (chunk === 'timeout') {
                // молчащий ход на сервере пользователя не бросаем — останавливаем
                live.timedOut = true;
                if (live.sid) await postJson('/api/agent/stop', { sessionId: live.sid });
                reader.cancel().catch(() => {});
                break;
            }
            const { done, value } = chunk;
            if (done) break;
            tail += decoder.decode(value, { stream: true });
            const lines = tail.split('\n');
            tail = lines.pop();
            for (const line of lines) {
                if (!line.trim()) continue;
                const event = JSON.parse(line);
                live.types[event.type] = (live.types[event.type] || 0) + 1;
                if (event.type === 'session') live.sid = event.id;
                if (event.type === 'error') live.errors.push(event.error);
                if (event.type === 'notice') live.notices.push(`${event.name}: ${event.text}`.slice(0, 200));
                if (event.type === 'text') live.answer = String(event.text || '');
                if (event.type === 'done' && event.text) live.answer = String(event.text);
            }
        }
        live.seconds = Math.round((Date.now() - started) / 1000);
        return live;
    };

    let live = await turn();
    // сервер теряет выбранное окружение при перезапуске: подключаем и пробуем ещё раз
    if (!live.sid && !connected && ['opencode', 'pi'].includes(agent) && live.errors.some((e) => /not connected/i.test(e))) {
        const result = await connect();
        if (!result.ok) return { ok: false, error: result.error };
        live = await turn();
    }
    if (!live.sid) return { ok: false, error: 'Ход не начался', request: { ...request, prompt: undefined }, live };

    const db = (await postJson('/api/sessions/messages', { id: live.sid })).messages || [];
    const roles = db.reduce((acc, m) => { acc[m.role] = (acc[m.role] || 0) + 1; return acc; }, {});
    // живые события против строк базы; продолженная сессия несёт строки прошлых ходов, поэтому «не меньше»
    const missingInDb = [['tool', 'tool'], ['thinking', 'thinking'], ['text', 'assistant']]
        .filter(([type, role]) => (live.types[type] || 0) > (roles[role] || 0))
        .map(([type, role]) => `${type}: вживую ${live.types[type]}, в базе строк ${role} ${roles[role] || 0}`);

    return {
        ok: !live.errors.length && !live.timedOut && Boolean(live.answer) && !missingInDb.length,
        session: live.sid, agent, model, mode: request.mode, connected,
        live: { ...live, answer: live.answer.slice(0, 300) },
        db: { rows: db.length, roles },
        missingInDb,
    };
}
