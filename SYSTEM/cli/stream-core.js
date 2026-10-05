// Общий разбор потока хода для CLI, которые говорят одним протоколом.
//
// Один контракт на все CLI (DOCS/decisions/017): коннектор отличается от соседнего
// только тем, как он запускает свой процесс и какими флагами зовёт модель. pi и omp
// отдают одинаковый NDJSON — session, tool_execution_start/end, message_end с
// provider/model/usage (проверено живьём на обоих), — поэтому разбор потока лежит
// здесь один раз, а не копией в каждом коннекторе: правка общего события иначе
// разошлась бы по двум файлам с первой же попытки.
//
// create(deps, spec):
//   deps — как у всех коннекторов (runTurn, resumeAndHandoff, db)
//   spec — что у CLI своё:
//     id          — имя коннектора в сообщениях об ошибке
//     run(target, args, options) — запуск с разбором цели по spawn.js
//     targets()   — цели запуска этого CLI на этой машине
//     fetchModels(target) — список моделей строками, как его отдаёт CLI
//     chatTools   — список читающих инструментов для режима Chat
//     timeoutMs   — сколько ждать ход (у openrouter длинные ответы — час с лишним)
const path = require('path');

// короткая подпись действия: «read index.html», «bash npm test»
function toolLabel(part) {
    const input = part.args || {};
    // от пути оставляем имя файла — в строке состояния важно «что», а не «где».
    // Ключ читаем и в camelCase (args.path), и в змеином (file_path): у разных
    // версий CLI поле называлось по-разному, а живой шаг остался бы голым тегом
    const detail = input.path || input.file_path
        ? path.basename(input.path || input.file_path)
        : input.command || input.pattern || input.url || '';
    return { type: 'tool', name: part.toolName || 'tool', detail: String(detail).slice(0, 120) };
}

// версия из строки вида «1.0.2» или «omp/18.6.0»
function parseVersion(stdout) {
    const match = String(stdout).match(/\d+\.\d+\.\d+/);
    return match ? match[0] : String(stdout).trim().split('\n')[0];
}

function create({ runTurn, resumeAndHandoff, db }, spec) {
    const { recordAssistantText, recordStep, setMessageToolResult, appendRaw, clip } = db;

    let activeTarget = null; // отдельная переменная на коннектор — иначе подключения затирают друг друга

    async function detectInstalls() {
        const checks = await Promise.allSettled(
            spec.targets().map(async (target) => ({
                id: target.id,
                label: target.label,
                version: parseVersion(await spec.run(target, ['--version'], { timeoutMs: 15000 })),
            }))
        );

        return checks.filter((c) => c.status === 'fulfilled').map((c) => c.value);
    }

    // PLACEHOLDER_ASK
}
