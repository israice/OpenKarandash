// Полнота строки сессии: всё, что сервер знает о строке, кроме её текста —
// полные аргументы и вывод инструмента, картинки результата, сводка полей
// Event Schema и сырое событие. На Sessions это тело шага-гармошки; те же поля
// показывают Feed и Flow, и набор должен совпадать на всех трёх
// (DOCS/decisions/039).
//
// Отдельный файл, а не часть ленты: набор полей и разметка секций — это
// про серверную строку, а не про то, как выглядит лента. Лента зовёт отсюда
// готовые куски и ничего не знает про поля строки.

// поля, у которых есть своя секция — в сводку они не попадают
const SHOWN_APART = new Set(['text', 'toolInput', 'toolResult', 'inputSent', 'extraMeta', 'resultMeta', 'toolResultImages', 'raw']);

export function prettyJson(raw) {
    if (!raw) return '';
    try { return JSON.stringify(JSON.parse(raw), null, 2); } catch { return String(raw); }
}

// секция тела шага: подпись и текст как есть
export function addSection(body, label, text, isError) {
    if (!text) return;

    const section = document.createElement('div');
    section.className = 'chat-tool-section';

    const caption = document.createElement('div');
    caption.className = 'chat-tool-section-label';
    caption.textContent = label;

    const pre = document.createElement('pre');
    pre.className = `chat-tool-section-pre${isError ? ' chat-tool-section-pre--error' : ''}`;
    pre.textContent = text;

    section.append(caption, pre);
    body.append(section);
}

// картинки результата: JSON-массив data-URL (toolResultImages в SYSTEM/core/sessions-db.js)
function addImages(body, raw) {
    let images;
    try { images = JSON.parse(raw || ''); } catch { return; }
    if (!Array.isArray(images) || !images.length) return;

    const section = document.createElement('div');
    section.className = 'chat-tool-section';

    const caption = document.createElement('div');
    caption.className = 'chat-tool-section-label';
    caption.textContent = `Images (${images.length})`;

    const list = document.createElement('div');
    list.className = 'chat-tool-images';
    for (const src of images) {
        const img = document.createElement('img');
        img.src = src;
        img.alt = 'tool result image';
        img.loading = 'lazy';
        list.append(img);
    }

    section.append(caption, list);
    body.append(section);
}

// сводка остальных полей строки разобранными. Тот же набор, что секция
// Metadata на ноде Flow (sessionMetadata в PROJECTS/Flow/flow-session-node.js) и блоки
// на странице Feed
function rowMetadata(row) {
    const meta = {};
    for (const [key, value] of Object.entries(row)) {
        if (SHOWN_APART.has(key) || value === null || value === undefined || value === '') continue;
        meta[key] = value;
    }
    for (const key of ['extraMeta', 'resultMeta']) {
        if (!row[key]) continue;
        try { meta[key] = JSON.parse(row[key]); } catch { meta[key] = row[key]; }
    }
    return Object.keys(meta).length ? JSON.stringify(meta, null, 2) : '';
}

// Тело шага-гармошки. Есть ли что открывать — решает вызывающий: показывает
// он узел гармошкой (кликабельно) или простой строкой
export function buildStepBody(row) {
    const body = document.createElement('div');
    body.className = 'chat-tool-body';

    addSection(body, 'Input', prettyJson(row.toolInput));
    addSection(body, row.toolError ? 'Error' : 'Output', row.toolResult || row.toolError, row.toolError);
    addImages(body, row.toolResultImages);
    addSection(body, 'Metadata', rowMetadata(row));
    addSection(body, 'Raw event', prettyJson(row.raw));

    return body;
}
