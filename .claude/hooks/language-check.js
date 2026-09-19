// Stop-хук: проверяет, что финальный текстовый ответ ассистента написан на том же
// языке, что и последнее сообщение пользователя (AGENTS.md, раздел "Конвенции").
// Зачем: правило "отвечай на языке текущего сообщения" — инструкция для модели,
// а не гарантия — при большом англоязычном фоне в контексте (схемы MCP, system
// reminders) язык иногда съезжает. Хук — детерминированная проверка снаружи модели.
// Регистрация — .claude/settings.json, ключ hooks.Stop.
//
// Сравниваем письменности, а не доли букв (.claude/hooks/language.js). Раньше
// хук считал долю латиницы по всему обращению целиком — вместе со служебным
// английским текстом, которого человек не писал (преамбула режима, карточка
// элемента интерфейса с текстом ошибки), — и заставлял переписывать по-английски
// ответ на русское сообщение. Хуже того, перекос закреплялся: следующий ход
// сравнивался уже с навязанным английским.
const fs = require('fs');
const { detect } = require('./language.js');

const SERVICE_ENTRY = /^\s*<(bash-input|bash-stdout|bash-stderr|local-command-stdout|local-command-stderr|local-command-caveat|command-name|command-message)>/;

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
        // isMeta — запись, которую подложила обвязка, а не человек: тело навыка,
        // загруженного слэш-командой, целиком английское и шло последним, так что
        // русское сообщение перед ним объявлялось английским
        if (entry.isMeta) continue;
        const content = entry.message?.content;
        // команда через "!" и её вывод — запись типа user, но человек её не писал
        // как реплику: латиница кода выдавала «английское сообщение»
        if (typeof content === 'string' && SERVICE_ENTRY.test(content)) continue;
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

    const user = detect(userText);
    const assistant = detect(assistantText);
    // судить не о чем или письменность неоднозначна — пропускаем: ложная
    // блокировка обходится дороже пропущенного расхождения
    if (!user || !assistant) return;
    if (user.script === assistant.script) return;

    console.log(JSON.stringify({
        decision: 'block',
        reason: 'AGENTS.md требует отвечать на языке текущего сообщения пользователя, а последний ответ на другом языке. Перепиши последний ответ на языке последнего сообщения пользователя — весь текст вне кода, инлайн-кода, URL и путей файлов.',
    }));
}

main();
