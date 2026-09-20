// Полнота строки в Sessions: всё, что сервер знает о строке сессии, видно
// здесь так же, как в Feed и на ноде Flow (DOCS/decisions/039, «То же правило
// для полей»). Громоздкое — сырое событие, картинки — сворачивается, но не
// прячется. Вынесено из chat-feed.js, чтобы тот не рос (DOCS/decisions/022)
import { state } from './chat-state.js';

export function prettyJson(raw) {
    if (!raw) return '';
    try { return JSON.stringify(JSON.parse(raw), null, 2); } catch { return String(raw); }
}

// раздел тела шага или блока Details: подпись и текст как есть
export function addToolSection(body, label, text, isError) {
    if (!text) return;
    const section = document.createElement('div');
    section.className = 'chat__tool-section';
    const lbl = document.createElement('div');
    lbl.className = 'chat__tool-section-label';
    lbl.textContent = label;
    const pre = document.createElement('pre');
    pre.className = `chat__tool-section-pre${isError ? ' chat__tool-section-pre--error' : ''}`;
    pre.textContent = text;
    section.append(lbl, pre);
    body.append(section);
}

// картинки результата: JSON-массив data-URL (toolResultImages в server.js)
export function addImagesSection(body, raw) {
    let images;
    try { images = JSON.parse(raw || ''); } catch { return; }
    if (!Array.isArray(images) || !images.length) return;
    const section = document.createElement('div');
    section.className = 'chat__tool-section';
    const lbl = document.createElement('div');
    lbl.className = 'chat__tool-section-label';
    lbl.textContent = `Images (${images.length})`;
    const list = document.createElement('div');
    list.className = 'chat__tool-images';
    for (const src of images) {
        const img = document.createElement('img');
        img.src = src;
        img.alt = 'tool result image';
        img.loading = 'lazy';
        list.append(img);
    }
    section.append(lbl, list);
    body.append(section);
}

// поля строки, которые не нарисованы отдельно: модель, токены, стоимость,
// id вызовов, поля Event Schema (source/actor/eventType/provider/taskId/
// attemptId), extra_meta и result_meta разобранными. Тот же набор, что
// секция Metadata на ноде Flow (sessionMetadata в PROJECTS/Flow/flow.js)
const SHOWN_APART = new Set(['text', 'toolInput', 'toolResult', 'inputSent', 'extraMeta', 'resultMeta', 'toolResultImages', 'raw']);

export function messageMetadata(m) {
    const meta = {};
    for (const [key, value] of Object.entries(m)) {
        if (SHOWN_APART.has(key) || value === null || value === undefined || value === '') continue;
        meta[key] = value;
    }
    for (const key of ['extraMeta', 'resultMeta']) {
        if (!m[key]) continue;
        try { meta[key] = JSON.parse(m[key]); } catch { meta[key] = m[key]; }
    }
    return Object.keys(meta).length ? JSON.stringify(meta, null, 2) : '';
}

// разделы, которые есть у строки любой роли: сводка полей и сырое событие
export function addRowSections(body, m) {
    addToolSection(body, 'Metadata', messageMetadata(m));
    addToolSection(body, 'Raw event', prettyJson(m.raw));
}

// реплика и размышление — не гармошка, как шаг, и размышление к тому же
// обрезано до трёх строк. Поэтому их данные идут отдельным свёрнутым блоком
// сразу под строкой, а не внутри неё
export function addRowDetails(m, after) {
    // пометка суждения о ходе идёт над блоком Details, а не внутри него:
    // ради неё не должно приходиться раскрывать гармошку. Разметку строит
    // общий SYSTEM/judgment-badge.js — тот же, что в Feed и на ноде Flow
    const mark = window.TurnJudgment?.badge(m.resultMeta);
    const place = (node) => {
        if (after && after.parentNode === state.chatList) after.after(node);
        else state.chatList.append(node);
    };

    const body = document.createElement('div');
    body.className = 'chat__details-body';
    if (m.role === 'user' && m.inputSent && m.inputSent !== m.text) {
        // в Chat-режиме модели уходит текст с преамбулой, а не то, что видно в ленте
        addToolSection(body, 'Sent to model', m.inputSent);
    }
    addRowSections(body, m);
    if (!body.children.length) {
        if (mark) place(mark);
        return null;
    }

    const details = document.createElement('details');
    details.className = `chat__details chat__details--${m.role}`;
    const summary = document.createElement('summary');
    summary.className = 'chat__details-summary';
    summary.textContent = 'Details';
    details.append(summary, body);
    // порядок в ленте: строка, пометка, Details — поэтому Details ставим
    // первым, а пометку вклиниваем перед ним
    place(details);
    if (mark) details.before(mark);
    return details;
}
