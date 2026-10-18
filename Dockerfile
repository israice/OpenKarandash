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
#  STAGE 1 - package stage
#
#  Multi-stage IS used here for a concrete reason: apt writes ~250 MB of .deb
#  files into /var/cache/apt/archives. Deleting them in the same RUN does not
#  shrink the layer (a whiteout only hides them in the merged view), so a
#  single-stage image would keep ~250 MB of dead weight. Copying the resulting
#  filesystem into a clean second stage is what actually removes them.
#  Both stages use the same debian:trixie-slim base, so the base layer is
#  shared and NOT duplicated.
# =============================================================================
FROM debian:trixie-slim AS packages

ARG DEBIAN_FRONTEND=noninteractive

# --- Runtime packages only: no build tools, no compilers, no browsers -------
#   xvfb / xauth / x11-utils    virtual framebuffer + X helpers (xdpyinfo = health)
#   x11vnc                      RFB server on the Xvfb display
#   lxde-core                   the LXDE desktop: startlxde, lxsession,
#                               openbox (WM), lxpanel (panel + menu),
#                               pcmanfm (desktop icons + file manager),
#                               lxterminal, lxappearance, lxmenu-data,
#                               lxsession-logout, lxlock
#   dbus, dbus-x11              session bus the desktop depends on
#   tango-icon-theme            icon names used by the desktop shortcuts
#   fonts-dejavu-core           minimal legible UI font
#   procps, psmisc              pgrep/pkill used by the session supervisor
#   x11-xserver-utils           xrandr (resolution helper)
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
      tango-icon-theme \
      fonts-dejavu-core \
      procps \
      psmisc \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/* /var/log/* /tmp/* /var/tmp/*

# --- Size diet -------------------------------------------------------------
# Debian's Xvfb hard-depends on the Mesa GL stack: libLLVM (~124 MB),
# mesa-libgallium (~41 MB), libz3 (~27 MB). We run Xvfb with
# "-extension GLX", so those drivers are never loaded - only libGL.so.1 and
# libGLX.so.0 are, and those live in libgl1 / libglx0 which stay installed.
# Also removed: adwaita-icon-theme (tango is our icon theme), the Ghostscript
# stack (libspectre is only used by openbox for SVG/PDF theme artwork, the
# stock LXDE theme renders fine without it), the C++ preprocessor and the
# systemd daemon (we start dbus-daemon ourselves).
# NOTE: libimlib2t64 MUST stay - openbox links against libImlib2.so.1.
# lxpolkit is dropped too: polkit has no authority to act on inside a container
# and its agent only puts a "No session for pid N" error dialog on the desktop.
# Measured effect: 714 MB -> ~440 MB of installed packages.
RUN dpkg --purge --force-depends --force-remove-reinstreq \
      libgl1-mesa-dri libglx-mesa0 mesa-libgallium libllvm19 libz3-4 \
      libglapi-mesa adwaita-icon-theme \
      poppler-data libspectre1 ghostscript libgs10 yudit-common \
      fonts-urw-base35 cpp-14-x86_64-linux-gnu systemd lxpolkit \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/* /var/log/* /tmp/* /var/tmp/*

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
    VNC_PORT=5900

# Clean filesystem of the package stage (no .deb cache, no apt lists)
COPY --from=packages / /

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

USER ${USERNAME}
WORKDIR /home/${USERNAME}

# Only for documentation: the port is NEVER published to the host, it is
# reachable exclusively from the session manager on the internal network.
EXPOSE 5900

# Ready = X display answers AND x11vnc is listening (checked passively)
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=4 \
  CMD ["/usr/local/bin/healthcheck.sh"]

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
