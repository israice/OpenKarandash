#!/bin/sh
# Запуск jev-ultrafast из контейнера Hermes: подставляет адрес моста до Chrome
# (PROJECTS/Browser/chrome-bridge.js на Windows) и держит окружение Python вне
# смонтированной папки. Пример:
#   PROJECTS/Browser/run.sh python examples/run.py --url https://example.com --goal 'открой первую ссылку'
set -e
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
env_value() { grep -E "^$1=" "$ROOT/.env" | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'" | tr -d '\r'; }
TOKEN=$(env_value CHROME_BRIDGE_TOKEN)
PORT=$(env_value CHROME_BRIDGE_PORT)
if [ -z "$TOKEN" ]; then
    echo 'нет CHROME_BRIDGE_TOKEN в .env: запустите мост на Windows (node PROJECTS/Browser/chrome-bridge.js)' >&2
    exit 1
fi
export BU_CDP_URL="http://${CHROME_BRIDGE_HOST:-host.docker.internal}:${PORT:-9223}/${TOKEN}"
export UV_PROJECT_ENVIRONMENT="${UV_PROJECT_ENVIRONMENT:-/opt/data/venvs/jev-ultrafast}"
cd "$ROOT/jev-ultrafast"
exec uv run --env-file "$ROOT/.env" "$@"
