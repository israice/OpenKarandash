// Замок сервера: кто сейчас работает и как его остановить. Единственный
// владелец DATA/server.lock — и сервер, и сторож, и команда остановки идут
// через него (DOCS/decisions/125).
//
// Раньше правда о запущенном сервере лежала в двух местах: в файле в DATA/
// (кто занял) и в правиле DOCS/agents/проверка.md (как погасить зомби вручную,
// через Get-CimInstance). Теперь источник один — этот файл, а остановка одна
// команда: `npm stop`.
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

const ROOT = path.join(__dirname, '..', '..');

// путь замка можно переопределить переменной окружения: этим пользуется
// самопроверка (SYSTEM/server-lock-check.js), чтобы не трогать настоящий
// замок работающего сервера
const LOCK_FILE = process.env.SERVER_LOCK_FILE || path.join(ROOT, 'DATA', 'server.lock');

// «замок занят» — отдельный код выхода: по нему сторож понимает, что ждать
// правок бессмысленно (как и «порт занят»)
const EXIT_LOCK_HELD = 4;

// пульс: работающий сервер обновляет время правки файла раз в HEARTBEAT_MS.
// Свежий пульс — «кто-то работает», второй экземпляр не поднимаем. Молчит дольше
// STALE_MS — прошлый процесс упал, не подчистив за собой: замок можно
// перехватить. PID для этого не годится: Windows и WSL — разные пространства
// процессов, чужой PID в них ничего не значит
const HEARTBEAT_MS = 3000;
const STALE_MS = HEARTBEAT_MS * 4;

let heartbeat = null; // таймер пульса, пока замок наш

// ---------- чтение ----------

// кто в замке: {watchdog, child, startedAt}. null — замка нет.
// Старый формат (просто pid) тоже читается: файл живёт в DATA/ и мог остаться
// от прежней версии — молчащий замок мы и так перехватываем
function read() {
    try {
        const raw = fs.readFileSync(LOCK_FILE, 'utf8').trim();
        if (!raw) return null;
        if (raw.startsWith('{')) {
            const data = JSON.parse(raw);
            return {
                watchdog: Number(data.watchdog) || null,
                child: Number(data.child) || null,
                platform: data.platform || null,
                host: data.host || null,
                startedAt: data.startedAt || null,
            };
        }
        return { watchdog: null, child: Number(raw) || null, platform: null, host: null, startedAt: null };
    } catch {
        return null;
    }
}

// сколько миллисекунд прошло с последнего пульса; null — замка нет
function heartbeatAge() {
    try {
        return Math.max(0, Date.now() - fs.statSync(LOCK_FILE).mtimeMs);
    } catch {
        return null;
    }
}

// жив ли процесс: signal 0 — проверка без убийства. EPERM — процесс есть,
// просто не наш: считаем живым
function isAlive(pid) {
    if (!pid) return false;
    if (process.platform === 'linux') {
        try {
            const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
            const state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3);
            if (state === 'Z' || state === 'X') return false;
        } catch (err) {
            if (err.code === 'ENOENT') return false;
        }
    }
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return err.code === 'EPERM';
    }
}

// ---------- захват и снятие ----------

// что сказать человеку, когда запуск отказали: сервер из другой среды
// останавливают там, а не здесь
function hintFor(holder) {
    if (holder?.platform && holder.platform !== process.platform) {
        return `It runs in another environment (${holder.platform}) — stop it there.`;
    }
    return 'Stop it with: npm stop';
}

// Замок занимает сервер — тот, кто держит порт и базу. Сторож передаёт свой
// pid через SERVER_WATCHDOG_PID: без него остановить дерево целиком нечем —
// в замке лежит pid того, кто реально работает.
function acquire({ watchdogPid = null } = {}) {
    const age = heartbeatAge();
    if (age !== null && age < STALE_MS) {
        return { ok: false, age, holder: read() };
    }
    fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true });
    fs.writeFileSync(LOCK_FILE, JSON.stringify({
        watchdog: watchdogPid,
        child: process.pid,
        // среда, из которой замок взят: Windows и WSL — разные пространства
        // процессов, и pid из другой среды здесь ничего не значит. По этой же
        // причине чужой замок не трогают (см. stop)
        platform: process.platform,
        host: os.hostname(),
        startedAt: new Date().toISOString(),
    }));
    startHeartbeat();
    return { ok: true };
}

// Снять замок, если он наш: чужой не трогаем — на Windows и в WSL сервер может
// работать в одной среде, а остановка идти из другой
function release(childPid = null) {
    stopHeartbeat();
    const holder = read();
    if (!holder) return false;
    if (childPid && holder.child !== childPid) return false;
    try {
        fs.unlinkSync(LOCK_FILE);
        return true;
    } catch {
        return false;
    }
}

function startHeartbeat() {
    stopHeartbeat();
    heartbeat = setInterval(() => {
        try { fs.utimesSync(LOCK_FILE, new Date(), new Date()); } catch { /* пропустим удар — догоним следующим */ }
    }, HEARTBEAT_MS);
    heartbeat.unref(); // пульс не должен держать процесс живым
}

function stopHeartbeat() {
    if (!heartbeat) return;
    clearInterval(heartbeat);
    heartbeat = null;
}

// Сервер не должен переживать сторожа: сторож его поднимает и гасит, а без
// него сервер остаётся один — порт и база заняты, второй не поднять, и
// прежний остановочный ритуал (Get-CimInstance по имени node.exe) остаётся
// единственным выходом. pid сторожа лежит в замке — сторож передал его при
// запуске. Событие 'disconnect' при смерти родителя на Windows не приходит
// (проверено: канал IPC молчит), поэтому сторожа мы спрашиваем сами — раз в
// две секунды. beforeExit — то, что сервер должен успеть сделать до смерти
// (телеграм отпустить, чтобы следующий запуск не получил Conflict)
function dieWithParent(beforeExit) {
    const watchdog = read()?.watchdog;
    if (!watchdog) return; // сервер запущен один: сторожа нет, и умирать некому
    let done = false;
    const die = async () => {
        if (done) return;
        done = true;
        if (beforeExit) {
            try { await beforeExit(); } catch { /* уходящему процессу нечего терять */ }
        }
        release(process.pid);
        process.exit(0);
    };
    process.on('disconnect', die);
    setInterval(() => { if (!isAlive(watchdog)) die(); }, 2000).unref();
}

// ---------- остановка ----------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Остановка работающего экземпляра — один порядок для всех: и Ctrl+C в
// терминале, и команда `npm stop`, и умерший сторож. Гасим сторож первым: он
// следит за файлами и, увидев смерть ребёнка, поднял бы нового — а нам нужна
// тишина. Потом ребёнка и ждём его смерти: пока он жив, порт и база заняты.
async function stop({ timeoutMs = 10000 } = {}) {
    const age = heartbeatAge();
    if (age === null) return { stopped: false, reason: 'not-running', killed: [] };

    const holder = read();
    if (!holder) {
        // файл есть, а прочитать его нельзя (пустой или битый) — сервера за ним
        // нет, иначе пульс был бы свежим и файл переписывался бы
        try { fs.unlinkSync(LOCK_FILE); } catch { /* нечего снимать */ }
        return { stopped: false, reason: 'stale', removed: true, killed: [] };
    }
    if (age >= STALE_MS) {
        // пульс молчит давно: сервера уже нет, остался только файл
        release(null);
        return { stopped: false, reason: 'stale', holder, removed: true, killed: [] };
    }
    // пульс свежий, а замок взят в другой среде (Windows против WSL): там pid
    // из другого пространства процессов, и его нельзя ни убить, ни проверить.
    // Такой замок не трогаем — снять его значило бы разрешить поднять второй
    // сервер поверх работающего
    if (holder?.platform && holder.platform !== process.platform) {
        return { stopped: false, reason: 'other-environment', holder, killed: [] };
    }

    const pids = [holder.watchdog, holder.child].filter(Boolean);
    const killed = pids.filter((pid) => isAlive(pid) && kill(pid));

    // ждём, пока процессы исчезнут: мёртвый ребёнок отпускает порт
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && pids.some((pid) => isAlive(pid))) await sleep(100);

    // не умерли — добиваем: иначе порт остался бы занят
    for (const pid of pids) {
        if (isAlive(pid)) {
            kill(pid, 'SIGKILL');
            killed.push(pid);
        }
    }
    release(holder.child);
    // сторож мог успеть поднять нового ребёнка и переписать замок — тогда
    // снятие по прежнему pid не сработает. Снимаем, если в замке мёртвые pid:
    // живого держателя мы не трогаем
    const left = read();
    if (left && !isAlive(left.child) && !isAlive(left.watchdog)) {
        try { fs.unlinkSync(LOCK_FILE); } catch { /* нечего снимать */ }
    }
    return { stopped: true, reason: killed.length ? 'stopped' : 'already-dead', holder, killed };
}

function kill(pid, signal = 'SIGTERM') {
    try {
        process.kill(pid, signal);
        return true;
    } catch {
        return false;
    }
}

// занят ли порт: после остановки это главный вопрос — «а остановилось ли?».
// Соединение, которое не отвергли, считаем занятым: осторожность здесь дороже
// правды
function portBusy(port) {
    return new Promise((resolve) => {
        const socket = net.connect({ host: '127.0.0.1', port });
        const done = (value) => { socket.destroy(); resolve(value); };
        socket.setTimeout(1000);
        socket.on('connect', () => done(true));
        socket.on('timeout', () => done(true));
        socket.on('error', () => done(false));
    });
}

module.exports = {
    LOCK_FILE, EXIT_LOCK_HELD, HEARTBEAT_MS, STALE_MS,
    read, heartbeatAge, isAlive, hintFor, acquire, release, dieWithParent, stop, portBusy,
};
