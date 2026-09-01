// Stop-хук: проверяет, что финальный текстовый ответ ассистента написан на том же
// языке, что и последнее сообщение пользователя (AGENTS.md, раздел "Конвенции").
// Зачем: правило "отвечай на языке текущего сообщения" — инструкция для модели,
// а не гарантия — при большом англоязычном фоне в контексте (схемы MCP, system
// reminders) язык иногда съезжает. Хук — детерминированная проверка снаружи модели.
// Регистрация — .claude/settings.json, ключ hooks.Stop.
const fs = require('fs');

// код, инлайн-код, URL и пути файлов не обязаны совпадать по языку — вырезаем перед
// подсчётом, иначе имена функций/переменных в коде дают ложные срабатывания
function stripNonProse(text) {
    return text
        .replace(/```[\s\S]*?```/g, ' ') // код-блоки
        .replace(/`[^`\n]+`/g, ' ') // инлайн-код
        .replace(/https?:\/\/\S+/g, ' ') // URL
        .replace(/\]\([^)]*\)/g, ']') // URL/путь внутри markdown-ссылки, текст ссылки остаётся
        .replace(/(?:^|[\s(])(?:[A-Za-z]:)?(?:[\w.-]*[\\/])+[\w.-]+/g, ' '); // пути файлов (в т.ч. абсолютные /mnt/...)
}

// доля латиницы среди кириллицы+латиницы; слишком короткий текст пропускаем —
// на нём один термин в скобках даёт нерепрезентативный процент
function latinRatio(text) {
    const cyr = (text.match(/\p{Script=Cyrillic}/gu) || []).length;
    const lat = (text.match(/[A-Za-z]/g) || []).length;
    const total = cyr + lat;
    if (total < 20) return null;
    return lat / total;
}

// последний текстовый блок последней записи заданного типа в transcript
function lastMessageText(transcriptPath, type) {
    let lines;
    try {
        lines = fs.readFileSync(transcriptPath, 'utf8').split('\n');
    } catch {
        return null;
    }

    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line) continue;
        let entry;
        try {
            entry = JSON.parse(line);
        } catch {
            continue;
        }
        if (entry.type !== type) continue;
        const content = entry.message?.content;
        if (typeof content === 'string') return content;
        if (!Array.isArray(content)) continue;
        const textBlocks = content.filter((b) => b.type === 'text' && b.text);
        if (textBlocks.length) return textBlocks[textBlocks.length - 1].text;
    }
    return null;
}

function main() {
    let input;
    try {
        input = JSON.parse(fs.readFileSync(0, 'utf8'));
    } catch {
        return;
    }

    // без этой проверки собственный "block" зациклил бы Stop-хук сам на себя
    if (input.stop_hook_active) return;

    const transcriptPath = input.transcript_path;
    if (!transcriptPath) return;

    const userText = lastMessageText(transcriptPath, 'user');
    const assistantText = lastMessageText(transcriptPath, 'assistant');
    if (!userText || !assistantText) return;

    const userRatio = latinRatio(stripNonProse(userText));
    const assistantRatio = latinRatio(stripNonProse(assistantText));
    if (userRatio === null || assistantRatio === null) return;

    const userIsCyrillic = userRatio <= 0.35;
    const userIsLatin = userRatio >= 0.65;
    const assistantIsCyrillic = assistantRatio <= 0.35;
    const assistantIsLatin = assistantRatio >= 0.65;

    // сравниваем только когда язык обоих сообщений однозначен (не смешанный текст) —
    // на пограничных случаях (0.35..0.65) решение неоднозначно, лучше пропустить
    const mismatch =
        (userIsCyrillic && assistantIsLatin) || (userIsLatin && assistantIsCyrillic);
    if (!mismatch) return;

    console.log(JSON.stringify({
        decision: 'block',
        reason: 'AGENTS.md требует отвечать на языке текущего сообщения пользователя, а последний ответ на другом языке. Перепиши последний ответ на языке последнего сообщения пользователя — весь текст вне кода, инлайн-кода, URL и путей файлов.',
    }));
}

main();
