// Чтение потока хода: NDJSON по строке и досматривание уже идущей работы.
//
// Ответ /api/agent/ask приходит потоком — по событию в строке. Этот файл
// умеет только читать его и переживать обрывы связи; что делать с событиями
// решает вызывающий (makeRenderer в sessions-stream.js). Формат событий общий
// для всех CLI (session|tool|delta|text|context|error|done), поэтому провайдеры
// здесь не различаются.
import { state } from './sessions-state.js';
import { api } from '../../SYSTEM/app.js';

export async function readNdjson(res, onEvent) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let tail = '';

    for (;;) {
        const { value, done } = await reader.read();
        if (done) break;

        tail += decoder.decode(value, { stream: true });
        const lines = tail.split('\n');
        tail = lines.pop(); // последняя строка может быть неполной — ждём следующую

        for (const line of lines) {
            if (line.trim()) onEvent(JSON.parse(line));
        }
    }
}

// Маршрут один на всех: какой CLI звать, сервер берёт из поля agent в теле
export async function streamAsk(body, onEvent) {
    const res = await fetch('/api/agent/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    await readNdjson(res, onEvent);
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Сколько раз подряд переподключаемся, не получив ни одного события: сервер
// перезапускается секунды, а не минуты — дольше ждать живого потока незачем,
// итог всё равно покажет перечитывание базы
const ATTACH_RETRIES = 8;

// Досматривает идущий ход до конца, переживая обрывы связи. after — номер
// (seq) последнего события, которое лента уже показала: сервер досылает из
// буфера хода всё, что было после него, поэтому ни пропусков, ни повторов
// (DOCS/decisions/046). Закрытие потока ещё не конец хода — конец это обычный
// JSON вместо ndjson. onAttached зовётся один раз, при первом живом потоке;
// без него вернётся false
export async function followRun(id, after, onEvent, onAttached) {
    let attached = false;
    let failures = 0;

    while (failures < ATTACH_RETRIES) {
        let res;
        try {
            res = await fetch('/api/sessions/attach', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                // deltas — просим ещё и куски текста по мере набора
                body: JSON.stringify({ id, after, deltas: true }),
            });
        } catch {
            failures += 1;
            await sleep(1500);
            continue;
        }

        // поток идёт с типом application/x-ndjson; обычный JSON означает, что
        // работа уже закончилась и подключаться не к чему
        if (!res.headers.get('content-type')?.includes('ndjson')) return attached;
        if (!attached) { attached = true; onAttached?.(); }

        let progressed = false;
        try {
            await readNdjson(res, (event) => {
                if (typeof event.seq === 'number') {
                    if (after != null && event.seq <= after) return; // уже показано
                    after = event.seq;
                }
                progressed = true;
                onEvent(event);
            });
        } catch { /* связь оборвалась посреди чтения — переподключаемся ниже */ }

        failures = progressed ? 0 : failures + 1;
        await sleep(300);
    }
    return attached;
}

// Останавливает CLI-процесс на сервере; поток сам закроется событием
// error/done. Очередь и запущенные процессы общие на все CLI, поэтому маршрут
// один и провайдера указывать не нужно
export function stopTurn() {
    api('/api/agent/stop', { sessionId: state.sessionId });
}