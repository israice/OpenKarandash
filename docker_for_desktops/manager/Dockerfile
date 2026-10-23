###############################################################################
#  Session manager for the Web Linux Desktop platform.
#
#  Responsibilities:
#    - REST API for creating / inspecting / stopping / deleting sessions
#    - resource admission control (RAM, CPU, disk, max sessions, queue)
#    - per-session Docker container lifecycle with hard limits
#    - session metadata persisted separately from the containers
#    - serves the noVNC web client and proxies the VNC WebSocket
#
#  The manager is the ONLY component that talks to the Docker socket.
#  Session containers never receive the socket and never run privileged.
###############################################################################
FROM python:3.13-slim-bookworm

ARG MANAGER_VERSION=1.0.0

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    NOVNC_ROOT=/usr/share/novnc

# We deliberately do NOT use the distro's `novnc` package here: it pulls a large
# dependency set. The noVNC web client is a handful of static files, so they are
# downloaded from the official release tarball and checksum-verified instead.
ARG NOVNC_VERSION=1.6.0
# sha256 of noVNC v1.6.0 source tarball (verified against the GitHub release)
ARG NOVNC_SHA256=5066103959ef4e9b10f37e5a148627360dd8414e4cf8a7db92bdbd022e728aaa

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      tini \
      xz-utils \
 && rm -rf /var/lib/apt/lists/*

COPY manager/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt && rm -f /tmp/requirements.txt

# noVNC + websockify static assets (served by the manager, see docs/README)
ARG NOVNC_URL=https://github.com/novnc/noVNC/archive/refs/tags/v1.6.0.tar.gz
RUN mkdir -p /usr/share/novnc \
 && curl -fsSL "${NOVNC_URL}" -o /tmp/novnc.tar.gz \
 && echo "${NOVNC_SHA256}  /tmp/novnc.tar.gz" | sha256sum -c - \
 && mkdir -p /tmp/novnc-src \
 && tar -xzf /tmp/novnc.tar.gz -C /tmp/novnc-src --strip-components=1 \
 && cp -r /tmp/novnc-src/. /usr/share/novnc/ \
 && rm -rf /tmp/novnc-src /tmp/novnc.tar.gz \
 && test -f /usr/share/novnc/vnc.html \
 && echo "noVNC installed: $(cat /usr/share/novnc/package.json | grep -o '"version": *"[^"]*"' | head -1)"

# Non-root runtime user
RUN groupadd -g 1001 manager \
 && useradd -m -u 1001 -g 1001 -s /usr/sbin/nologin manager \
 && mkdir -p /var/lib/session-manager \
 && chown -R manager:manager /var/lib/session-manager

WORKDIR /app
COPY manager/app/ /app/app/
COPY config/manager.yaml /app/config/manager.yaml

USER manager

EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=4 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8080/healthz', timeout=3).status==200 else 1)"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["python", "-m", "app.main"]
