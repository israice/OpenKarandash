// Клиент TypeSafe System One (модель Jev) — ничья обвязка, как http.js и scan.js.
//
// Это не ещё один агент: System One ничего не генерирует и не выбирает себе
// следующий шаг. Он отвечает на заданные вопросы типизированно — вероятность
// «да» (noul), один вариант из нашего списка (choice), позиция на описанной
// шкале (score). Поток по-прежнему держит код, модель даёт только суждение
// там, где иначе пришлось бы гадать регулярками (docs.typesafe.ai,
// «how to build with System One», DOCS/decisions/051).
//
// Сами вопросы и пороги живут не здесь, а одним местом в turn-judgment.js —
// так их можно прочитать и подправить, не разбираясь в транспорте.

const API_URL = 'https://api.typesafe.ai/v1/systemone';
// Версия закреплена, а не алиас `jev-latest`, и это прямое указание доки
// (страница Models, «Aliases»): алиас переезжает на новый выпуск сам, а
// пороги в turn-judgment.js подогнаны на нашем материале именно под эту
// версию — переехав, они молча перестали бы значить то же самое. На новую
// версию переходим сами, перемерив пороги. Какая версия ответила на деле,
// всё равно пишется в строку хода: ответ несёт своё поле model
const MODEL = 'jev-1.13.0';

// суждение не должно задерживать ни ход, ни письмо в Telegram: типичный запрос
// укладывается в ~100 мс, всё, что дольше нескольких секунд, — уже сбой сети
const TIMEOUT_MS = 8000;
// 429 и 529 доку велит повторять с растущей паузой, остальные коды — окончательны
const RETRY_STATUS = new Set([429, 529]);
const RETRY_DELAYS_MS = [300, 900];
// сколько ждать по просьбе самого сервиса: заголовок retry-after сильнее нашей
// лесенки — он знает про свои лимиты то, чего не знаем мы. Ограничиваем сверху,
// чтобы ход не завис из-за чужого «приходите через минуту»
const RETRY_AFTER_CAP_MS = 5000;

// заголовок бывает в секундах и датой — доку интересует только первое, но
// разобрать второе дешевле, чем потом гадать, почему повтор ушёл сразу
function retryAfterMs(res) {
    const raw = res.headers.get('retry-after');
    if (!raw) return null;
    const seconds = Number(raw);
    const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(raw) - Date.now();
    if (!Number.isFinite(ms) || ms <= 0) return null;
    return Math.min(ms, RETRY_AFTER_CAP_MS);
}

// Ключ берём из окружения, а если его там нет — один раз из .env. Второе нужно
// не серверу (он .env читает сам при старте), а скриптам из терминала:
// PROJECTS/Graph/search.js работает и без запущенного сервера, и без этого
// поиск из терминала молча оставался бы без осмысленной расстановки
let envKey;
function apiKey() {
    const fromEnv = (process.env.TYPESAFE_API_KEY || '').trim();
    if (fromEnv) return fromEnv;
    if (envKey === undefined) {
        try {
            const file = require('fs').readFileSync(require('path').join(__dirname, '..', '..', '.env'), 'utf8');
            envKey = (file.match(/^TYPESAFE_API_KEY=(.*)$/m)?.[1] || '').trim().replace(/^["']|["']$/g, '');
        } catch {
            envKey = '';
        }
    }
    return envKey;
}

// ключа нет — весь механизм выключен, и всё работает ровно как до него:
// в Telegram уходит каждый ход, подсказок к запросу нет, пометки в ленте нет
function isEnabled() {
    return Boolean(apiKey());
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// Счётчики и последняя неудача. Нужны затем, что сбой здесь ничего не ломает
// и потому ничем себя не выдаёт: кончился ключ или лёг сервис — суждений
// просто не станет, телеграм снова завалит владельца каждой репликой, записки
// перестанут подкладываться, а пометки исчезнут из ленты. Узнать об этом по
// симптомам можно через неделю, поэтому состояние показывает панель
// наблюдения на Home (PROJECTS/Home/home-observation.eta)
let lastError = null;
let okCount = 0;
let failCount = 0;
let lastAt = null;
// входящие токены с последнего запуска сервера: выход не тарифицируется,
// поэтому считать его незачем. Постоянного хранения расход не стоит —
// он копеечный, и важен только порядок величины
let inputTokens = 0;

function status() {
    return {
        enabled: isEnabled(),
        ok: okCount,
        failed: failCount,
        lastError,
        lastAt,
        inputTokens,
        // «работает», «ни одного запроса ещё не было», «последний не прошёл»:
        // решает сервер, а не шаблон — то же состояние понадобится и в другом месте
        health: !isEnabled() ? 'off' : (lastError ? 'error' : (okCount ? 'ok' : 'idle')),
    };
}

// Один запрос со всеми вопросами сразу: независимые вопросы считаются
// параллельно на стороне TypeSafe и не видят ответов друг друга, поэтому
// дробить их на несколько запросов — только терять время и токены.
//
// Возвращает { answers, usage, model } либо null: сбой сети, отсутствие ключа
// и любая ошибка сервиса означают «суждения нет», а не «ход не удался».
async function systemOne(state, questions) {
    const key = apiKey();
    if (!key || !questions || !Object.keys(questions).length) return null;

    const body = JSON.stringify({ model: MODEL, state, questions });
    let wait = null;
    for (let attempt = 0; ; attempt += 1) {
        try {
            const res = await fetch(API_URL, {
                method: 'POST',
                headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
                body,
                signal: AbortSignal.timeout(TIMEOUT_MS),
            });
            if (res.ok) {
                lastError = null;
                okCount += 1;
                lastAt = new Date().toISOString();
                const data = await res.json();
                inputTokens += data?.usage?.input_tokens || 0;
                return data;
            }
            // 401 — ключ, 422 — наши вопросы не прошли проверку: повторять нечего
            if (!RETRY_STATUS.has(res.status) || attempt >= RETRY_DELAYS_MS.length) {
                lastError = `HTTP ${res.status}`;
                failCount += 1;
                lastAt = new Date().toISOString();
                return null;
            }
            wait = retryAfterMs(res);
        } catch (err) {
            if (attempt >= RETRY_DELAYS_MS.length) {
                lastError = err.message;
                failCount += 1;
                lastAt = new Date().toISOString();
                return null;
            }
            wait = null; // сети не было — заголовка тоже
        }
        await sleep(wait ?? RETRY_DELAYS_MS[attempt]);
    }
}

// разбор ответов с оглядкой на тип: поле у каждого примитива своё, и путать их
// нельзя — у noul нет confidence вовсе, а score возвращает дробную позицию
function noul(answers, id) {
    const a = answers?.[id];
    return a && typeof a.noul === 'number' ? a.noul : null;
}

function choice(answers, id) {
    const a = answers?.[id];
    if (!a || typeof a.choice !== 'string') return null;
    return { value: a.choice, confidence: typeof a.confidence === 'number' ? a.confidence : null };
}

function score(answers, id) {
    const a = answers?.[id];
    if (!a || typeof a.score !== 'number') return null;
    return { value: a.score, confidence: typeof a.confidence === 'number' ? a.confidence : null };
}

module.exports = { isEnabled, status, systemOne, noul, choice, score, MODEL };
