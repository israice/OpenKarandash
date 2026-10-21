// ---------- шаги инструментов ----------

import { state } from './sessions-state.js';
import { buildStepBody } from './sessions-details.js';
import * as Scroll from './sessions-feed-scroll.js';
import { closeThinking } from './sessions-feed-thinking.js';
import { makeTag } from './sessions-feed-tag.js';

// шаги сворачиваются гармошкой: открыт может быть только один — клик по
// свёрнутому открывает его и закрывает ранее открытый, клик по открытому
// сворачивает обратно
export function setStepOpen(step, open) {
    if (open) {
        const prevOpen = state.list.querySelector('.chat-message--tool.is-open');
        if (prevOpen && prevOpen !== step) prevOpen.classList.remove('is-open');
        step.classList.add('is-open');
    } else {
        step.classList.remove('is-open');
    }
}

// Строка шага: что агент сделал (Read index.html, Bash npm test).
// text приходит уже склеенным «имя деталь» (toolLabel на сервере) — имя
// инструмента выделяем цветным тегом, разбирая первое слово.
// row — строка сессии целиком: из неё тело гармошки (если есть)
export function addStep(text, before, row) {
    // действие закрывает блок мыслей: дальше модель думает уже о новом шаге
    closeThinking();
    const stick = Scroll.isNearBottom();
    const step = document.createElement('div');
    step.className = 'chat-message chat-message--tool';

    const head = document.createElement('div');
    head.className = 'chat-tool-head';
    const match = String(text).match(/^(\S+)(\s+([\s\S]*))?$/);
    if (match) {
        head.append(makeTag(match[1]));
        if (match[3]) head.append(document.createTextNode(` ${match[3]}`));
    } else {
        head.textContent = text;
    }
    step.append(head);

    // У шагов без тела клика нет: у живого потока до перечитывания истории нет
    // сырых args/result, открывать нечего, и курсор должен остаться обычным
    if (row) {
        const body = buildStepBody(row);
        if (body.children.length) {
            step.append(body);
            step.addEventListener('click', () => setStepOpen(step, !step.classList.contains('is-open')));
        } else {
            step.classList.add('chat-message--tool-plain');
        }
    } else {
        step.classList.add('chat-message--tool-plain');
    }

    if (before && before.parentNode === state.list) state.list.insertBefore(step, before);
    else state.list.append(step);
    if (stick) Scroll.scrollToBottom();
    return step;
}
