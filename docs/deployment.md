# 部署指南

目标形态：**一个容器**同时提供游戏站（`/`）、后台站（`/admin/`）、API 与素材，
外层用 nginx（宝塔即可）做域名 + HTTPS 反代。底图瓦片**已打进镜像**（CI 构建时拉取烘焙）。

```
浏览器 ──▶ nginx（域名 + HTTPS，站点内 proxy_cache off）
             └─▶ 127.0.0.1:8787 ──▶ 容器 nte-geoguess
                                       ├─ /              游戏站（STATIC_DIR）
                                       ├─ /admin/         后台站（ADMIN_STATIC_DIR）
                                       ├─ /api /images /icons
                                       └─ /mapsource-tiles ──▶ /srv/tiles（镜像内置瓦片）
                                    数据：/data（宿主目录挂载：SQLite + 上传截图）
```

镜像由 GitHub Actions 在 push 到 `main`（或打 `v*` 标签）时构建并发布：

```
ghcr.io/564024841/nte-geoguess:latest
```

> 旧版本曾是「server + web 两个镜像、对外 8080/8081 两个端口」，**现已废弃**，
> 请使用下面的单镜像方式。

---

## 瓦片是本地化的，只在部署时联网

| 阶段 | 是否需要外网 | 说明 |
| --- | --- | --- |
| **部署时（一次性）** | 需要 | 从 GitHub 拉一次瓦片（约 30MB），或从内网机器拷过来 |
| **运行时（每次访问）** | **不需要** | 服务端只从 `TILES_DIR` 读磁盘上的 jpg，代码里没有任何远程回退 |

```bash
cd NTE-GeoGuess
npm run tiles:fetch     # 浅克隆 + 稀疏检出，只取 tiles/；失败可重跑（git 续传）
npm run tiles:verify    # 校验：z=0 的 x 目录数（应为 51）、抽样 7 张、总数与体积
```

默认拉到「仓库同级的 `MapSource/tiles`」。网络不稳或内网隔离时，可以在别的机器上拉好后整目录拷过来：

```bash
npm run tiles:mirror -- <源瓦片目录> --dest <目标目录>
```

生产建议设 `REQUIRE_TILES=1`（compose 默认已开）：瓦片缺失或不完整时服务端**拒绝启动**，
避免「服务起来了但底图全黑」这种难排查的状态。

### 镜像里的瓦片

底图瓦片**已经打进镜像**：GitHub Actions 在构建前会从 `Maa-NTE/MapSource` 拉一次 `tiles/`
（约 30MB / 3516 张），`Dockerfile` 的 tiles 阶段把它放进 `/srv/tiles`，并校验
`z=0` 有 51 个 x 目录、总数不少于 3000 张——校验不过就**不会发镜像**，避免发布"底图全黑"的版本。

因此部署端不需要准备瓦片目录。想用宿主目录里的瓦片覆盖镜像内容时，
取消 `deploy/docker-compose.yml` 里那行只读挂载并设 `TILES_HOST_DIR` 即可：

```yaml
      - ${TILES_HOST_DIR:-../../MapSource/tiles}:/srv/tiles:ro
```

> 注意：`Maa-NTE/MapSource` 未声明许可证（默认"保留所有权利"），瓦片随镜像分发等同于再分发游戏底图。
> 如果你的 GHCR 包是 public，建议改成 private，或改用宿主挂载（`TILES_HOST_DIR`）避免分发。

---

## 方式一：Docker Compose（推荐）

```bash
# 1) 拉代码（瓦片默认放在仓库同级的 MapSource/tiles）
git clone https://github.com/564024841/NTE-GeoGuess.git /www/wwwroot/nte-geoguess/app
cd /www/wwwroot/nte-geoguess/app

# 2) 准备环境文件（至少改 ADMIN_PASSWORD；瓦片已内置，不用管 TILES_*）
cp deploy/.env.example deploy/.env

# 3) 数据目录要能被容器内的 node 用户（uid 1000）写入
sudo mkdir -p /www/wwwroot/nte-geoguess/data
sudo chown -R 1000:1000 /www/wwwroot/nte-geoguess/data

# 4) 拉镜像并启动
docker compose -f deploy/docker-compose.yml --env-file deploy/.env pull
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d

# 5) 自检
curl -s http://127.0.0.1:8787/api/health
docker compose -f deploy/docker-compose.yml --env-file deploy/.env logs -f --tail=50
```

`deploy/.env` 里最常用的几个：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `ADMIN_PASSWORD` | 无（必填） | 后台登录密码；留空则后台接口禁用 |
| `APP_BIND` / `APP_PORT` | `127.0.0.1` / `8787` | 只监听本机交给 nginx 反代；想直接暴露就设 `0.0.0.0:8080` |
| `DATA_HOST_DIR` | `./data` | SQLite + 上传截图，务必持久化并备份 |
| `COOKIE_SECURE` | `false` | HTTPS 部署必须设 `true` |

首次启动会自动把内置题库导入 SQLite，日志里出现
`[seed] 已导入内置数据：分类 8、点位 476`。

### 更新版本

```bash
git pull
docker compose -f deploy/docker-compose.yml --env-file deploy/.env pull
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d
```

compose 带了 `com.centurylinklabs.watchtower.enable=true` 标签：
watchtower 以 `--label-enable` 运行时会自动拉新镜像重启，无需手工执行上面两条。
**注意**：watchtower 不带 `--label-enable` 时会更新机器上所有容器，可能影响别的服务。

### 备份

数据全在 `DATA_HOST_DIR`（SQLite + 后台上传截图）：

```bash
sudo tar czf /www/backup/nte-geoguess-$(date +%F).tar.gz -C /www/wwwroot/nte-geoguess data
```

---

## 方式二：宝塔「Node 项目」原生部署（不用 Docker）

```bash
git clone <仓库> /www/wwwroot/nte-geoguess/app
cd /www/wwwroot/nte-geoguess/app
npm ci --no-audit --no-fund
npm run build            # 构建 shared / game / admin
```

宝塔面板 → 网站 → **Node项目** → 添加项目：

| 字段 | 值 |
| --- | --- |
| 项目目录 | `<部署根>/app`（仓库根） |
| 启动命令 | `start`（即 package.json 的 `npm run start`） |
| Node 版本 | **v22.x**（`better-sqlite3` 在 Node 24 上没有预编译包，会编译失败） |
| 运行用户 | `www` |
| 项目端口 | `8787` |
| 绑定域名 | 你的域名 |

环境变量写法：宝塔「默认项目」**不会注入任何自定义环境变量**（源码里前置只导出 `PATH`），
启动命令里也不能写 `VAR=value cmd`（面板用 `nohup <第一个词>` 直接执行）。
所以把变量放进**仓库根的 `.env`**，由 `server/src/config.js` 的 `process.loadEnvFile()` 读取：

```dotenv
PORT=8787
STATIC_DIR=<仓库>/apps/game/dist
ADMIN_STATIC_DIR=<仓库>/apps/admin/dist
TILES_DIR=<部署根>/MapSource/tiles
DATA_DIR=<仓库>/data
REQUIRE_TILES=1
ADMIN_PASSWORD=...
```

`.env` 需要 `chmod 600`、属主设为运行用户，并且不要提交（`.gitignore` 已忽略）。

其它注意：

- 更新流程：`git pull` → `npm ci` → `npm run build` → 面板里重启项目。
  浅克隆无法 `pull --ff-only`（历史被判为分叉），建议完整克隆，或用
  `git fetch --depth 1 && git reset --hard FETCH_HEAD`。
- **题库数据更新后要强制重导**：seed 只在 `meta.seed_version` 与代码内版本不一致时执行。
  数据更新后临时在 `.env` 加 `FORCE_SEED=1` 重启一次，或删掉 `DATA_DIR` 下的 SQLite 让它重导
  （`uploads/` 不要删）。
- 在面板里删除该 Node 项目会**连带删除该站点的 nginx 配置**，之后要重建反向代理站点。

---

## 环境变量清单

镜像里已写好容器内路径，通常只需要在 `deploy/.env` 里设前面那张表的几个变量。
完整清单（都有默认值，只有 `ADMIN_PASSWORD` 必须显式设置）：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `ADMIN_PASSWORD` | 空 | 后台登录密码；留空则后台接口禁用（登录返回 503） |
| `PORT` / `HOST` | `8080` / `0.0.0.0` | 容器内监听（镜像默认 8080；原生部署默认 8787） |
| `STATIC_DIR` / `ADMIN_STATIC_DIR` | 空 | 游戏站 / 后台站产物目录；镜像里是 `/srv/game`、`/srv/admin` |
| `DATA_DIR` | `<仓库>/data` | SQLite 与上传截图的根目录；镜像里是 `/data` |
| `DATABASE_FILE` / `UPLOADS_DIR` | `$DATA_DIR/…` | 需要分开指定时才用 |
| `TILES_DIR` | `<仓库>/../MapSource/tiles` | 瓦片目录；镜像里是 `/srv/tiles` |
| `REQUIRE_TILES` | `false` | `1` = 瓦片缺失/不完整时拒绝启动（compose 默认 `1`） |
| `TILE_URL_TEMPLATE` | `/mapsource-tiles/{z}/{x}/{y}.jpg` | 下发给前端的瓦片 URL |
| `TILE_REDIRECT_BASE` | 空 | 填了则瓦片 302 到该地址（对象存储/CDN）；留空即完全本地 |
| `SEED_DATA_FILE` / `CALIBRATION_FILE` | 仓库内 JSON | 内置题库快照与坐标标定 |
| `SEED_IMAGES_DIR` / `ICONS_DIR` | 仓库内目录 | 内置截图与分类图标 |
| `COOKIE_SECURE` | `false` | HTTPS 部署必须设 `true` |
| `SESSION_TTL_HOURS` | `12` | 后台会话有效期 |
| `CORS_ORIGINS` | 空 | 后台站与 API 不同源时填，逗号分隔（带 Cookie 的跨域不允许 `*`） |
| `LOGIN_MAX_ATTEMPTS` / `LOGIN_WINDOW_MINUTES` | `5` / `15` | 登录失败限流 |
| `BODY_LIMIT_BYTES` | `32MB` | 请求体上限（截图以 base64 提交） |
| `DISABLE_SEED` / `FORCE_SEED` | `false` / 未设 | 跳过首次导入 / 强制重新导入一次 |
| `LOG_LEVEL` | `info` | `error` / `warn` / `info` / `debug` |

前端侧只有两个构建期变量：`VITE_API_BASE`（默认空 = 同源，反代部署保持空）、
`VITE_DEV_SERVER`（仅开发用）。

---

## HTTPS 与域名（nginx / 宝塔）

1. 在宝塔新建一个**反向代理**站点：域名 → `http://127.0.0.1:8787`（compose 默认绑定）。
2. 申请/绑定 SSL，并在 `deploy/.env` 里设 `COOKIE_SECURE=true` 后重启容器。
3. **该站点必须关掉 nginx 代理缓存**：宝塔全局 `proxy.conf` 里有 `proxy_cache cache_one;`，
   不关的话构建新版本后会命中旧首页 HTML（表现为「页面空白」）。在该站点的 `location /` 里加：

   ```nginx
   proxy_cache off;
   ```

4. 后台地址是 `https://<域名>/admin/`，建议再加一层访问限制（Basic Auth / IP 白名单 / VPN）。

---

## 安全清单

- [ ] `ADMIN_PASSWORD` 用强密码；`deploy/.env` 不要提交（`.gitignore` 已忽略）
- [ ] 后台站不暴露在公网，或加 VPN / IP 白名单 / Basic Auth
- [ ] 生产 HTTPS + `COOKIE_SECURE=true`
- [ ] `CORS_ORIGINS` 只列真正的后台域名
- [ ] 定期备份 `DATA_HOST_DIR`；关注其体积增长（后台上传的截图）
- [ ] 域名站点加 `proxy_cache off;`，避免构建后命中旧 HTML

---

## 故障排查

| 现象 | 排查方向 |
| --- | --- |
| 域名 502 | 容器没起来或端口不对：`docker compose ps`、`curl 127.0.0.1:8787/api/health`、检查 nginx `proxy_pass` |
| 页面空白 / 提示「路径不存在」 | ① 首页 HTML 被 nginx 缓存 → 站点加 `proxy_cache off;`；② 前端没构建或 `STATIC_DIR` 不对 |
| 页面能开但没有图、统计是 0 | 题库没导入：看日志有没有 `[seed] 已导入内置数据`；数据更新后用 `FORCE_SEED=1` 重导 |
| 底图黑 / 瓦片 404 | `TILES_HOST_DIR` 挂错；`REQUIRE_TILES=1` 时缺瓦片会直接拒绝启动 |
| 后台登录 503 | 没设 `ADMIN_PASSWORD` |
| 后台登录成功但立刻 401 | HTTPS 环境没开 `COOKIE_SECURE`，或跨域没配 `CORS_ORIGINS` |
| 容器起不来，SQLite 读写失败 | 宿主数据目录权限不对：容器内是 uid 1000，`sudo chown -R 1000:1000 <DATA_HOST_DIR>` |
| 原生部署 `npm ci` 报 `better-sqlite3` 编译失败 | 用了 Node 24，换 Node 22 |
| 原生部署点启动报 `failed to run command 'PORT=8787'` | 启动命令不能写 `VAR=value` 前缀，改用 `.env` 文件 |
| 拉不到基础镜像（`registry-1.docker.io` 超时） | 配 Docker 镜像加速器，或先把 `node:22-bookworm-slim` 拉到本地 |

看日志：

```bash
docker compose -f deploy/docker-compose.yml --env-file deploy/.env logs -f app
```
