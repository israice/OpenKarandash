// Доведение хода до конца тем же CLI, который его начал.
//
// Модель заканчивает шаг причиной «хочу звать инструменты» (у opencode-схемы
// `tool-calls`, у pi — `toolUse`), и это значит, что работа не закончена: CLI
// должен был пойти дальше сам, а процесс вышел раньше. Пульт такой обрыв
// раньше принимал за конец хода — и ход оставался на первом шаге навсегда.
// На живых данных это выглядело как «модель думает», хотя она уже не думала:
// последней строкой сессии оставался шаг, а отличить это от обычного хода
// можно было только пересмотрев всю переписку.
//
// Продолжает тот же CLI, та же его сессия и та же модель: подхвата другого
// исполнителя здесь нет и не появится (DOCS/decisions/097). У пульта нет ни
// решения, ни выбора — одна и та же фраза, один и тот же предел, и работа
// ведётся ровно той моделью, которой шёл первый запуск.
//
// Решение владельца 2026-10-05: ход останавливается только когда задание
// доведено и проверено, либо когда на сегодня исчерпан лимит — и тогда под
// сообщением о лимите стоит кнопка «Продолжить» (DOCS/decisions/101).
const { turnUnfinished } = require('./any-parse.js');
const { isDailyLimit, LIMIT_NOTICE, BOUND_NOTICE, NO_RESUME_NOTICE } = require('./daily-limit.js');

// Сколько раз ход продолжается сам. Предел обязателен: работа может
// зациклиться (агент читает один и тот же файл и правит его по кругу), и
// бесконечный прогон — это тишина в ленте на часы вместо ответа. Исчерпание
// предела не поломка, а честная остановка с пометкой и кнопкой продолжения.
const MAX_CONTINUATIONS = Number(process.env.TURN_CONTINUATIONS) || 6;

// Фраза, которой ход продолжается. Одна на все CLI и на все случаи: в ней нет
// решения, только указание вернуться к незаконченной работе, доделать её и
// проверить результат так, как велит правило проекта. Своих слов пульт не
// подставляет — иначе продолжение стало бы его собственным планом, а это
// запрещено (DOCS/целевая-архитектура.md, раздел «Оркестратора в проекте нет»).
const CONTINUE_PROMPT = [
    'Continue the task you were given.',
    'The previous run ended before you finished it: its last step was about to call tools, and the process exited.',
    'Do not start over — pick up from your last unfinished step, finish the whole task, verify the result as the project rules ask, and only then give the final answer.',
].join(' ');

// Лог продолжений, а не причина остановки: он нужен, чтобы в ленте было видно,
// что пульт продолжал ход сам, а не что модель вдруг заговорила сама.
const CONTINUE_NOTICE = (n, max) => `ход не доведён до ответа — продолжаю тем же CLI, тем же выбором модели (${n} из ${max})`;

// driveToEnd({ ctx, args, runOnce, buildArgs })
//   runOnce(args)   — один запуск CLI; промис рассосётся, когда процесс выйдет
//   buildArgs(id)   — аргументы следующего запуска по сессии CLI с этим id
async function driveToEnd({ ctx, args, runOnce, buildArgs }) {
    let current = args;
    let continuations = 0;
    for (;;) {
        await runOnce(current);

        // Поломка хода: решение за человеком (DOCS/decisions/097). Отдельно
        // от всех прочих — исчерпанный лимит, потому что это единственный
        // случай, когда работа заведомо не потеряна, а ждать нечего: до завтра
        // тот же запрос всё равно не пройдёт.
        if (ctx.errorText) {
            if (isDailyLimit(ctx.errorText)) ctx.notice('server.limit', LIMIT_NOTICE);
            return;
        }
        if (!turnUnfinished(ctx)) return;

        // Вернуться к работе нечем: своей сессии у CLI нет, а следующий запуск
        // начался бы с нуля и повторил бы сделанное — хуже, чем остановиться
        if (!ctx.cliSessionId) {
            ctx.notice('server.stopped', NO_RESUME_NOTICE);
            return;
        }
        if (continuations >= MAX_CONTINUATIONS) {
            ctx.notice('server.stopped', BOUND_NOTICE.replace('{n}', String(continuations)));
            return;
        }

        continuations += 1;
        ctx.notice('server.continue', CONTINUE_NOTICE(continuations, MAX_CONTINUATIONS));
        ctx.noteInput(CONTINUE_PROMPT);
        current = buildArgs(ctx.cliSessionId);
    }
}

module.exports = { driveToEnd, CONTINUE_PROMPT, MAX_CONTINUATIONS };