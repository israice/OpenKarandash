// ---------- блок размышления ----------

import { state } from './sessions-state.js';
import * as Scroll from './sessions-feed-scroll.js';
import { makeTag } from './sessions-feed-tag.js';

// Блок мыслей модели: в заголовке тег, в теле — все абзацы блока по порядку.
// Собирает его сервер (одна строка базы на блок, ctx.think в
// SYSTEM/core/run-turn.js), лента только рисует: текст приходит уже целиком,
// поэтому блок не растёт по кускам, а заменяется целиком. Гармошки здесь нет:
// блок открыт всегда (решение владельца, 2026-10-10), сворачивается только
// шаг инструмента.
let openThinking = null;

// тег блока мыслей — тот же, что имя инструмента у шага: он и называет блок,
// и стоит слева от текста, как имя инструмента у шага. Мысль
// субагента приходит с «↳ » в начале (renderStored в sessions-history.js так же
// помечает шаги вложенного хода) — у шага эта метка уезжает в тег, здесь тоже
const THINKING_TAG = 'thinking';

const NESTED = /^\u21b3\s+/;

// абзац мысли — кусок между пустыми строками, как их пишет модель. Тот же
// разрез делает и сервер, склеивая мысли блока через пустую строку, поэтому
// блок из базы и блок живого потока режутся одинаково
function thoughtParagraphs(text) {
    return String(text).split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean);
}

export function addThinking(text, before) {
    const stick = Scroll.isNearBottom();
    const nested = NESTED.test(text);
    const thoughts = thoughtParagraphs(nested ? text.replace(NESTED, '') : text);
    // блок из прошлой сессии или прошлого хода к списку не подключён: мысли
    // дописывать в него нельзя, следующая встанет своим блоком
    if (!openThinking?.isConnected) {
        // не <details>: складная гармошка здесь не нужна — блок открыт всегда
        // (решение владельца, 2026-10-10), поэтому голова и тело — обычные
        // слои, как у тела шага инструмента, а не строка переключателя
        const block = document.createElement('div');
        block.className = 'chat-message chat-message--thinking';

        // в голове только метка: прежняя строка предпросмотра жила за тем,
        // что тело было свёрнуто, а теперь тело видно целиком, и последний
        // абзац дублировался бы сразу в двух местах
        const head = document.createElement('div');
        head.className = 'chat-thinking-head';
        // у метки размышления свой белый цвет (chat-tag--thinking в
        // messages.css): она не действие, и серый оттенок был плохо виден.
        // Остальные теги остаются цветными по инструменту
        const tag = makeTag(nested ? `\u21b3 ${THINKING_TAG}` : THINKING_TAG, THINKING_TAG);
        tag.classList.add('chat-tag--thinking');
        head.append(tag);

        const body = document.createElement('div');
        body.className = 'chat-thinking-body';

        block.append(head, body);
        if (before && before.parentNode === state.list) state.list.insertBefore(block, before);
        else state.list.append(block);
        openThinking = block;
    }

    if (thoughts.length) {
        const body = openThinking.querySelector('.chat-thinking-body');
        body.replaceChildren(...thoughts.map((part) => {
            const paragraph = document.createElement('p');
            paragraph.className = 'chat-thinking-paragraph';
            paragraph.textContent = part;
            return paragraph;
        }));
    }

    if (stick) Scroll.scrollToBottom();
    return openThinking;
}

// Блок мыслей закончен: следующая мысль встанет своим блоком. Зовут его
// addStep (действие) и addMessage (ответ или реплика человека) — там мысли
// и заканчиваются по смыслу; сам блок остаётся в ленте открытом
export function closeThinking() {
    openThinking = null;
}

// Текст текущего блока мыслей целиком. Нужен потоку, который шлёт мысли
// кусками (событие delta, sessions-stream.js): первый его кусок должен
// дополнить уже собранный блок, а не заменить его своими двумя словами
export function thinkingText() {
    if (!openThinking?.isConnected) return '';
    return openThinking.querySelectorAll('.chat-thinking-paragraph')
        .map((paragraph) => paragraph.textContent).join('\n\n');
}
