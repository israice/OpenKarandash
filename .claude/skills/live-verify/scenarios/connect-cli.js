// Подключить CLI на сервере пользователя — то же, что кнопка Connect в Settings:
// /api/agent/detect (какие окружения найдены) и /api/agent/connect (выбрать одно из них).
// Возвращает версию, список моделей и какие из них бесплатные (для пробного хода).
//
// Параметры:
//   agent=<имя>     claude | opencode | pi | codex | hermes — ключи таблицы AGENTS в server.js (обязателен)
//   target=<id>     окружение (opencode-wsl, pi-windows, wsl ...); без него — первое найденное
//   detect=1        только показать найденные окружения, ничего не подключая
//
// Что сценарий меняет: connect переключает на сервере активное окружение этого агента — следующий
// ход пользователя этим агентом пойдёт через него, пока его страница не переподключит своё
// (она делает это сама при загрузке). Поэтому claude, если он уже подключён, сценарий не трогает:
// у него подключение ещё и переключает мост Hermes.
async function scenario(P) {
    const post = async (url, body) => (await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })).json();
    if (!P.agent) return { ok: false, error: 'Нужен параметр agent=claude|opencode|pi|codex|hermes' };

    if (P.agent === 'claude' && !P.detect) {
        const { claude } = await post('/api/agent/status');
        if (claude && (!P.target || P.target === claude.id)) return { ok: true, agent: 'claude', alreadyConnected: claude };
        if (claude) return { ok: false, error: `claude уже подключён как ${claude.id}; переключать его на ${P.target} сценарий не станет — это решение пользователя`, connected: claude };
    }

    const detected = await post('/api/agent/detect', { agent: P.agent });
    if (detected.ok === false) return { ok: false, error: detected.error };
    const installs = detected.installs || [];
    if (P.detect) return { ok: true, agent: P.agent, installs };
    if (!installs.length) return { ok: false, error: `Ни одного окружения ${P.agent} не найдено — CLI не установлен там, где его ищет сервер` };

    const target = P.target || installs[0].id;
    const result = await post('/api/agent/connect', { agent: P.agent, id: target });
    if (!result.ok) return { ok: false, error: result.error, installs };

    // бесплатные: у OpenRouter — суффикс «:free» и сборный роутер «…/free», у OpenCode — «…-free»
    // и opencode/big-pickle (им пробные ходы гоняли прошлые сессии)
    const models = result.models || [];
    const freeModels = models.filter((m) => /(:free|-free|\/free)$/i.test(m) || m === 'opencode/big-pickle');
    return { ok: true, agent: P.agent, connected: { id: result.id, label: result.label, version: result.version }, installs, models: models.length, freeModels };
}
