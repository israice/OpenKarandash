// Коннектор omp CLI (omp, bun-установка на этой машине).
//
// Контракт на все CLI один (DOCS/decisions/017): своя цель запуска, свой список
// моделей, свой разбор потока — а разбор потока общий с pi (SYSTEM/cli/stream-core.js),
// потому что omp отдаёт тот же NDJSON: session, tool_execution_start/end,
// message_end с provider/model/usage. Проверено живьём на v18.6.0.
//
// Отличия от pi, и все три — по факту проверки на этой машине:
//
// - **Windows.** У omp настоящий бинарник omp.exe на PATH (bun ставит его в
//   ~/.bun/bin), а не npm-шим, поэтому spawn берёт его прямо: обходной путь из
//   pi.js с поиском входа пакета здесь не нужен. Если бинарника нет — цели нет в
//   списке вовсе, а не «найдена и падает при первом запуске».
// - **Список моделей.** Не `--list-models`, а подкоманда `models list`: печатает
//   таблицу с рамкой, где заголовок группы — «openrouter (561)», а в строках
//   модели уже без имени шлюза («stealth/space-bunny-alpha»). Шлюз берём из
//   заголовка группы и склеиваем обратно в «openrouter/stealth/…» — ровно в том
//   виде, какой потом принимает --model.
// - **Версия.** Печатается как «omp/18.6.0» — разбирает общий parseVersion.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { run } = require('./spawn.js');
const streamCore = require('./stream-core.js');

const OMP_BIN = process.env.OMP_BIN;
const OMP_ASK_TIMEOUT_MS = Number(process.env.OMP_ASK_TIMEOUT_MS) || Number(process.env.PI_ASK_TIMEOUT_MS) || 3_600_000;

// Из встроенных инструментов оставляем только читающие: у omp нет
// --permission-mode, и --tools является allowlist'ом сразу для всех инструментов
// (этим же списком гасятся расширения), поэтому обсуждение получается строгим
const OMP_CHAT_TOOLS = 'read,grep,find,ls';

// На Windows ищем сам omp.exe: where печатает найденные обёртки, берём первую,
// у которой расширение .exe — шимы (.cmd/.ps1) spawn без shell не запускает
// (Node 20.12 отвечает на них EINVAL), а shell здесь недопустим: промпт
// многострочный. Вне Windows — команда omp из PATH как есть.
function resolveOmpBinary() {
    if (process.platform !== 'win32') return 'omp';
    try {
        const found = execFileSync('where', ['omp'], { encoding: 'utf8' })
            .split('\n').map((line) => line.trim()).filter(Boolean);
        return found.find((file) => file.toLowerCase().endsWith('.exe') && fs.existsSync(file))
            || found.find((file) => fs.existsSync(file))
            || null;
    } catch {
        return null;
    }
}

// id цели — с префиксом omp-: все цели идут в общую колонку sessions.target, и
// совпадение id перепутало бы принадлежность сессии не тому CLI (agentNameByTarget)
function ompTargets() {
    if (OMP_BIN) return [{ id: 'omp-custom', label: 'OMP_BIN', cmd: OMP_BIN, args: [] }];
    const bin = resolveOmpBinary();
    if (!bin) return [];
    return [{ id: 'omp-windows', label: 'Windows', cmd: bin, args: [] }];
}

function create(deps) {
    // `omp models list` печатает по группам-шлюзам: заголовок «openrouter (561)»,
    // затем рамка с колонками context/max-out/thinking/images. Нам нужны только
    // имена моделей, и имя шлюза в них не входит — он берётся из заголовка группы
    // и склеивается обратно. Модели помечены префиксом «~» (нечёткое совпадение
    // для --model) — в нашем списке это значение, поэтому его снимаем: иначе
    // собранная строка модели не совпала бы с тем, что понимает CLI.
    async function fetchModels(target) {
        const stdout = await run(target.cmd, [...target.args, 'models', 'list'], { timeoutMs: 30000 }).catch(() => '');
        const models = [];
        let gateway = '';
        for (const line of String(stdout).split(/\r?\n/)) {
            const text = line.trim();
            if (!text) continue;
            const header = text.match(/^(\S+)\s+\(\d+\)$/);
            if (header) { gateway = header[1]; continue; }
            // строка модели начинается вертикальной рамкой таблицы; рамки-заголовки
            // и разделители отсеются сами, у них в первой ячейке не имя модели
            if (!text.startsWith('│')) continue;
            const name = text.slice(1).split('│')[0].trim();
            if (!name || /^-{2,}$/.test(name)) continue;
            const cleaned = name.replace(/^~/, '');
            if (!cleaned.includes('/')) continue;
            const value = gateway ? `${gateway}/${cleaned}` : cleaned;
            if (!models.includes(value)) models.push(value);
        }
        return models;
    }

    return streamCore.create(deps, {
        id: 'omp',
        run: (target, args, options) => run(target.cmd, [...target.args, ...args], options),
        targets: ompTargets,
        fetchModels,
        chatTools: OMP_CHAT_TOOLS,
        timeoutMs: OMP_ASK_TIMEOUT_MS,
    });
}

module.exports = { create, ompTargets };
