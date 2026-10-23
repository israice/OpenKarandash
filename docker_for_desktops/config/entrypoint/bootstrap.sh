#!/bin/bash
# =============================================================================
#  bootstrap.sh - first-run initialisation of the session home directory.
#
#  /opt/desktop-defaults mirrors the layout of $HOME. Its contents are COPIED
#  into the persistent home volume ONCE, guarded by ~/.desktop-initialized.
#  Re-running the container never overwrites user changes - the only exception
#  are the desktop shortcuts, which belong to the image and are refreshed on
#  every start (see the bottom of this file).
#
#  Everything under $HOME after the copy belongs to that session alone.
# =============================================================================
set -uo pipefail

HOME_DIR="${HOME:-/home/desktop}"
DEFAULTS=/opt/desktop-defaults
MARKER="${HOME_DIR}/.desktop-initialized"

mkdir -p "${HOME_DIR}/Desktop" "${HOME_DIR}/Pictures" "${HOME_DIR}/Documents" \
         "${HOME_DIR}/Downloads" "${HOME_DIR}/Templates" "${HOME_DIR}/.config" \
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

# The desktop shortcuts belong to the image, not to the user: they are re-added
# whenever they are missing, so the user has no lasting say over them anyway.
# They are therefore refreshed on every start - otherwise a session that was
# created before a fix keeps the broken shortcut (the "Settings" one pointed
# at lxappearance, which is not in the image) forever.
[ -d "${DEFAULTS}/Desktop" ] && cp -f "${DEFAULTS}/Desktop/"*.desktop "${HOME_DIR}/Desktop/" 2>/dev/null

# The panel layout is refreshed too, but only while it is still the one this
# image shipped: the marker comment disappears as soon as lxpanel rewrites the
# file (which it does when the user rearranges the panel), and from that moment
# the layout belongs to the user.
PANEL_SRC="${DEFAULTS}/lxde-profile/.config/lxpanel/LXDE/panels/panel"
PANEL_DST="${HOME_DIR}/.config/lxpanel/LXDE/panels/panel"
if [ -f "$PANEL_SRC" ]; then
  if [ ! -f "$PANEL_DST" ] || grep -qs 'webdesktop-managed' "$PANEL_DST"; then
    mkdir -p "$(dirname "$PANEL_DST")"
    cp -f "$PANEL_SRC" "$PANEL_DST" 2>/dev/null
  fi
fi

chmod +x "${HOME_DIR}/bin/"* 2>/dev/null

# The prompt of a session container shows the container name, which is an id
# (wd-<session id>), not a hostname anybody recognises. The standard Debian
# prompt minus the host part: "desktop:~$" instead of "desktop@wd-1a2b3c:~$".
# The window title (the \e]0;...\a escape) keeps the host name, so a user
# with several sessions open can still tell them apart.
BASHRC="${HOME_DIR}/.bashrc"
if [ -f "${BASHRC}" ] && ! grep -q 'webdesktop-prompt' "${BASHRC}"; then
  cat >> "${BASHRC}" <<'EOF'

# webdesktop-prompt: the container hostname is an id, not a name - drop it
# from the prompt but keep it in the window title.
PS1='${debian_chroot:+($debian_chroot)}\[\e]0;\u@\h: \w\a\]${debian_chroot:+($debian_chroot)}\[\033[01;32m\]\u:\w\033[00m\]$ '
EOF
fi

exit 0
