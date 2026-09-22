#!/bin/sh
# 容器入口：启动前自检「底图瓦片 + 内容数据(JSON)」。
#
# 三条原则：
#   1) 先探目录可写性，不可写就**立刻退出并说明原因**，绝不白下载几十 MB；
#   2) 已有文件优先，绝不覆盖部署方放好的数据；
#   3) 下载位置优先用挂载进来的目录（可持久化），不可写时才退到容器内临时目录。
set -eu

TILES_DIR="${TILES_DIR:-/srv/tiles}"
DATA_JSON_CACHE_DIR="${DATA_JSON_CACHE_DIR:-/tmp/nte-data-json}"
RUN_UID="$(id -u)"

log() { echo "[bootstrap] $*"; }

# 目录存在且当前用户可写（顺带 mkdir -p）
writable() {
  dir="$1"
  mkdir -p "$dir" 2>/dev/null || return 1
  touch "$dir/.write-test.$$" 2>/dev/null || return 1
  rm -f "$dir/.write-test.$$" 2>/dev/null || true
  return 0
}

need_tiles() { [ "${REQUIRE_TILES:-0}" = "1" ]; }

fail_tiles() {
  log "原因：容器以 uid ${RUN_UID} 运行，而 $TILES_DIR 不可写（宿主属主不是 ${RUN_UID}，或挂载带了 :ro）。"
  log "处理：把宿主目录属主改成 ${RUN_UID}:${RUN_UID}（例如 chown -R 1000:1000 <目录>），"
  log "      或去掉只读挂载，或把 REQUIRE_TILES 设为 0（底图会全黑）。"
  if need_tiles; then
    log "REQUIRE_TILES=1：直接退出（本次没有发起下载）。"
    exit 1
  fi
}

# ---------- 1. 底图瓦片 ----------
if [ -d "$TILES_DIR/0" ]; then
  log "瓦片就绪：$TILES_DIR（$(find "$TILES_DIR" -name '*.jpg' | wc -l) 张）"
elif [ "${TILES_AUTO_FETCH:-1}" != "1" ]; then
  log "瓦片缺失（$TILES_DIR），且 TILES_AUTO_FETCH=0，跳过自动下载"
  fail_tiles
elif ! writable "$TILES_DIR"; then
  log "瓦片缺失（$TILES_DIR），且该目录不可写。"
  fail_tiles
else
  repo="${MAPSOURCE_REPO:-Maa-NTE/MapSource}"
  branch="${MAPSOURCE_BRANCH:-main}"
  log "瓦片缺失（$TILES_DIR），从 ${repo}@${branch} 下载…"
  tmp="$(mktemp -d)"
  if curl -fsSL "https://codeload.github.com/${repo}/tar.gz/refs/heads/${branch}" | tar xz -C "$tmp"; then
    src="$(find "$tmp" -maxdepth 2 -type d -name tiles | head -n 1)"
    if [ -n "$src" ] && cp -a "$src/." "$TILES_DIR/" 2>/dev/null; then
      log "瓦片就绪：$(find "$TILES_DIR" -name '*.jpg' | wc -l) 张"
    else
      log "下载成功但解压/写入失败（$TILES_DIR）"
      rm -rf "$tmp"
      fail_tiles
    fi
  else
    log "瓦片下载失败（网络不可达？）"
    rm -rf "$tmp"
    fail_tiles
  fi
  rm -rf "$tmp"
fi

# ---------- 2. 内容数据 JSON（题库快照 / 坐标标定 / 区域落点）----------
repo_git="${GIT_REPO:-564024841/NTE-GeoGuess}"
repo_branch="${GIT_BRANCH:-main}"

ensure_json() {
  var="$1"
  file="$2"
  bundled="/app/$file"
  eval "current=\${$var:-}"

  if [ -n "${current:-}" ] && [ -r "$current" ]; then
    log "$var 就绪：$current"
    return 0
  fi

  target_dir=""
  if [ "${DATA_JSON_AUTO_FETCH:-1}" = "1" ]; then
    # 优先写回配置路径所在目录（挂载进来的话可持久化）
    if [ -n "${current:-}" ]; then
      d="$(dirname "$current")"
      if writable "$d"; then target_dir="$d"; fi
    fi
    if [ -z "$target_dir" ] && writable "$DATA_JSON_CACHE_DIR"; then
      target_dir="$DATA_JSON_CACHE_DIR"
    fi
  fi

  if [ -n "$target_dir" ]; then
    target="$target_dir/$(basename "$file")"
    if curl -fsSL "https://raw.githubusercontent.com/${repo_git}/${repo_branch}/${file}" -o "$target" 2>/dev/null \
      && [ -s "$target" ]; then
      log "$var 缺失，已从仓库下载：$target"
      export "$var=$target"
      return 0
    fi
    log "$var 下载失败：${repo_git}/${repo_branch}/${file}"
  else
    log "$var 缺失（${current:-未设置}），且没有可写目录可用于下载"
  fi

  if [ -r "$bundled" ]; then
    log "$var 回退到镜像内置副本：$bundled"
    export "$var=$bundled"
  else
    log "警告：$var 既下载不到，镜像内也没有副本（$bundled）"
  fi
  return 0
}

ensure_json SEED_DATA_FILE        packages/shared/data/map-data.json
ensure_json CALIBRATION_FILE      packages/shared/data/navi-coordinate-calibration.json
ensure_json REGION_POSITIONS_FILE packages/shared/data/region-positions.json

exec "$@"
