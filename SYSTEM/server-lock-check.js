// Самопроверка замка сервера: без неё правку в SYSTEM/core/server-lock.js
// некому проверить — отдельных тестов в проекте нет (DOCS/decisions/025),
// поэтому проверка живёт в общей проверке `npm run check`.
//
// Работает на временном файле: настоящий замок работающего сервера не трогаем
// (путь замка переопределяется переменной SERVER_LOCK_FILE).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const FILE = path.join(os.tmpdir(), `openkarandash-lock-check-${process.pid}.lock`);
process.env.SERVER_LOCK_FILE = FILE;
const lock = require('./core/server-lock.js');

const problems = [];
const check = (ok, what) => { if (!ok) problems.push(what); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Родитель и его ребёнок — как сторож и сервер: ребёнок занимает замок и
// умирает вместе с родителем. Кодом, а не файлом: лишних файлов в проекте
// не заводим (DOCS/decisions/022)
const LOCK_PATH = path.join(__dirname, 'core', 'server-lock.js');
const CHILD_CODE = `
const lock = require(${JSON.stringify(LOCK_PATH)});
lock.acquire({ watchdogPid: Number(process.env.SERVER_WATCHDOG_PID) || null });
lock.dieWithParent();
setTimeout(() => {}, 60000);
`;
const PARENT_CODE = `
const { spawn } = require('child_process');
spawn(process.execPath, ['-e', ${JSON.stringify(CHILD_CODE)}], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: { ...process.env, SERVER_WATCHDOG_PID: String(process.pid) },
});
setTimeout(() => {}, 60000);
`;

// файл замка с устаревшим пульсом: так выглядит замок, оставшийся от упавшего
// процесса (он не успел снять файл)
const writeStaleLock = () => {
    fs.writeFileSync(FILE, JSON.stringify({ watchdog: null, child: 999999, startedAt: null }));
    const old = new Date(Date.now() - 60000);
    fs.utimesSync(FILE, old, old);
};

(async () => {
    // 1. свободный замок занимается
    const first = lock.acquire({ watchdogPid: null });
    check(first.ok, 'acquire on a free lock failed');
    check(fs.existsSync(FILE), 'the lock file was not created');
    check(lock.read()?.child === process.pid, 'the lock does not name the holder');

    // 2. занятый замок не занимается второй раз
    const second = lock.acquire({ watchdogPid: null });
    check(!second.ok, 'a second instance took a lock that is already held');
    check(second.age >= 0, 'the refusal does not say how long the lock has been held');

    // 3. снятие замка убирает файл
    check(lock.release(process.pid), 'release did not remove the lock');
    check(!fs.existsSync(FILE), 'the lock file survived the release');

    // 4. устаревший замок перехватывается: упавший процесс не снял файл
    writeStaleLock();
    const third = lock.acquire({ watchdogPid: null });
    check(third.ok, 'a stale lock was not taken over');

    // 5. остановка гасит живой процесс и снимает замок
    const dummy = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    try {
        fs.writeFileSync(FILE, JSON.stringify({ watchdog: null, child: dummy.pid, startedAt: null }));
        const stopped = await lock.stop();
        check(stopped.stopped, 'stop did not report a stopped instance');
        check(stopped.killed.includes(dummy.pid), 'stop did not kill the process named in the lock');
        await sleep(300);
        check(!lock.isAlive(dummy.pid), 'the killed process is still alive');
        check(!fs.existsSync(FILE), 'the lock file survived the stop');
    } finally {
        try { dummy.kill(); } catch { /* уже мёртв */ }
    }

    // 6. остановка при отсутствии замка — не ошибка
    if (fs.existsSync(FILE)) fs.unlinkSync(FILE);
    const nothing = await lock.stop();
    check(nothing.reason === 'not-running', 'stop on a free project did not report "not running"');

    // 7. сторож исчез, а сервер остался — так выглядит зомби: он держит порт и
    // базу, а второй экземпляр не поднять. Сервер замечает пропажу сторожа сам
    // (pid сторожа лежит в замке) и умирает, снимая замок
    if (fs.existsSync(FILE)) fs.unlinkSync(FILE);
    const orphan = spawn(process.execPath, ['-e', CHILD_CODE], {
        stdio: 'ignore',
        env: { ...process.env, SERVER_LOCK_FILE: FILE, SERVER_WATCHDOG_PID: '999999' },
    });
    try {
        for (let i = 0; i < 50 && !lock.read()?.child; i++) await sleep(100);
        check(lock.read()?.child, 'the dummy server did not take the lock');
        for (let i = 0; i < 60 && lock.isAlive(orphan.pid); i++) await sleep(100);
        check(!lock.isAlive(orphan.pid), 'the server outlived a watchdog that was already gone');
        check(!fs.existsSync(FILE), 'the lock file survived the death of the watchdog');
    } finally {
        try { orphan.kill(); } catch { /* уже мёртв */ }
    }

    // 8. сторож умер вместе с сервером (резкая смерть): замок остаётся, и
    // остановка его убирает — иначе следующий запуск откажется
    if (fs.existsSync(FILE)) fs.unlinkSync(FILE);
    const parent = spawn(process.execPath, ['-e', PARENT_CODE], {
        stdio: 'ignore',
        env: { ...process.env, SERVER_LOCK_FILE: FILE },
    });
    let childPid = null;
    try {
        for (let i = 0; i < 50 && !childPid; i++) {
            await sleep(100);
            childPid = lock.read()?.child || null;
        }
        check(childPid, 'the dummy server did not take the lock');
        if (childPid) {
            process.kill(parent.pid, 'SIGTERM');   // на Windows это TerminateProcess: обработчика не будет
            for (let i = 0; i < 60 && lock.isAlive(childPid); i++) await sleep(100);
            check(!lock.isAlive(childPid), 'the server outlived the watchdog');
        }
    } finally {
        try { parent.kill(); } catch { /* уже мёртв */ }
    }

    // 9. stale lock cleanup is deterministic even when the watchdog removed
    // its own lock while exiting on Linux.
    writeStaleLock();
    const stopped = await lock.stop();
    check(stopped.reason === 'stale', 'stop did not recognise a leftover lock');
    check(!fs.existsSync(FILE), 'the leftover lock survived the stop');

    // 10. замок из другой среды (Windows против WSL) трогать нельзя: pid там
    // из другого пространства процессов, а снять замок значило бы разрешить
    // поднять второй сервер поверх работающего
    const foreign = process.platform === 'win32' ? 'linux' : 'win32';
    fs.writeFileSync(FILE, JSON.stringify({ watchdog: null, child: 999999, platform: foreign, startedAt: null }));
    const foreignStop = await lock.stop();
    check(foreignStop.reason === 'other-environment', 'stop touched a lock taken in another environment');
    check(fs.existsSync(FILE), 'the lock of another environment was removed');

    if (fs.existsSync(FILE)) fs.unlinkSync(FILE);
    if (problems.length === 0) {
        console.log('чисто');
        process.exit(0);
    }
    console.log('НАШЛОСЬ:');
    for (const problem of problems) console.log(`  ${problem}`);
    process.exit(1);
})();
