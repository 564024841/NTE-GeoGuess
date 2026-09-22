#!/bin/sh
# 容器入口：首次启动时可选地把底图瓦片抓到 TILES_DIR（默认关闭）。
#
# 为什么需要：镜像里的 /srv/tiles 平时是空的（CI 构建上下文不含 MapSource/），
# 生产一般从宿主目录只读挂载瓦片。若你希望容器自带瓦片、又不想在宿主上准备目录，
# 就用 TILES_AUTO_FETCH=1 启动，并把 /srv/tiles 换成一个可写卷（命名卷或宿主目录）。
set -e

TILES_DIR="${TILES_DIR:-/srv/tiles}"

if [ "${TILES_AUTO_FETCH:-0}" = "1" ] && [ ! -d "$TILES_DIR/0" ]; then
  repo="${MAPSOURCE_REPO:-Maa-NTE/MapSource}"
  branch="${MAPSOURCE_BRANCH:-main}"
  echo "[tiles] $TILES_DIR 为空，从 github.com/$repo ($branch) 拉取底图瓦片…"
  tmp="$(mktemp -d)"
  curl -fsSL "https://codeload.github.com/$repo/tar.gz/refs/heads/$branch" | tar xz -C "$tmp"
  src="$(find "$tmp" -maxdepth 2 -type d -name tiles | head -n 1)"
  if [ -z "$src" ]; then
    echo "[tiles] 压缩包里没找到 tiles/ 目录，放弃" >&2
    exit 1
  fi
  mkdir -p "$TILES_DIR"
  cp -a "$src/." "$TILES_DIR/"
  rm -rf "$tmp"
  echo "[tiles] 完成：$(find "$TILES_DIR" -name '*.jpg' | wc -l) 张瓦片"
fi

exec "$@"
