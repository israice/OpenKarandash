// Таблицы полей страницы Feed: какое поле карточки как подписать и чем
// напечатать (списки [путь, подпись, форматтер?]), а также что карточка рисует
// иначе и потому в таблицу не попадает. Отдельный файл потому, что это чистые
// данные — ни DOM, ни состояния страницы: ими пользуются и карточка сообщения,
// и сводная карточка сессии, а держать их в том же файле, где живёт отрисовка,
// значит читать таблицы ради правки разметки.
import {
    fmtTime, fmtNum, fmtCost, fmtDuration, fmtPercent, fmtBool, fmtEpoch,
} from './feed-format.js';

// известные поля сообщения (см. listMessages в SYSTEM/core/sessions-db.js) — подпись и то,
// как значение показать. Порядок здесь = порядок строк в карточке
const MESSAGE_SPECS = [
    ['createdAt', 'Time', fmtTime],
    // Event Schema (DOCS/decisions/040): кто прислал строку и что это было.
    // Стоят сразу за временем — это первое, что нужно знать о событии.
    // У строк, записанных до появления этих полей, они пустые и не рисуются
    ['source', 'Source'],
    ['actor', 'Actor'],
    ['eventType', 'Event type'],
    ['provider', 'Provider'],
    ['taskId', 'Task'],
    ['attemptId', 'Attempt'],
    ['model', 'Model'],
    ['effort', 'Effort'],
    ['inputTokens', 'Tokens (in)', fmtNum],
    ['outputTokens', 'Tokens (out)', fmtNum],
    ['cacheReadTokens', 'Tokens (cache read)', fmtNum],
    ['cacheCreationTokens', 'Tokens (cache write)', fmtNum],
    ['costUsd', 'Turn cost', fmtCost],
    ['durationMs', 'Turn duration', fmtDuration],
    ['stopReason', 'Stop reason'],
    ['toolUseId', 'tool_use_id'],
    ['parentToolUseId', 'parent_tool_use_id'],
    ['mode', 'Mode'],
    ['toolError', 'tool_error', fmtBool],
];
const TEXT_SPEC = ['text', 'Label (text)'];
// поля, которые карточка рисует не строкой таблицы, а иначе: блоком,
// картинкой или в заголовке — в таблице их дублировать не нужно
const MESSAGE_EXCLUDE = ['role', 'text', 'toolName', 'toolInput', 'toolResult', 'toolResultImages', 'inputSent', 'resultMeta', 'extraMeta', 'raw'];

const META_SPECS = [
    ['target', 'CLI (target)'],
    ['contextPercent', 'Context used', fmtPercent],
    ['contextWindow', 'Context window (tokens)', fmtNum],
];
const META_EXCLUDE = ['ok', 'messages', 'sessionInfo', 'rateLimit', 'usage', 'thumb'];
const INFO_SPECS = [
    ['cwd', 'Working directory (cwd)'],
    ['permissionMode', 'Permission mode'],
    ['model', 'Model (from init)'],
    ['apiKeySource', 'API key source'],
    ['claudeCodeVersion', 'Claude Code version'],
    ['outputStyle', 'Output style'],
    ['fastModeState', 'Fast mode'],
    ['fastModeDisabledReason', 'Fast mode: disabled reason'],
    ['analyticsDisabled', 'Analytics disabled', fmtBool],
    ['productFeedbackDisabled', 'Product feedback disabled', fmtBool],
    ['initUuid', 'Init event UUID'],
    ['messagingSocketPath', 'Messaging socket'],
];
// списки из init показываем и числом в таблице, и составом отдельным блоком
const LIST_SPECS = [
    ['tools', 'Tools allowed'],
    ['mcpServers', 'MCP servers connected'],
    ['slashCommands', 'Slash commands available'],
    ['terminalSlashCommands', 'Terminal slash commands'],
    ['agents', 'Subagents available'],
    ['skills', 'Skills available'],
    ['plugins', 'Plugins connected'],
    ['capabilities', 'Runtime capabilities'],
];
const COUNT_SPECS = LIST_SPECS.map(([key, label]) => [key, label, (v) => fmtNum(v.length)]);
const INFO_EXCLUDE = [...LIST_SPECS.map(([key]) => key), 'memoryPaths'];
const RATE_SPECS = [
    ['status', 'Limit: status'],
    ['rateLimitType', 'Limit: type'],
    ['overageStatus', 'Limit: overage status'],
    ['overageDisabledReason', 'Limit: overage disabled reason'],
    ['isUsingOverage', 'Limit: overage in use', fmtBool],
    ['resetsAt', 'Limit: reset (overall)', fmtEpoch],
];
// подписи окон лимита; окно, которого здесь нет, покажется своим ключом,
// а не пропадёт — набор окон задаёт сервер Anthropic, не мы
const WINDOW_LABELS = { five_hour: '5 hours', seven_day: '7 days' };
const USAGE_SPECS = [
    ['inputTokens', 'Tokens (in)', fmtNum],
    ['outputTokens', 'Tokens (out)', fmtNum],
    ['cacheReadTokens', 'Tokens (cache read)', fmtNum],
    ['cacheCreationTokens', 'Tokens (cache write)', fmtNum],
    ['costUsd', 'Total session cost', fmtCost],
    ['durationMs', 'Total session duration', fmtDuration],
];

export {
    MESSAGE_SPECS, TEXT_SPEC, MESSAGE_EXCLUDE,
    META_SPECS, META_EXCLUDE,
    INFO_SPECS, LIST_SPECS, COUNT_SPECS, INFO_EXCLUDE,
    RATE_SPECS, WINDOW_LABELS, USAGE_SPECS,
};