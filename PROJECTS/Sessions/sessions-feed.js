// Лента вкладки Sessions: строки разговора. Здесь только рисование —
// addMessage/addStep/addThinkingStep/pending, всё, что добавляет строку в
// #chatList. Кто и когда это зовёт — sessions-stream.js (живой поток) и
// renderStoredMessage там же (строки из базы); правила прокрутки и гармошки
// шагов — свои, потому что относятся к рисованию, а не к потоку.
//
// Мёртвый код, который здесь жил до переписки, убран: подсказка по
// демо-карточкам (WORKER_INFO, renderWorkerTooltip, initFeed) — таких узлов
// на Sessions нет вовсе, и держать их в ленте было незачем.
//
// Сам файл — сборка: рисование разложено по темам (метка, реплика, шаг,
// мысль, промпт, ожидание, markdown, прокрутка), и здесь только перечислено
// то, чем вкладка пользуется снаружи. Набор имён — тот же, что был у файла до
// разложения: поток, история и панель берут отсюда рисование, и менять этот
// набор молча нельзя (DOCS/decisions/123).

export { isNearBottom, scrollToBottom } from './sessions-feed-scroll.js';

export { addStep } from './sessions-feed-steps.js';

export { addThinking, closeThinking, thinkingText } from './sessions-feed-thinking.js';

export { addInput } from './sessions-feed-input.js';

export { addMessage } from './sessions-feed-message.js';

export { addPending, markPendingActivity, removePending, addInterrupted } from './sessions-feed-pending.js';
