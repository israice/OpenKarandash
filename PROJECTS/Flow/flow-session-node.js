// Содержимое ноды сессии: вид карточки по роли сообщения и секции факта
// (что вошло, что произошло, что вышло, картинки, метаданные, исходное
// событие). Само построение графа — в flow-session-build.js.
//
// Эти ноды не переживают перезагрузку: они целиком выводятся из сообщений и
// рисуются заново при каждом построении (см. flow-session-sync.js).
(function () {
    window.FlowSessionNode = function (ctx) {

        // вид ноды сессии по роли сообщения: эмодзи в аватар, цвет — классом
        // .flow-node--kind-* (см. flow.css), заголовок карточки. Роли те же,
        // что записывает сервер (см. listMessages в SYSTEM/core/sessions-db.js). Select
        // .flow-node__type не трогаем: это словарь пользователя для его
        // собственной разметки, а не тип факта из сессии
        const NODE_KINDS = {
            user: { emoji: '👤', kind: 'user', title: 'Question' },
            assistant: { emoji: '💬', kind: 'assistant', title: 'Answer' },
            thinking: { emoji: '💭', kind: 'thinking', title: 'Reasoning' },
            hook: { emoji: '🪝', kind: 'hook', title: 'Hook' },
            system: { emoji: '🖥️', kind: 'system', title: 'System event' },
            unknown: { emoji: '❔', kind: 'unknown', title: 'Unrecognized event' },
            top_level: { emoji: '❔', kind: 'unknown', title: 'Event of unknown type' },
        };

        // семейства инструментов; первое совпадение выигрывает, поэтому префикс
        // mcp__ стоит выше собственных имён — инструмент MCP-сервера может
        // называться как угодно, включая Read или Task
        const TOOL_KINDS = [
            [/^mcp__/, '🔌', 'tool-mcp'],
            [/^(WebSearch|WebFetch)$/, '🌐', 'tool-web'],
            [/^(Read|Write|Edit|NotebookEdit)$/, '📄', 'tool-file'],
            [/^(Bash|PowerShell)$/, '⌨️', 'tool-shell'],
            [/^Task$/, '🤖', 'tool-task'],
            [/^AskUserQuestion$/, '🙋', 'tool-ask'],
            [/^(Grep|Glob)$/, '🔍', 'tool-search'],
            // те же семейства под другими именами (иначе помощник
            // рисуется отдельной картинкой, а это тот же класс работы)
            [/^(read_file|write_file|patch)$/, '📄', 'tool-file'],
            [/^(terminal|execute_code|process)$/, '⌨️', 'tool-shell'],
            [/^(web_search|web_extract|browser_\w+)$/, '🌐', 'tool-web'],
            [/^delegate_task$/, '🤖', 'tool-task'],
            [/^clarify$/, '🙋', 'tool-ask'],
            [/^(search_files|session_search)$/, '🔍', 'tool-search'],
        ];

        function nodeKindOf(m) {
            // пометка хода (recordNotice в SYSTEM/core/sessions-db.js): в заголовке — её источник
            // (server.retry-nudge…), а не общее слово
            if (m.role === 'system' && m.toolName) return { ...NODE_KINDS.system, title: m.toolName };
            // ответ помощника — не ответ основной модели
            if (m.role === 'assistant' && m.parentToolUseId) return { ...NODE_KINDS.assistant, title: 'Subagent answer' };
            if (m.role !== 'tool') return NODE_KINDS[m.role] || NODE_KINDS.unknown;
            const name = m.toolName || 'Tool';
            for (const [re, emoji, kind] of TOOL_KINDS) {
                if (re.test(name)) return { emoji, kind, title: name };
            }
            return { emoji: '🔧', kind: 'tool', title: name };
        }

        // ставит ноде вид: класс семейства (ровно один на ноду), пометку ошибки
        // и эмодзи в аватар — тем же способом, что и ручной выбор иконки в меню
        function setNodeKind(n, kind, emoji, isError) {
            for (const c of [...n.classList]) {
                if (c.startsWith('flow-node--kind-')) n.classList.remove(c);
            }
            n.classList.add('flow-node--kind-' + kind);
            n.classList.toggle('flow-node--error', !!isError);
            const avatar = n.querySelector('.flow-node__avatar');
            if (avatar) avatar.textContent = emoji;
        }

        // toolInput приходит сериализованным JSON (см. recordStep в SYSTEM/core/sessions-db.js) —
        // печатаем читаемо, многострочные значения (old_string/new_string правок
        // кода) настоящими переносами, а не как «\n» внутри одной строки.
        // Копия из PROJECTS/Feed/page.js: прямой зависимости Flow от Feed быть
        // не может — Feed это страница кнопки «+», её удаляют из меню
        // (DOCS/decisions/016)
        function formatJsonValue(value, indent) {
            const pad = '  '.repeat(indent);
            const childPad = '  '.repeat(indent + 1);
            if (value === null || value === undefined) return 'null';
            if (Array.isArray(value)) {
                if (value.length === 0) return '[]';
                const items = value.map((v) => `${childPad}${formatJsonValue(v, indent + 1)}`);
                return `[\n${items.join(',\n')}\n${pad}]`;
            }
            if (typeof value === 'object') {
                const keys = Object.keys(value);
                if (keys.length === 0) return '{}';
                const items = keys.map((k) => `${childPad}${JSON.stringify(k)}: ${formatJsonValue(value[k], indent + 1)}`);
                return `{\n${items.join(',\n')}\n${pad}}`;
            }
            if (typeof value === 'string' && value.includes('\n')) {
                const lines = value.split('\n').map((line) => childPad + line);
                return `"""\n${lines.join('\n')}\n${childPad}"""`;
            }
            return JSON.stringify(value);
        }
        function prettyJson(raw) {
            if (!raw) return '';
            try { return formatJsonValue(JSON.parse(raw), 0); } catch { return raw; }
        }
        function truncate(s, n) { return s && s.length > n ? `${s.slice(0, n)}…` : (s || ''); }

        // три секции шага: что вошло, что произошло, что вышло. Пустые не
        // показываем — у реплики пользователя нет ни аргументов, ни результата
        function sessionFacts(m) {
            const input = m.role === 'user'
                // в Chat-режиме модели уходит не то, что видно в чате, а текст с
                // приклеенной преамбулой (SYSTEM/cli/outside-browser.js) — показываем реально отправленное
                ? (m.inputSent && m.inputSent !== m.text ? m.inputSent : '')
                : prettyJson(m.toolInput);
            return [
                ['Input', input, false],
                ['What happened', m.text || '', false],
                ['Output', m.toolResult || '', !!m.toolError],
                // скриншоты и прочие картинки результата: JSON-массив data-URL
                // (toolResultImages в SYSTEM/core/sessions-db.js). Секция рисует их картинками
                ['Images', m.toolResultImages || '', false],
                // всё остальное, что сервер знает о строке (модель, токены, id
                // вызовов, откуда перенесена): ни одно поле не должно быть скрыто
                ['Metadata', sessionMetadata(m), false],
                // исходное событие целиком (DOCS/decisions/040, этап 2). Секция
                // свёрнута, как и остальные, поэтому экран не занимает, а
                // прятать поле нельзя: правило «всё, что сервер знает о строке,
                // видно во всех трёх страницах» — DOCS/decisions/039
                ['Raw event', rawText(m.raw), false],
            ];
        }

        // raw бывает до 400 тысяч знаков, а нода живого хода перестраивается
        // раз в секунду: разбирать и форматировать его каждый раз заново
        // дорого, поэтому помним последние разобранные
        const rawTextCache = new Map();
        function rawText(raw) {
            if (!raw) return '';
            let text = rawTextCache.get(raw);
            if (text === undefined) {
                text = prettyJson(raw);
                if (rawTextCache.size >= 300) rawTextCache.delete(rawTextCache.keys().next().value);
                rawTextCache.set(raw, text);
            }
            return text;
        }

        function sessionMetadata(m) {
            // raw и картинки результата показываются своими секциями (Raw event,
            // Images), а поля Event Schema (source/actor/eventType/provider/taskId)
            // попадают сюда сами
            const skip = new Set(['text', 'toolInput', 'toolResult', 'inputSent', 'extraMeta', 'resultMeta', 'toolResultImages', 'raw']);
            const meta = {};
            for (const [key, value] of Object.entries(m)) {
                if (skip.has(key) || value === null || value === undefined || value === '') continue;
                meta[key] = value;
            }
            for (const key of ['extraMeta', 'resultMeta']) {
                if (!m[key]) continue;
                try { meta[key] = JSON.parse(m[key]); } catch { meta[key] = m[key]; }
            }
            return formatJsonValue(meta, 0);
        }

        // плашка модели над заголовком ноды — тот же тег, что над ответом
        // в Sessions и в заголовке карточки Feed (SYSTEM/model-tag.js,
        // DOCS/decisions/039). Знание берётся у самой строки, а не из
        // шапки сессии: ноды строятся по всей истории, где модели и
        // исполнители менялись. source строки — имя CLI, который её вёл,
        // поэтому путь в плашке полный (pi/openrouter/stealth/…)
        function applyNodeModel(n, m) {
            n.querySelector('.flow-node__titles > .model-tag')?.remove();
            const tag = window.ModelTag?.tag(m.role === 'assistant' ? m.model : null, m.source);
            if (tag) n.querySelector('.flow-node__titles')?.prepend(tag);
        }

        // пометка суждения о ходе — та же, что в Sessions и Feed
        // (SYSTEM/judgment-badge.js, DOCS/decisions/039). Нода живого
        // хода перестраивается раз в секунду, поэтому прежнюю пометку
        // снимаем и ставим новую, а не копим их
        function applyNodeJudgment(n, m) {
            n.querySelector('.judgment')?.remove();
            const mark = window.TurnJudgment?.badge(m.resultMeta);
            // сразу под телом ноды, перед гармошкой секций
            if (mark) n.querySelector('.flow-node__body').after(mark);
        }

        // гармошка в карточке: нативный <details>, своего JS на раскрытие нет.
        // Секции сверяются по подписи и переиспользуются — иначе живая
        // перестройка закрывала бы раскрытую секцию раз в секунду
        function applyNodeFacts(n, m) {
            const sections = sessionFacts(m).filter(([, text]) => text);
            let box = n.querySelector('.flow-node__facts');
            if (!sections.length) {
                if (box) box.remove();
                return;
            }
            if (!box) {
                box = document.createElement('div');
                box.className = 'flow-node__facts';
                n.querySelector('.flow-node__body').after(box);
            }
            const items = [];
            for (const [label, text, isError] of sections) {
                let item = [...box.children].find((el) => el.dataset.label === label);
                if (label === 'Images') {
                    item = applyNodeImages(item, text);
                    if (item) items.push(item);
                    continue;
                }
                if (!item) {
                    item = document.createElement('details');
                    item.className = 'flow-node__fact';
                    item.dataset.label = label;
                    if (label === 'What happened') item.open = true;
                    const summary = document.createElement('summary');
                    summary.className = 'flow-node__fact-summary';
                    summary.textContent = label;
                    const pre = document.createElement('pre');
                    pre.className = 'flow-node__fact-text';
                    item.append(summary, pre);
                }
                item.classList.toggle('flow-node__fact--error', isError);
                const pre = item.querySelector('.flow-node__fact-text');
                // «свои слова» правятся прямо здесь и уходят в саму сессию
                // (см. focusout в flow-edit.js); остальные секции — запись факта,
                // только чтение. Присваиваем, только если значение меняется:
                // переустановка contentEditable у поля в фокусе сбивает каретку,
                // а перестройка при живом ходе идёт раз в секунду
                const editable = m.role === 'user' && label === 'What happened';
                const want = editable ? 'true' : 'false';
                if (pre.contentEditable !== want) pre.contentEditable = want;
                pre.classList.toggle('flow-node__fact-text--editable', editable);
                // пока поле в фокусе, живая перестройка не должна затирать набранное
                if (pre.textContent !== text && document.activeElement !== pre) {
                    pre.textContent = text;
                    pre.dataset.saved = text;
                }
                items.push(item);
            }
            for (const el of [...box.children]) {
                if (!items.includes(el)) el.remove();
            }
            // порядок восстанавливаем только когда он вправду нарушен: секция
            // «что вышло» появляется позже остальных, когда сервер дописывает
            // результат вызова. append переносит узел (удаляет и вставляет
            // заново), а перенос снимает фокус — правка реплики во время живого
            // хода теряла бы каретку на каждой перестройке
            const ordered = items.length === box.children.length
                && items.every((el, i) => box.children[i] === el);
            if (!ordered) box.append(...items);
        }

        // секция картинок результата. Перерисовывается, только когда набор
        // картинок сменился: иначе живая перестройка раз в секунду заново
        // декодировала бы их и мигала
        function applyNodeImages(item, raw) {
            let images;
            try { images = JSON.parse(raw); } catch { return null; }
            if (!Array.isArray(images) || !images.length) return null;
            if (!item) {
                item = document.createElement('details');
                item.className = 'flow-node__fact';
                item.dataset.label = 'Images';
                const summary = document.createElement('summary');
                summary.className = 'flow-node__fact-summary';
                const list = document.createElement('div');
                list.className = 'flow-node__fact-images';
                item.append(summary, list);
            }
            if (item.dataset.saved !== raw) {
                item.dataset.saved = raw;
                item.querySelector('.flow-node__fact-summary').textContent = `Images (${images.length})`;
                const list = item.querySelector('.flow-node__fact-images');
                list.replaceChildren(...images.map((src) => {
                    const img = document.createElement('img');
                    img.src = src;
                    img.alt = 'tool result image';
                    img.loading = 'lazy';
                    return img;
                }));
            }
            return item;
        }

        // файл, которого коснулся шаг: путь берём из аргументов вызова.
        // Разделители приводим к одному виду — иначе один и тот же файл,
        // названный то абсолютным путём, то относительным, даст две ноды
        function toolFilePath(m) {
            if (m.role !== 'tool' || !m.toolInput) return null;
            try {
                const input = JSON.parse(m.toolInput);
                if (input.file_path) return String(input.file_path).split('\\').join('/');
                // у части файловых инструментов путь лежит в поле path
                if (/^(read_file|write_file|patch)$/.test(m.toolName || '') && input.path) {
                    return String(input.path).split('\\').join('/');
                }
                // вызов Skill читает целиком SKILL.md в контекст — тот же факт,
                // что и Read, только путь не приходит полем, а собирается по
                // имени навыка. Скоуп «plugin:skill»/«dir:skill» неоднозначен
                // (без плагина или лишней папки не собрать верный путь без
                // догадок) — на таких молчим, чем дорисовывать наугад
                if (m.toolName === 'Skill' && input.skill && !String(input.skill).includes(':')) {
                    return `.claude/skills/${input.skill}/SKILL.md`;
                }
                return null;
            } catch { return null; }
        }

        // пути документов, которых коснулось сообщение. Обычный шаг — один путь
        // из toolInput.file_path (Read/Edit/…). CLAUDE.md и файл авто-памяти в
        // трассу так не попадают вовсе: CLI подмешивает их в системный промпт до
        // первого хода агента, вызова инструмента под это нет (см. TASKS.md,
        // «Чего в плане нет и почему», и DOCS/decisions/019 — единственный честный
        // канал для такого факта это хук). SessionStart-хук
        // (.claude/hooks/context-files-node.js) сообщает реально загруженные им
        // файлы списком в stdout — эта функция достаёт их из строки роли hook
        function messageFilePaths(m) {
            const single = toolFilePath(m);
            if (single) return [single];
            if (m.role !== 'hook' || !m.toolResult) return [];
            try {
                const parsed = JSON.parse(m.toolResult);
                if (!Array.isArray(parsed.contextFiles)) return [];
                return parsed.contextFiles.map((p) => String(p).split('\\').join('/'));
            } catch { return []; }
        }

        // короткий детерминированный ключ пути: сам путь в id ноды не положить —
        // слэши и точки ломают селектор, а хэша хватает, чтобы одна и та же
        // строка всегда давала одну и ту же ноду
        function pathKey(path) {
            let h = 0;
            for (let i = 0; i < path.length; i++) h = (Math.imul(h, 31) + path.charCodeAt(i)) | 0;
            return (h >>> 0).toString(36);
        }

        // нода документа: заголовок — имя файла, тело — полный путь, кнопка
        // открывает его в том же окне файла, что и клик по узлу графа
        function applyFileNode(n, path) {
            ctx.setNodeTexts(n, path.split('/').pop(), path);
            setNodeKind(n, 'doc', '🗒️', false);
            ctx.setNodeScope(n, 'system');
            ctx.setNodeType(n, 'system');
            n.dataset.file = path;
            if (!n.querySelector('.flow-node__open')) {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'flow-node__open';
                btn.textContent = 'Open file';
                n.querySelector('.flow-node__body').after(btn);
            }
        }

        // содержимое ноды сессии целиком — вид, заголовок, тело и секции
        function applySessionNode(n, m) {
            // позиция строки в сессии — адрес для правки текста на сервере
            n.dataset.position = m.position;
            const kind = nodeKindOf(m);
            // в теле — только превью: полный текст живёт в секции «what happened»
            ctx.setNodeTexts(n, kind.title, truncate(m.text, 200));
            setNodeKind(n, kind.kind, kind.emoji, m.toolError);
            applyNodeModel(n, m);
            applyNodeFacts(n, m);
            applyNodeJudgment(n, m);
            ctx.setNodeScope(n, 'system');
            ctx.setNodeType(n, 'system');
        }

        ctx.setNodeKind = setNodeKind;
        ctx.applySessionNode = applySessionNode;
        ctx.applyFileNode = applyFileNode;
        ctx.messageFilePaths = messageFilePaths;
        ctx.pathKey = pathKey;
        ctx.truncate = truncate;
        ctx.prettyJson = prettyJson;
    };
})();
