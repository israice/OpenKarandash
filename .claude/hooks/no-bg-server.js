// PreToolUse-хук: не даёт запустить server.js из сессии. Без NO_RELOAD=1 сервер
// поднимает сторожа с дочерним процессом, а на Windows смерть оболочки не шлёт им
// сигналов — оба переживают сессию, держат cwd проекта (папку не переименовать),
// крутят опрос файлов и дерутся за .sessions.db со следующей копией.
// Сервер для себя пользователь поднимает сам; автоматических проверок в проекте нет
// (DOCS/decisions/025).
// Регистрация — .claude/settings.json, ключ hooks.PreToolUse.

// перед node допускаем переменные окружения, путь и кавычку внешней оболочки,
// после — флаги Node: «PORT=3001 node --inspect ./server.js», «pwsh -c "node server.js"».
// Исключение — «node --check server.js»: это разбор файла, а не запуск сервера
const RUNS_SERVER = /(^|[\s;&|("'])(\S*[\\/])?node(\.exe)?["']?\s+((?!--?(check|c)\b)-\S+\s+)*["']?(\.[\\/])?server\.js/i;

function out(decision, reason) {
    const hookSpecificOutput = {
        hookEventName: 'PreToolUse',
        permissionDecision: decision,
        ...(reason ? { permissionDecisionReason: reason } : {}),
    };
    console.log(JSON.stringify({ hookSpecificOutput }));
    process.exit(0);
}

let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { data += chunk; });
process.stdin.on('error', () => out('allow'));
process.stdin.on('end', () => {
    let input;
    try {
        input = JSON.parse(data);
    } catch {
        return out('allow'); // не разобрали вход — не наша забота
    }
    if (input.tool_name !== 'Bash') return out('allow');
    const command = input.tool_input?.command || '';
    if (!RUNS_SERVER.test(command)) return out('allow');

    out('deny', 'Запускать server.js из сессии нельзя: сторож и дочерний процесс переживут её, '
        + 'займут папку проекта (её нельзя будет переименовать) и .sessions.db. '
        + 'Серверный файл проверяй разбором — «node --check <файл>»; работает ли фича, '
        + 'смотрит пользователь на своём сервере.');
});
