#!/bin/bash
# =============================================================================
#  Session entrypoint: Xvfb  ->  LXDE desktop  ->  x11vnc
#
#  Runs as the unprivileged "desktop" user. One container = one session.
#  Nothing here is shared between containers except the read-only defaults in
#  /opt/desktop-defaults, which are COPIED into the persistent home directory.
# =============================================================================
set -uo pipefail

USER_NAME="${USER:-desktop}"
HOME_DIR="${HOME:-/home/${USER_NAME}}"
export HOME="${HOME_DIR}"

DISPLAY_NUM="${DISPLAY_NUM:-1}"
VNC_PORT="${VNC_PORT:-5900}"
SCREEN_GEOMETRY="${SCREEN_GEOMETRY:-1440x900x24}"
VNC_RESOLUTION="${VNC_RESOLUTION:-1440x900}"
VNC_PASSWORD="${VNC_PASSWORD:-}"
RES_FILE="${HOME}/.resolution-request"

export DISPLAY=":${DISPLAY_NUM}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export USER="${USER_NAME}"
export LOGNAME="${USER_NAME}"
export HOME="${HOME_DIR}"

# Keep GTK/Qt apps from creating huge caches inside the session home.
export XDG_CACHE_HOME="${HOME}/.cache"
export NO_AT_BRIDGE=1
export QT_QPA_PLATFORM=xcb

log() { printf '[session %s] %s\n' "${DISPLAY_NUM}" "$*"; }

XVFB_PID=""; DE_PID=""; VNC_PID=""; DBUS_PID=""

cleanup() {
  log "shutting down..."
  for pid in "${VNC_PID}" "${DE_PID}" "${XVFB_PID}" "${DBUS_PID}"; do
    [ -n "$pid" ] && kill -TERM "$pid" 2>/dev/null
  done
  sleep 1
  pkill -TERM -u "$(id -u)" -f 'startlxde|lxpanel|pcmanfm|openbox|feh|lxterminal|lxlock|lxsession' 2>/dev/null
  rm -f "/tmp/.X${DISPLAY_NUM}-lock" 2>/dev/null
  rm -f /tmp/session-ready 2>/dev/null
  log "stopped."
  exit 0
}
trap cleanup TERM INT

stop_stack() {
  rm -f /tmp/session-ready 2>/dev/null
  for pid in "${VNC_PID}" "${DE_PID}" "${XVFB_PID}"; do
    [ -n "$pid" ] && kill -TERM "$pid" 2>/dev/null
  done
  # LXDE children are spawned by startlxde; make sure nothing survives a restart
  pkill -TERM -u "$(id -u)" -f 'startlxde|lxpanel|pcmanfm --desktop|openbox|lxlock' 2>/dev/null
  sleep 1
  for pid in "${VNC_PID}" "${DE_PID}" "${XVFB_PID}"; do
    [ -n "$pid" ] && kill -KILL "$pid" 2>/dev/null
  done
  VNC_PID=""; DE_PID=""; XVFB_PID=""
  rm -f "/tmp/.X${DISPLAY_NUM}-lock" 2>/dev/null
}

start_dbus() {
  [ -n "$DBUS_PID" ] && return 0
  # dbus-launch handles the address/pid plumbing and works without a display.
  local out
  out="$(dbus-launch --sh-syntax 2>/dev/null)"
  if [ -n "$out" ]; then
    eval "${out}"
    DBUS_PID="${DBUS_SESSION_BUS_PID:-}"
    export DBUS_SESSION_BUS_ADDRESS
    log "session bus ready (${DBUS_SESSION_BUS_ADDRESS})"
  else
    log "WARNING: dbus-launch failed; desktop may show errors"
  fi
}

start_stack() {
  local geom="${SCREEN_GEOMETRY}"
  if [ -s "$RES_FILE" ]; then
    local want
    want="$(tr -d '[:space:]' < "$RES_FILE")"
    if printf '%s' "$want" | grep -Eq '^[0-9]{3,5}x[0-9]{3,5}$'; then
      geom="${want}x24"
      log "resolution request detected: ${want}"
    fi
    rm -f "$RES_FILE"
  fi

  SCREEN_GEOMETRY="$geom"
  WIDTH=""; HEIGHT=""; DEPTH=""
  IFS='x' read -r WIDTH HEIGHT DEPTH <<< "$geom"
  [ -z "$DEPTH" ] && DEPTH=24

  log "starting Xvfb ${DISPLAY} ${geom}"
  rm -f "/tmp/.X${DISPLAY_NUM}-lock" 2>/dev/null
  Xvfb "$DISPLAY" -screen 0 "$geom" -nolisten tcp -noreset +extension RANDR -extension GLX \
      >/tmp/xvfb.log 2>&1 &
  XVFB_PID=$!

  for _ in $(seq 1 60); do
    if xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then break; fi
    kill -0 "$XVFB_PID" 2>/dev/null || { log "FATAL: Xvfb exited"; cat /tmp/xvfb.log; exit 1; }
    sleep 0.25
  done
  xdpyinfo -display "$DISPLAY" >/dev/null 2>&1 || { log "FATAL: display not ready"; exit 1; }
  log "display ${DISPLAY} is up (${WIDTH}x${HEIGHT})"

  start_dbus

  log "starting LXDE desktop"
  setsid startlxde >/tmp/lxde.log 2>&1 &
  DE_PID=$!
  sleep 3

  # ---- x11vnc -------------------------------------------------------------
  local vnc_args=(
    -display "$DISPLAY"
    -rfbport "$VNC_PORT"
    -listen 0.0.0.0            # only reachable on the internal compose network
    -forever
    # -nevershared is deliberate. x11vnc serves clients one at a time and
    # keeps abandoned ones in its client list, so with -shared a browser that
    # disappears mid-handshake (tab closed, network blip) starves every later
    # viewer until x11vnc eventually notices the dead socket - minutes later.
    # With -nevershared the newest browser always wins, which is exactly the
    # behaviour you want when a noVNC tab reconnects.
    -nevershared
    -repeat
    -xkb -noxdamage -nolookup
    -desktop "Web Desktop ${DISPLAY_NUM}"
    -o /tmp/x11vnc.log
  )
  if [ -n "$VNC_PASSWORD" ]; then
    # x11vnc truncates RFB passwords to 8 characters.
    local pwfile
    pwfile="$(mktemp /tmp/vncpass.XXXXXX)"
    chmod 600 "$pwfile"
    printf '%s' "$VNC_PASSWORD" > "$pwfile"
    vnc_args+=(-rfbauth "$pwfile")
    log "VNC password protection enabled (8 chars max)"
  else
    vnc_args+=(-nopw)
    log "VNC listening on 0.0.0.0:${VNC_PORT} inside the container network only"
  fi

  log "starting x11vnc on port ${VNC_PORT}"
  x11vnc "${vnc_args[@]}" >/dev/null 2>&1 &
  VNC_PID=$!

  for _ in $(seq 1 40); do
    # Passive readiness check: is x11vnc LISTENING? Probing by connecting
    # would leave zombie clients in x11vnc's single-client accept loop.
    hex_port=$(printf '%04X' "${VNC_PORT}")
    if awk -v p="$hex_port" '$4 == "0A" && $2 ~ (":" p "$") { f = 1 } END { exit !f }' \
         /proc/net/tcp /proc/net/tcp6 2>/dev/null; then
      break
    fi
    kill -0 "$VNC_PID" 2>/dev/null || { log "FATAL: x11vnc exited"; cat /tmp/x11vnc.log; exit 1; }
    sleep 0.25
  done

  touch /tmp/session-ready
  log "session READY - open it in a browser through the manager."
}

# -----------------------------------------------------------------------------
log "session bootstrap (user=$(id -un) uid=$(id -u) home=${HOME})"
/usr/local/bin/bootstrap.sh

start_stack

# --- supervisor loop: react to resolution changes, keep the session alive -----
while true; do
  sleep 2
  # Resolution change requested from inside the desktop
  if [ -s "$RES_FILE" ]; then
    log "re-applying screen resolution..."
    stop_stack
    start_stack
    continue
  fi
  # A crashed core component is restarted instead of leaving a black screen
  if ! kill -0 "$XVFB_PID" 2>/dev/null || ! kill -0 "$VNC_PID" 2>/dev/null; then
    log "core component died, restarting the session stack"
    stop_stack
    start_stack
    continue
  fi
  if ! pgrep -u "$(id -u)" -f 'pcmanfm --desktop' >/dev/null 2>&1; then
    log "desktop manager is not running, relaunching"
    setsid pcmanfm --desktop --profile LXDE >/dev/null 2>&1 &
  fi
done
