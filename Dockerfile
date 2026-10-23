# syntax=docker/dockerfile:1
###############################################################################
#  Web Linux Desktop  —  image for one graphical session
#
#  One image -> N containers (one per user session).
#  Contains a full LXDE desktop, an Xvfb virtual display and an x11vnc server.
#  Deliberately contains NO Chrome/Chromium - the browser lives on the client.
#
#  Build:   docker build -t webdesktop:lxde .
#  Size:    see scripts/image-size.sh for how the numbers are measured.
###############################################################################

# =============================================================================
#  STAGE 0 - Node.js runtime
#
#  Keep the desktop's Node version aligned with the app image. Projects cloned
#  into a desktop can then run their npm scripts without installing Node first.
# =============================================================================
FROM node:22-bookworm AS node-runtime

# =============================================================================
#  STAGE 1 - package stage
#
#  The package stage is isolated for a concrete reason: apt writes ~250 MB of .deb
#  files into /var/cache/apt/archives. Deleting them in the same RUN does not
#  shrink the layer (a whiteout only hides them in the merged view), so a
#  single-stage image would keep ~250 MB of dead weight. Copying the resulting
#  filesystem into a clean second stage is what actually removes them.
#  The Node runtime comes from the app's official Node 22 base image below.
# =============================================================================
FROM debian:trixie-slim AS packages

ARG DEBIAN_FRONTEND=noninteractive

# --- Runtime packages only: no build tools, no compilers, no browsers -------
#   xvfb / xauth / x11-utils    virtual framebuffer + X helpers (xdpyinfo = health)
#   x11vnc                      RFB server on the Xvfb display
#   lxde-core                   the LXDE desktop: startlxde, lxsession,
#                               openbox (WM), lxpanel (panel + menu),
#                               pcmanfm (desktop icons + file manager),
#                               lxterminal, lxmenu-data,
#                               lxsession-logout, lxlock
#                               (lxappearance is NOT part of lxde-core on
#                               trixie - it is a separate GTK3 package)
#   dbus, dbus-x11              session bus the desktop depends on
#   menu-xdg                    debian-menu.menu, without it the "Debian"
#                               submenu of the application menu stays empty
#   xdg-utils                   xdg-open: the file manager needs it to open a
#                               document with the application of its choice
#   libglib2.0-bin              gsettings, the only way to change the GTK3
#                               icon theme without lxappearance
#   tango-icon-theme            full-colour legacy icon names (terminal,
#                               system-file-manager, gnome-log-out, ...)
#   adwaita-icon-theme          the symbolic icon set GTK3 apps ask for
#   librsvg2-common             the gdk-pixbuf SVG loader - WITHOUT it gdk-pixbuf
#                               cannot decode a single SVG, so every scalable
#                               icon (Tango's too) and every GTK3 theme asset
#                               (bullet-symbolic.svg and friends) stays blank
#   fonts-dejavu-core           minimal legible UI font
#   procps, psmisc              pgrep/pkill used by the session supervisor
#   x11-xserver-utils           xrandr (resolution helper)
#   sudo                        the session user becomes root inside the
#                               container: without it `sudo apt-get install`
#                               fails and NOTHING can be installed
#   ca-certificates, curl       https downloads (curl | bash installers)
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      xvfb \
      xauth \
      x11-utils \
      x11vnc \
      xclip \
      xsel \
      x11-xserver-utils \
      lxde-core \
      lxterminal \
      dbus \
      dbus-x11 \
      menu-xdg \
      xdg-utils \
      libglib2.0-bin \
      tango-icon-theme \
      adwaita-icon-theme \
      librsvg2-common \
      fonts-dejavu-core \
      procps \
      psmisc \
      sudo \
      ca-certificates \
      curl \
      git \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/* /var/log/* /tmp/* /var/tmp/*

# --- Size diet -------------------------------------------------------------
# Five stacks are dead weight in a container, but apt cannot remove them on
# its own - every one of them is a hard dependency of something we need:
#
#   Mesa GL    xvfb -> libgl1 -> libglx0 -> libglx-mesa0 -> mesa-libgallium
#              -> libllvm19 (126 MB)
#   Ghostscript libspectre1 -> libgs10 -> libgs10-common -> fonts-urw-base35
#              (15 MB; only used by openbox for SVG/PDF window artwork)
#   systemd    lxsession -> libpam-systemd -> systemd
#   polkit     lxsession -> lxpolkit, lxsession-logout -> polkitd
#   lightdm    light-locker -> lightdm (a display manager in a container?)
#
# At runtime none of them is used: Xvfb is started with "-extension GLX" and
# never creates a GL context, openbox's stock theme is raster artwork, polkit
# has no authority to act on inside a container (and the agent is disabled in
# /etc/xdg/lxsession/LXDE/desktop.conf anyway) and there is no display manager -
# the session is started by the entrypoint.
#
# light-locker itself stays: it ships /usr/bin/lxlock, and the LXDE logout
# dialog offers "Lock Screen". A manual lock is a deliberate feature here (an
# IDLE lock would be a support ticket, a manual one is not), and without
# lightdm light-locker still locks the screen on its own. Only lightdm, the
# display manager it merely recommends, goes.
#
# The purge therefore runs with --force-depends, and the dependencies it
# leaves dangling are satisfied by a dummy provider package below, so the dpkg
# database stays consistent and `apt-get install` still works inside the image.
#
# Kept on purpose: libgl1 + libglx0 + libglvnd0 (Xvfb links libGL.so.1 and
# libGLX.so.0), libimlib2t64 (openbox links libImlib2.so.1), libxcb-shape0
# (x11-utils needs it), libwayland-client0 and libepoxy0 (GTK3 needs them).
#
# adwaita-icon-theme is NOT removed any more: it is the only source of the
# symbolic icons GTK3 asks for (view-refresh-symbolic, dialog-information-
# symbolic, ...), and without them every menu, checkbox and toolbar button in
# the session draws a blank placeholder.
RUN dpkg --purge --force-all --force-remove-reinstreq \
      libgl1-mesa-dri libglx-mesa0 mesa-libgallium libllvm19 libz3-4 \
      libglapi-mesa \
      libgbm1 libdrm-amdgpu1 libdrm-intel1 libdrm2 libdrm-common \
      libvulkan1 libwayland-server0 \
      libxcb-dri3-0 libxcb-glx0 libxcb-present0 libxcb-randr0 \
      poppler-data ghostscript libgs10 libgs10-common yudit-common \
      fonts-urw-base35 libspectre1 \
      systemd systemd-sysv libpam-systemd libsystemd-shared \
      lxpolkit polkitd libpolkit-gobject-1-0 libpolkit-agent-1-0 \
      lightdm \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/* /var/log/* /tmp/* /var/tmp/*

# --- Dummy provider for the dependencies the purge leaves dangling ---------
# See the size diet above. A package that ships no files but provides the
# removed names keeps dpkg and apt consistent: without it the image reports
# broken dependencies and every `apt-get install` inside it fails with
# "Unmet dependencies".
#
#   libglx-mesa0            <- libglx0        (the GLX dispatch, kept)
#   libspectre1 (= 0.2.3)   <- libimlib2t64   (openbox, kept)
#   polkit-1-auth-agent     <- lxsession
#   polkitd                 <- lxsession-logout
#   default-dbus-session-bus<- dconf-service
RUN set -eux; \
    mkdir -p /tmp/stub/DEBIAN; \
    printf '%s\n' \
      'Package: webdesktop-slim-stub' \
      'Version: 1.0' \
      'Architecture: all' \
      'Maintainer: Web Desktop <desktop@example.invalid>' \
      'Provides: libglx-mesa0, libspectre1 (= 0.2.3), polkit-1-auth-agent, polkitd, default-dbus-session-bus' \
      'Description: dummy provider for packages removed from this image' \
      ' The Mesa GL stack, the Ghostscript CLI, the polkit agent, the systemd' \
      ' daemon and the display manager are removed on purpose: Xvfb runs with' \
      ' -extension GLX, polkit cannot act on anything inside a container and' \
      ' there is no display manager. The packages that depend on them are' \
      ' kept, so this package provides the removed names and keeps the dpkg' \
      ' database consistent.' \
      > /tmp/stub/DEBIAN/control; \
    dpkg-deb --build /tmp/stub /tmp/webdesktop-slim-stub.deb >/dev/null; \
    dpkg -i /tmp/webdesktop-slim-stub.deb >/dev/null; \
    rm -rf /tmp/stub /tmp/webdesktop-slim-stub.deb; \
    rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*

# =============================================================================
#  STAGE 2 - runtime
# =============================================================================
FROM debian:trixie-slim

ARG USERNAME=desktop
ARG USER_UID=1000
ARG USER_GID=1000
ARG RESOLUTION=1440x900

# NOTE: VNC_PASSWORD is intentionally NOT baked into the image. It is passed
# per container by the session manager through the Docker API env, or via
# --env-file on the command line.
ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    HOME=/home/desktop \
    DISPLAY_NUM=1 \
    SCREEN_GEOMETRY=${RESOLUTION}x24 \
    VNC_RESOLUTION=${RESOLUTION} \
    VNC_PORT=5900 \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/games:/usr/local/games

# Clean filesystem of the package stage (no .deb cache, no apt lists)
COPY --from=packages / /
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=node-runtime /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm

RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && node --version \
 && npm --version \
 && node -e "require('node:sqlite')"

# LXDE session definition (window manager + GTK/icon theme). Replaces Debian's
# default, which points at icon themes that are not installed here.
COPY config/lxsession/desktop.conf /etc/xdg/lxsession/LXDE/desktop.conf

# Desktop icons / wallpaper / LXDE profile defaults that are COPIED (once) into
# each session's persistent home directory. /opt/desktop-defaults mirrors the
# layout of $HOME, so bootstrap.sh can copy the tree verbatim. Read-only in the
# image, writable in the volume - sessions never share mutable configuration.
COPY assets/wallpaper.png /opt/desktop-defaults/wallpaper.png
COPY config/entrypoint/desktop-items/ /opt/desktop-defaults/Desktop/
COPY config/entrypoint/lxde-profile/ /opt/desktop-defaults/lxde-profile/
# Helper commands used by the desktop shortcuts, also on PATH
COPY config/entrypoint/lxde-profile/bin/ /usr/local/bin/
COPY config/entrypoint/entrypoint.sh /usr/local/bin/entrypoint.sh
COPY config/entrypoint/bootstrap.sh  /usr/local/bin/bootstrap.sh
COPY config/entrypoint/healthcheck.sh /usr/local/bin/healthcheck.sh
RUN chmod 0755 /usr/local/bin/entrypoint.sh \
 && chmod 0755 /usr/local/bin/bootstrap.sh \
 && chmod 0755 /usr/local/bin/healthcheck.sh \
 && chmod 0755 /usr/local/bin/set-resolution \
 && chmod 0755 /usr/local/bin/set-icon-theme \
 && chmod 0755 /usr/local/bin/lxde-restart \
 && chmod 0755 /opt/desktop-defaults/lxde-profile/bin/*

# Non-privileged runtime user
RUN groupadd -g "${USER_GID}" "${USERNAME}" \
 && useradd -m -u "${USER_UID}" -g "${USER_GID}" -s /bin/bash "${USERNAME}" \
 && mkdir -p /run/user/${USER_UID} \
 && chown -R ${USER_UID}:${USER_GID} /home/${USERNAME} /run/user/${USER_UID} \
 && chmod 0700 /run/user/${USER_UID} \
 && echo "${USERNAME}:!" | chpasswd \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/* /tmp/* /var/tmp/*

# Passwordless sudo for the session user.
#
# A desktop where `sudo apt-get install` does not work is a desktop where
# nothing can be installed - and installing software is a normal thing to do
# in a session. The escalation is confined to the container: no docker socket,
# no host mounts, no privileged mode, hard RAM/CPU/pids limits.
#
# The rule lives in a file of its own because sudo refuses to read a
# sudoers.d entry with the wrong permissions, and because `visudo -c` has to
# be able to check it at build time - a broken sudoers file would only show
# up in the session, as "sudo: no passwordless access".
RUN printf '%s ALL=(ALL) NOPASSWD:ALL\n' "${USERNAME}" > /etc/sudoers.d/desktop \
 && chown root:root /etc/sudoers.d/desktop \
 && chmod 0440 /etc/sudoers.d/desktop \
 && grep -q '^@includedir /etc/sudoers.d' /etc/sudoers \
 && visudo -c

# OpenCode is part of the desktop contract: the chat bridge executes the CLI
# in this image, while the interactive terminal in LXDE uses the same binary.
# Install it into the system PATH so it is available to both root during image
# build and the unprivileged desktop user at runtime.  Git is installed in the
# package stage above because workspace preparation and OpenCode both need it.
RUN export OPENCODE_INSTALL_DIR=/usr/local/bin \
 && curl -fsSL https://opencode.ai/install | bash \
 && install -m 0755 /home/desktop/.opencode/bin/opencode /usr/local/bin/opencode \
 && /usr/local/bin/opencode --version \
 && rm -rf /home/${USERNAME}/.opencode /home/${USERNAME}/.local \
 && chown ${USER_UID}:${USER_GID} /home/${USERNAME}/.bashrc

USER ${USERNAME}
WORKDIR /home/${USERNAME}

# Only for documentation: the port is NEVER published to the host, it is
# reachable exclusively from the session manager on the internal network.
EXPOSE 5900

# Ready = X display answers AND x11vnc is listening (checked passively)
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=4 \
  CMD ["/usr/local/bin/healthcheck.sh"]

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
