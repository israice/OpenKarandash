#!/usr/bin/env bash
# Остановить контейнеры Hermes и бридж на хосте.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

docker compose --env-file .env --project-directory . \
  -f hermes/docker-compose.yml -f docker-compose.hermes.yml down || true

# Порт — из claude-bridge/.env, а не хардкод: на машине может стоять другой
# клон claude-bridge на другом порту, а с хардкодом 8787 этот скрипт однажды
# погасил чужой процесс вместо своего (см. DOCS/decisions/029)
PORT="${CLAUDE_BRIDGE_PORT:-}"
if [ -z "$PORT" ] && [ -f "$ROOT/claude-bridge/.env" ]; then
  PORT="$(grep -m1 '^CLAUDE_BRIDGE_PORT=' "$ROOT/claude-bridge/.env" | cut -d= -f2)"
fi
PORT="${PORT:-8788}"

PID="$(ss -lptn "sport = :${PORT}" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | head -1 || true)"
if [ -z "$PID" ]; then
  echo "бридж не запущен"
elif [ "$(readlink -f "/proc/$PID/cwd" 2>/dev/null)" != "$(readlink -f "$ROOT/claude-bridge")" ]; then
  # процесс на этом порту — не наш (например, другой клон claude-bridge на
  # той же машине): гасить чужое без спроса нельзя
  echo "на порту ${PORT} чужой процесс (pid $PID, cwd $(readlink -f "/proc/$PID/cwd" 2>/dev/null)) — не трогаю"
else
  kill "$PID" && echo "бридж остановлен (pid $PID)"
fi
