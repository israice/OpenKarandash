// ---------- markdown ----------

// Ответ модели приходит в markdown — рендерим его в HTML, чтобы списки и
// абзацы легли отдельными блоками, а не одной слитной строкой pre-wrap.
// Намеренно маленький разбор: поддерживаем ровно то, чем отвечает агент
// (заголовки, списки, код, ссылки, жирный/курсив)
import { escapeHtml } from '../../SYSTEM/app.js';

export function renderMarkdown(text) {
    const codeBlocks = [];

    // код прячем до разбора остального — звёздочки и решётки внутри него
    // не должны считаться разметкой. Плейсхолдер помечаем невидимым символом,
    // чтобы его нельзя было случайно распознать как обычный текст
    let src = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
        codeBlocks.push(`<pre><code>${escapeHtml(code.replace(/\n$/, ''))}</code></pre>`);
        return `⁣${codeBlocks.length - 1}⁣`;
    });

    src = escapeHtml(src);
    src = src.replace(/`([^`]+)`/g, '<code>$1</code>');
    src = src.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    src = src.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>');
    src = src.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

    const out = [];
    let list = null; // 'ul' | 'ol' | null
    let para = [];

    const flushPara = () => {
        if (para.length) { out.push(`<p>${para.join('<br>')}</p>`); para = []; }
    };
    const closeList = () => {
        if (list) { out.push(`</${list}>`); list = null; }
    };

    for (const rawLine of src.split('\n')) {
        const line = rawLine.trim();
        const codeRef = line.match(/^⁣\d+⁣$/);
        const heading = line.match(/^(#{1,6})\s+(.*)/);
        const bullet = line.match(/^[-*]\s+(.*)/);
        const numbered = line.match(/^\d+[.)]\s+(.*)/);

        // пустая строка закрывает абзац, но не список — иначе список из пунктов,
        // разделённых пустыми строками, распадается на несколько <ol>, и
        // нумерация каждый раз начинается заново (1 1 1 вместо 1 2 3)
        if (!line) { flushPara(); continue; }

        if (codeRef) {
            // плейсхолдер код-блока — целый блок сам по себе, не абзац
            flushPara(); closeList();
            out.push(line);
        } else if (heading) {
            flushPara(); closeList();
            const level = heading[1].length;
            out.push(`<h${level}>${heading[2]}</h${level}>`);
        } else if (bullet) {
            flushPara();
            if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; }
            out.push(`<li>${bullet[1]}</li>`);
        } else if (numbered) {
            flushPara();
            if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; }
            out.push(`<li>${numbered[1]}</li>`);
        } else {
            closeList();
            para.push(line);
        }
    }
    flushPara();
    closeList();

    return out.join('').replace(/⁣(\d+)⁣/g, (_, i) => codeBlocks[i]);
}