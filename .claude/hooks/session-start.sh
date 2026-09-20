#!/bin/bash
#
# SessionStart-хук: кладёт в контекст агента (и в ленту владельца — строкой роли
# hook) блок «Task Status»: бусины в работе и готовые к работе, плюс последние
# записи базы знаний. Соседний хук `bd prime --hook-json` списка задач НЕ даёт
# (проверено: 11 614 символов инструкций и памяти, ни одного id бусины), так что
# этот блок не дубль и остаётся.
#
# Почему скрипт урезан. До правки он шёл 10–13 с на каждом старте сессии (медиана
# 13,2 с на 42 стартах из интерфейса, до 71,9 с на /clear в терминале), а первый
# ответ Claude ждёт конца SessionStart-хуков — задержку платил каждый ход из
# OpenKarandash и Telegram. Замер по шагам: четыре запроса bd к встроенной
# Dolt-базе на /mnt/c подряд — 2,7 + 3,5 + 1,4 + 1,6 с, ещё 0,9 с — git status.
# Убрано:
# - предупреждение «Main directory has uncommitted changes… only work in
#   .worktrees/»: правило снято в DOCS/decisions/026, а дерево грязное почти всегда
#   (гитлинк hermes) — предупреждение врало в каждой второй сессии;
# - обход .worktrees/bd-* в поисках влитых веток и `gh pr list`: у репозитория нет
#   origin, gh падал всегда («no git remotes found»);
# - разделы Blocked и Stale: `head -3` резал их до заголовка со счётчиком, сами
#   задачи в вывод не попадали; `bd blocked` и `bd stale` остаются в одной команде.
# Оставшиеся два запроса bd и разбор базы знаний идут одновременно, каждый под своим
# timeout: зависшая база отнимает свой раздел, а не весь блок (по общему таймауту
# хука Claude Code выбросил бы вывод целиком), и про отнятый раздел блок говорит
# прямо — молчание агент прочёл бы как «задач в работе нет». jq больше не нужен —
# базу знаний разбирает node, который есть везде, где работают остальные хуки.
#
# Хук никогда не ломает сессию: без bd (Windows-claude) молча выходит, код
# возврата всегда 0. Формат оставшихся разделов тот же, что был.
#
# Регистрация — .claude/settings.json, ключ hooks.SessionStart.

# errexit и nounset могут приехать снаружи через экспортированный SHELLOPTS — с ними
# первый же read на пустом stdin оборвал бы хук с кодом 1
set +eu

# ход из интерфейса (server.js ставит OPENKARANDASH_SETTING_SOURCES) на `--resume`:
# блок уже лежит в контексте и в ленте с первого хода сессии — повторять его на
# каждом ходу значит платить секунды и сорить в ленте. Новая сессия, /clear и
# сжатие блок получают как обычно. read с таймаутом: пустой, незакрытый или вовсе
# закрытый stdin хук не подвесит и в stderr не насорит
if [[ -n "$OPENKARANDASH_SETTING_SOURCES" ]]; then
    IFS= read -r -t 1 -d '' HOOK_INPUT 2>/dev/null
    RESUME_RE='"source"[[:space:]]*:[[:space:]]*"resume"'
    [[ "$HOOK_INPUT" =~ $RESUME_RE ]] && exit 0
fi

# Windows-claude читает те же настройки, но bd у него в PATH нет — выходим молча,
# а не строкой «bd not found» в контексте каждой сессии
command -v bd >/dev/null 2>&1 || exit 0

# CLAUDE_PROJECT_DIR ставит Claude Code; при ручном запуске считаем от места скрипта
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." 2>/dev/null && pwd)}"
BEADS_DIR="$PROJECT_DIR/.beads"

if [[ ! -d "$BEADS_DIR" ]]; then
    echo "No .beads directory found. Run 'bd init' to initialize."
    exit 0
fi

# bd ищет базу от текущей папки
cd "$PROJECT_DIR" 2>/dev/null || exit 0

TMP_DIR=$(mktemp -d 2>/dev/null) || exit 0
trap 'rm -rf "$TMP_DIR"' EXIT

# Claude Code отменяет хук по своему таймауту сигналом: забираем с собой и детей,
# иначе запросы bd ещё до 12 с держат базу, в которую агент уже идёт сам
PIDS=""
WATCHDOG=""
trap 'kill $PIDS $WATCHDOG 2>/dev/null; exit 0' TERM INT HUP

# timeout из coreutils (есть и в WSL, и в Git Bash); у Windows свой timeout.exe с
# другим смыслом — его не берём
BD_TIMEOUT=10
LIMIT_BD=()
LIMIT_NODE=()
if timeout --version >/dev/null 2>&1; then
    LIMIT_BD=(timeout -k 2 "$BD_TIMEOUT")
    LIMIT_NODE=(timeout -k 1 5)
fi

# вывод — в файлы, а не в трубу: оставь bd после себя фоновый процесс, ждать его
# хук не станет. `-n 5` у ready: первые пять строк те же, а bd не собирает
# остальные двадцать
"${LIMIT_BD[@]}" bd list --status in_progress >"$TMP_DIR/in_progress" 2>/dev/null &
PID_IN_PROGRESS=$!
"${LIMIT_BD[@]}" bd ready -n 5 >"$TMP_DIR/ready" 2>/dev/null &
PID_READY=$!
PIDS="$PID_IN_PROGRESS $PID_READY"

# Show 5 most recent, deduplicated by key (latest wins). Раньше это делал jq,
# которого нет у Windows-claude; битую строку журнала пропускаем, а не теряем
# из-за неё весь раздел
KNOWLEDGE_FILE="$BEADS_DIR/memory/knowledge.jsonl"
PID_KNOWLEDGE=""
if [[ -f "$KNOWLEDGE_FILE" && -s "$KNOWLEDGE_FILE" ]]; then
    "${LIMIT_NODE[@]}" node -e '
        try {
            const rows = [];
            const text = require("fs").readFileSync(process.argv[1], "utf8").replace(/^﻿/, "");
            const lines = text.split("\n").filter((l) => l.trim());
            for (const line of lines.slice(-20)) {
                try {
                    const row = JSON.parse(line);
                    if (row && typeof row === "object" && !Array.isArray(row) && row.content != null) rows.push(row);
                } catch { /* битая строка */ }
            }
            const latest = new Map();
            for (const row of rows) {
                const seen = latest.get(row.key);
                if (!seen || (row.ts || 0) >= (seen.ts || 0)) latest.set(row.key, row);
            }
            const cut = (value, n) => Array.from(String(value ?? "")).slice(0, n).join("");
            [...latest.values()]
                .sort((a, b) => (b.ts || 0) - (a.ts || 0) || (String(a.key) < String(b.key) ? -1 : 1))
                .slice(0, 5)
                .forEach((row) => {
                    const type = cut(row.type, 5).replace(/[a-z]/g, (c) => c.toUpperCase());
                    console.log(`  [${type}] ${cut(row.content, 100)}  (${row.source ?? null})`);
                });
        } catch { /* нет файла — раздел остаётся без строк */ }
    ' "$KNOWLEDGE_FILE" >"$TMP_DIR/knowledge" 2>/dev/null &
    PID_KNOWLEDGE=$!
    PIDS="$PIDS $PID_KNOWLEDGE"
fi

# без coreutils timeout (macOS) сторожим детей сами: ни один не живёт дольше срока
if [[ ${#LIMIT_BD[@]} -eq 0 ]]; then
    ( sleep "$BD_TIMEOUT"; kill -9 $PIDS ) >/dev/null 2>&1 &
    WATCHDOG=$!
fi

# код возврата нужен, чтобы отличить «задач нет» от «bd не ответил»; 2>/dev/null
# на весь блок глушит служебное «Killed» от bash про прибитых детей
{
    wait "$PID_IN_PROGRESS"
    RC_IN_PROGRESS=$?
    wait "$PID_READY"
    RC_READY=$?
    [[ -n "$PID_KNOWLEDGE" ]] && wait "$PID_KNOWLEDGE"
    if [[ -n "$WATCHDOG" ]]; then
        kill "$WATCHDOG"
        wait "$WATCHDOG"
    fi
} 2>/dev/null

echo ""
echo "## Task Status"
echo ""

# пустой вывод у bd бывает только при сбое: на «ничего нет» он сам пишет
# «No issues found.» — поэтому раздел без вывода и с ненулевым кодом считаем
# неполученным, а не пустым
MISSING=""

# Show in-progress beads first (highest priority)
IN_PROGRESS=$(head -5 "$TMP_DIR/in_progress" 2>/dev/null)
if [[ -n "$IN_PROGRESS" ]]; then
    echo "### In Progress (resume these):"
    echo "$IN_PROGRESS"
    echo ""
elif [[ $RC_IN_PROGRESS -ne 0 ]]; then
    MISSING="In Progress (bd list --status in_progress)"
fi

# Show ready (unblocked) beads
READY=$(head -5 "$TMP_DIR/ready" 2>/dev/null)
if [[ -n "$READY" ]]; then
    echo "### Ready (no blockers):"
    echo "$READY"
    echo ""
elif [[ $RC_READY -ne 0 ]]; then
    MISSING="${MISSING:+$MISSING, }Ready (bd ready)"
fi

if [[ -n "$MISSING" ]]; then
    echo "bd не ответил (сбой или таймаут ${BD_TIMEOUT} с) — не получено: $MISSING. Это не значит «задач нет»: запроси сам."
elif [[ -z "$IN_PROGRESS" && -z "$READY" ]]; then
    echo "No active beads. Create one with: bd create \"Task title\" -d \"Description\""
fi

# ============================================================
# Knowledge Base - Surface recent learnings
# ============================================================
if [[ -n "$PID_KNOWLEDGE" ]]; then
    TOTAL_ENTRIES=$(wc -l < "$KNOWLEDGE_FILE" | tr -d ' ')
    echo ""
    echo "## Recent Knowledge ($TOTAL_ENTRIES entries)"
    echo ""
    # без node (или при его сбое) раздел остаётся без строк
    cat "$TMP_DIR/knowledge" 2>/dev/null
    echo ""
    echo "  Search: .beads/memory/recall.sh \"keyword\""
fi

echo ""
exit 0
