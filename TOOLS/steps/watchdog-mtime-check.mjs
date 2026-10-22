// Самопроверка сторожа (записка 135): правка, замеченная в момент, когда
// isValid() падает на полузаписанном соседнем файле, не должна теряться —
// срез mtime потребляется только после успешного запроса перезапуска.
// Лаборатория полная: в temp собирается своё дерево, копируется настоящий
// SYSTEM/core/watchdog.js (ROOT у сторожа считается от своего __dirname),
// замок уводится переменной SERVER_LOCK_FILE, живой сервер и живой сторож
// не затрагиваются. Ребёнок — заглушка: на prepareRestart отвечает
// readyToRestart и штампует каждый свой старт; рост штампов = перезапуск.
import { spawn, execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lab = (() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-lab-'));
    const p = (...x) => path.join(dir, ...x);
    fs.mkdirSync(p('PROJECTS'));
    fs.mkdirSync(p('SYSTEM', 'core'), { recursive: true });
    fs.mkdirSync(p('SYSTEM', 'cli'), { recursive: true });
    const coreSrc = path.dirname(fileURLToPath(new URL('../../SYSTEM/core/watchdog.js', import.meta.url)));
    // только то, что сторожу нужно импортом: замер isValid запускает node --check
    // на каждый наблюдаемый файл — чем их меньше, тем быстрее тик (полная папка
    // core добавляла к замеру секунды, и проверка не дожидалась перезапуска)
    for (const name of ['watchdog.js', 'server-lock.js', 'host-deps.js']) {
        fs.copyFileSync(path.join(coreSrc, name), p('SYSTEM', 'core', name));
    }
    fs.writeFileSync(p('SYSTEM', 'cli', 'target.js'), 'exports.x = 1;\n');
    fs.writeFileSync(p('server.js'), [
        'const fs = require("fs");',
        'fs.appendFileSync(process.env.LAB_STAMP, Date.now() + "\\n");',
        'process.on("message", (m) => {',
        '    if (m && m.prepareRestart) { fs.appendFileSync(process.env.LAB_STAMP, Date.now() + "\\n"); process.send({ readyToRestart: true }); }',
        '});',
        'setInterval(() => {}, 1000);',
    ].join('\n'));
    fs.writeFileSync(p('dog.js'), [
        'const w = require("./SYSTEM/core/watchdog.js");',
        'w.run({',
        `    serverFile: ${JSON.stringify(p('server.js'))},`,
        '    pollMs: 40,',
        `    logExit: (m) => require("fs").appendFileSync(process.env.LAB_LOG, m + "\\n"),`,
        '});',
    ].join('\n'));
    return { dir, p, stamp: p('stamps.log') };
})();

const dog = spawn(process.execPath, [lab.p('dog.js')], {
    env: { ...process.env, LAB_STAMP: lab.stamp, SERVER_LOCK_FILE: lab.p('lock.file'), HOST_DEPS: '0' },
    stdio: 'ignore',
});
dog.on('error', (e) => console.error(`FAIL dog: ${e.message}`));

const assert = (name, cond) => {
    if (!cond) { console.error(`FAIL ${name}`); process.exitCode = 1; return; }
    console.log(`ok ${name}`);
};
const stamps = () => (fs.existsSync(lab.stamp) ? fs.readFileSync(lab.stamp, 'utf8').split(/\r?\n/).filter(Boolean).length : 0);

try {
    await sleep(800);
    const before = stamps();
    fs.writeFileSync(lab.p('SYSTEM', 'core', 'broken.js'), 'это не javascript ({{{');
    await sleep(200); // полузапись уже зреет, когда замечают правку
    fs.utimesSync(lab.p('SYSTEM', 'cli', 'target.js'), new Date(), new Date());
    await sleep(1500); // несколько тиков на замечание и провал isValid
    assert('сломанное дерево не перезапускается', stamps() === before);
    fs.unlinkSync(lab.p('SYSTEM', 'core', 'broken.js')); // починка: touch'а target больше не было
    await sleep(2500);
    assert('после починки правка всё же доходит', stamps() > before);
} catch (err) {
    console.error(`FAIL uncaught: ${err.message}`);
    process.exitCode = 1;
} finally {
    try { execFileSync('taskkill', ['/PID', String(dog.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* уже умер */ }
    try { fs.rmSync(lab.dir, { recursive: true, force: true }); } catch { /* Windows держит файл — не страшно */ }
}
