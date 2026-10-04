// Коннектор OpenCode CLI.
//
// Сознательно не переиспользует ничего Claude-специфичного — в проекте нет общей
// абстракции над CLI, это её осознанный отказ (см. решение 006 про один набор
// маршрутов на все CLI). Общими остаются только провайдеро-независимые вещи:
// таблицы sessions/messages и DB-хелперы, реестр идущих ходов runs (один на все
// провайдеры) и общая обвязка хода (SYSTEM/core/run-turn.js).
//
// create({ runTurn, resumeAndHandoff, db }): runTurn — общая обвязка хода,
// resumeAndHandoff — продолжение сессии и пересказ истории (SYSTEM/core/handoff.js),
// db — функции записи сообщений (SYSTEM/core/sessions-db.js).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { run } = require('./spawn.js');

const OPENCODE_BIN = process.env.OPENCODE_BIN;
const OPENCODE_ASK_TIMEOUT_MS = Number(process.env.OPENCODE_ASK_TIMEOUT_MS) || 3_600_000;

// версия из строки вида «2.1.245 (Claude Code)»
function parseVersion(stdout) {
    const match = stdout.match(/\d+\.\d+\.\d+/);
    return match ? match[0] : stdout.trim().split('\n')[0];
}

// короткая подпись действия: «Read index.html», «Bash npm test»
function toolLabel(part) {
    const input = part.input || {};
    // от пути оставляем имя файла — в строке состояния важно «что», а не «где».
    // Ключи читаем и Claude-стиля (file_path), и opencode-стиля (filePath/query):
    // read/edit у opencode шлют filePath, websearch — query, и без этих ключей
    // живой шаг остаётся голым тегом без содержимого
    const detail = part.name === 'Task' ? `${input.subagent_type || ''}: ${input.description || ''}`.trim()
        : input.file_path ? path.basename(input.file_path)
        : input.filePath ? path.basename(input.filePath)
        : input.command || input.pattern || input.url || input.query || '';
    return { type: 'tool', name: part.name, detail: String(detail).slice(0, 120) };
}

// Проект живёт на Windows, и CLI работает на той же машине — WSL-цели у коннектора
// больше нет (осталась от времён Claude-коннектора и только мешала: модель, выбранная
// в Settings, в WSL-сборке падала, и ход уходил чужой). Ищем бинарник в PATH, а при
// неудаче — по известным путям установки Windows и Linux.
//
// На Windows `where opencode` находит npm-шим (opencode.cmd), а spawn без shell такой
// файл не запускает — поэтому ищем настоящий .exe, а запасной путь берём из записи
// npm в PATH (проверено живьём: 1.18.34 отвечает, модель space-bunny-alpha
// в списке CLI есть).
function resolveOpenCodeBin(pathName, fallbackParts) {
    try {
        execFileSync(process.platform === 'win32' ? 'where' : 'which', [pathName], { stdio: 'ignore' });
        return pathName; // нашёлся в PATH
    } catch {
        for (const parts of fallbackParts) {
            const fallback = path.join(...parts.map((part) => (part === '@APPDATA' ? process.env.APPDATA || '' : part === '@HOME' ? os.homedir() : part)));
            if (fallback && fs.existsSync(fallback)) return fallback;
        }
        return pathName; // не нашли — оставляем как есть, ENOENT покажет run
    }
}

// id цели — с префиксом opencode-: все цели идут в общую колонку sessions.target, и
// совпадение id перепутало бы принадлежность сессии не тому CLI (agentNameByTarget)
function openCodeTargets() {
    if (OPENCODE_BIN) {
        return [{ id: 'opencode-custom', label: 'OPENCODE_BIN', cmd: OPENCODE_BIN, args: [] }];
    }
    return process.platform === 'win32'
        ? [{ id: 'opencode-windows', label: 'Windows', cmd: resolveOpenCodeBin('opencode.exe', [
            ['@APPDATA', 'npm', 'node_modules', 'opencode-ai', 'bin', 'opencode.exe'],
            ['@HOME', '.opencode', 'bin', 'opencode.exe'],
        ]), args: [] }]
        : [{ id: 'opencode-linux', label: 'Linux', cmd: resolveOpenCodeBin('opencode', [
            ['@HOME', '.opencode', 'bin', 'opencode'],
        ]), args: [] }];
}

// runOpenCode — запуск CLI построчным NDJSON, таймаут, Stop. Prompt идёт
// позиционным аргументом: opencode run читает его именно так (проверено вживую),
// stdin CLI не читает вовсе. Сам запуск — через spawn.js, локальный или через
// exec-bridge, коннектору без разницы
function runOpenCode(target, cliArgs, options) {
    return run(target.cmd, [...target.args, ...cliArgs], options);
}

function create({ runTurn, resumeAndHandoff, db }) {
    const { recordAssistantText, recordStep, setMessageToolResult, appendRaw, clip } = db;

    let activeTarget = null; // отдельная переменная от activeTarget Claude — иначе подключения затирают друг друга

    async function detectInstalls() {
        const checks = await Promise.allSettled(
            openCodeTargets().map(async (target) => ({
                id: target.id,
                label: target.label,
                version: parseVersion(await runOpenCode(target, ['--version'], { timeoutMs: 15000 })),
            }))
        );

        return checks.filter((c) => c.status === 'fulfilled').map((c) => c.value);
    }

    // список моделей — реальный, не хардкод: `opencode models` без флагов формата
    // печатает плоский текстовый список `provider/model`, по строке на модель
    // (проверено вживью — 6 бесплатных моделей opencode/* без авторизации)
    async function fetchModels(target) {
        const stdout = await runOpenCode(target, ['models'], { timeoutMs: 15000 });
        return stdout.trim().split('\n').map((line) => line.trim()).filter(Boolean);
    }

    async function ask({ prompt, model, sessionId, mode, hints, plan }, send) {
        if (!activeTarget) return send({ type: 'error', error: 'OpenCode is not connected' });
        const target = activeTarget;
        if (!prompt) return send({ type: 'error', error: 'Empty request' });

        const { resumeId, handoff } = await resumeAndHandoff(sessionId, target.id, hints, plan, prompt);
        const args = ['run', handoff + prompt, '--format', 'json'];
        if (model) args.push('--model', model);
        if (resumeId) args.push('--session', resumeId);
        // у OpenCode нет проверенного аналога --permission-mode/--disallowedTools у Claude
        // (см. память команды) — режим Chat/Action пока только помечает строки в базе
        // (mode-колонка), инструменты CLI на уровне флагов не ограничивает

        return runTurn({ target, prompt, sessionId, model, mode, plan }, send, async (ctx) => {
            let cliSessionSeen = false;
            // callID вызова инструмента -> позиция строки шага: tool_use приходит дважды
            // на один callID (сперва running, потом completed), вторая запись только
            // дописывает tool_result в ту же строку
            const toolPositions = new Map();

            const onLine = (line) => {
                let event;
                try {
                    event = JSON.parse(line);
                } catch {
                    return; // не JSON — служебный вывод CLI
                }

                // sessionID лежит в каждом событии (не только в первом, как у Claude) —
                // связываем его с нашей сессией один раз, для «--session» этого же CLI
                if (event.sessionID && !cliSessionSeen) {
                    cliSessionSeen = true;
                    ctx.begin(event.sessionID);
                }

                if (event.type === 'text' && event.part?.text?.trim()) {
                    ctx.answer = event.part.text;
                    if (ctx.session) ctx.assistantPosition = recordAssistantText(ctx.session, event.part.text, ctx.meta.model, null, null, event.part);
                    ctx.emit({ type: 'text', text: event.part.text });
                    return;
                }

                if (event.type === 'tool_use' && event.part) {
                    const part = event.part;
                    const toolName = part.tool || 'tool';
                    const state = part.state || {};
                    let position = toolPositions.get(part.callID);
                    if (position === undefined && ctx.session) {
                        // подпись та же, что уходит в живую ленту (toolLabel), а не своя
                        // сборка: иначе строка в базе «read …» и живой шаг разъезжаются,
                        // и после перечитывания лента показывает другой текст
                        const step = toolLabel({ name: toolName, input: state.input || {} });
                        // у opencode title приходит отдельно от input — запасная деталь
                        // для шагов, чьи аргументы не знает toolLabel
                        if (!step.detail && state.title) step.detail = String(state.title).slice(0, 120);
                        position = recordStep(ctx.session, `${step.name} ${step.detail}`.trim(), toolName, state.input, part.callID, null, null, part);
                        toolPositions.set(part.callID, position);
                        ctx.emit(step);
                    }
                    if (position !== undefined && ctx.session && (state.status === 'completed' || state.status === 'error')) {
                        const output = typeof state.output === 'string' ? state.output : JSON.stringify(state.output ?? '');
                        setMessageToolResult.run(clip(output), state.status === 'error' ? 1 : 0, null, ctx.session, position);
                        appendRaw(ctx.session, position, part);
                    }
                    return;
                }

                if (event.type === 'step_finish' && event.part) {
                    const tokens = event.part.tokens || {};
                    ctx.meta.usage.inputTokens += tokens.input || 0;
                    ctx.meta.usage.outputTokens += tokens.output || 0;
                    ctx.meta.usage.cacheReadTokens += tokens.cache?.read || 0;
                    ctx.meta.usage.cacheCreationTokens += tokens.cache?.write || 0;
                    if (typeof event.part.cost === 'number') ctx.meta.costUsd = (ctx.meta.costUsd || 0) + event.part.cost;
                    if (event.part.reason) ctx.meta.stopReason = event.part.reason;
                    return;
                }

                if (event.type === 'error') {
                    // ошибка хода приходит внутри потока, а не кодом возврата процесса
                    // (проверено вживую — запуск с несуществующей моделью завершился кодом 0)
                    ctx.fail(event.error?.data?.message || event.error?.name || 'OpenCode returned an error');
                    return;
                }

                // step_start и прочие неразобранные события: у OpenCode нет аналога
                // thinking/rate_limit, своей ветки в общей схеме под них нет
            };

            await runOpenCode(target, args, {
                timeoutMs: OPENCODE_ASK_TIMEOUT_MS, onLine,
                onSpawn: (child) => { ctx.run.child = child; },
            });
        });
    }

    return {
        targets: openCodeTargets,
        detect: detectInstalls,
        version: (target) => runOpenCode(target, ['--version'], { timeoutMs: 15000 }).then(parseVersion),
        // список моделей отдаёт сам CLI — заранее знать его нельзя
        models: fetchModels,
        activate: (target) => { activeTarget = target; },
        connected: () => Boolean(activeTarget),
        ask,
    };
}

module.exports = { create };