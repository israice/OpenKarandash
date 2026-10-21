// ---------- промпт хода ----------

import { state } from './sessions-state.js';
import * as Scroll from './sessions-feed-scroll.js';
import { makeTag } from './sessions-feed-tag.js';

export function addInput(text, before) {
    const stick = Scroll.isNearBottom();
    const block = document.createElement('details');
    block.className = 'chat-message chat-message--input';

    const head = document.createElement('summary');
    head.className = 'chat-input-head';
    const tag = makeTag('prompt', 'prompt');
    tag.classList.add('chat-tag--muted');
    const preview = document.createElement('span');
    preview.className = 'chat-prompt-preview';
    const body = document.createElement('div');
    body.className = 'chat-input-body';
    block.append(head, body);
    head.append(tag, document.createTextNode(' '), preview);

    // первые строки — заголовок блока в тексте промпта ([OpenKarandash] …),
    // по ним видно, что преамбула есть; тело промпта достаётся целиком
    const lines = String(text || '').split('\n');
    const first = (lines.find((line) => line.trim()) || '').trim();
    preview.textContent = first.length > 120 ? `${first.slice(0, 120)}…` : first;
    head.title = preview.textContent;
    body.textContent = text || '';

    if (before && before.parentNode === state.list) state.list.insertBefore(block, before);
    else state.list.append(block);
    if (stick) Scroll.scrollToBottom();
    return block;
}