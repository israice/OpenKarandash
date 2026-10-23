#!/usr/bin/env bash
# =============================================================================
#  image-size.sh - report the REAL size of the desktop image.
#
#  `docker image ls` is not a reliable number: on Docker Desktop's containerd
#  image store it adds the compressed blob size on top of the uncompressed
#  layer sizes, so it over-reports. This script prints all three figures:
#
#    ls        what `docker image ls` says (may double count)
#    content   compressed bytes actually pulled over the network
#    on-disk   uncompressed bytes a running container occupies
#
#  Usage: ./scripts/image-size.sh [image]
# =============================================================================
set -euo pipefail

IMAGE="${1:-${DESKTOP_IMAGE:-webdesktop:lxde}}"
MB=1048576

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "image not found: $IMAGE (build it with: docker compose build desktop-image)" >&2
  exit 1
fi

ls_size=$(docker image ls "$IMAGE" --format '{{.Size}}')
content=$(docker image inspect "$IMAGE" --format '{{.Size}}')

# Uncompressed total = sum of the layer sizes reported by `docker history`.
on_disk=$(docker history "$IMAGE" --format '{{.Size}}' | numfmt --from=iec 2>/dev/null | awk '
  function tokb(b,   u, v) {
    u = substr(b, length(b) - 1)
    v = substr(b, 1, length(b) - 2) + 0
    if (u == "KiB" || u == "KB" || u == "kB") return v / 1024
    if (u == "MiB" || u == "MB") return v
    if (u == "GiB" || u == "GB") return v * 1024
    return v
  }
  { s += tokb($0) }
  END { printf "%.1f", s }')

# Measured runtime footprint of a freshly started session, for reference.
echo "image            : $IMAGE"
echo "docker image ls  : $ls_size          (may double count, see header)"
echo "compressed blob  : $(awk -v b="$content" -v m=$MB 'BEGIN{printf "%.1f MB (%.1f MiB)", b/1000000, b/m}')"
echo "uncompressed     : ${on_disk} MB             (what a container occupies)"

echo
echo "installed packages inside the image:"
docker run --rm --entrypoint sh "$IMAGE" -c \
  "dpkg-query -f='\${Installed-Size}\n' -W 2>/dev/null | awk '{s+=\$1} END {printf \"  %d MiB in %d packages\n\", s/1024, NR}'"

echo "browser check (must print nothing):"
browsers=$(docker run --rm --entrypoint sh "$IMAGE" -c \
  "ls /usr/bin /usr/local/bin /opt 2>/dev/null | grep -Ei 'chrom|chrome' || true")
if [ -z "$browsers" ]; then
  echo "  OK: no chrome/chromium binary in the image"
else
  echo "  FAIL: found: $browsers"
  exit 1
fi
