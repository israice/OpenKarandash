// Hermes как исполнитель: строка в таблице AGENTS сервера.
//
// Отличие от Claude и OpenCode только в том, как его зовут и что он печатает.
// Наружу — тот же поток событий (session|text|error|done), поэтому вкладка Chat,
// панель сессий и Hermes-оркестратор работают с ним, ничего про него не зная.
//
// Обе системы: сервер на Windows видит и свою установку, и WSL-копию (через
// `wsl.exe bash -lc`), сервер в WSL — свою. Установка у каждой системы отдельная
// (SYSTEM/Hermes/runtime/<win|wsl>), см. DOCS/decisions/008.

const fs = require('fs');
const os = require('os');
const path = require('path');
const setup = require('./hermes-setup.js');

const ROOT = path.join(__dirname, '..', '..');
const IS_WINDOWS = process.platform === 'win32';

const winBin = path.join(__dirname, 'runtime', 'win', 'venv', 'Scripts', 'hermes.exe');
const wslBinRelative = 'SYSTEM/Hermes/runtime/wsl/venv/bin/hermes';

// путь к проекту глазами WSL: сервер на Windows знает его как C:\..., а внутри
// виртуалки та же папка — /mnt/c/...
function wslProjectPath() {
    const drive = ROOT[0].toLowerCase();
    return `/mnt/${drive}${ROOT.slice(2).replace(/\\/g, '/')}`;
}

function shQuote(value) {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

// какие установки есть прямо сейчас. Список строится по файлам на диске, а не по
// предположениям: если окружение для системы не поставлено, её здесь нет
function targets() {
    const found = [];

    if (IS_WINDOWS) {
        if (fs.existsSync(winBin)) {
            found.push({ id: 'hermes-windows', label: 'Windows', kind: 'direct', bin: winBin });
        }
        const wslProject = wslProjectPath();
        found.push({
            id: 'hermes-wsl',
            label: 'WSL',
            kind: 'wsl',
            bin: `${wslProject}/${wslBinRelative}`,
            home: `${wslProject}/DATA/hermes`,
            cwd: wslProject,
        });
    } else if (fs.existsSync(setup.HERMES_BIN)) {
        found.push({ id: 'hermes-wsl', label: 'WSL', kind: 'direct', bin: setup.HERMES_BIN });
    }

    return found;
}

// в WSL-цель бинарник может быть не поставлен — проверить это с Windows дёшево не
// получится, поэтому detect честно говорит «установлен» только про то, что видит
// на своей файловой системе, а для чужой системы отвечает null
function detect() {
    return targets().map((target) => ({
        id: target.id,
        label: target.label,
        path: target.bin,
        installed: target.kind === 'wsl' && IS_WINDOWS ? null : fs.existsSync(target.bin),
    }));
}

// команда одного запуска. -z печатает ТОЛЬКО итоговый текст: ни баннера, ни
// спиннера, ни превью инструментов — разбирать нечего, и это единственный
// режим Hermes, рассчитанный на скрипты. --usage-file даёт отчёт о расходе
// (модель, токены, стоимость) — по нему потом видно, кто и чем выполнял
function command(target, prompt, { model, usageFile } = {}) {
    if (target.kind === 'wsl') {
        const line = [
            `cd ${shQuote(target.cwd)}`,
            [
                `HERMES_HOME=${shQuote(target.home)}`,
                shQuote(target.bin),
                model ? `--model ${shQuote(model)}` : '',
                `-z ${shQuote(prompt)}`,
                usageFile ? `--usage-file ${shQuote(usageFile)}` : '',
            ].filter(Boolean).join(' '),
        ].join(' && ');
        return { cmd: 'wsl.exe', args: ['bash', '-lc', line], env: {} };
    }

    const args = [];
    if (model) args.push('--model', model);
    args.push('-z', prompt);
    if (usageFile) args.push('--usage-file', usageFile);
    return { cmd: target.bin, args, env: setup.childEnv() };
}

// временный файл под отчёт о расходе: кладём в системный temp, а не в проект —
// это мусор одного запуска, ему нечего делать среди файлов проекта
function usagePath() {
    return path.join(os.tmpdir(), `hermes-usage-${process.pid}-${Date.now()}.json`);
}

function readUsage(file) {
    try {
        const usage = JSON.parse(fs.readFileSync(file, 'utf8'));
        fs.unlinkSync(file);
        return usage;
    } catch {
        return null; // отчёта нет — запуск упал раньше, чем Hermes успел его написать
    }
}

module.exports = { targets, detect, command, usagePath, readUsage, wslProjectPath };
