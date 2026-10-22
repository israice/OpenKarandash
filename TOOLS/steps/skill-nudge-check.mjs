// Самопроверка гейтов skill-nudge (порожние пути, без сети): послеходовой
// досмотр должен молчать на каждом не-конце работы. Полный путь с реальным
// ответом jev проверяется живым ходом на сервере владельца (DOCS/decisions/002).
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { reviewTurn, nudgeTrace, worthReviewing } = require('../../SYSTEM/core/skill-nudge.js');

const assert = (name, cond) => {
    if (!cond) { console.error(`FAIL ${name}`); process.exitCode = 1; return; }
    console.log(`ok ${name}`);
};

assert('no judgment -> not worth', !worthReviewing(null));
assert('final report below threshold -> not worth', !worthReviewing({ finalReport: 0.5 }));
assert('final report at threshold -> worth', worthReviewing({ finalReport: 0.6 }));
assert('work done at threshold -> worth', worthReviewing({ finalReport: 0, workDone: 0.8 }));

const done = { finalReport: 0.9 };
const few = (label, tag, args) => reviewTurn({ judgment: done, agent: 'pi-windows', profile: '', ...args })
    .then((r) => assert(`${label}${tag}`, r === null));

(async () => {
    // защита от ключа не нужна: ключ в .env есть, но check не должен ходить в
    // сеть — все отсюда ветки выходят раньше systemOne
    await few('short answer', 'short', { answer: 'ok' });
    await few('no answer', 'empty', { answer: '' });
    // ход с оценкой выше порога и нормальным ответом уйдёт в сеть — этот случай
    // здесь не прогоняем; порог и форма вопроса курируются живыми ходами
    const t = nudgeTrace({ noul: 0.8, profile: 'Backend developer' });
    assert('trace shape', t && t.noul === 0.8 && t.profile === 'Backend developer');
    assert('trace null', nudgeTrace(null) === null);
})().catch((err) => { console.error(`FAIL uncaught: ${err.message}`); process.exitCode = 1; });
