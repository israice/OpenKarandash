// Родительский процесс: сторож, который перезапускает сервер после правок
// серверных файлов, и общий замок от параллельного запуска.
//
// Почему это отдельный модуль, а не кусок server.js: в проекте работают два
// процесса. Родительский не обслуживает запросы — он только следит за файлами и
// держит дочерний живым, и поднимать его должен он, а не сервер
// (DOCS/decisions/020). Сервер при этом ничего не знает о стороже, кроме двух
// вещей: попросить перезапуск и получить отказ «уже перезапускаюсь».
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const hostDeps = require('./host-deps.js');

// коды выхода, по которым родительский процесс понимает, чего ждать бессмысленно:
// порт занят и занята DATA/server.lock. Правкой серверных файлов это не лечится
const EXIT_PORT_BUSY = 3;
const EXIT_LOCK_HELD = 4;

// корень проекта на два уровня выше: модуль лежит в SYSTEM/core
const ROOT = path.join(__dirname, '..', '..');
// общий замок: им пользуются и сторож (снимает мёртвому ребёнку), и сам сервер
const LOCK_FILE = path.join(ROOT, 'DATA', 'server.lock');

// ---------- сторож перезапуска ----------
//
// Node читает файл один раз при старте, поэтому сервер работает в дочернем процессе,
// а родительский следит за server.js и поднимает дочерний заново после правок.
//
// Запускается ли сторож — решает вызывающий (server.js): только в родительском
// процессе и только при включённой живой перезагрузке. В дочернем он не нужен,
// там наоборот нужен замок.
function run({ serverFile, pollMs, logExit }) {
    // папка данных: её раньше заводил модуль карты, а он подключается уже в
    // дочернем процессе. Родительскому она нужна для журнала выключений
    fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true });

    let child = null;
    let restarting = false;    // перезапуск запрошен: ждём от сервера «можно»
    let retryTimer = null;     // отложенный повторный запуск после падения
    let retries = 0;           // сколько раз подряд сервер упал — основа паузы

    // сервер подключает через require и серверные модули вне себя самого — их
    // правки тоже должны рестартовать сервер, иначе Node продолжает работать со
    // старой версией из памяти. Список собираем по правилам раскладки, а не руками:
    // перечисленный руками отставал от кода (PROJECTS/Sessions/pages-server.js и
    // SYSTEM/core/* в нём не было, и правка страниц молча не доезжала до сервера).
    //
    // Список перечитывается на каждом замере, а не собирается один раз при старте
    // сторожа: иначе модуль, заведённый уже после запуска, не попадал в него
    // никогда. Так и вышло с SYSTEM/core/typesafe.js и turn-judgment.js — сервер
    // сутки крутил бы их первую версию, а правки молча не доезжали, потому что
    // Node держит require-кэш до перезапуска процесса. Соседний замер файлов
    // моста читает свой список именно так, и по той же причине
    const serverModules = (dir) => {
        try {
            return fs.readdirSync(dir).filter((f) => f.endsWith('-server.js')).map((f) => path.join(dir, f));
        } catch {
            return []; // не папка или её нет — просто нечего смотреть
        }
    };
    const watchedFiles = () => {
        try {
            return [
                serverFile,
                ...fs.readdirSync(path.join(ROOT, 'PROJECTS')).flatMap((name) => serverModules(path.join(ROOT, 'PROJECTS', name))),
                ...serverModules(path.join(ROOT, 'SYSTEM')),
                ...fs.readdirSync(path.join(ROOT, 'SYSTEM/core')).map((f) => path.join(ROOT, 'SYSTEM/core', f)),
                // коннекторы CLI лежат своей папкой (DOCS/decisions/022) и правятся
                // так же часто, как остальное ядро: без этого их правки не доезжали
                // бы до сервера до ручного перезапуска
                ...fs.readdirSync(path.join(ROOT, 'SYSTEM/cli')).map((f) => path.join(ROOT, 'SYSTEM/cli', f)),
            ];
        } catch {
            return [serverFile]; // папку переименовывают прямо сейчас — замер не повод падать
        }
    };

    // сломанная правка не должна ронять сторожа вместе с сервером:
    // файл с синтаксической ошибкой не запускаем, старый процесс продолжает работать
    const isValid = () => {
        try {
            for (const file of watchedFiles()) execFileSync(process.execPath, ['--check', file], { stdio: 'ignore' });
            return true;
        } catch {
            console.error('one of the server files does not parse — keeping the previous version running');
            return false;
        }
    };

    // момент смерти выбирает не сторож, а сам сервер: он один знает, идёт ли сейчас
    // ход и не начинается ли новый прямо сейчас. Сторож только просит — и ждёт
    // ответа readyToRestart, сколько бы ни длились текущие ходы
    const restart = () => {
        if (!isValid()) return; // починят файл — mtime изменится, и мы придём сюда снова
        if (!child) return start(); // прошлый процесс упал сам — просто поднимаем заново
        if (restarting) return; // уже попросили: перезапустимся с последней версией файлов
        restarting = true;
        console.log('server file changed — restarting as soon as the current turns finish...');
        // канал мог закрыться, если процесс умирает прямо сейчас: без колбэка ошибка
        // прилетела бы событием 'error' на child и унесла сторожа вместе с сервером
        child.send({ prepareRestart: true }, () => {});
    };

    const start = () => {
        // сервер поднялся — пауза между повторами снова короткая
        if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
        retries = 0;
        child = spawn(process.execPath, [serverFile], {
            stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
            env: { ...process.env, SERVER_CHILD: '1' },
        });

        // Агент из чата правит файлы проекта, в том числе серверные. перезапуск
        // посреди работы убил бы запущенный CLI, поэтому гасим сервер только
        // по его собственному «можно»: к этому мгновению ходов нет, а новые он
        // уже не берёт — раньше между этими двумя событиями была щель, и запрос,
        // отправленный в неё, умирал вместе с процессом
        child.on('message', (message) => {
            if (message && message.readyToRestart) child.kill();
        });

        child.on('exit', (code, signal) => {
            // На Windows kill() — это TerminateProcess: сервер не успевает ничего
            // подчистить, и его замок DATA/server.lock лежит ещё STALE_MS. Запуск
            // следом в эти секунды отказывал «другая копия уже работает». Ребёнок
            // мёртв — значит, его замок заведомо ничей, снимаем его сами (только
            // свой: в файле лежит pid держателя)
            try {
                if (fs.readFileSync(LOCK_FILE, 'utf8').trim() === String(child.pid)) fs.unlinkSync(LOCK_FILE);
            } catch { /* замка нет или он чужой — не трогаем */ }
            child = null;
            // Правку самого сторожа ребёнок не исполнит: его код мы только что
            // погасили. Поднимаем новую копию себя и уходим — она берёт порт и
            // замок сама (замок ребёнка мы уже сняли строкой выше) и смотрит за
            // проектом уже своим, свежим списком файлов
            if (respawnSelf) {
                respawnSelf = false;
                logExit('watchdog code changed — restarting the watchdog itself');
                // пауза перед новой копией: порт и замок только что освободил
                // погашенный ребёнок, а поднявшийся сервер с портом, занятым хоть
                // на секунду, уходит с кодом «порт занят» и уносит сторожа следом
                setTimeout(() => {
                    spawn(process.execPath, [serverFile], { stdio: 'inherit' }).unref();
                    process.exit(0);
                }, 1500);
            }
            logExit(`child exited: code=${code} signal=${signal} restarting=${restarting}`);
            if (restarting) {
                restarting = false;
                start();
                return;
            }
            if (signal || code === 0) process.exit(0); // остановлен снаружи или завершился штатно
            // порт занят: правкой серверных файлов это не лечится, ждать нечего. иначе
            // сторож жил бы вечно — крутил опрос файлов и держал cwd проекта, из-за
            // чего папку проекта нельзя переименовать, пока процесс не убьют вручную
            if (code === EXIT_PORT_BUSY || code === EXIT_LOCK_HELD) process.exit(code);
            // упал сам (например, ошибка в коде): раньше сторож просто ждал правки
            // серверного файла, и страница оставалась мёртвой минутами — выглядело
            // именно как «перестала запускаться». Теперь поднимаем сервер сами,
            // с растущей паузой: файлы уже проверены на разбор (иначе не
            // перезапускаем — тогда правка придёт по опросу mtime), а повторяющиеся
            // падения не превращаются в плотный цикл
            console.error(`server crashed (code ${code}) — trying again shortly`);
            const delay = Math.min(5000 * (retries++ + 1), 60000);
            retryTimer = setTimeout(() => {
                retryTimer = null;
                if (child || restarting) return; // успели поднять — отмена
                if (!isValid()) return; // файл не разбирается: дождёмся правки по mtime
                start();
            }, delay);
            retryTimer.unref();
        });
    };

    // Родительский процесс — сам серверный код, и его правка (server.js, сам
    // watchdog.js) не доезжает до него самого: Node держит require-кэш до
    // перезапуска процесса. Список watchedFiles перечитывается на каждом
    // замере, но сам список написан в коде этого процесса — сторож, запущенный
    // до правки, её не знает и молча крутит прежнюю версию (так потерялось
    // наблюдение за папкой SYSTEM/cli, и правки коннекторов не доезжали часами,
    // а ход падал на TypeError из кода, которого на диске уже нет).
    //
    // Поэтому за изменениями собственных файлов сторож следит отдельно: увидев
    // их, он гасит ребёнка и поднимает новую копию себя — та берёт и порт, и
    // замок, и смотрит за проектом уже новым списком.
    const ownFiles = () => [__filename, serverFile];

    // непрочитанный файл пропускаем, а не бросаем весь замер: раньше на любую
    // ошибку statSync замер падал целиком и опрос молча выходил из строя навсегда.
    // Достаточно было переименовать любой из watched-файлов (screenshot.js →
    // karandash-server.js) — и сервер до конца дня продолжал крутить старый код
    const latestMtime = (files) => files.reduce((max, file) => {
        try {
            return Math.max(max, fs.statSync(file).mtimeMs);
        } catch {
            return max; // файла нет — его правку всё равно поймает соседний
        }
    }, 0);
    let mtime = latestMtime(watchedFiles());
    let ownMtime = latestMtime(ownFiles());
    // true — ребёнок погашен, и в его обработчике exit поднимается новая копия
    // сторожа. Флаг живёт вне restart(), потому что гасит он сам ребёнка.
    let respawnSelf = false;

    setInterval(() => {
        // сначала собственный код сторожа: перезапуск ребёнка его не обновляет,
        // и без этой проверки правка watchdog.js не доезжала бы никогда
        const currentOwn = latestMtime(ownFiles());
        if (currentOwn !== ownMtime) {
            ownMtime = currentOwn;
            if (isValid() && child) {
                console.log('the watchdog itself changed — handing over to a fresh copy...');
                respawnSelf = true;
                child.kill();
                return;
            }
            if (isValid() && !child) start(); // прошлый процесс упал — поднимаем с новым кодом
            return;
        }

        const current = latestMtime(watchedFiles());
        if (current === mtime) return;

        mtime = current;
        restart();
    }, pollMs);

    process.on('exit', (code) => logExit(`watchdog exit: code=${code}`));

    // Ctrl+C — кнопка «стоп» для сервера. Остановка синхронная: process.exit
    // не ждёт промисов
    const shutdown = (why) => {
        logExit(`watchdog got ${why}`);
        if (child) child.kill('SIGTERM');
        process.exit(0);
    };
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => shutdown(signal));

    // На Windows сигнала с клавиатуры может и не быть: консоль переходит в сырой
    // режим, и Ctrl+C перестаёт превращаться в событие — сторож живёт вечно.
    // Программный сигнал (GenerateConsoleCtrlEvent) при этом проходит. Поэтому
    // слушаем клавиатуру сами: в сыром режиме Ctrl+C приходит байтом 0x03
    // независимо от того, что сделали с консолью до нас. Режим переустанавливаем
    // раз в секунду — переключение false→true нужно, иначе setRawMode(true) при
    // уже «своём» сыром режиме ничего не делает
    if (process.platform === 'win32' && process.stdin.isTTY) {
        const arm = () => { try { process.stdin.setRawMode(false); process.stdin.setRawMode(true); } catch { /* консоль отобрали */ } };
        arm();
        process.stdin.resume();
        process.stdin.on('data', (chunk) => { if (chunk.includes(3)) shutdown('Ctrl+C (raw stdin)'); });
        setInterval(arm, 1000).unref();
    }

    // Системные зависимости хоста (git, python): чего нет — ставится,
    // SYSTEM/core/host-deps.js. HOST_DEPS=0 в .env выключает проверку.
    // Агентский CLI туда не входит: его подключает человек кнопкой в Settings
    if (process.env.HOST_DEPS !== '0') hostDeps.ensureHost();
    start();
}

// ---------- замок от параллельного запуска ----------
// Порт-гвард в http-server.js ловит вторую копию только на том же порту. Если у
// копий разные PORT в .env (например, Windows и WSL запущены одновременно с
// разными портами) или .env вовсе разные — обе поднимаются молча и дерутся за
// общие DATA/sessions.db, vault и телеграм-токен (Conflict от getUpdates). Порт
// тут не судья, а вот файл в DATA/ виден обеим сторонам одинаково — на нём и
// делаем общий замок, независимый от PORT.
//
// PID в замке не помогает: Windows и WSL — разные пространства процессов,
// чужой PID в них ничего не значит. Вместо этого держим «пульс» — раз в
// HEARTBEAT_MS обновляем время правки файла. Свежий пульс при старте значит
// «кто-то уже работает» — отказываем. Пульс не обновлялся дольше STALE_MS —
// прошлый процесс упал, не подчистив за собой, замок можно перехватить
const HEARTBEAT_MS = 3000;
const STALE_MS = HEARTBEAT_MS * 4;

function acquireLock() {
    const lockFile = LOCK_FILE;
    try {
        const age = Date.now() - fs.statSync(lockFile).mtimeMs;
        if (age < STALE_MS) {
            console.error(`Another OpenKarandash server is already holding ${lockFile} (last heartbeat ${Math.round(age / 1000)}s ago).`);
            console.error('Stop that instance first — running two at once fights over the database, the vault and the Telegram bot token.');
            process.exit(EXIT_LOCK_HELD);
        }
    } catch { /* замка ещё нет — первый запуск */ }
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    fs.writeFileSync(lockFile, String(process.pid));
    setInterval(() => {
        try { fs.utimesSync(lockFile, new Date(), new Date()); } catch { /* пропустим удар — догоним следующим */ }
    }, HEARTBEAT_MS).unref();
}

// сторож снимает замок упавшего ребёнка — путь к нему знает и он сам
module.exports = { run, acquireLock, EXIT_PORT_BUSY, EXIT_LOCK_HELD };