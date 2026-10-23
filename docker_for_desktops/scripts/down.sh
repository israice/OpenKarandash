#!/usr/bin/env bash
# =============================================================================
#  down.sh - guaranteed clean teardown of the Web Linux Desktop stack.
#
#  `docker compose down` on its own can fail with
#
#      ! Network webdesktop_sessions Resource is still in use
#
#  because session containers are created through the Docker API and are not
#  compose services: compose never stops them, and a running one holds an
#  endpoint on the internal `sessions` network.
#
#  The manager handles the normal case by stopping its containers on SIGTERM.
#  This script is the escape hatch for the rest: it stops the manager, sweeps up
#  containers that survived a SIGKILL or a manager running with
#  STOP_SESSIONS_ON_SHUTDOWN=0, and only then calls `compose down`.
#
#  Usage:
#    ./scripts/down.sh              # stop everything, keep session home volumes
#    ./scripts/down.sh --data       # also delete per-session home volumes
#    ./scripts/down.sh --volumes    # stop everything and delete ALL volumes
#
#  Nothing here touches a container that is not labelled webdesktop.session.
# =============================================================================
set -euo pipefail

cd "$(dirname "$0")/.."

VOLUMES=0
SESSION_DATA=0
for arg in "$@"; do
  case "$arg" in
    -v|--volumes) VOLUMES=1 ;;
    --data)       SESSION_DATA=1 ;;
    -h|--help)    sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

say() { printf '\n==> %s\n' "$*"; }

# 1. Stop the manager first: on SIGTERM it removes its own session containers.
say "stopping the manager"
docker compose stop manager 2>/dev/null || true

# 2. Sweep up every session container that is still there, by label.
say "removing leftover session containers"
leftovers=$(docker ps -aq --filter "label=webdesktop.session" || true)
if [ -n "$leftovers" ]; then
  # shellcheck disable=SC2086
  docker rm -f $leftovers
else
  echo "none"
fi

# 3. Home volumes of sessions, if asked for.
if [ "$SESSION_DATA" -eq 1 ]; then
  say "removing session home volumes"
  # By label, and by name pattern for volumes created before labels existed.
  vols=$( { docker volume ls -q --filter "label=webdesktop.session"; \
            docker volume ls -q --filter "name=wd-home-"; } 2>/dev/null | sort -u )
  if [ -n "$vols" ]; then
    # shellcheck disable=SC2086
    docker volume rm -f $vols
  else
    echo "none"
  fi
fi

# 4. Now compose can take the networks down.
if [ "$VOLUMES" -eq 1 ]; then
  say "docker compose down --volumes"
  docker compose down --volumes --remove-orphans
else
  say "docker compose down"
  docker compose down --remove-orphans
fi

# 5. Tell the truth about what is left, instead of leaving a surprise behind.
say "leftovers"
docker ps -a --filter "label=webdesktop.session" --format 'container {{.Names}} ({{.Status}})'
docker volume ls --filter "name=wd-home-" --format 'volume   {{.Name}}'
docker network ls --filter "name=webdesktop_" --format 'network  {{.Name}}'
echo "done"