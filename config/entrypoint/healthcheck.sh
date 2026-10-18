#!/bin/bash
# Container healthcheck.
#
# The session is "healthy" only when the X display answers AND x11vnc is
# LISTENING on its RFB port - exactly what the browser needs.
#
# The port check is PASSIVE (it parses /proc/net/tcp) instead of connecting to
# it. An active connect-and-close probe every few seconds floods x11vnc with
# half-open clients: it serves one client at a time and keeps abandoned ones in
# its client list, so a real viewer can be starved by its own healthcheck.
set -u

DISPLAY_NUM="${DISPLAY_NUM:-1}"
VNC_PORT="${VNC_PORT:-5900}"

xdpyinfo -display ":${DISPLAY_NUM}" >/dev/null 2>&1 || exit 1

hex_port=$(printf '%04X' "$VNC_PORT")
# /proc/net/tcp: $2 = local_address "HEXADDR:HEXPORT", $4 = state (0A = LISTEN)
awk -v p="$hex_port" '
  $4 == "0A" && $2 ~ (":" p "$") { found = 1 }
  END { exit !found }
' /proc/net/tcp /proc/net/tcp6 2>/dev/null || exit 1
exit 0
