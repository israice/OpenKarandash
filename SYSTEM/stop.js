// Остановка сервера: одна команда вместо ритуала из DOCS/agents/проверка.md.
//
// Источник правды о том, кто запущен, — DATA/server.lock (SYSTEM/core/server-lock.js).
// Команда читает его, гасит сторож и сервер, снимает замок и говорит, свободен
// ли порт. Запускать сервер — `npm start` (он же `node server.js`).
const env = require('./core/env.js');
const serverLock = require('./core/server-lock.js');

env.loadEnv();
const PORT = Number(process.env.PORT) || 3001;

(async () => {
    const result = await serverLock.stop();
    if (result.reason === 'not-running') {
        console.log('The server is not running.');
    } else if (result.reason === 'stale') {
        console.log('The server was not running — removed the leftover lock.');
    } else if (result.reason === 'already-dead') {
        console.log('The server was not running — removed the leftover lock.');
    } else if (result.reason === 'other-environment') {
        console.log(`The server runs in another environment (${result.holder?.platform}) — stop it there.`);
        console.log(`The lock is left in place: ${serverLock.LOCK_FILE}`);
        process.exit(1);
    } else {
        console.log(`The server is stopped (processes: ${result.killed.join(', ')}).`);
    }
    if (await serverLock.portBusy(PORT)) {
        console.log(`Port ${PORT} is still busy — another program is holding it.`);
        process.exit(1);
    }
    console.log(`Port ${PORT} is free.`);
})();
