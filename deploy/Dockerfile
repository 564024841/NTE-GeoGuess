# 图寻服务端镜像。
#
# 构建上下文 = 仓库根目录（docker build -f deploy/Dockerfile .）
#
# 产物包含：
#   · 服务端（Fastify + SQLite）
#   · 游戏站与后台站的构建产物（由 nginx 或 STATIC_DIR 托管）
#   · 内置地图数据快照与 477 张点位截图（用于首次 seed）
#
# 底图瓦片约 30MB，默认不打进镜像：
#   · 由 nginx 直接读宿主目录（推荐，见 deploy/nginx.conf 示例）
#   · 或设置 TILE_REDIRECT_BASE 指向对象存储/CDN
# 需要打进镜像时用 --build-arg INCLUDE_TILES=1（要求构建上下文里存在 MapSource/tiles）。
#
# 构建参数：
#   NPM_REGISTRY      npm 源，网络受限时改成镜像源，例如
#                     --build-arg NPM_REGISTRY=https://registry.npmmirror.com
#   WITH_BUILD_TOOLS  设为 1 时安装 g++/make/python3（默认 0）。
#                     better-sqlite3 通常有 linux 预编译包，不需要编译器；
#                     仅当预编译下载失败、需要从源码编译时才打开。
#   INCLUDE_TILES     设为 1 时把瓦片打进镜像

# ---------- 构建阶段 ----------
FROM node:22-bookworm-slim AS builder

WORKDIR /app

ARG NPM_REGISTRY=https://registry.npmjs.org/
ARG WITH_BUILD_TOOLS=0

# 编译器是可选的：better-sqlite3 在 Node 22 / linux-x64 上有预编译包，
# 默认走预编译能显著缩短构建时间、缩小镜像；预编译拉不到时再打开这个开关。
RUN if [ "$WITH_BUILD_TOOLS" = "1" ]; then \
      apt-get update \
      && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
      && rm -rf /var/lib/apt/lists/*; \
    fi

# 先只复制清单，让「只改源码」的情况能命中依赖层缓存
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/game/package.json apps/game/
COPY apps/admin/package.json apps/admin/
COPY server/package.json server/

# 源码必须在 npm ci 之前就位：
# workspace 包 shared 带 prepare 钩子（安装后立即构建自己），
# 而 npm 的 --ignore-scripts 不会跳过 workspace 的 prepare，
# 所以缺了 scripts/build.mjs 就会直接失败。
COPY packages/shared packages/shared
COPY apps/game apps/game
COPY apps/admin apps/admin
COPY server server

# --ignore-scripts 跳过第三方包的安装脚本（避免执行不受控的 postinstall），
# 随后单独 rebuild better-sqlite3，把它的原生模块装好。
RUN npm ci --no-audit --no-fund --ignore-scripts --registry="$NPM_REGISTRY" \
  && npm rebuild better-sqlite3 --registry="$NPM_REGISTRY" \
  && npm run build:shared \
  && npm run build:game \
  && npm run build:admin

# ---------- 运行阶段 ----------
FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    PORT=8787 \
    HOST=0.0.0.0 \
    DATA_DIR=/data \
    LOG_LEVEL=info \
    TILES_DIR=/srv/tiles \
    SEED_IMAGES_DIR=/srv/seed-images/locations \
    ICONS_DIR=/srv/icons

WORKDIR /app

ARG NPM_REGISTRY=https://registry.npmjs.org/

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates tini \
  && rm -rf /var/lib/apt/lists/*

# 依赖（含 better-sqlite3 原生模块）从构建阶段带过来
COPY --from=builder /app/node_modules node_modules
COPY --from=builder /app/package.json package.json
COPY --from=builder /app/package-lock.json package-lock.json

# 共享包（含 dist 与 seed 数据）
COPY --from=builder /app/packages/shared packages/shared

# 服务端源码
COPY --from=builder /app/server server

# 前端构建产物：交给 nginx / STATIC_DIR 托管
COPY --from=builder /app/apps/game/dist /srv/game
COPY --from=builder /app/apps/admin/dist /srv/admin

# 内置素材：点位截图与分类图标
COPY apps/game/public/images/locations /srv/seed-images/locations
COPY apps/game/public/icons /srv/icons

# 可选：把瓦片打进镜像
ARG INCLUDE_TILES=0
RUN if [ "$INCLUDE_TILES" = "1" ]; then \
      mkdir -p /srv/tiles && cp -r ../MapSource/tiles/. /srv/tiles/ 2>/dev/null || true; \
    fi

RUN mkdir -p /data/uploads /srv/tiles && chown -R node:node /data /srv/tiles

# 非 root 运行
USER node

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server/src/index.js"]
