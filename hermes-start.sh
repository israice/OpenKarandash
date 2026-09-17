#!/usr/bin/env bash
# Ручной запуск claude-bridge на хосте и Hermes в Docker (только WSL/bash).
# Штатно это делает сам сторож server.js (SYSTEM/core/hermes-stack.js) при
# `node server.js`; этот скрипт — когда нужен только Hermes без сервера.
#
# Бридж НЕ МОЖЕТ жить в контейнере: он управляет `claude` CLI, который стоит на
# хосте. Контейнер достаёт до него через host.docker.internal — см.
# docker-compose.hermes.yml, почему не network_mode: host.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

# Порт бриджа берём из его собственного .env, а не хардкодим здесь: иначе при
# смене CLAUDE_BRIDGE_PORT в claude-bridge/.env скрипт продолжал бы стучаться
# в старый порт и — что хуже — решил бы, что бридж уже поднят, если на старом
# порту случайно отвечает чужой процесс (см. DOCS/decisions/029)
BRIDGE_PORT="${CLAUDE_BRIDGE_PORT:-}"
if [ -z "$BRIDGE_PORT" ] && [ -f "$ROOT/claude-bridge/.env" ]; then
  BRIDGE_PORT="$(grep -m1 '^CLAUDE_BRIDGE_PORT=' "$ROOT/claude-bridge/.env" | cut -d= -f2)"
fi
BRIDGE_PORT="${BRIDGE_PORT:-8788}"
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
# без этого файла свежий hermes-home поднимается с provider: auto и не находит
# credentials — переписать некому. Кладём его только при первом запуске, чтобы
# не затирать правки, сделанные руками (hermes model, hermes config set, ...)
if [ ! -f "$ROOT/hermes-home/config.yaml" ]; then
  log "завожу hermes-home/config.yaml (provider: claude-bridge)"
  mkdir -p "$ROOT/hermes-home"
  cp "$ROOT/hermes-home.config.example.yaml" "$ROOT/hermes-home/config.yaml"
fi

docker info >/dev/null 2>&1 || die "Docker demon недоступен — сначала запусти Docker Desktop"
# только gateway: дашборд Hermes (сервис dashboard, :9119) в этом проекте не
# нужен — интерфейсом служит наш сервер, а Hermes ему отдаёт agent API :8642
log "запускаю контейнер Hermes"
HERMES_UID="$(id -u)" HERMES_GID="$(id -g)" "${COMPOSE[@]}" up -d gateway

log "готово"
echo
echo "  agent API: http://127.0.0.1:8642/v1"
echo "  бридж   : http://127.0.0.1:${BRIDGE_PORT}/health"
echo "  логи    : logs/bridge.log  |  ${COMPOSE[*]} logs -f"
