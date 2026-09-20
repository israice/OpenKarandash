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
// jev-latest — рекомендованный докой алиас: отвечает текущая версия (jev-1.13.x)
const MODEL = 'jev-latest';

// суждение не должно задерживать ни ход, ни письмо в Telegram: типичный запрос
// укладывается в ~100 мс, всё, что дольше нескольких секунд, — уже сбой сети
const TIMEOUT_MS = 8000;
// 429 и 529 доку велит повторять с растущей паузой, остальные коды — окончательны
const RETRY_STATUS = new Set([429, 529]);
const RETRY_DELAYS_MS = [300, 900];

function apiKey() {
    return (process.env.TYPESAFE_API_KEY || '').trim();
}

// ключа нет — весь механизм выключен, и всё работает ровно как до него:
// в Telegram уходит каждый ход, подсказок к запросу нет, пометки в ленте нет
function isEnabled() {
    return Boolean(apiKey());
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// последняя неудача — её показывает Settings и видно в журнале сервера.
// Хранится строкой, а не выбрасывается: суждение необязательно, и падать
// из-за него ход не должен
let lastError = null;

function status() {
    return { enabled: isEnabled(), lastError };
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
                return await res.json();
            }
            // 401 — ключ, 422 — наши вопросы не прошли проверку: повторять нечего
            if (!RETRY_STATUS.has(res.status) || attempt >= RETRY_DELAYS_MS.length) {
                lastError = `HTTP ${res.status}`;
                return null;
            }
        } catch (err) {
            if (attempt >= RETRY_DELAYS_MS.length) {
                lastError = err.message;
                return null;
            }
        }
        await sleep(RETRY_DELAYS_MS[attempt]);
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
