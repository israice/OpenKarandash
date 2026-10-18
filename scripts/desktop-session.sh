#!/usr/bin/env bash
# =============================================================================
#  desktop-session.sh - manage Web Linux Desktop sessions from the shell.
#
#  Talks to the manager's REST API, never to Docker directly, so the same
#  authentication, admission control and ownership rules apply as in the browser.
#
#  Usage:
#    eval "$(./scripts/desktop-session.sh env)"      # export URL/USER/PASSWORD
#    ./scripts/desktop-session.sh create [--resolution 1280x800] [--password S]
#    ./scripts/desktop-session.sh create --wait 90   # block until running
#    ./scripts/desktop-session.sh list
#    ./scripts/desktop-session.sh status  <id>
#    ./scripts/desktop-session.sh url     <id>
#    ./scripts/desktop-session.sh stop    <id>
#    ./scripts/desktop-session.sh start   <id>
#    ./scripts/desktop-session.sh restart <id>
#    ./scripts/desktop-session.sh logs    <id> [tail]
#    ./scripts/desktop-session.sh delete  <id> [--delete-data]
#    ./scripts/desktop-session.sh resources
#    ./scripts/desktop-session.sh usage
#    ./scripts/desktop-session.sh open    <id>        # print the browser URL
#    ./scripts/desktop-session.sh wait    <id> [secs]
#    ./scripts/desktop-session.sh backup  <id> <dest.tar>
#    ./scripts/desktop-session.sh restore <id> <src.tar>
#
#  Configuration (environment):
#    WD_URL        default http://127.0.0.1:8080
#    WD_USER       default admin
#    WD_PASSWORD   optional; only needed if the manager has auto-login turned off
#    WD_API_TOKEN  optional bearer token instead of basic auth
#    WD_PREFIX     docker volume prefix, default wd
#
#  With the default settings no credential is needed at all: the manager has
#  auto-login, so plain curl to the URL is already authenticated.
# =============================================================================
set -euo pipefail

WD_URL="${WD_URL:-http://127.0.0.1:8080}"
WD_USER="${WD_USER:-admin}"
WD_PASSWORD="${WD_PASSWORD:-}"
WD_API_TOKEN="${WD_API_TOKEN:-}"
WD_PREFIX="${WD_PREFIX:-wd}"

die() { echo "error: $*" >&2; exit 1; }

# --- tiny JSON field extractor (no jq dependency) ---------------------------
jget() { printf '%s' "$1" | sed -n "s/.*\"$2\":\"\([^\"]*\)\".*/\1/p"; }

api() {
  local method="$1" path="$2" body="${3:-}"
  local -a args=(-sS -X "$method" -H "Accept: application/json" -w '\n%{http_code}')
  # Credentials only when the user configured some. Otherwise auto-login does
  # the job and nothing has to be typed.
  if [ -n "$WD_API_TOKEN" ]; then
    args+=(-H "Authorization: Bearer ${WD_API_TOKEN}")
  elif [ -n "$WD_PASSWORD" ]; then
    args+=(-u "${WD_USER}:${WD_PASSWORD}")
  fi
  [ -n "$body" ] && args+=(-H "Content-Type: application/json" -d "$body")

  local raw code payload
  raw=$(curl "${args[@]}" "${WD_URL}${path}") || die "request to ${WD_URL}${path} failed"
  code=$(printf '%s' "$raw" | tail -n1)
  payload=$(printf '%s' "$raw" | sed '$d')
  if [ "$code" -ge 400 ]; then
    echo "HTTP ${code} from ${method} ${path}:" >&2
    echo "$payload" >&2
    exit 1
  fi
  printf '%s' "$payload"
}

fmt_table() {
  python3 -c '
import json, sys
d = json.load(sys.stdin)
rows = d.get("sessions", [])
if not rows:
    print("no sessions")
    raise SystemExit(0)
w = max(len(r["id"]) for r in rows)
print("ID".ljust(w), "OWNER".ljust(12), "STATE".ljust(10), "RESOLUTION".ljust(11), "LIMITS".ljust(14), "URL")
for r in rows:
    limits = "%sM/%sc" % (r.get("memory_limit_mb"), r.get("cpu_limit"))
    print(r["id"].ljust(w), str(r.get("owner","")).ljust(12),
          str(r.get("state","")).ljust(10), str(r.get("resolution","")).ljust(11),
          limits.ljust(14), r.get("url",""))
'
}

cmd_env() {
  printf "export WD_URL='%s'\n" "$WD_URL"
  printf "export WD_USER='%s'\n" "$WD_USER"
  printf "export WD_PASSWORD='%s'\n" "$WD_PASSWORD"
}

cmd_create() {
  local resolution="" password="" waitsecs=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --resolution) resolution="$2"; shift 2 ;;
      --password)   password="$2";   shift 2 ;;
      --wait)       waitsecs="$2";   shift 2 ;;
      *) die "unknown option for create: $1" ;;
    esac
  done

  # Build the JSON body without depending on jq. Fields are collected with a
  # leading separator and joined, so there is never a trailing comma.
  local body="{" sep=""
  [ -n "$resolution" ] && { body="${body}${sep}\"resolution\":\"$resolution\""; sep=","; }
  [ -n "$password" ]   && { body="${body}${sep}\"vnc_password\":\"$password\""; sep=","; }
  [ -n "$waitsecs" ]   && { body="${body}${sep}\"wait\":${waitsecs}"; sep=","; }
  body="${body}}"

  local out id url state
  out=$(api POST /api/sessions "$body")
  id=$(jget "$out" id); url=$(jget "$out" url); state=$(jget "$out" state)
  [ -n "$id" ] || die "unexpected response: $out"
  echo "session ${id} created (${state})"
  echo "url: ${url}"
  [ -n "$waitsecs" ] && wait_ready "$id" "$waitsecs"
  return 0
}

wait_ready() {
  local id="$1" timeout="${2:-90}" elapsed=0 state=""
  while [ "$elapsed" -lt "$timeout" ]; do
    state=$(jget "$(api GET "/api/sessions/${id}")" state)
    case "$state" in
      running) echo "session ${id} is running"; return 0 ;;
      failed|stopped)
        echo "session ${id} ended in state '${state}'" >&2
        api GET "/api/sessions/${id}/logs?tail=50" || true
        return 1 ;;
    esac
    sleep 2; elapsed=$((elapsed + 2))
  done
  echo "session ${id} not ready after ${timeout}s (last state: ${state:-unknown})" >&2
  return 1
}

cmd_delete() {
  local id="$1" data="false"
  if [ "${2:-}" = "--delete-data" ]; then data="true"; fi
  api DELETE "/api/sessions/${id}?delete_data=${data}"
  echo
}

cmd_backup() {
  local id="$1" dest="$2" vol="${WD_PREFIX}-home-${id}"
  docker volume inspect "$vol" >/dev/null 2>&1 || die "no such volume: ${vol}"
  local dir base
  dir=$(dirname "$dest"); base=$(basename "$dest")
  mkdir -p "$dir"
  echo "archiving volume ${vol} -> ${dest}"
  docker run --rm \
    -v "${vol}:/src:ro" \
    -v "${dir}:/dst" \
    alpine:3.20 sh -c "cd /src && tar czf /dst/${base} ."
  ls -lh "$dest"
}

cmd_restore() {
  local id="$1" src="$2" vol="${WD_PREFIX}-home-${id}" dir base
  [ -f "$src" ] || die "backup not found: $src"
  dir=$(dirname "$src"); base=$(basename "$src")
  docker volume create "$vol" >/dev/null
  echo "restoring ${src} into volume ${vol}"
  # --numeric-owner keeps the archive's uid/gid instead of the extracting
  # container's; the chown afterwards fixes archives taken from a host where
  # the session user had a different uid. 1000:1000 is the uid in the image.
  docker run --rm \
    -v "${vol}:/dst" \
    -v "${dir}:/backup:ro" \
    alpine:3.20 sh -c \
    "cd /dst && tar xzf /backup/${base} && chown -R 1000:1000 /dst"
  echo "now run: $0 restart ${id}"
}

cmd_logs()  { api GET "/api/sessions/$1/logs?tail=${2:-200}"; }
cmd_url()   { jget "$(api GET "/api/sessions/$1/url")" url; }
cmd_open()  { cmd_url "$1"; }
cmd_status(){ api GET "/api/sessions/$1"; }

[ $# -gt 0 ] || { sed -n '2,32p' "$0"; exit 1; }
sub="$1"; shift

case "$sub" in
  env)        cmd_env ;;
  create)     cmd_create "$@" ;;
  list|ls)    api GET /api/sessions | fmt_table ;;
  status)     cmd_status "$@" ;;
  url)        cmd_url "$@" ;;
  stop)       echo "stopping $1";  api POST "/api/sessions/$1/stop"    >/dev/null; echo ok ;;
  start)      echo "starting $1"; api POST "/api/sessions/$1/start"   >/dev/null; echo ok ;;
  restart)    echo "restarting $1"; api POST "/api/sessions/$1/restart" >/dev/null; echo ok ;;
  logs)       cmd_logs "$@" ;;
  delete|rm)  cmd_delete "$@" ;;
  open)       cmd_open "$@" ;;
  resources)  api GET /api/resources | python3 -m json.tool ;;
  usage)      api GET /api/resources/sessions | python3 -m json.tool ;;
  backup)     cmd_backup "$@" ;;
  restore)    cmd_restore "$@" ;;
  wait)       wait_ready "$1" "${2:-90}" ;;
  *)          die "unknown command '$sub' (see the header of this script)" ;;
esac
