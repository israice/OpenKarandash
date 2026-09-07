#!/usr/bin/env bash
# Остановить контейнеры Hermes и бридж на хосте.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

docker compose --env-file .env --project-directory . \
  -f hermes/docker-compose.yml -f docker-compose.hermes.yml down || true

PORT="${CLAUDE_BRIDGE_PORT:-8787}"
PID="$(ss -lptn "sport = :${PORT}" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | head -1 || true)"
if [ -n "$PID" ]; then
  kill "$PID" && echo "бридж остановлен (pid $PID)"
else
  echo "бридж не запущен"
fi
