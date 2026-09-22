#!/bin/sh
# 容器入口：启动前自检「底图瓦片 + 内容数据(JSON)」。
#
# 三条原则（严格模式：宁可启动失败，也不糊过去）：
#   1) 先探目录可写性，不可写就**立刻退出并说明原因**，绝不白下载几十 MB；
#   2) 已有文件优先，绝不覆盖部署方放好的数据；
#   3) 所有下载只写进挂载进来的持久目录（/srv/tiles、/srv/data-json）。
#      没有 /tmp 兜底，也没有「回退到镜像内置副本」这种静默降级。
set -eu

TILES_DIR="${TILES_DIR:-/srv/tiles}"
RUN_UID="$(id -u)"
stage=""

log() { echo "[bootstrap] $*"; }

# 目录存在且当前用户可写（顺带 mkdir -p）
writable() {
  dir="$1"
  mkdir -p "$dir" 2>/dev/null || return 1
  touch "$dir/.write-test.$$" 2>/dev/null || return 1
  rm -f "$dir/.write-test.$$" 2>/dev/null || true
  return 0
}

count_tiles() { find "$TILES_DIR" -name '*.jpg' 2>/dev/null | wc -l | tr -d ' '; }

need_tiles() { [ "${REQUIRE_TILES:-0}" = "1" ]; }

# 收尾：REQUIRE_TILES=1 就退出；=0 时只告警（底图会全黑）。
# $1 = unwritable（目录写不进去）| download（下载/复制失败）
fail_tiles() {
  if [ "${1:-unwritable}" = "unwritable" ]; then
    log "原因：容器以 uid ${RUN_UID} 运行，而 $TILES_DIR 不可写（宿主属主不是 ${RUN_UID}，或挂载带了 :ro）。"
    log "处理：把宿主目录属主改成 ${RUN_UID}:${RUN_UID}（例如 chown -R 1000:1000 <目录>），"
    log "      或去掉只读挂载，或把 REQUIRE_TILES 设为 0（底图会全黑）。"
  else
    log "处理：把瓦片手工放进 $TILES_DIR（例如从别的机器拷一份完整的 tiles/），"
    log "      或改 MAPSOURCE_REPO / MAPSOURCE_BRANCH 指向可用的仓库，或设 REQUIRE_TILES=0（底图会全黑）。"
  fi
  if need_tiles; then
    log "REQUIRE_TILES=1：直接退出，不会用半份数据启动。"
    exit 1
  fi
}

# ---------- 1. 底图瓦片 ----------
# 清掉上次被强杀时可能留下的暂存目录，免得把半份瓦片当成"已就绪"
rm -rf "$TILES_DIR"/.bootstrap-tmp.* 2>/dev/null || true
rm -f "$TILES_DIR"/.write-test.* 2>/dev/null || true

if [ "$(count_tiles)" -gt 0 ]; then
  log "瓦片就绪：$TILES_DIR（$(count_tiles) 张）"
elif [ "${TILES_AUTO_FETCH:-1}" != "1" ]; then
  log "瓦片缺失（$TILES_DIR），且 TILES_AUTO_FETCH=0，跳过自动下载"
  fail_tiles unwritable
elif ! writable "$TILES_DIR"; then
  log "瓦片缺失（$TILES_DIR），且该目录不可写。"
  fail_tiles unwritable
else
  repo="${MAPSOURCE_REPO:-Maa-NTE/MapSource}"
  branch="${MAPSOURCE_BRANCH:-main}"
  log "瓦片缺失（$TILES_DIR），从 ${repo}@${branch} 下载…"
  # 下载与解压都在挂载目录里的隐藏暂存目录里做（不放 /tmp），退出时清掉
  stage="$TILES_DIR/.bootstrap-tmp.$$"
  mkdir -p "$stage"
  # 出错/被 kill 时也要把暂存目录清掉（exec 之后不会走 EXIT trap，所以下面还会显式删一次）
  trap 'if [ -n "${stage:-}" ]; then rm -rf "$stage"; fi' EXIT HUP INT TERM

  archive="$stage/tiles.tar.gz"
  ok=0
  if curl -fsSL "https://codeload.github.com/${repo}/tar.gz/refs/heads/${branch}" -o "$archive" \
    && [ -s "$archive" ] \
    && tar xzf "$archive" -C "$stage"; then
    ok=1
  fi

  if [ "$ok" = "1" ]; then
    src="$(find "$stage" -maxdepth 2 -type d -name tiles | head -n 1)"
    if [ -n "$src" ] && cp -a "$src/." "$TILES_DIR/"; then
      rm -rf "$stage"
      stage=""
      log "瓦片就绪：$TILES_DIR（$(count_tiles) 张）"
    else
      log "错误：下载解开后没找到 tiles/ 目录，或复制到 $TILES_DIR 失败。"
      log "      检查 MAPSOURCE_REPO / MAPSOURCE_BRANCH 是否正确。"
      fail_tiles download
    fi
  else
    log "错误：瓦片下载或解压失败（codeload.github.com 连不上？仓库/分支名写错？）"
    fail_tiles download
  fi
fi

# 显式清理暂存目录（REQUIRE_TILES=0 且失败时会走到这里）
if [ -n "${stage:-}" ]; then
  rm -rf "$stage"
  stage=""
fi

# ---------- 2. 内容数据 JSON（题库快照 / 坐标标定 / 区域落点）----------
repo_git="${GIT_REPO:-564024841/NTE-GeoGuess}"
repo_branch="${GIT_BRANCH:-main}"

ensure_json() {
  var="$1"
  file="$2"
  eval "current=\${$var:-}"

  if [ -n "${current:-}" ] && [ -r "$current" ]; then
    log "$var 就绪：$current"
    return 0
  fi

  if [ -z "${current:-}" ]; then
    log "错误：$var 未设置，不知道该读哪个文件。"
    exit 1
  fi

  target_dir="$(dirname "$current")"

  if [ "${DATA_JSON_AUTO_FETCH:-1}" != "1" ]; then
    log "错误：$var 指向的文件不存在（$current），且 DATA_JSON_AUTO_FETCH=0（不允许自动下载）。"
    log "处理：把文件放到该路径，或设 DATA_JSON_AUTO_FETCH=1 允许容器自动补全。"
    exit 1
  fi

  if ! writable "$target_dir"; then
    log "错误：$var 指向的文件不存在（$current），且所在目录 $target_dir 不可写，无法下载补全。"
    log "处理：把宿主目录属主改成 ${RUN_UID}:${RUN_UID}（例如 chown -R 1000:1000 <目录>），并去掉挂载上的 :ro。"
    exit 1
  fi

  target="$target_dir/$(basename "$file")"
  # 主源 + 镜像源；两个都不行就报错退出（不换目录、不用镜像里的旧副本）
  raw="https://raw.githubusercontent.com/${repo_git}/${repo_branch}/${file}"
  mirror="https://cdn.jsdelivr.net/gh/${repo_git}@${repo_branch}/${file}"
  for url in "$raw" "$mirror"; do
    # 先落到临时名再改名，避免中断时留下半截文件
    if curl -fsSL "$url" -o "$target.part.$$" 2>/dev/null && [ -s "$target.part.$$" ]; then
      mv -f "$target.part.$$" "$target"
      log "$var 缺失，已下载并持久化：$target"
      export "$var=$target"
      return 0
    fi
    rm -f "$target.part.$$" 2>/dev/null || true
    log "下载失败：$url"
  done

  log "错误：$var 补全失败（$current 缺失，且两个下载源都不可用）。"
  log "处理：手工把文件放到 $current，或检查 GIT_REPO/GIT_BRANCH 与服务器的外网连通性。"
  exit 1
}

ensure_json SEED_DATA_FILE        packages/shared/data/map-data.json
ensure_json CALIBRATION_FILE      packages/shared/data/navi-coordinate-calibration.json
ensure_json REGION_POSITIONS_FILE packages/shared/data/region-positions.json

exec "$@"
