# 图寻单镜像（Node 服务端 + 游戏前端 + 后台前端 + 内置静态资源）
# 构建上下文必须是仓库根目录：docker build -f deploy/Dockerfile .

# ---------- 构建阶段 ----------
FROM node:22-bookworm-slim AS builder

WORKDIR /app

ARG NPM_REGISTRY=https://registry.npmjs.org/
ARG WITH_BUILD_TOOLS=0

RUN if [ "$WITH_BUILD_TOOLS" = "1" ]; then \
      apt-get update \
      && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
      && rm -rf /var/lib/apt/lists/*; \
    fi

COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/game/package.json apps/game/
COPY apps/admin/package.json apps/admin/
COPY server/package.json server/

COPY packages/shared packages/shared
COPY apps/game apps/game
COPY apps/admin apps/admin
COPY server server

RUN npm ci --no-audit --no-fund --ignore-scripts --registry="$NPM_REGISTRY" \
  && npm rebuild better-sqlite3 --registry="$NPM_REGISTRY" \
  && npm run build:shared \
  && npm run build:game \
  && npm run build:admin

# ---------- 可选瓦片收集阶段 ----------
# 如果构建上下文里有 MapSource/tiles，就复制进 /tiles；没有时保持空目录。
FROM alpine:3.20 AS tiles
WORKDIR /context
COPY . .
RUN mkdir -p /tiles \
  && if [ -d MapSource/tiles ]; then cp -a MapSource/tiles/. /tiles/; fi

# ---------- 运行阶段 ----------
FROM node:22-bookworm-slim AS runtime

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

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl tini \
  && rm -rf /var/lib/apt/lists/*

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

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "server/src/index.js"]
