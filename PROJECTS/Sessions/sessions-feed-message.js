// Реплика ленты: ответ модели, реплика человека, строка ошибки хода.
//
// Отдельный файл: реплику рисуют и поток (sessions-stream.js), и история из
// базы (sessions-history.js), и она — единственное место, где ответ
// превращается в HTML (markdown). Шаг инструмента и блок мыслей репликами не
// являются: у них своя форма, и живут они в своих файлах.
//
// Файл вернулся на своё место после того, как лента разложена по темам: при
// разложении реплика потерялась, а её импортировали двое (поток и история) —
// вкладка Sessions перестала грузиться целиком (DOCS/decisions/123).
import { state } from './sessions-state.js';
import { renderMarkdown } from './sessions-feed-markdown.js';
import { closeThinking } from './sessions-feed-thinking.js';
import { isNearBottom, scrollToBottom } from './sessions-feed-scroll.js';

// Реплика ленты. model — та модель, которая дала этот ответ: у строки из базы
// своё поле (message.model), у ответа, который сейчас стримится, — выбор в
// шапке сессии. Подпись рисуется только у ответа модели: реплике человека и
// служебным строкам она не нужна, и там model не передаётся вовсе.
// before — вставить перед этой строкой, а не в конец: так ответ встаёт выше
// строки ожидания, которая остаётся последней
export function addMessage(text, kind, model, before, cli) {
    // ответ или реплика человека закрывают блок мыслей
    closeThinking();
    const stick = isNearBottom();

    // куда встаёт строка: перед заданным узлом, а тот — в конец
    const place = (node) => {
        if (before && before.parentNode === state.list) state.list.insertBefore(node, before);
        else state.list.append(node);
    };

    const message = document.createElement('div');
    message.className = `chat-message chat-message--${kind}`;
    if (kind === 'assistant' && text) message.innerHTML = renderMarkdown(text);
    else message.textContent = text;

    // плашка модели — первой строкой внутри пузыря ответа, слева над текстом:
    // та же подпись, что в заголовке карточки Feed и на ноде Flow
    // (SYSTEM/model-tag.js, DOCS/decisions/039). Внутри пузыря, а не над ним:
    // своего тона у неё нет, плашка на фоне ленты читалась как отдельная
    // строка переписки. Без модели у ответа её не бывает — звать с пустым
    // значением незачем
    const tag = window.ModelTag?.tag(model, cli);
    if (tag) message.prepend(tag);

    place(message);

    if (stick) scrollToBottom();
    return message;
}
