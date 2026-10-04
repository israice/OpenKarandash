// Лента вкладки Sessions: строки разговора. Здесь только рисование —
// addMessage/addStep/addThinkingStep/pending, всё, что добавляет строку в
// #chatList. Кто и когда это зовёт — sessions-stream.js (живой поток) и
// renderStoredMessage там же (строки из базы); правила прокрутки и гармошки
// шагов — свои, потому что относятся к рисованию, а не к потоку.
//
// Мёртвый код, который здесь жил до переписки, убран: подсказка по
// демо-карточкам (WORKER_INFO, renderWorkerTooltip, initFeed) — таких узлов
// на Sessions нет вовсе, и держать их в ленте было незачем.
import { state } from './sessions-state.js';
import { escapeHtml } from '../../SYSTEM/app.js';
import { buildStepBody, buildDetails } from './sessions-details.js';

// ---------- прокрутка ----------

// Прокручиваем вниз только если пользователь и так был у низа ленты —
// иначе новые блоки во время стрима сбрасывали бы его к последнему сообщению.
// Проверять «у низа ли» нужно ДО того, как в ленту добавится новый блок:
// иначе scrollHeight уже вырастет на высоту этого блока, и даже если
// пользователь стоял у самого низа, дистанция окажется большой
const NEAR_BOTTOM_PX = 80;

export function isNearBottom() {
    const { scrollHeight, scrollTop, clientHeight } = state.messages;
    return scrollHeight - scrollTop - clientHeight <= NEAR_BOTTOM_PX;
}

export function scrollToBottom() {
    state.messages.scrollTop = state.messages.scrollHeight;
}

// ---------- markdown ----------

// Ответ модели приходит в markdown — рендерим его в HTML, чтобы списки и
// абзацы легли отдельными блоками, а не одной слитной строкой pre-wrap.
// Намеренно маленький разбор: поддерживаем ровно то, чем отвечает агент
// (заголовки, списки, код, ссылки, жирный/курсив)
function renderMarkdown(text) {
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

// ---------- шаги инструментов ----------

// Цвет тега инструмента считаем от имени хэшем: одно и то же имя
// (read_file, search_files, Bash, …) всегда получает один и тот же оттенок,
// а разные имена визуально различаются — без ручного списка всех инструментов
// всех CLI
function toolTagHue(name) {
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
    return hash % 360;
}

// Шаги сворачиваются гармошкой: открыт может быть только один — клик по
// свёрнутому открывает его и закрывает ранее открытый, клик по открытому
// сворачивает обратно
function setStepOpen(step, open) {
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
// row — строка сессии целиком: из неё тело гармошки (если оно есть)
export function addStep(text, before, row) {
    // действие закрывает блок мыслей: дальше модель думает уже о новом шаге
    closeThinking();
    const stick = isNearBottom();
    const step = document.createElement('div');
    step.className = 'chat-message chat-message--tool';

    const head = document.createElement('div');
    head.className = 'chat-tool-head';
    const match = String(text).match(/^(\S+)(\s+([\s\S]*))?$/);
    if (match) {
        const hue = toolTagHue(match[1]);
        const tag = document.createElement('span');
        tag.className = 'chat-tool-tag';
        tag.style.color = `hsl(${hue}, 70%, 68%)`;
        tag.style.background = `hsl(${hue}, 45%, 18%)`;
        tag.textContent = match[1];
        head.append(tag);
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
    if (stick) scrollToBottom();
    return step;
}

// ---------- блок размышления ----------

// Блок мыслей модели: в заголовке последний дошедший абзац, в теле — все
// абзацы блока по порядку. Собирает его сервер (одна строка базы на блок,
// ctx.think в SYSTEM/core/run-turn.js), лента только рисует: текст приходит
// уже целиком, поэтому блок не растёт по кускам, а заменяется целиком.
// Свёрнут он по умолчанию — мыслей в ходе много, а читают ответ и шаги
let openThinking = null;

// абзац мысли — кусок между пустыми строками, как их пишет модель. Тот же
// разрез делает и сервер, склеивая мысли блока через пустую строку, поэтому
// блок из базы и блок живого потока режутся одинаково
function thoughtParagraphs(text) {
    return String(text).split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean);
}

export function addThinking(text, before) {
    const stick = isNearBottom();
    // блок из прошлой сессии или прошлого хода к списку не подключён: мысли
    // дописывать в него нельзя, следующая встанет своим блоком
    if (!openThinking?.isConnected) {
        const block = document.createElement('details');
        block.className = 'chat-message chat-message--thinking';

        const head = document.createElement('summary');
        head.className = 'chat-thinking-head';

        const body = document.createElement('div');
        body.className = 'chat-thinking-body';

        block.append(head, body);
        if (before && before.parentNode === state.list) state.list.insertBefore(block, before);
        else state.list.append(block);
        openThinking = block;
    }

    const paragraphs = thoughtParagraphs(text);
    if (paragraphs.length) {
        const head = openThinking.querySelector('.chat-thinking-head');
        head.textContent = paragraphs[paragraphs.length - 1];
        head.title = head.textContent;

        const body = openThinking.querySelector('.chat-thinking-body');
        body.replaceChildren(...paragraphs.map((part) => {
            const paragraph = document.createElement('p');
            paragraph.className = 'chat-thinking-paragraph';
            paragraph.textContent = part;
            return paragraph;
        }));
    }

    if (stick) scrollToBottom();
    return openThinking;
}

// Блок мыслей закончен: следующая мысль встанет своим блоком. Зовут его
// addStep (действие) и addMessage (ответ или реплика человека) — там мысли
// и заканчиваются по смыслу; сам блок остаётся в ленте свёрнутым
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

// Реплика ленты. model — та модель, которая дала этот ответ: у строки из базы
// своё поле (message.model), у ответа, который сейчас стримится, — выбор в
// шапке сессии. Подпись рисуется только у ответа модели: реплике человека и
// служебным строкам она не нужна, и там model не передаётся вовсе.
// before — вставить перед этой строкой, а не в конец: так ответ встаёт выше
// строки ожидания, которая остаётся последней
export function addMessage(text, kind, model, before) {
    // ответ или реплика человека закрывают блок мыслей
    closeThinking();
    const stick = isNearBottom();
    state.empty.hidden = true;

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
    const tag = window.ModelTag?.tag(model);
    if (tag) message.prepend(tag);

    place(message);

    if (stick) scrollToBottom();
    return message;
}

// ---------- строка ожидания ----------

const PENDING_HTML = '<span class="chat-typing"><span></span><span></span><span></span></span>'
    + '<span class="chat-pending-note"></span>';

// Часы ожидания на строке с точками. Между шагами агент молчит десятки секунд,
// и без счётчика живая работа неотличима от оборванной: человек не знает,
// ждать или подтолкнуть
function formatWait(seconds) {
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
// Ход может кончиться ничем: сервер погасили посреди работы, запрос отменили,
// агент ответил так, что ответ не удалось разобрать. В ленте это выглядело
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

export { buildDetails };