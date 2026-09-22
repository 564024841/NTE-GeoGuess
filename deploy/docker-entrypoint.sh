#!/bin/sh
# 容器入口：启动前自检「底图瓦片 + 内容数据(JSON)」，缺失就自动下载补全。
#
# 设计原则：
#   · 已有文件的挂载目录优先级最高，什么都不做（部署方自己维护数据时零干扰）。
#   · 缺什么补什么，补不了的给出明确原因，而不是让服务起在半残状态。
#   · 所有开关都能用环境变量关掉（见 docs/deployment.md）。
set -eu

TILES_DIR="${TILES_DIR:-/srv/tiles}"
DATA_JSON_CACHE_DIR="${DATA_JSON_CACHE_DIR:-/tmp/nte-data-json}"

log() { echo "[bootstrap] $*"; }

# ---------- 1. 底图瓦片 ----------
tiles_ok() { [ -d "$TILES_DIR/0" ]; }

fetch_tiles() {
  repo="${MAPSOURCE_REPO:-Maa-NTE/MapSource}"
  branch="${MAPSOURCE_BRANCH:-main}"
  url="https://codeload.github.com/${repo}/tar.gz/refs/heads/${branch}"
  log "瓦片缺失（$TILES_DIR），从 $repo@$branch 下载…"
  tmp="$(mktemp -d)"
  if ! curl -fsSL "$url" | tar xz -C "$tmp"; then
    rm -rf "$tmp"
    return 1
  fi
  src="$(find "$tmp" -maxdepth 2 -type d -name tiles | head -n 1)"
  if [ -z "$src" ]; then
    log "压缩包里没有 tiles/ 目录"
    rm -rf "$tmp"
    return 1
  fi
  mkdir -p "$TILES_DIR" 2>/dev/null || true
  if ! cp -a "$src/." "$TILES_DIR/" 2>/dev/null; then
    log "下载成功但写入 $TILES_DIR 失败（只读挂载或权限不足）"
    rm -rf "$tmp"
    return 1
  fi
  rm -rf "$tmp"
  log "瓦片就绪：$(find "$TILES_DIR" -name '*.jpg' | wc -l) 张"
}

if ! tiles_ok; then
  if [ "${TILES_AUTO_FETCH:-1}" = "1" ]; then
    if ! fetch_tiles && [ "${REQUIRE_TILES:-0}" = "1" ]; then
      log "已开启 REQUIRE_TILES 且瓦片不可用：请把完整瓦片放到 $TILES_DIR，"
      log "或改成可写挂载让容器自己下载，或临时设 REQUIRE_TILES=0。"
      exit 1
    fi
  else
    log "瓦片缺失（$TILES_DIR）且 TILES_AUTO_FETCH=0，跳过自动下载"
    if [ "${REQUIRE_TILES:-0}" = "1" ]; then
      log "REQUIRE_TILES=1 时不允许空瓦片目录，退出。"
      exit 1
    fi
  fi
else
  log "瓦片就绪：$TILES_DIR（$(find "$TILES_DIR" -name '*.jpg' | wc -l) 张）"
fi

# ---------- 2. 内容数据 JSON（题库快照 / 坐标标定 / 区域落点）----------
# 缺失时优先从仓库 raw 下载；下载不了就退回镜像内置的那份，并打印用了哪一份。
repo_git="${GIT_REPO:-564024841/NTE-GeoGuess}"
repo_branch="${GIT_BRANCH:-main}"

ensure_json() {
  var="$1"        # 环境变量名，例如 SEED_DATA_FILE
  file="$2"       # 仓库里的相对路径，例如 packages/shared/data/map-data.json
  bundled="/app/$file"
  eval "current=\${$var:-}"

  if [ -n "$current" ] && [ -r "$current" ]; then
    log "$var 就绪：$current"
    return 0
  fi

  if [ "${DATA_JSON_AUTO_FETCH:-1}" = "1" ]; then
    mkdir -p "$DATA_JSON_CACHE_DIR" 2>/dev/null || true
    target="$DATA_JSON_CACHE_DIR/$(basename "$file")"
    url="https://raw.githubusercontent.com/${repo_git}/${repo_branch}/${file}"
    if curl -fsSL "$url" -o "$target" 2>/dev/null && [ -s "$target" ]; then
      log "$var 缺失，已从仓库下载：$target"
      export "$var=$target"
      return 0
    fi
  fi

  if [ -r "$bundled" ]; then
    log "$var 缺失（${current:-未设置}），回退到镜像内置：$bundled"
    export "$var=$bundled"
    return 0
  fi

  log "警告：$var 缺失，且既下载不到也没有内置副本（$bundled）"
  return 0
}

ensure_json SEED_DATA_FILE      packages/shared/data/map-data.json
ensure_json CALIBRATION_FILE    packages/shared/data/navi-coordinate-calibration.json
ensure_json REGION_POSITIONS_FILE packages/shared/data/region-positions.json

exec "$@"
