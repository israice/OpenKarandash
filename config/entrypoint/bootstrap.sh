#!/bin/bash
# =============================================================================
#  bootstrap.sh - first-run initialisation of the session home directory.
#
#  /opt/desktop-defaults mirrors the layout of $HOME. Its contents are COPIED
#  into the persistent home volume ONCE, guarded by ~/.desktop-initialized.
#  Re-running the container never overwrites user changes.
#
#  Everything under $HOME after the copy belongs to that session alone.
# =============================================================================
set -uo pipefail

HOME_DIR="${HOME:-/home/desktop}"
DEFAULTS=/opt/desktop-defaults
MARKER="${HOME_DIR}/.desktop-initialized"

mkdir -p "${HOME_DIR}/Desktop" "${HOME_DIR}/Pictures" "${HOME_DIR}/Documents" \
         "${HOME_DIR}/Downloads" "${HOME_DIR}/.config" \
         "${HOME_DIR}/.local/share" "${HOME_DIR}/.cache"

if [ ! -f "$MARKER" ]; then
  echo "[bootstrap] first run: installing desktop defaults into ${HOME_DIR}"
  [ -f "${DEFAULTS}/wallpaper.png" ] && cp -f "${DEFAULTS}/wallpaper.png" "${HOME_DIR}/wallpaper.png"
  [ -d "${DEFAULTS}/Desktop" ] && cp -f "${DEFAULTS}/Desktop/"*.desktop "${HOME_DIR}/Desktop/" 2>/dev/null
  # .config/lxsession/LXDE/autostart and .config/pcmanfm/LXDE/desktop-items-0.conf
  [ -d "${DEFAULTS}/lxde-profile" ] && cp -rn "${DEFAULTS}/lxde-profile/." "${HOME_DIR}/" 2>/dev/null
  touch "$MARKER"
  echo "[bootstrap] defaults installed"
else
  echo "[bootstrap] home already initialised, keeping user data"
fi

# Shortcuts are re-added only if the user removed them from the Desktop folder.
# ("-n" = never overwrite an existing file.)
[ -d "${DEFAULTS}/Desktop" ] && cp -f -n "${DEFAULTS}/Desktop/"*.desktop "${HOME_DIR}/Desktop/" 2>/dev/null

chmod +x "${HOME_DIR}/bin/"* 2>/dev/null
exit 0
