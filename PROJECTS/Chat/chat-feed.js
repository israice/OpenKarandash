// Лента сообщений вкладки Chat: markdown ответа, строки шагов и рассуждений,
// сообщения, строка ожидания с тремя точками, подсказка по исполнителю на
// карточке задачи. Вынесено из SYSTEM/app.js (DOCS/decisions/022)
import { state } from './chat-state.js';
import { escapeHtml } from '../../SYSTEM/app.js';

// Профиль каждого исполнителя на шкале: чем он владеет и что из этого
// задействовано именно в текущей задаче (used) — это решает глава компании,
// наводя курсор на иконку.
const WORKER_INFO = {
    secretary: {
        emoji: '🗂️', name: 'Secretary', role: 'Intake and task breakdown',
        competencies: ['Prioritization', 'Spec writing', 'Routing'],
        mcp: ['Notion', 'Slack'],
        tools: ['Todo list', 'Spec templates'],
        skills: ['intake-triage'],
        used: ['Prioritization', 'Routing', 'Todo list', 'intake-triage'],
    },
    researcher: {
        emoji: '🔎', name: 'Researcher', role: 'Root cause hunting',
        competencies: ['Log analysis', 'Debugging', 'Reading unfamiliar code'],
        mcp: ['GitHub', 'Sentry'],
        tools: ['grep/rg', 'Profiler'],
        skills: ['root-cause-analysis'],
        used: ['Log analysis', 'Debugging', 'GitHub', 'grep/rg', 'root-cause-analysis'],
    },
    architect: {
        emoji: '🧭', name: 'Architect', role: 'Solution design',
        competencies: ['System design', 'Risk assessment'],
        mcp: ['Notion'],
        tools: ['Diagrams'],
        skills: ['design-review'],
        used: ['System design', 'design-review'],
    },
    designer: {
        emoji: '🎨', name: 'Designer', role: 'UI/UX for the change',
        competencies: ['Interfaces', 'Accessibility'],
        mcp: ['Figma'],
        tools: ['Figma'],
        skills: ['ui-review'],
        used: [],
    },
    developer: {
        emoji: '🛠️', name: 'Developer', role: 'Implementing the change (in progress)',
        competencies: ['Node.js', 'Race debugging', 'Automated tests'],
        mcp: ['GitHub', 'Context7'],
        tools: ['VS Code', 'node:sqlite'],
        skills: ['bugfix', 'test-writing'],
        used: ['Node.js', 'Race debugging', 'Automated tests', 'GitHub', 'node:sqlite', 'bugfix', 'test-writing'],
    },
    tester: {
        emoji: '🧪', name: 'Tester', role: 'Next up: regression run',
        competencies: ['Regression testing', 'Edge cases'],
        mcp: ['GitHub Actions'],
        tools: ['Playwright'],
        skills: ['regression-suite'],
        used: ['Regression testing', 'GitHub Actions', 'Playwright', 'regression-suite'],
    },
    writer: {
        emoji: '📝', name: 'Technical writer', role: 'Documenting changes',
        competencies: ['Changelog', 'Documentation'],
        mcp: ['Notion'],
        tools: ['Markdown'],
        skills: ['release-notes'],
        used: [],
    },
    reviewer: {
        emoji: '✅', name: 'Reviewer', role: 'Final acceptance',
        competencies: ['Code review', 'Spec compliance check'],
        mcp: ['GitHub'],
        tools: ['code-review'],
        skills: ['final-approval'],
        used: [],
    },
};

function renderWorkerTags(items, used) {
    return items.map((item) => `<span class="worker-tooltip__tag${used.has(item) ? ' is-used' : ''}">${item}</span>`).join('');
}

function renderWorkerTooltip(info) {
    const used = new Set(info.used);
    return `
        <div class="worker-tooltip__head">
            <span class="worker-tooltip__emoji">${info.emoji}</span>
            <div>
                <div class="worker-tooltip__name">${info.name}</div>
                <div class="worker-tooltip__role">${info.role}</div>
            </div>
        </div>
        <div class="worker-tooltip__section">
            <p class="worker-tooltip__label">Competencies</p>
            <div class="worker-tooltip__tags">${renderWorkerTags(info.competencies, used)}</div>
        </div>
        <div class="worker-tooltip__section">
            <p class="worker-tooltip__label">MCP</p>
            <div class="worker-tooltip__tags">${renderWorkerTags(info.mcp, used)}</div>
        </div>
        <div class="worker-tooltip__section">
            <p class="worker-tooltip__label">Tools</p>
            <div class="worker-tooltip__tags">${renderWorkerTags(info.tools, used)}</div>
        </div>
        <div class="worker-tooltip__section">
            <p class="worker-tooltip__label">Skills</p>
            <div class="worker-tooltip__tags">${renderWorkerTags(info.skills, used)}</div>
        </div>
        <p class="worker-tooltip__hint">Highlighted — used in this task</p>
    `;
}

// прокручиваем вниз только если пользователь и так был у низа ленты —
// иначе новые блоки во время стрима сбрасывали его к последнему сообщению.
// Проверять «у низа ли пользователь» нужно ДО того, как в ленту добавится
// новый блок — иначе scrollHeight уже вырастет на высоту этого блока,
// и даже если пользователь стоял у самого низа, дистанция окажется большой.
const CHAT_SCROLL_NEAR_BOTTOM_PX = 80;
export function isChatNearBottom() {
    const distanceFromBottom = state.chatMessages.scrollHeight - state.chatMessages.scrollTop - state.chatMessages.clientHeight;
    return distanceFromBottom <= CHAT_SCROLL_NEAR_BOTTOM_PX;
}
export function scrollChatToBottom() {
    state.chatMessages.scrollTop = state.chatMessages.scrollHeight;
}

// ответ ассистента приходит в markdown — рендерим его в HTML, чтобы списки
// и абзацы легли отдельными блоками, а не одной slitной строкой pre-wrap
function renderMarkdown(text) {
    const codeBlocks = [];
    // код прячем до разбора остального — звёздочки/решётки внутри не должны считаться разметкой
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
        // разделённых пустыми строками, распадается на несколько <ol>, и нумерация
        // каждый раз начинается заново (1 1 1 вместо 1 2 3)
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

// строка шага: что Claude сделал (Read index.html, Bash npm test)
export function addStep(text, before) {
    const stick = isChatNearBottom();
    const step = document.createElement('div');
    step.className = 'chat__message chat__message--tool';
    step.textContent = text;
    if (before && before.parentNode === state.chatList) state.chatList.insertBefore(step, before);
    else state.chatList.append(step);
    if (stick) scrollChatToBottom();
    return step;
}

// строка рассуждения (event.type === 'thinking', см. server.js emit):
// раньше текст в неё вообще не попадал — событие тихо отбрасывалось
// в makeRenderer, а в ленте не оставалось никакого следа рассуждения
export function addThinkingStep(text, before) {
    const stick = isChatNearBottom();
    const step = document.createElement('div');
    step.className = 'chat__message chat__message--thinking';
    step.textContent = text;
    step.title = text;
    if (before && before.parentNode === state.chatList) state.chatList.insertBefore(step, before);
    else state.chatList.append(step);
    if (stick) scrollChatToBottom();
    return step;
}

export function addMessage(text, kind) {
    const stick = isChatNearBottom();
    state.chatEmpty.hidden = true;

    const message = document.createElement('div');
    message.className = `chat__message chat__message--${kind}`;
    if (kind === 'assistant' && text) message.innerHTML = renderMarkdown(text);
    else message.textContent = text;
    state.chatList.append(message);
    if (stick) scrollChatToBottom();
    return message;
}

// строка ожидания с тремя точками — она же показывает текущий шаг.
// Если строка уже есть (её мог завести syncPendingWithIndicator по
// оранжевому кругу раньше, чем подключился поток), переиспользуем её,
// а не заводим вторую: переносим в конец ленты и показываем
export function addPendingStatus() {
    const existing = state.chatList.querySelector('.chat__message--pending');
    if (existing) {
        existing.hidden = false;
        state.chatList.append(existing);
        return existing;
    }
    const status = addMessage('', 'assistant');
    status.classList.add('chat__message--pending');
    status.innerHTML = '<span class="chat__typing"><span></span><span></span><span></span></span>';
    return status;
}

// подсказка по исполнителю на карточках демо-раскладки — узлы берутся здесь,
// а не на верхнем уровне модуля; зовёт init() в chat.js
export function initFeed() {
    const workerTooltip = document.getElementById('workerTooltip');

    document.querySelectorAll('.task-card__progress-worker').forEach((el) => {
        const info = WORKER_INFO[el.dataset.worker];
        if (!info) return;

        el.addEventListener('mouseenter', () => {
            workerTooltip.innerHTML = renderWorkerTooltip(info);
            const rect = el.getBoundingClientRect();
            workerTooltip.classList.add('is-visible');
            const tipRect = workerTooltip.getBoundingClientRect();
            let left = rect.left + rect.width / 2 - tipRect.width / 2;
            left = Math.max(8, Math.min(left, window.innerWidth - tipRect.width - 8));
            let top = rect.top - tipRect.height - 10;
            if (top < 8) top = rect.bottom + 10;
            workerTooltip.style.left = `${left}px`;
            workerTooltip.style.top = `${top}px`;
        });

        el.addEventListener('mouseleave', () => {
            workerTooltip.classList.remove('is-visible');
        });
    });
}
