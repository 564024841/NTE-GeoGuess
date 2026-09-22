# 部署指南

目标形态：一台 Linux 云服务器上跑两个容器 —— 服务端（Fastify + SQLite）与
nginx（托管游戏站、后台站并反代 API）。底图瓦片由服务端或 nginx 直接读盘。

```
浏览器 ──▶ nginx:8080（游戏站，公开）──┐
          nginx:8081（后台站，内网）  ├─▶ /api /images /icons /mapsource-tiles ─▶ server:8787
                                      ┘                                              │
                                                                              /data（SQLite + 上传截图）
                                                                              /srv/tiles（本地瓦片）
```

## 瓦片是本地化的，只在部署时联网

这点先讲清楚，因为它决定了「地图会不会因为网络波动打不开」：

| 阶段 | 是否需要外网 | 说明 |
| --- | --- | --- |
| **部署时（一次性）** | 需要 | 从 GitHub 拉一次瓦片（30MB），或者从内网机器拷过来 |
| **运行时（每次访问）** | **不需要** | 服务端只从 `TILES_DIR` 读磁盘上的 jpg，代码里没有任何远程回退 |

也就是说，地图加载速度取决于服务器磁盘与网络出口，与 GitHub 无关。
（早期版本的 `map-data.json` 里留着一个 `raw.githubusercontent.com` 的瓦片模板字段，
但它**不参与运行**：服务端下发给前端的是本地路径 `/mapsource-tiles/{z}/{x}/{y}.jpg`。）

---

## 1. 准备瓦片（一次性）

瓦片在独立仓库 `Maa-NTE/MapSource`，不在本项目里。用仓库自带的脚本拉取与校验：

```bash
cd NTE-GeoGuess
npm run tiles:fetch          # 浅克隆 + 稀疏检出，只取 tiles/，失败可重跑（git 会续传）
npm run tiles:verify         # 校验完整性
```

`tiles:verify` 会检查 z=0 的 x 目录数是否与地图尺寸吻合（应为 51 个）、
抽样四角与中心共 7 张瓦片是否存在且未损坏，并报告总数与体积。
正常输出：

```
=== 瓦片校验：/path/MapSource/tiles
  z=0 的 x 目录    51 个（0–50）
  瓦片总数        3516 张 / 29.8 MB
  抽样通过        7 张
  结论            完整可用
```

默认拉到「仓库同级的 `MapSource/tiles`」，compose 的 `TILES_HOST_DIR` 默认就指那里。
想放别处：

```bash
TILES_DIR=/srv/nte-tiles npm run tiles:fetch
# 然后在 deploy/.env 里设 TILES_HOST_DIR=/srv/nte-tiles
```

### 网络不稳 / 内网隔离时的三种办法

1. **重跑**：`tiles:fetch` 是幂等的，git 会续上已下载的对象。也可以先只克隆再单独检出：
   ```bash
   git clone --depth 1 --filter=blob:none --no-checkout https://github.com/Maa-NTE/MapSource.git
   cd MapSource && git sparse-checkout init --cone && git sparse-checkout set tiles && git checkout main
   ```
2. **从已有瓦片的机器拷过来**（推荐给完全内网的环境，30MB 用 U 盘/内网 scp 都行）：
   ```bash
   # 在已拉好瓦片的机器上验证并复制
   npm run tiles:mirror -- /path/to/MapSource/tiles --dest /srv/nte-tiles
   # 或者直接 scp -r
   ```
3. **指向自己的镜像仓库**：
   ```bash
   MAPSOURCE_REPO=git@内网git:mirror/MapSource.git npm run tiles:fetch
   ```

### 让服务器在瓦片有问题时拒绝启动

服务端启动时会抽样自检瓦片（目录结构 + 四角/中心/低分辨率层共 7 张）。
默认只是告警；**生产建议打开 `REQUIRE_TILES=1`**（compose 里已默认打开），
这样瓦片缺失或不完整时服务端直接退出，而不是「服务起来了但底图全黑」这种难排查的状态。

```bash
# deploy/.env
REQUIRE_TILES=1
```

`TILES_HOST_DIR` 指向一个不存在的目录时，Docker 会替你建一个空目录，
服务端会报「z=0 下没有任何 x 目录（目录是空的）」——这正是这个检查要拦的情况。

---

## 2. 用 Docker Compose 启动（推荐）

```bash
cd NTE-GeoGuess
cp deploy/.env.example deploy/.env
# 编辑 deploy/.env，至少改掉 ADMIN_PASSWORD，并确认 TILES_HOST_DIR 指向瓦片目录
# 私有镜像需先登录 GHCR（PAT 至少需要 read:packages）
echo "$GHCR_TOKEN" | docker login ghcr.io -u <github-username> --password-stdin
docker compose -f deploy/docker-compose.yml --env-file deploy/.env pull
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d
```

`deploy/docker-compose.yml` 默认拉取：

- `ghcr.io/564024841/nte-geoguess-server:${IMAGE_TAG:-latest}`
- `ghcr.io/564024841/nte-geoguess-web:${IMAGE_TAG:-latest}`

如需覆盖，修改 `deploy/.env` 里的 `IMAGE_TAG`、`SERVER_IMAGE`、`WEB_IMAGE`。

启动后：

| 地址 | 用途 |
| --- | --- |
| `http://<服务器IP>:8080` | 游戏站 |
| `http://<服务器IP>:8081` | 后台站（默认只允许内网网段，见 `deploy/nginx.conf`） |
| `http://127.0.0.1:8787/api/health` | 服务端健康检查（容器内） |

自检：

```bash
curl -s http://127.0.0.1:8080/api/health
curl -s http://127.0.0.1:8080/api/stats
```

首次启动会自动把内置快照导入 SQLite（1622 点位 / 476 道可出题），
日志里会出现 `[seed] 已导入内置数据`。数据库与上传的截图都在 `nte-geoguess-data` 卷里。

### 更新版本

```bash
git pull
docker compose -f deploy/docker-compose.yml --env-file deploy/.env pull
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d
```

数据在卷里，不会丢；`seed` 只在 `meta.seed_version` 变化时才会重跑。

> **容器名约定**：compose 会把两个服务命名为 `server` 与 `web`，
> 而 `deploy/nginx.conf` 里的 upstream 就写着 `server:8787`。
> 手工 `docker run` 复现这套拓扑时，后端容器必须命名为 `server`，
> 且与 web 容器在同一个自定义网络里，否则 nginx 会报
> `host not found in upstream "server:8787"` 并拒绝启动。

### 备份

只需要备份数据卷（SQLite + 后台上传的截图）：

```bash
docker run --rm -v nte-geoguess-data:/data -v "$PWD:/backup" alpine \
  tar czf /backup/nte-geoguess-$(date +%F).tar.gz -C /data .
```

---

## 3. 不用 Docker 直接跑

```bash
npm install
npm run build:shared

# 服务端（默认 0.0.0.0:8787）
ADMIN_PASSWORD='你的密码' npm run dev:server

# 另开两个终端跑前端开发服务器（会代理到 8787）
npm run dev:game    # http://127.0.0.1:5174
npm run dev:admin   # http://127.0.0.1:5175
```

生产跑法：

```bash
npm run build          # 构建 shared + game + admin
ADMIN_PASSWORD='...' NODE_ENV=production npm start
# 把 apps/game/dist 与 apps/admin/dist 交给 nginx 托管，/api 反代到 8787
```

---

## 4. 环境变量清单

全部有默认值，只有 `ADMIN_PASSWORD` 必须显式设置才能用后台。

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `ADMIN_PASSWORD` | 空 | 后台登录密码。**留空则后台接口禁用**（登录返回 503） |
| `PORT` / `HOST` | `8787` / `0.0.0.0` | 服务端监听 |
| `DATA_DIR` | `<仓库根>/data` | SQLite 与上传截图的根目录（放在仓库根是为了避开 `node --watch` 的监视范围） |
| `DATABASE_FILE` | `$DATA_DIR/nte-geoguess.sqlite` | 数据库文件 |
| `UPLOADS_DIR` | `$DATA_DIR/uploads` | 后台上传的截图 |
| `SEED_DATA_FILE` | `packages/shared/data/map-data.json` | 首次导入的内置数据快照 |
| `CALIBRATION_FILE` | `packages/shared/data/navi-coordinate-calibration.json` | 坐标标定 |
| `SEED_IMAGES_DIR` | `apps/game/public/images/locations` | 内置点位截图 |
| `ICONS_DIR` | `apps/game/public/icons` | 分类图标 |
| `TILES_DIR` | `../MapSource/tiles` | 底图瓦片目录 |
| `TILE_URL_TEMPLATE` | `/mapsource-tiles/{z}/{x}/{y}.jpg` | 下发给前端的瓦片 URL |
| `TILE_REDIRECT_BASE` | 空 | 填了则瓦片请求 302 到该地址（CDN）；**留空即完全本地** |
| `REQUIRE_TILES` | `false` | 设为 `1` 时瓦片缺失/不完整会拒绝启动（compose 默认已开） |
| `COOKIE_SECURE` | `false` | HTTPS 部署必须设 `true` |
| `SESSION_TTL_HOURS` | `12` | 后台会话有效期 |
| `CORS_ORIGINS` | 空 | 后台站与 API 不同源时填写，逗号分隔 |
| `LOGIN_MAX_ATTEMPTS` / `LOGIN_WINDOW_MINUTES` | `5` / `15` | 登录失败限流 |
| `BODY_LIMIT_BYTES` | 32MB | 请求体上限（截图以 base64 提交） |
| `DISABLE_SEED` | `false` | 设为 `true` 跳过首次导入 |
| `FORCE_SEED` | 未设 | 设为 `1` 强制重新导入一次 |
| `LOG_LEVEL` | `info` | `error` / `warn` / `info` / `debug` |
| `STATIC_DIR` | 空 | 填了则由服务端顺带托管前端产物（单容器简易部署） |

前端侧只有两个变量：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `VITE_API_BASE` | 空（同源） | 前端访问 API 的基地址；同源部署留空 |
| `VITE_DEV_SERVER` | `8787` | 仅开发用：vite 代理到后端端口 |

---

## 5. HTTPS 与域名

nginx 配置里两个 server 共用 8080/8081。上线时通常是：

1. 用 Caddy / Traefik / certbot 在最外层做 TLS 终止，把 `game.example.com`
   转发到 `nginx:8080`、`admin.example.com` 转发到 `nginx:8081`。
2. 设置了 `COOKIE_SECURE=true`，并让 `CORS_ORIGINS=https://admin.example.com`。
3. 后台域名最好再加一层防护（VPN、IP 白名单、或 nginx `auth_basic`）。

`deploy/nginx.conf` 里已经给后台站加了内网网段限制，公网部署时按自己的办公网/VPN 段调整。

---

## 6. 安全清单

- [ ] `ADMIN_PASSWORD` 用强密码，且不要提交 `deploy/.env`
- [ ] 后台站不暴露在公网（或加 VPN / Basic Auth）
- [ ] 生产 HTTPS + `COOKIE_SECURE=true`
- [ ] `CORS_ORIGINS` 只列真正的后台域名，不要写 `*`（带 Cookie 的跨域请求不允许通配）
- [ ] 定期备份数据卷
- [ ] 关注 `server/data/uploads` 体积增长（后台上传的截图）

---

## 7. 故障排查

| 现象 | 排查方向 |
| --- | --- |
| 游戏站显示「无法载入地图数据」 | `curl http://<host>:8080/api/health`；看 server 容器日志 |
| 后台登录返回 503 | 没设 `ADMIN_PASSWORD` |
| 后台登录成功但立刻 401 | HTTPS 环境没开 `COOKIE_SECURE`，或跨域没配 `CORS_ORIGINS` |
| 底图是黑的 | 瓦片目录没挂对（看日志里的「未找到底图瓦片目录」）；或 `TILES_HOST_DIR` 指错 |
| 题面截图 404 | 内置截图目录没挂对（`SEED_IMAGES_DIR`），或后台删除题目时把图删了 |
| 后台上传 413 | 截图超过 8MB，或 nginx `client_max_body_size` 太小 |
| 想让数据重来一遍 | 删掉数据卷，或 `FORCE_SEED=1` 重启一次 |

看日志：

```bash
docker compose -f deploy/docker-compose.yml logs -f server
```

### 拉不到基础镜像（registry-1.docker.io 超时）

国内网络常见：`docker build` 报
`failed to resolve source metadata for docker.io/library/node:22-bookworm-slim`。
这不是 Dockerfile 的问题，是拉不到基础镜像。处理办法任选：

1. **配置镜像加速器**（Docker Desktop → Settings → Docker Engine），加入：

   ```json
   { "registry-mirrors": ["https://<你的加速器地址>"] }
   ```

2. **先把基础镜像拉到本地**，之后 `docker build` 会直接命中本地层：

   ```bash
   docker pull <加速器前缀>/library/node:22-bookworm-slim
   docker tag  <加速器前缀>/library/node:22-bookworm-slim node:22-bookworm-slim
   docker pull <加速器前缀>/library/nginx:1.27-alpine
   docker tag  <加速器前缀>/library/nginx:1.27-alpine nginx:1.27-alpine
   ```

   注意 `Dockerfile` 与 `Dockerfile.web` 都用到了 `node:22-bookworm-slim`，
   nginx 用到 `nginx:1.27-alpine`，三个 tag 都要有。

3. **完全不用 Docker**：见上面第 3 节，直接 `npm run build` + `npm start`，
   把 `apps/game/dist`、`apps/admin/dist` 交给宿主上的 nginx。

> 两个镜像已在开发环境实际构建并跑通（见下面「镜像验证记录」）。
> 若你的网络仍然拉不到基础镜像，按上面三条处理。

---

## 8. 镜像验证记录

两个镜像在本项目的开发环境里实际构建并运行过，验证内容如下。

构建（基础镜像先从可达的镜像源拉取并打成标准 tag）：

```bash
docker pull <镜像源>/library/node:22-bookworm-slim
docker tag  <镜像源>/library/node:22-bookworm-slim node:22-bookworm-slim
docker pull <镜像源>/library/nginx:1.27-alpine
docker tag  <镜像源>/library/nginx:1.27-alpine nginx:1.27-alpine

docker build -f deploy/Dockerfile     -t nte-geoguess-server:test \
  --build-arg NPM_REGISTRY=https://registry.npmmirror.com .
docker build -f deploy/Dockerfile.web -t nte-geoguess-web:test \
  --build-arg NPM_REGISTRY=https://registry.npmmirror.com .
```

结果：`nte-geoguess-server` 约 572MB，`nte-geoguess-web` 约 106MB。

按生产拓扑起容器（容器名 `server` / `web` 必须与 nginx 里的 upstream 一致）：

```bash
docker network create nte-test-net
docker run -d --name server --network nte-test-net \
  -e ADMIN_PASSWORD='...' -v /path/to/MapSource/tiles:/srv/tiles:ro \
  nte-geoguess-server:test
docker run -d --name web --network nte-test-net \
  -p 8080:8080 -p 8081:8081 nte-geoguess-web:test
```

已验证的行为：

| 项目 | 结果 |
| --- | --- |
| 首次启动 seed | 分类 40、点位 1622（可出题 476），59ms |
| 容器内 SQLite | better-sqlite3 预编译包可用，**不需要 g++** |
| 健康检查 | 容器 `HEALTHCHECK` 报 healthy |
| 静态素材 | `/images/locations/*`、`/icons/*`、`/mapsource-tiles/*` 均 200 |
| 服务端 API 套件（直连容器） | 全部通过 |
| 服务端 API 套件（经 nginx） | 全部通过 |
| 游戏站端到端（经 nginx :8080） | 全部通过 |
| 后台站端到端（经 nginx :8081） | 全部通过 |

过程中发现并修掉的两个真实缺陷，已包含在仓库里：

1. **内置素材路径没指向镜像内位置**：`Dockerfile` 把截图与图标放到 `/srv/seed-images`、`/srv/icons`，
   但没设对应的 `ENV`，直接 `docker run` 会导致截图 404。
   现在 `TILES_DIR` / `SEED_IMAGES_DIR` / `ICONS_DIR` 已在镜像里写好默认值。
2. **nginx 不转发条件请求头**：默认情况下 nginx 会丢掉 `If-None-Match`，
   导致 `/api/bootstrap` 的 ETag 复用失效（客户端每次都拿到 200、重传一份数据）。
   已在 `deploy/nginx-snippets/proxy-headers.conf` 显式转发，
   同时后端改为按弱 ETag 语义比较（nginx 开 gzip 会把强标签改写成 `W/"..."`）。

### 构建参数

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `NPM_REGISTRY` | `https://registry.npmjs.org/` | npm 源，受限网络改成镜像源 |
| `WITH_BUILD_TOOLS` | `0` | 设为 `1` 装 g++/make/python3；默认不需要（better-sqlite3 有预编译包） |
| `INCLUDE_TILES` | `0` | 设为 `1` 把瓦片打进镜像 |
