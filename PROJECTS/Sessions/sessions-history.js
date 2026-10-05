// Строка сессии из базы → лента.
//
// Правило одно для всех ролей, которые пишет сервер (listMessages в
// SYSTEM/core/sessions-db.js), — те же строки рисуют Feed и Flow, и ни одна роль не должна
// пропасть или выдать себя за ответ модели:
// - user — реплика человека; assistant — ответ (с ошибкой хода — строкой ошибки);
// - всё, что сделано внутри вызова помощника (parentToolUseId), — шаг с «↳»,
//   а не реплика основной модели;
// - thinking — размышление; tool/system/hook/unknown/top_level — строка шага,
//   тег — имя инструмента или источник события.
//
// Отдельный файл, а не часть потока: показ истории и показ живого ответа —
// разные вещи. Поток (sessions-stream.js) события хода рисует сам, а отсюда
// берёт только эту функцию для перечитывания ленты после хода.
import { addStep, addThinking, addMessage } from './sessions-feed.js';

export function renderStored(row) {
    const nested = row.parentToolUseId ? '↳ ' : '';
    const text = row.text || '';

    if (row.role === 'user') {
        addMessage(text, 'user');
    } else if (row.role === 'assistant') {
        if (nested) {
            addStep(`${nested}subagent ${text}`, undefined, row);
        } else {
            // подпись моделью — по полям самой строки: ход мог вести другой
            // исполнитель другой моделью, а в шапке сессии выбрана уже следующая.
            // source строки — имя CLI, который этот ход вёл (SYSTEM/cli/index.js,
            // agentNameByTarget), поэтому путь в плашке полный
            const kind = row.stopReason === 'error' ? 'error' : 'assistant';
            addMessage(text, kind, row.model, null, row.source);
        }
    } else if (row.role === 'thinking') {
        addThinking(`${nested}${text}`);
    } else if (row.role === 'tool') {
        addStep(text, undefined, row);
    } else {
        // system (пометки хода recordNotice, системные события CLI), hook,
        // unknown, top_level — toolInput/toolResult бывают и здесь (хуки пишут
        // вывод той же парой колонок)
        const tag = row.toolName || row.role;
        addStep(`${nested}${tag} ${text === tag ? '' : text}`.trim(), undefined, row);
    }
}

// Ход считается недоведённым, когда последнее слово осталось не за агентом: на
// шаге инструмента (работу оборвали) или на вопросе человека (ответа не было).
//
// Отдельный случай — строка ответа с пометкой stopReason='error'. Ошибкой хода
// в базе роль 'error' не пишется: finishExchange кладёт текст ошибки в строку
// ответа и помечает её stopReason, поэтому раньше ход, кончившийся ошибкой
// (в том числе исчерпанным дневным лимитом), читался как доведённый до конца и
// кнопки продолжения не получал — хотя работа не сделана и продолжать есть чем.
//
// Пометки хода о продолжении и об остановке ('system') пропускаем насквозь:
// за ними всё равно лежит настоящая причина, и решение о кнопке принимается по
// ней, а не по тому, что пульт успел написать последним.
export function isTurnUnfinished(messages) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const row = messages[i];
        const role = row.role;
        if (role === 'assistant' || role === 'error') {
            if (row.stopReason !== 'error') return false;
            continue; // ошибка хода — работа не доведена, кнопка нужна
        }
        if (role === 'user' || role === 'tool') return true;
    }
    return false;
}