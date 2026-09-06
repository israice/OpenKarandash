#!/usr/bin/env bash
# Поднять весь стек: claude-bridge на хосте, Hermes в Docker.
#
# Бридж НЕ МОЖЕТ жить в контейнере: он управляет `claude` CLI, который стоит на
# хосте. Compose-файл Hermes использует network_mode: host, поэтому контейнер
# достаёт до бриджа обычным loopback.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

BRIDGE_PORT="${CLAUDE_BRIDGE_PORT:-8787}"
# Относительные пути специально: Docker Desktop переписывает абсолютные пути
# WSL, переданные в --env-file, в кривые Windows-пути (/mnt/c/... -> C:\mnt\c\...).
# Скрипт делает cd в $ROOT выше, поэтому относительные пути после этого целы.
COMPOSE=(docker compose --env-file .env --project-directory .
         -f hermes/docker-compose.yml -f docker-compose.hermes.yml)

log() { printf '\033[36m==>\033[0m %s\n' "$*"; }
die() { printf '\033[31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

# ── 1. бридж (хост) ────────────────────────────────────────
if curl -sf -m 3 "http://127.0.0.1:${BRIDGE_PORT}/health" >/dev/null 2>&1; then
  log "бридж уже слушает :${BRIDGE_PORT}"
else
  command -v python3 >/dev/null || die "python3 не найден на хосте"
  log "запускаю claude-bridge на :${BRIDGE_PORT}"
  mkdir -p "$ROOT/logs"
  ( cd "$ROOT/claude-bridge" && setsid nohup python3 server.py >>"$ROOT/logs/bridge.log" 2>&1 & )
  for _ in $(seq 1 20); do
    curl -sf -m 2 "http://127.0.0.1:${BRIDGE_PORT}/health" >/dev/null 2>&1 && break
    sleep 0.5
  done
  curl -sf -m 2 "http://127.0.0.1:${BRIDGE_PORT}/health" >/dev/null 2>&1 \
    || die "бридж не запустился — смотри logs/bridge.log"
fi
log "здоровье бриджа: $(curl -s "http://127.0.0.1:${BRIDGE_PORT}/health")"

# ── 2. Hermes (docker) ──────────────────────────────────────
docker info >/dev/null 2>&1 || die "Docker demon недоступен — сначала запусти Docker Desktop"
log "запускаю контейнеры Hermes"
HERMES_UID="$(id -u)" HERMES_GID="$(id -g)" "${COMPOSE[@]}" up -d

log "готово"
echo
echo "  дашборд : http://127.0.0.1:9119"
echo "  бридж   : http://127.0.0.1:${BRIDGE_PORT}/health"
echo "  логи    : logs/bridge.log  |  ${COMPOSE[*]} logs -f"
