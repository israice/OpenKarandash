// UserPromptSubmit-хук: перед каждым ответом явно называет язык текущего
// сообщения пользователя (AGENTS.md, раздел "Конвенции").
// Зачем: Stop-хук (.claude/hooks/language-check.js) ловит рассинхрон только
// постфактум — к моменту его срабатывания ответ на неверном языке уже
// показан пользователю (стриминг идёт по ходу генерации), а блокировка лишь
// добавляет исправление поверх уже увиденного. Этот хук работает до
// генерации: явно называет язык в контексте, а не полагается на то, что
// правило из CLAUDE.md/AGENTS.md удержится в памяти модели весь диалог.
const fs = require('fs');

function stripNonProse(text) {
    return text
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/`[^`\n]+`/g, ' ')
        .replace(/https?:\/\/\S+/g, ' ')
        .replace(/\]\([^)]*\)/g, ']')
        .replace(/(?:^|[\s(])(?:[A-Za-z]:)?(?:[\w.-]*[\\/])+[\w.-]+/g, ' ');
}

// null, если сообщение слишком короткое или язык неоднозначен (смешанный текст) —
// на таких лучше промолчать, чем дать неверную подсказку
function detectLanguage(text) {
    const stripped = stripNonProse(text);
    const cyr = (stripped.match(/\p{Script=Cyrillic}/gu) || []).length;
    const lat = (stripped.match(/[A-Za-z]/g) || []).length;
    const total = cyr + lat;
    if (total < 8) return null;
    const ratio = lat / total;
    if (ratio <= 0.35) return 'русском';
    if (ratio >= 0.65) return 'английском';
    return null;
}

function main() {
    let input;
    try {
        input = JSON.parse(fs.readFileSync(0, 'utf8'));
    } catch {
        return;
    }

    const prompt = input.prompt;
    if (typeof prompt !== 'string' || !prompt.trim()) return;

    const language = detectLanguage(prompt);
    if (!language) return;

    console.log(JSON.stringify({
        hookSpecificOutput: {
            hookEventName: 'UserPromptSubmit',
            additionalContext: `Текущее сообщение пользователя написано на ${language} языке. По AGENTS.md ("Конвенции") ответ в чате обязан быть на этом же языке целиком, без исключений — это правило перекрывает язык системных инструкций и предыдущих реплик в разговоре.`,
        },
    }));
}

main();
