# 部署指南

目标形态：**一个容器**同时提供游戏站（`/`）、后台站（`/admin/`）、API 与素材，
外层用 nginx（宝塔即可）做域名 + HTTPS 反代。底图瓦片**不在镜像里**，从宿主目录挂载。

```
浏览器 ──▶ nginx（域名 + HTTPS，站点内 proxy_cache off）
             └─▶ 127.0.0.1:8787 ──▶ 容器 nte-geoguess
                                       ├─ /              游戏站（STATIC_DIR）
                                       ├─ /admin/         后台站（ADMIN_STATIC_DIR）
                                       ├─ /api /images /icons
                                       └─ /mapsource-tiles ──▶ /srv/tiles（宿主目录挂载）
                                    数据：/data（宿主目录挂载：SQLite + 上传截图）
```

镜像由 GitHub Actions 在 push 到 `main`（或打 `v*` 标签）时构建并发布：

```
ghcr.io/564024841/nte-geoguess:latest
```

镜像基于 **Alpine**（`node:22-alpine`，musl）：运行阶段只有 `ca-certificates`、`curl`、`tini`、
`libstdc++` 这几个包，体积比 Debian 版小一截。代价是 `better-sqlite3` 没有 musl 预编译包，
构建时要在 Alpine 里从源码编译（`deploy/Dockerfile` 构建阶段已装好 `python3 make g++`），
自己改 Dockerfile 时别把那步删掉。

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

### 瓦片：不在镜像里，从宿主目录挂载

镜像**不含瓦片**（保持精简，也避免再分发没有许可证声明的游戏底图）。
部署前先把瓦片放到宿主目录，再挂进容器 `/srv/tiles`：

```bash
npm run tiles:fetch          # 拉到仓库同级的 MapSource/tiles（约 30MB / 3516 张）
npm run tiles:verify         # 校验完整性（z=0 应有 51 个 x 目录、抽样 7 张）
```

`deploy/.env` 里设 `TILES_HOST_DIR=<瓦片目录>`；compose 里对应这一行：

```yaml
      - "${TILES_HOST_DIR:-./tiles}:/srv/tiles"
```

宿主目录**必须可写**（而且不要挂成 `:ro`）：瓦片缺失时容器启动自检要往里下载补全。

**更新瓦片**：直接往这个宿主目录里覆盖 `{z}/{x}/{y}.jpg` 即可——服务端按请求读盘，
上传完立即生效，不用重建镜像、也不用重启容器（想复查就 `docker compose restart app`，
启动时会抽样自检瓦片并打印结论）。

`REQUIRE_TILES=1`（compose 默认）时，宿主瓦片目录为空或不完整会让服务端**拒绝启动**，
避免出现"服务起来了但底图全黑"。临时调试可以先设 `REQUIRE_TILES=0`。

### 内容数据（题库 / 坐标标定 / 区域落点）也不走 git

仓库里的 `packages/shared/data/*.json` 只是**最基本的骨架**，真正的数据放在宿主机上，
由 compose 挂进容器 `/srv/data-json`，并用环境变量指路：

| 文件 | 容器内路径 | 环境变量 | 作用 |
| --- | --- | --- | --- |
| `map-data.json` | `/srv/data-json/map-data.json` | `SEED_DATA_FILE` | 内置题库快照（点位/题目/分类），首次启动 seed 导入 SQLite |
| `navi-coordinate-calibration.json` | `/srv/data-json/navi-coordinate-calibration.json` | `CALIBRATION_FILE` | 坐标标定，`/api/bootstrap` 下发给前端做地图↔游戏坐标换算 |
| `region-positions.json` | `/srv/data-json/region-positions.json` | `REGION_POSITIONS_FILE` | 地图上区域名标签的落点 |

```yaml
    volumes:
      - "${SHARED_DATA_HOST_DIR:-./data-json}:/srv/data-json"
```

这个目录同样要**可写**（不要 `:ro`）：文件缺失时容器启动自检会从仓库 raw 下载一份补进来，
并一直留在宿主目录里（下次不会重复下载）。

**更新这些数据**：直接覆盖宿主目录里的文件。
题库快照（`map-data.json`）改了之后需要让它重新导入（seed 只在 `meta.seed_version` 不匹配时跑）：
临时加 `FORCE_SEED=1` 重启一次，或删掉 `DATA_DIR` 下那个 SQLite 再重启；
标定与区域落点则是**下个请求即生效**（服务端运行时读取）。

---

## 宝塔面板：用 Compose 项目部署

宝塔的「Docker → Compose 项目 → 添加」有两个输入框：**Compose** 和 **env**。

| 输入框 | 粘什么 |
| --- | --- |
| Compose | [`deploy/docker-compose.yml`](../deploy/docker-compose.yml) 的全部内容 |
| env | [`deploy/.env.example`](../deploy/.env.example) 的全部内容（至少改 `ADMIN_PASSWORD`，三个宿主目录写绝对路径） |

env 框里只提供 compose 里 `${...}` 的取值，**不会进容器**（进容器的是 compose 里 `environment:`
那段）。所以镜像固定、数据路径固定，只有密码/端口/宿主目录需要你改。

只想粘一个文件、不想管 env 时，用
[`deploy/docker-compose.standalone.yml`](../deploy/docker-compose.standalone.yml)
（环境变量全部内联写死），贴进 Compose 框即可。

### 目录是怎么绑定的

宝塔会把 compose 项目建在 `/www/server/panel/data/compose/<项目名>/`，
**compose 里的相对路径就是相对这个项目目录解析的**（宝塔自己的 Compose 项目都这么用，
例如 Forgejo 的 `./forgejo:/data` 实际就是 `/www/server/panel/data/compose/Forgejo/forgejo`）。

本次部署用的是**绝对路径**（写死在 env 框里），指向宝塔给这个项目建的那个目录 ——
这样项目目录之外的地方不会莫名多出数据目录：

```dotenv
DATA_HOST_DIR=/www/server/panel/data/compose/nte-geoguess/data
TILES_HOST_DIR=/www/server/panel/data/compose/nte-geoguess/tiles
SHARED_DATA_HOST_DIR=/www/server/panel/data/compose/nte-geoguess/data-json
```

如果宝塔里项目名不叫 `nte-geoguess`，把三行里的目录名一起换掉；也可以用相对路径
`./data`、`./tiles`、`./data-json`（效果一样，就是依赖"项目目录"这个前提）。

也就是要在项目目录里准备好：

| 目录 | 内容 | 权限 |
| --- | --- | --- |
| `data/` | SQLite + 后台上传截图 | 容器以 uid 1000 写入：`chown -R 1000:1000 data` |
| `tiles/` | 完整底图瓦片（`z=-6..0` 的 `{z}/{x}/{y}.jpg`） | **容器要写**（缺瓦片时自动下载补全）：`chown -R 1000:1000 tiles` |
| `data-json/` | `map-data.json`、`navi-coordinate-calibration.json`、`region-positions.json` | **容器要写**（缺文件时自动下载补全并保留）：`chown -R 1000:1000 data-json` |

三个目录一次性给对属主，之后都不用再管：

```bash
cd /www/server/panel/data/compose/nte-geoguess
sudo chown -R 1000:1000 data tiles data-json
```

> 如果你更习惯把数据放在 `/www/wwwroot/nte-geoguess/` 下（不和宝塔自己的数据区混在一起），
> 把上面三个 `*_HOST_DIR` 换成那边的绝对路径即可，例如
> `DATA_HOST_DIR=/www/wwwroot/nte-geoguess/data`（tiles、data-json 同理）。
> **不要**把这些目录放到 `/www/server/panel/data` 里手工 chmod/chown ——
> 那是宝塔自己的数据区（`600 root`），权限被改坏会连带多个服务起不来。

### 更新流程（都不需要重建镜像）

| 改什么 | 怎么做 | 生效方式 |
| --- | --- | --- |
| 主程序 | `git push` → Actions 出镜像 | watchtower 自动拉取，或 `docker compose pull && up -d` |
| 底图瓦片 | 往 `tiles/` 覆盖文件 | 下个请求即生效 |
| 坐标标定 / 区域落点 | 覆盖 `data-json/` 里的文件 | 下个请求即生效 |
| 题库快照 | 覆盖 `data-json/map-data.json` | 加 `FORCE_SEED=1` 重启一次（或删 `data/` 里的 SQLite 重启）后导入 |

### 启动自检与自动补全

容器入口（`deploy/docker-entrypoint.sh`）在启动服务前会自检一次，**缺什么补什么**：

| 检查项 | 缺失时的行为 | 相关变量 |
| --- | --- | --- |
| 底图瓦片（`$TILES_DIR` 里有没有 `*.jpg`） | **先探 `$TILES_DIR` 可不可写**：可写才把 `codeload.github.com/<MAPSOURCE_REPO>` 的 tar.gz 解到 `$TILES_DIR` 下的隐藏暂存目录、再复制到位；不可写或下载失败 → **直接报错退出**（不会白下载几十 MB） | `TILES_AUTO_FETCH`（默认 `1`）、`MAPSOURCE_REPO`、`MAPSOURCE_BRANCH` |
| 题库快照 / 坐标标定 / 区域落点 | 缺哪个就下载到**它所在的挂载目录**（持久化）：先试 `raw.githubusercontent.com`，再试 `cdn.jsdelivr.net` 镜像；目录不可写、两个源都失败 → **直接报错退出** | `DATA_JSON_AUTO_FETCH`（默认 `1`）、`GIT_REPO`、`GIT_BRANCH` |

要点：

- 已经放好文件的挂载目录**优先级最高**，自检不会覆盖你的数据。
- 自动下载需要**写入权限**：`data/`、`tiles/`、`data-json/` 都按可写准备（`chown -R 1000:1000`，且**不要加 `:ro`**）。
  目录不可写时脚本会**先探测、直接退出并说明原因**，不会反复下载同一个 30MB 包。
- 不想让容器联网拉数据时，把 `TILES_AUTO_FETCH` / `DATA_JSON_AUTO_FETCH` 设成 `0`，
  自己把 `tiles/`、`data-json/` 准备好即可；此时文件缺失会**直接报错退出**，不会静默降级。
- 所有下载都只写进挂载目录（`/srv/tiles`、`/srv/data-json`），**不会回退到 `/tmp`、也不会回退到
  镜像里那份骨架** —— 宁可启动失败并打印原因，也不要起一个数据不对的服务。
- 已经有文件时自检只打印"就绪"，不会重新下载。上次被强杀留下的隐藏暂存目录，下次启动会先清掉。

---

---

## 方式一：Docker Compose（推荐）

```bash
# 1) 拉代码（瓦片默认放在仓库同级的 MapSource/tiles）
git clone https://github.com/564024841/NTE-GeoGuess.git /www/wwwroot/nte-geoguess/app
cd /www/wwwroot/nte-geoguess/app

# 2) 准备环境文件（至少改 ADMIN_PASSWORD 和 TILES_HOST_DIR）
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
| `TILES_HOST_DIR` | `./tiles` | 底图瓦片目录（镜像不含瓦片，必须挂载，且容器要能写） |
| `SHARED_DATA_HOST_DIR` | `./data-json` | 题库快照 / 坐标标定 / 区域落点所在目录，同样要能写 |
| `COOKIE_SECURE` | `true` | 走 HTTPS 保持 `true`；纯 HTTP 调试才设 `false` |
| `REQUIRE_TILES` | `1` | 瓦片缺失时拒绝启动；设 `0` 只告警（底图会全黑） |

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
| `SEED_DATA_FILE` / `CALIBRATION_FILE` / `REGION_POSITIONS_FILE` | 镜像内骨架 JSON | 题库快照 / 坐标标定 / 区域落点；生产用挂载覆盖（compose 默认指向 `/srv/data-json/*`） |
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
| 拉不到基础镜像（`registry-1.docker.io` 超时） | 配 Docker 镜像加速器，或先把 `node:22-alpine` 拉到本地 |
| 自己构建镜像时 `better-sqlite3` 编译失败 | 基础镜像是 Alpine（musl），该模块没有 musl 预编译包，必须保留构建阶段的 `python3 make g++` 与 `npm rebuild better-sqlite3 --build-from-source` |

看日志：

```bash
docker compose -f deploy/docker-compose.yml --env-file deploy/.env logs -f app
```
