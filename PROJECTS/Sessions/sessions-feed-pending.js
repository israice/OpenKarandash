// ---------- строка ожидания ----------

import { state } from './sessions-state.js';
import { addMessage } from './sessions-feed-message.js';
import { scrollToBottom } from './sessions-feed-scroll.js';

const PENDING_HTML = '<span class="chat-typing"><span></span><span></span><span></span></span>'
    + '<span class="chat-pending-note"></span>';

// Часы ожидания на строке с точками. Между шагами агент молчит десятки секунд,
// и без счётчика живая работа неотличима от оборванной: человек не знает,
// ждать или подтолкнуть
export function formatWait(seconds) {
    if (seconds < 60) return `${seconds} с`;
    return `${Math.floor(seconds / 60)} мин ${String(seconds % 60).padStart(2, '0')} с`;
}

function stopPendingClock(status) {
    if (status?.__pendingTimer) {
        clearInterval(status.__pendingTimer);
        status.__pendingTimer = null;
    }
}

function startPendingClock(status) {
    stopPendingClock(status);

    let note = status.querySelector('.chat-pending-note');
    if (!note) {
        note = document.createElement('span');
        note.className = 'chat-pending-note';
        status.append(note);
    }

    const started = Date.now();
    const tick = () => {
        const seconds = Math.round((Date.now() - started) / 1000);
        // первые секунды не подписываем: короткий шаг не должен мигать цифрой
        note.textContent = seconds < 3 ? '' : `думает ${formatWait(seconds)}`;
    };
    tick();
    status.__pendingTimer = setInterval(tick, 1000);
}

// Строка ожидания с тремя точками — она же показывает текущий шаг. Если
// строка уже есть (её мог завести syncPending по оранжевому кругу раньше, чем
// подключился поток), переиспользуем её, а не заводим вторую: переносим в
// конец ленты и показываем
export function addPending() {
    const existing = state.list.querySelector('.chat-message--pending');
    if (existing) {
        existing.hidden = false;
        state.list.append(existing);
        startPendingClock(existing);
        return existing;
    }

    // строка ожидания — это реплика ленты (addMessage): тот же пузырь, те же
    // классы, что у ответа модели. Свою разметку здесь заводить нельзя: без
    // класса chat-message--assistant строка ожидания теряет рамку и фон
    // (SYSTEM/styles/messages.css) и выглядит как чужеродный обрывок
    const status = addMessage('', 'assistant');
    status.classList.add('chat-message--pending');
    status.innerHTML = PENDING_HTML;
    startPendingClock(status);
    return status;
}

// шаг выполнен — ожидание началось заново, счётчик считает паузу до
// следующего действия, а не всё время хода
export function markPendingActivity(status) {
    if (status?.isConnected) startPendingClock(status);
}

// Снять строку ожидания вместе с её часами: без этого таймер продолжал бы
// тикать на выброшенном узле до конца жизни страницы
export function removePending(status) {
    stopPendingClock(status);
    status?.remove();
}

// Плашка «ход прерван» с кнопкой продолжения.
//
// Ход может кончиться ничьей: сервер погасили посреди работы, запрос отменили,
//_agent ответил так, что ответ не удалось разобрать. В ленте это выглядело
// просто как оборванный список шагов — непонятно, ждать или подтолкнуть.
// Теперь видно прямо, и продолжение — одно нажатие вместо ручного «продолжай»
export function addInterrupted(onContinue) {
    const notice = addMessage('', 'assistant');
    notice.classList.add('chat-message--interrupted');

    const text = document.createElement('span');
    text.textContent = 'Ход прерван, не доведён до ответа.';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'chat-continue';
    button.textContent = 'Продолжить';
    button.addEventListener('click', () => {
        notice.remove();
        onContinue();
    });

    notice.append(text, button);
    scrollToBottom();
    return notice;
}
