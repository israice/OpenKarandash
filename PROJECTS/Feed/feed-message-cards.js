// Карточки ленты Feed по данным события: сводка по всей сессии
// (contextPercent/sessionInfo/rateLimit/usage) и карточка одного сообщения —
// с разбором ролей (tool/hook/thinking/system/unknown/top_level/ответ модели).
// Отдельный файл потому, что это разбор протокола события, а не рисование:
// примитивы карточек (аккордеон, блоки, таблица полей) лежат в feed-cards.js и
// приходят сюда аргументом, списки подписей полей — в feed-fields.js. Раньше всё
// это было в одном файле вместе со сборкой страницы.
import {
    fmtTime, fmtCost, fmtPercent, fmtEpoch, fmtShare, truncate, prettyJson,
} from './feed-format.js';
import {
    MESSAGE_SPECS, TEXT_SPEC, MESSAGE_EXCLUDE,
    META_SPECS, META_EXCLUDE,
    INFO_SPECS, COUNT_SPECS, INFO_EXCLUDE,
    RATE_SPECS, WINDOW_LABELS, USAGE_SPECS,
} from './feed-fields.js';

export function createFeedMessageCards({ addCard, addBlock, addImages, addKv }) {
    // карточка-сводка по всей сессии: contextPercent/sessionInfo/rateLimit/usage —
    // раньше эти поля вообще не читались на этой странице
    function addSessionMetaCard(container, meta) {
        const info = meta.sessionInfo || {};
        const rate = meta.rateLimit || {};
        const windows = rate.unifiedWindows || {};
        const usage = meta.usage || {};
        const tools = Array.isArray(info.tools) ? info.tools : [];
        const mcpServers = Array.isArray(info.mcpServers) ? info.mcpServers : [];
        const slashCommands = Array.isArray(info.slashCommands) ? info.slashCommands : [];
        const terminalSlashCommands = Array.isArray(info.terminalSlashCommands) ? info.terminalSlashCommands : [];
        const agents = Array.isArray(info.agents) ? info.agents : [];
        const skills = Array.isArray(info.skills) ? info.skills : [];
        const capabilities = Array.isArray(info.capabilities) ? info.capabilities : [];
        const plugins = Array.isArray(info.plugins) ? info.plugins : [];

        addCard(container, {
            icon: 'meta',
            title: 'Whole session',
            subtitle: `context ${fmtPercent(meta.contextPercent)} · ${fmtCost(usage.costUsd)}`,
            extraClass: 'session-feed__card--meta',
        }, (body) => {
            // окна лимита строим по тем, что реально пришли: появится новое —
            // покажется само, своим ключом, а не потеряется
            const windowSpecs = Object.keys(windows).flatMap((key) => [
                [`unifiedWindows.${key}.utilization`, `Limit ${WINDOW_LABELS[key] || key}: used`, fmtShare],
                [`unifiedWindows.${key}.resetsAt`, `Limit ${WINDOW_LABELS[key] || key}: reset`, fmtEpoch],
            ]);
            addKv(body, [
                { source: meta, specs: META_SPECS, exclude: META_EXCLUDE },
                { source: info, specs: INFO_SPECS, exclude: INFO_EXCLUDE },
                { source: { tools, mcpServers, slashCommands, terminalSlashCommands, agents, skills, plugins, capabilities }, specs: COUNT_SPECS },
                { source: rate, specs: [...RATE_SPECS, ...windowSpecs], exclude: ['unifiedWindows'] },
                { source: usage, specs: USAGE_SPECS },
            ]);
            addBlock(body, `Allowed tools (${tools.length})`, tools.join(', '));
            addBlock(body, `MCP servers (${mcpServers.length})`, mcpServers.join(', '));
            addBlock(body, `Slash commands (${slashCommands.length})`, slashCommands.join(', '));
            addBlock(body, `Terminal slash commands (${terminalSlashCommands.length})`, terminalSlashCommands.join(', '));
            addBlock(body, `Subagents (${agents.length})`, agents.join(', '));
            addBlock(body, `Skills (${skills.length})`, skills.join(', '));
            addBlock(body, `Runtime capabilities (${capabilities.length})`, capabilities.join(', '));
            addBlock(body, `Plugins (${plugins.length})`, plugins.length ? prettyJson(JSON.stringify(plugins)) : '');
            if (info.memoryPaths) addBlock(body, 'Memory paths (memory_paths)', prettyJson(JSON.stringify(info.memoryPaths)));
            if (meta.thumb) {
                const thumbLabel = document.createElement('div');
                thumbLabel.className = 'session-feed__block-label';
                thumbLabel.textContent = 'Preview (thumb)';
                const img = document.createElement('img');
                img.className = 'session-feed__thumb';
                img.src = meta.thumb;
                img.alt = 'Session preview';
                body.append(thumbLabel, img);
            }
        });
    }

    // одна карточка на сообщение — заголовок для быстрой ориентации без
    // раскрытия, тело — все поля целиком (текст/аргументы/результат/
    // модель/токены/стоимость/stopReason/id вызовов), ничего не обрезаем
    // и не прячем: до этой правки страница показывала только message.text
    // (для tool — короткую метку вида "Bash ..."), остальное приходило
    // с сервера, но на экране не появлялось
    function addMessageCard(container, message) {
        // withText — роли, где message.text не уходит в отдельный блок,
        // а служит короткой меткой (инструмент, хук, системное событие)
        const kv = (body, withText) => addKv(body, [{
            source: message,
            specs: withText ? [TEXT_SPEC, ...MESSAGE_SPECS] : MESSAGE_SPECS,
            exclude: MESSAGE_EXCLUDE,
        }]);

        // сырое событие показываем у карточки любой роли, а не только у той,
        // которую сервер не разобрал: в нём и лежит страховка от неполного
        // разбора (DOCS/decisions/040, этап 2). Обёртка нужна, чтобы блок
        // добавлялся сам во всех ветках — иначе новую ветку забудут дописать
        const card = (opts, fillBody) => addCard(container, opts, (body) => {
            fillBody(body);
            if (message.raw) addBlock(body, 'Raw event (raw)', prettyJson(message.raw));
        });

        if (message.role === 'tool') {
            card({
                icon: 'tool',
                title: message.toolName || 'Tool',
                subtitle: message.toolError ? 'error' : fmtTime(message.createdAt),
                extraClass: `session-feed__card--tool session-feed__card--dense${message.toolError ? ' session-feed__card--error' : ''}`,
            }, (body) => {
                kv(body, true);
                addBlock(body, 'Arguments (toolInput)', prettyJson(message.toolInput));
                addBlock(body, 'Result (toolResult)', message.toolResult, message.toolError ? 'session-feed__block--error' : '');
                addImages(body, message.toolResultImages);
                if (message.extraMeta) addBlock(body, 'Extra metadata (caller etc.)', prettyJson(message.extraMeta));
            });
            return;
        }

        if (message.role === 'hook') {
            card({
                icon: 'hook',
                title: message.toolName || message.text || 'Hook',
                subtitle: message.toolError ? 'error' : fmtTime(message.createdAt),
                extraClass: `session-feed__card--hook session-feed__card--dense${message.toolError ? ' session-feed__card--error' : ''}`,
            }, (body) => {
                kv(body, true);
                addBlock(body, 'hook_id / hook_event (toolInput)', prettyJson(message.toolInput));
                addBlock(body, 'Hook output (stdout/stderr/output)', message.toolResult, message.toolError ? 'session-feed__block--error' : '');
                if (message.extraMeta) addBlock(body, 'Extra metadata (extra_meta)', prettyJson(message.extraMeta));
            });
            return;
        }

        if (message.role === 'thinking') {
            card({
                icon: 'thinking',
                title: 'Reasoning',
                subtitle: `${truncate(message.text, 60)} · ${fmtTime(message.createdAt)}`,
                extraClass: 'session-feed__card--thinking session-feed__card--dense',
            }, (body) => {
                kv(body, false);
                addBlock(body, 'Reasoning text', message.text);
                if (message.extraMeta) addBlock(body, 'Extra metadata (signature etc.)', prettyJson(message.extraMeta));
            });
            return;
        }

        // system/unknown/top_level — три уровня перехвата на сервере
        // (SYSTEM/core/sessions-db.js: recordSystemEvent/recordUnknownPart/recordTopLevelEvent):
        // неразобранный подтип system-события, неразобранный тип части ответа,
        // и, наконец, вообще неразобранный верхнеуровневый event.type (например,
        // control_response/interrupt-хендшейк, который CLI заявляет в
        // capabilities, но живым тестом не проверялся) — раньше любой из этих
        // трёх случаев пропадал молча, теперь виден целиком сырым JSON
        if (message.role === 'system' || message.role === 'unknown' || message.role === 'top_level') {
            const titleByRole = {
                system: 'System event',
                unknown: 'Unrecognized event',
                top_level: 'Event of unknown type',
            };
            card({
                icon: message.role === 'top_level' ? 'unknown' : message.role,
                // у пометки хода (recordNotice в SYSTEM/core/sessions-db.js) имя источника — в toolName,
                // а что произошло — в text: в заголовке нужны оба
                title: [message.toolName, message.text !== message.toolName ? truncate(message.text, 120) : '']
                    .filter(Boolean).join(' — ') || titleByRole[message.role],
                subtitle: fmtTime(message.createdAt),
                extraClass: `session-feed__card--${message.role === 'top_level' ? 'unknown' : message.role} session-feed__card--dense`,
            }, (body) => {
                kv(body, true);
                addBlock(body, 'Raw event (toolInput)', prettyJson(message.toolInput));
                // откуда строка: id сообщения в CLI, дочерняя сессия помощника и т.п.
                if (message.extraMeta) addBlock(body, 'Extra metadata (extra_meta)', prettyJson(message.extraMeta));
            });
            return;
        }

        const kind = message.role === 'user' ? 'user' : 'assistant';
        const isError = message.stopReason === 'error';
        // ответ, данный внутри вызова помощника (parent_tool_use_id), — не ответ основной модели
        const who = kind === 'user' ? 'You' : (message.parentToolUseId ? 'Subagent' : 'Assistant');
        card({
            icon: kind,
            title: `${who}${isError ? ' · turn error' : ''}`,
            subtitle: `${truncate(message.text, 60)} · ${fmtTime(message.createdAt)}`,
            // подпись моделью — по полю самой строки: ход мог вести другая
            // модель, а выбранная в шапке сессии относится к следующему ходу
            model: kind === 'assistant' ? message.model : null,
            extraClass: `session-feed__card--${kind}${isError ? ' session-feed__card--error' : ''}`,
        }, (body) => {
            // пометка суждения о ходе — первой строкой тела карточки: то же,
            // что в Sessions и на ноде Flow, одним общим SYSTEM/judgment-badge.js
            const mark = window.TurnJudgment?.badge(message.resultMeta);
            if (mark) body.append(mark);
            kv(body, false);
            addBlock(body, 'Text', message.text);
            // в Chat-режиме модели уходит не этот текст, а он же с приклеенной
            // спереди CHAT_PREAMBLE (SYSTEM/cli/outside-browser.js) — показываем реально отправленное,
            // если оно записано и отличается от того, что видно в чате
            if (message.inputSent && message.inputSent !== message.text) {
                addBlock(body, 'Actually sent to the model (input_sent)', message.inputSent);
            }
            // всё, что событие result присылает сверх уже разложенных по колонкам
            // usage/cost/duration — тайминги, отказы в разрешении, статистика
            // субагентов и т.д. (см. SYSTEM/core/run-turn.js, resultMeta) — целиком, одним JSON
            if (message.resultMeta) {
                addBlock(body, 'Turn diagnostics (result_meta)', prettyJson(message.resultMeta));
            }
            if (message.extraMeta) addBlock(body, 'Extra metadata (extra_meta)', prettyJson(message.extraMeta));
        });
    }

    return { addSessionMetaCard, addMessageCard };
}