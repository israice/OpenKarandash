#!/usr/bin/env bash
# =============================================================================
#  resources.sh - what is this host actually spending on desktops?
#
#  Reports per-session RAM/CPU, total committed memory, and the remaining
#  headroom against the admission-control thresholds in config/manager.yaml.
#
#  Usage: ./scripts/resources.sh [--json] [--watch [seconds]]
# =============================================================================
set -euo pipefail

WD_URL="${WD_URL:-http://127.0.0.1:8080}"
WD_USER="${WD_USER:-admin}"
WD_PASSWORD="${WD_PASSWORD:-}"
WD_API_TOKEN="${WD_API_TOKEN:-}"
WD_PREFIX="${WD_PREFIX:-wd}"

curl_auth() {
  # No credentials configured -> plain request: the manager's auto-login
  # already treats this as an authenticated call.
  if [ -n "$WD_API_TOKEN" ]; then
    curl -sS -H "Authorization: Bearer ${WD_API_TOKEN}" "$@"
  elif [ -n "$WD_PASSWORD" ]; then
    curl -sS -u "${WD_USER}:${WD_PASSWORD}" "$@"
  else
    curl -sS "$@"
  fi
}

render() {
  curl_auth "${WD_URL}/api/resources" | python3 -c '
import json, sys
d = json.load(sys.stdin)
h, l = d["host"], d["limits"]
print("Host")
print("  visible to manager  : %s" % ("yes" if h["visible"] else "NO - see README (admission falls back to the manager cgroup)"))
print("  RAM total          : %d MiB" % h["total_memory_mb"])
print("  RAM available      : %d MiB" % h["available_memory_mb"])
print("  committed to desks : %d MiB  (%d sessions x %s MiB limit)"
      % (h["committed_memory_mb"], d["sessions_running"], l["memory_per_session_mb"]))
print("  CPU                : %d cores, load %.2f (%.2f per core)"
      % (h["cpu_count"], h["load_average_1m"], h["load_per_cpu"]))
print("  disk free          : %d MiB of %d MiB" % (h["disk_free_mb"], h["disk_total_mb"]))
print()
print("Admission control")
print("  sessions           : %d / %d" % (d["sessions_running"], l["max_sessions"]))
print("  queued requests    : %d  (action on overload: %s)" % (d["queue_length"], l["overload_action"]))
print("  min free RAM       : %s MiB   reserve after a new session: %s MiB"
      % (l["min_free_memory_mb"], l["reserve_memory_mb"]))
print("  min free disk      : %s MiB   max load per core: %s"
      % (l["min_free_disk_mb"], l["max_load_per_cpu"]))
'
  echo
  echo "Live per-container usage (docker stats, one-shot sample)"
  if ! command -v docker >/dev/null 2>&1; then
    echo "  (docker CLI not available here - run this script on the server)"
    return 0
  fi
  printf '  %-14s %-12s %12s %10s %10s\n' CONTAINER HEALTH "RAM" "RAM/CAP" CPU
  set +e
  names=$(docker ps --filter "label=webdesktop.session" --format '{{.Names}}' 2>/dev/null)
  if [ -z "$names" ]; then
    echo "  (no running sessions, or the docker CLI cannot reach the daemon here)"
    set -e
    return 0
  fi
  for c in $names; do
    line=$(docker stats --no-stream --format '{{.MemUsage}}|{{.CPUPerc}}' "$c" 2>/dev/null)
    mem=$(echo "${line:-n/a}" | cut -d'|' -f1 | cut -d' ' -f1)
    cpu=$(echo "${line:-n/a}" | cut -d'|' -f2)
    cap=$(docker inspect --format '{{.HostConfig.Memory}}' "$c" 2>/dev/null)
    if [ -n "$cap" ] && [ "$cap" -gt 0 ] 2>/dev/null; then cap="$((cap / 1048576))M"; else cap="-"; fi
    health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$c")
    printf '  %-14s %-12s %12s %10s %10s\n' "$c" "$health" "$mem" "$cap" "$cpu"
  done
  set -e
  echo
  echo "Docker storage summary:"
  docker system df 2>/dev/null | sed 's/^/  /' || echo "  (docker system df unavailable)"
  return 0
}

case "${1:-}" in
  --json) curl_auth "${WD_URL}/api/resources" | python3 -m json.tool ;;
  --watch) while true; do clear; date; render; sleep "${2:-5}"; done ;;
  "")     render ;;
  *)      echo "usage: $0 [--json|--watch [seconds]]" >&2; exit 2 ;;
esac
