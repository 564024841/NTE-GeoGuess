# 图寻单镜像（Node 服务端 + 游戏前端 + 后台前端 + 内置静态资源）
# 构建上下文必须是仓库根目录：docker build -f deploy/Dockerfile .
#
# 基础镜像统一用 Alpine（musl，体积小、拉取快）：
#   · 构建阶段要装 python3 / make / g++ —— better-sqlite3 没有 musl 预编译包，
#     必须在 Alpine 里从源码编译（prebuild-install 下到的是 glibc 版，加载会失败）；
#   · 运行阶段要装 libstdc++（编译出来的 .node 动态链接它）、curl（入口脚本下载瓦片与内容数据）、
#     tini（当 PID 1 收信号；Alpine 里的路径是 /sbin/tini）。

# ---------- 构建阶段 ----------
FROM node:22-alpine AS builder

WORKDIR /app

ARG NPM_REGISTRY=https://registry.npmjs.org/

# 编译 better-sqlite3 用（Alpine 走 musl，没有预编译包）
RUN apk add --no-cache python3 make g++ ca-certificates

COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/game/package.json apps/game/
COPY apps/admin/package.json apps/admin/
COPY server/package.json server/

COPY packages/shared packages/shared
COPY apps/game apps/game
COPY apps/admin apps/admin
COPY server server

# 前端构建完就不再需要 vite/vue 那套构建期依赖了：最后把 devDependencies 从 node_modules 里剔除，
# 运行阶段直接拷这份「只剩生产依赖」的树（better-sqlite3 这时已经编译好，prune 不会重编）。
# 必须排在 build:* 之后，并且带 --ignore-scripts，否则 npm 会去跑被删包的生命周期脚本。
RUN npm ci --no-audit --no-fund --ignore-scripts --registry="$NPM_REGISTRY" \
  && npm rebuild better-sqlite3 --build-from-source --registry="$NPM_REGISTRY" \
  && npm run build:shared \
  && npm run build:game \
  && npm run build:admin \
  && npm prune --omit=dev --ignore-scripts

# ---------- 可选瓦片收集阶段 ----------
# 如果构建上下文里有 MapSource/tiles，就复制进 /tiles；没有时保持空目录。
FROM alpine:3.20 AS tiles
WORKDIR /context
COPY . .
RUN mkdir -p /tiles \
  && if [ -d MapSource/tiles ]; then cp -a MapSource/tiles/. /tiles/; fi

# ---------- 运行阶段 ----------
FROM node:22-alpine AS runtime

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    DATA_DIR=/data \
    LOG_LEVEL=info \
    STATIC_DIR=/srv/game \
    ADMIN_STATIC_DIR=/srv/admin \
    TILES_DIR=/srv/tiles \
    REQUIRE_TILES=0 \
    SEED_IMAGES_DIR=/srv/seed-images/locations \
    # 内容数据：镜像里只带一份「最基本」的骨架，生产用 compose 挂载真实文件并覆盖下面三个路径
    SEED_DATA_FILE=/app/packages/shared/data/map-data.json \
    CALIBRATION_FILE=/app/packages/shared/data/navi-coordinate-calibration.json \
    REGION_POSITIONS_FILE=/app/packages/shared/data/region-positions.json \
    ICONS_DIR=/srv/icons

WORKDIR /app

# curl：入口脚本要用它下载瓦片 / 内容数据；tini：Alpine 里在 /sbin/tini；
# libstdc++：better-sqlite3 编译出来的 .node 会动态链接它
RUN apk add --no-cache ca-certificates curl tini libstdc++

COPY --from=builder /app/node_modules node_modules
COPY --from=builder /app/package.json package.json
COPY --from=builder /app/package-lock.json package-lock.json
COPY --from=builder /app/packages/shared packages/shared
COPY --from=builder /app/server server

# 前端构建产物（由服务端同源托管）
COPY --from=builder /app/apps/game/dist /srv/game
COPY --from=builder /app/apps/admin/dist /srv/admin

# 内置截图与图标
COPY apps/game/public/images/locations /srv/seed-images/locations
COPY apps/game/public/icons /srv/icons

# 可选内置瓦片（上下文存在即复制，不存在也不报错）
COPY --from=tiles /tiles /srv/tiles

# 入口脚本：启动前自检瓦片与内容数据，缺失就自动下载补全
COPY deploy/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN mkdir -p /data/uploads /srv/tiles \
  && chown -R node:node /data /srv \
  && chmod +x /usr/local/bin/docker-entrypoint.sh

USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "server/src/index.js"]
