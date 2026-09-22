# NTE 图寻 · GeoGuess

以《Neverness to Everness》游戏大地图为底图的**图寻**小游戏：
系统给出一张游戏内截图，你在大地图上标出你认为的位置，**落点离真实位置越近，得分越高**。

底图、坐标系统与点位数据复用自 [Maa-NTE/MaaNTE-Map](https://github.com/Maa-NTE/MaaNTE-Map)；
抽题、评分与题库管理由本项目实现。

**这是一个可上线的服务端架构**：游戏站与后台站分开构建，部署时由**同一个容器（单镜像）**对外提供
（游戏站 `/`、后台站 `/admin/`、API 与素材），题库与截图由服务端存储。

---

## 仓库结构

```
NTE-GeoGuess/
├─ packages/shared/          三方共用的纯逻辑（几何、题库、评分、常量）
├─ apps/game/                游戏站（只读，面向玩家）
├─ apps/admin/               后台站（题库管理，登录保护）
├─ server/                   服务端（Fastify + SQLite + 截图存储）
├─ deploy/                   Dockerfile / compose / nginx / env 模板
├─ docs/                     API 契约、部署指南、需求提取
└─ scripts/                  自动化校验脚本
```

三个 workspace 各自独立构建：

| 包 | 作用 | 产物 |
| --- | --- | --- |
| `@nte-geoguess/shared` | 坐标换算、题库索引、评分规则 | `packages/shared/dist`（esbuild 打包，浏览器与 Node 共用） |
| `@nte-geoguess/game` | 玩家界面 | `apps/game/dist` |
| `@nte-geoguess/admin` | 题库后台 | `apps/admin/dist` |
| `nte-geoguess-server` | API + 素材托管 | 直接跑 Node |

> shared 之所以要打包一次：`geometry.js` 依赖 JSON 标定文件，
> 浏览器（Vite）能直接 import，而 Node 的 ESM 加载 JSON 要求 import attributes。
> 用 esbuild 预先把 JSON 内联，两个运行时拿到的是同一份代码，判分口径不会分叉。

---

## 快速开始

```bash
npm install                 # 安装全部 workspace 依赖

npm run build:shared        # 先构建共享包
npm run dev:server          # 服务端，默认 0.0.0.0:8787（需先设 ADMIN_PASSWORD）
npm run dev:game            # 游戏站，http://127.0.0.1:5174
npm run dev:admin           # 后台站，http://127.0.0.1:5175
```

服务端需要 `ADMIN_PASSWORD` 才能启用后台接口：

```powershell
$env:ADMIN_PASSWORD='你的密码'; npm run dev:server
```

也可以用一条命令同时起服务端 + 游戏站：

```bash
npm run dev
```

### 底图瓦片

瓦片不在本仓库，来自独立的 `Maa-NTE/MapSource`（约 3516 张 / 30MB）。
**运行时只读本地磁盘，不访问任何远程地址**——GitHub 只在部署时拉一次。

```powershell
npm run tiles:fetch     # 浅克隆 + 稀疏检出，只取 tiles/；失败可重跑（git 续传）
npm run tiles:verify    # 校验：z=0 的 x 目录数、抽样 7 张瓦片、总数与体积
```

默认拉到仓库同级的 `MapSource/tiles`，服务端也从那里读（可用 `TILES_DIR` 覆盖）。
网络不稳或内网隔离时，可以在别的机器上拉好后整目录拷过来：

```powershell
npm run tiles:mirror -- <源瓦片目录> --dest <目标目录>
```

生产建议设 `REQUIRE_TILES=1`：瓦片缺失时服务端拒绝启动，
避免「服务起来了但底图全黑」这种难排查的状态（`deploy/docker-compose.yml` 默认已开）。
镜像**不含**瓦片（避免再分发无许可证声明的底图）：容器启动自检发现瓦片目录里没有 jpg 时会自动拉一份，
下载位置就是挂载进来的宿主目录，所以数据是持久的。

---

## 玩法与规则

- 一局 3 / 5 / 10 题；每题给一张截图，点地图落点，确认后结算。
- **评分按底图像素偏差**：

  ```
  得分 = 100 × 2^(−像素偏差 / 50)
  ```

  点中得 100 分，偏 50 px 得 50 分，偏 150 px 约 12.5 分。
  评价分档：≤12 px「神了」/ ≤40 px「非常接近」/ ≤90 px「还不错」/ ≤180 px「偏了」/ 其余「差得远」。

  > 为什么不按「米」算：地图与游戏坐标不是等比关系，
  > **1 底图像素 ≈ 122 游戏单位**（`npm run qa:server` 会复核这个比例）。
  > 按游戏坐标当米会让偏 5 像素就等于 0 分。

- 结算时地图上用虚线连接「你的落点 → 真实位置」，右侧给出偏差、得分与区域。
- **地图上不显示任何点位图标**：点位标记会遮挡底图纹理，也等于提前剧透所有出题位置。
  只有你的落点图钉、答案图钉与偏差连线是局内产物。
- **地图上标注区域名**（米格尔区、绘空町、薄暮区 …），作为定位参照。
  放大约到 -2 及以上才出现（初始整图视图下 7 个标签会糊在一起），
  可在开始页用「在地图上标注区域名」开关关掉。标签不拦截点击，不会影响落点。
  落点在 `packages/shared/data/region-positions.json`，改位置只改这个文件。
- 走完整局后展示总分、平均偏差与逐题复盘；战绩存在浏览器 localStorage。
- 快捷键：`空格` 确认落点 / 下一题，`R` 换一批题。

### 筛选（只有一层：分类）

分类就是区域，取值：向阳岛、新赫兰德区、未闻浦、桥间地、米格尔区、绘空町、薄暮区 + 「未标注」。

> 早期版本还有一层按地图坐标算出的**九宫格方位分区**（北西/北中/北东/中西/中中/中东/南西/南中）。
> 已删除：方位不是游戏里的真实区域，和区域分类是两套并行的维度，容易混淆。
> 现在「按区域出题」直接用区域分类即可。

- 分类上标注了该分类的点位数；**橙色的数字表示这个分类下的点位暂时都没有截图，出不了题**
  （悬停有说明）。选了这种分类，开始按钮会禁用并提示减少筛选条件。
- 后台上传的自建题归入「自建题目」。

> **区域归属的权威来源是「区域分类」**（点位 `types` 里的 `region-*`），
> 其次是显式的 `region` 字段，最后回退到「自建题目」。
> 不再从 `district` 推断——那个字段有 1222 个占位值「全地图」，不适合当依据。

> 为什么会有「未标注」：476 道可出题的截图题在原数据里的 `district` 全是占位值「全地图」，
> 而 400 个有真实区域名的点位全都没有截图——两个集合完全不相交。
> 所以按区域名重建分类后，这 476 道题统一归入「未标注」
> （其中落在已知区域范围之外的 4 个已改归薄暮区），
> 等你在后台上传区域截图时再选对应区域分类。

---

## 题库后台

`apps/admin` 是独立的单页应用，登录后可以：

- 上传游戏截图 → 在地图上点选答案位置 → 保存到待提交清单 → 一次性批量入库
- 题库列表：搜索、分页、按来源筛选
- 编辑题目（改文字 / 换截图 / 重选坐标）、删除题目（会清理独占截图）
- 分类管理：新建、删除（删除会把引用该分类的点位改派到兜底分类）

数据全部通过 API 落到服务端 SQLite，截图存到 `DATA_DIR/uploads`。
接口契约见 [`docs/api-contract.md`](docs/api-contract.md)。

---

## 命令

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 并行启动服务端 + 游戏站 |
| `npm run dev:server` / `dev:game` / `dev:admin` | 单独启动 |
| `npm run build` | 构建 shared + game + admin |
| `npm start` | 生产模式启动服务端 |
| `npm run qa` | 几何自检 + 服务端 API 端到端（无需浏览器） |
| `npm run qa:all` | 下面四项全跑（需要服务端与两个前端都已启动） |
| `npm run qa:geometry` | 仿射精度、像素空间划分、往返一致性、比例系数、题库索引 |
| `npm run qa:server` | 服务端 API 端到端（自起临时实例 + 临时数据目录，跑完清理） |
| `npm run qa:game` | 游戏站端到端（需先起 server 与 game） |
| `npm run qa:admin` | 后台站端到端（需先起 server 与 admin；会自动清理测试数据） |

`qa:game` / `qa:admin` 用本机 Chrome（仓库里已有 `playwright-core`，不需要下载浏览器）。
`qa:admin` 覆盖：登录页与密码错误提示、登录、地图取数、上传截图 → 地图点选 → 保存到清单
→ 批量提交、题库搜索、编辑改名、删除二次确认、分类增删、登出后鉴权生效。

### 校验覆盖一览

| 层级 | 校验内容 |
| --- | --- |
| 几何 | 地图元数据自洽、仿射可逆、标定点精确复现（1e-12）、三层坐标往返误差、比例系数与各向异性、点位落图范围、题库索引与分区 |
| 服务端 | 健康检查、bootstrap 结构与 ETag/304、鉴权与限流、题目增删改查、批量部分失败语义、截图魔数校验、分类改派、瓦片路由、登出 |
| 游戏站 | 数据确实来自 API、瓦片解码 512×512、无点位图标、落点→结算→整局复盘、产物不含后台接口痕迹 |
| 后台站 | 上述后台路径全部走真实浏览器操作 |

---

## 部署

完整说明见 [`docs/deployment.md`](docs/deployment.md)。**默认形态是单镜像**：一个容器同时提供游戏站、后台站、API 与素材，
宝塔（或任意）nginx 只负责域名 + HTTPS 反代。镜像由 GitHub Actions 在 push 到 `main` 时自动构建并发布到 GHCR：
`ghcr.io/564024841/nte-geoguess:latest`。最短路径：

```bash
cp deploy/.env.example deploy/.env      # 至少改掉 ADMIN_PASSWORD
docker compose -f deploy/docker-compose.yml --env-file deploy/.env pull
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d
```

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `APP_BIND` / `APP_PORT` | `127.0.0.1` / `8787` | 默认只监听本机，交给宝塔 nginx 反代；想直接暴露就设成 `0.0.0.0:8080` |
| `DATA_HOST_DIR` | `./data` | SQLite + 后台上传截图，务必持久化并备份 |
| `ADMIN_PASSWORD` | 无 | 后台登录密码；留空则后台接口禁用 |

底图瓦片**不在镜像里**（镜像保持精简、也不涉及再分发底图），必须从宿主目录挂载：

```bash
npm run tiles:fetch        # 拉到仓库同级的 MapSource/tiles（约 30MB）
# 然后在 deploy/.env 里设 TILES_HOST_DIR=<该目录>
```

以后更新瓦片，**直接往这个宿主目录里覆盖文件即可**——服务端按请求读盘，上传完立即生效，
不需要重建镜像、也不需要重启容器（想验证可以 `docker compose restart app` 看启动自检日志）。

同理，**题库快照、坐标标定、区域落点**这些内容数据也不在 git 上维护：
仓库里的 `packages/shared/data/*.json` 只是骨架，生产把它们放到宿主目录里挂进容器
`/srv/data-json`（compose 默认已配好 `SHARED_DATA_HOST_DIR`），改文件即生效
（其中题库快照需要 `FORCE_SEED=1` 重启一次让它重新导入）。

想交给宝塔的「Docker → Compose 项目」管理时，它的两个输入框分别粘
[`deploy/docker-compose.yml`](deploy/docker-compose.yml)（Compose 框）和
[`deploy/.env.example`](deploy/.env.example)（env 框，三个宿主目录写绝对路径，
指向 `/www/server/panel/data/compose/nte-geoguess/`）；只想粘一个文件就用
[`deploy/docker-compose.standalone.yml`](deploy/docker-compose.standalone.yml)（变量全部内联）。
细节见 [`docs/deployment.md`](docs/deployment.md) 的「宝塔面板：用 Compose 项目部署」。

容器启动时会先自检：**瓦片目录里没有 jpg、或内容数据 JSON 不存在，就自动下载补全**
（`TILES_AUTO_FETCH` / `DATA_JSON_AUTO_FETCH`，默认开；可用 `=0` 关闭成"缺了就报错"）。
补全只写进挂载的宿主目录；**目录不可写或下载失败 = 直接退出并说明原因**，
没有"退到 `/tmp`"或"用镜像里那份旧骨架"的静默兜底。

更新流程：`git push` → Actions 构建并发布镜像 → 服务器上 `docker compose pull && docker compose up -d`。
compose 已带 `com.centurylinklabs.watchtower.enable=true` 标签：若你的 watchtower 以 `--label-enable` 运行，
它会自动拉新镜像并重启，无需手工干预。

> **宝塔部署要点**（都是踩过的坑）：
> 1. 宝塔全局 nginx 开着 `proxy_cache cache_one`，重新构建后会命中旧首页 HTML、表现为「页面空白」——
>    **该站点要加 `proxy_cache off;`**。
> 2. 用宝塔「Node 项目（默认项目）」原生部署时它**不注入环境变量**（前置只导出 PATH，启动命令也不能写
>    `VAR=value` 前缀），所以变量要放仓库根的 `.env`，由 `server/src/config.js` 的 `process.loadEnvFile()` 读取；
>    用 Docker 部署没有这个问题，变量都在 compose 里。
> 3. `better-sqlite3` 在 Node 24 上没有预编译包，原生部署请用 **Node 22**（镜像里已是 Node 22）。
> 4. `/admin/` 建议加访问限制（Basic Auth / IP 白名单 / VPN）；HTTPS 环境下设 `COOKIE_SECURE=true`。

---

## 数据说明与已知限制

1. **内置题源 476 道；区域归属是「按坐标算出来」的，仓库里的骨架仍是未标注。**
   原始数据 1622 个点位里有 1222 个的 `district` 是占位值「全地图」，
   而 476 道有截图的题全部落在这一批里；400 个有真实区域名的点位则都没有截图
   （它们是谕石之类的纯地图标记）。无截图、出不了题的点位已全部删除，
   现在是 **476 个点位 / 476 道可出题 / 8 个分类**。
   所以「按区域出题」得先归类：`npm run classify:regions` 用
   `packages/shared/data/region-reference.json` 里那 400 个参照点做 kNN 投票（参考点留一法自检 96.8%），
   把 476 道题落到 向阳岛 25 / 新赫兰德区 120 / 未闻浦 15 / 桥间地 66 / 米格尔区 124 /
   绘空町 121 / 薄暮区 5。这个结果**只写进部署侧的数据**（`data-json/map-data.json` + SQLite），
   仓库里的 `map-data.json` 保持「最基本的骨架」，需要时用脚本重新生成。

2. **数据整理有可复现的脚本，都是「不加参数即演练、加 `--apply` 才执行」，幂等。**
   - `npm run migrate:regions`：按区域名重建分类、删除既无区域名又无截图的占位点位。
   - `npm run add:region-twilight`：新增「薄暮区」分类，并把落在已知区域范围之外的
     未标注点位改归该区。
   - `npm run classify:regions`：按坐标把题归到区域（kNN + 覆盖范围规则），参考点在
     `packages/shared/data/region-reference.json`（来自 MaaNTE-Map），推断规则在
     `packages/shared/src/regionInference.js` —— 后台出题时的自动归类用的是同一份实现。
     加 `--cv` 会打印参照点留一法自检准确率；执行时会备份、写盘并同步数据库。
   - `npm run remove:imageless`：删除所有无截图点位（出不了题的地图标记）。
   除 `remove:imageless` 外都会先备份到 `data/backups/`；`remove:imageless` 按使用者要求
   不做自动备份，但会把删掉的点位完整写进 `data/removed-imageless-*.json` 以便恢复。
   这些脚本都不影响后台上传的自建题。

3. **运行数据默认在仓库根的 `data/`。**
   SQLite 与后台上传的截图都在那里，已被 `.gitignore` 排除。
   放在仓库根而不是 `server/` 下，是因为 `dev:server` 用 `node --watch`，
   数据写在被监视的目录里会导致每次写库都重启服务端、清空登录会话。
   生产用 `DATA_DIR` 指向挂载卷。

4. **`district` 字段不可用。**
   全部为「全地图」，所以区域筛选用的是按地图九宫格自动分区。
   一旦数据里出现真实区域值，`packages/shared/src/puzzles.js` 会自动优先使用真实值。

5. **底图不完整也不影响游玩。**
   有截图的点位集中在地图的一部分区域（约 X 1476–7707 / Y 2989–11393，
   底图为 26112×26112），其余区域是纯地图。

6. **后台站必须保护。**
   默认只有一个密码，没有多用户与权限分级。公网部署请按
   `docs/deployment.md` 的安全清单处理（VPN / IP 白名单 / Basic Auth / HTTPS）。

7. **内置数据与截图的来源与权利归属见下文「许可与第三方权利」。**
   点位数据与坐标标定的整理成果来自 MaaNTE-Map 项目，游戏画面（底图、截图）的版权归游戏发行商；
   后台上传的截图属于你自己的素材。

---

## 许可与第三方权利

### 本项目许可

本项目以 **GNU Affero General Public License v3.0**（SPDX：`AGPL-3.0-only`）发布，
全文见仓库根目录的 [`LICENSE`](LICENSE)。

选择 AGPL 不是偏好，而是**许可义务**：本项目的坐标换算代码提取自
[Maa-NTE/MaaNTE-Map](https://github.com/Maa-NTE/MaaNTE-Map)（该仓库同样以 AGPL-3.0 发布），
点位数据与坐标标定也复制自该仓库，因此本项目整体构成其**派生作品**，
必须沿用同一许可分发（AGPL-3.0 §5）。

本项目是**通过网络提供服务的程序**，所以 AGPL-3.0 §13 同样适用：
任何公开部署的实例都必须向使用者提供完整对应源码。本仓库即为该源码——
部署时请保持本仓库公开，并保证后台站（`apps/admin`）与服务端（`server/`）的源码同样可获取。

### 第三方权利

AGPL-3.0 只覆盖本项目作者拥有版权的部分，**不覆盖下列第三方内容**：

| 内容 | 位置 | 权利归属 |
| --- | --- | --- |
| 点位数据、坐标标定、区域划分（整理成果） | `packages/shared/data/` | MaaNTE-Map 项目，AGPL-3.0 |
| 游戏底图瓦片（约 3516 张 / 30MB） | 不在本仓库，来自 `Maa-NTE/MapSource` | 游戏发行商；**该仓库未声明任何许可证** |
| 游戏内截图（内置题库） | `apps/game/public/images/locations/` | 游戏发行商 |
| 后台上传的截图 | 服务端 `DATA_DIR/uploads`（不入库） | 上传者本人 |

《Neverness to Everness》的名称、地图成像、游戏画面、图标、商标及其他素材，
版权归其开发商与发行商所有，**既不属于 MaaNTE-Map 项目，本项目也无权对其再许可**。

因此请注意：

- 本项目是**非官方粉丝项目**，与游戏开发商、发行商无任何隶属或合作关系。
- 本项目及其任何部署实例**不得用于商业用途**；权利人提出要求时，涉及游戏素材的部分应立即移除。
- 底图瓦片不随本仓库分发，仅在部署时通过 `npm run tiles:fetch` 按需拉取。
- **请勿将瓦片镜像进本仓库或任何其他仓库**：`Maa-NTE/MapSource` 未声明许可证，
  默认状态为「保留所有权利」，再分发前须先取得权利人许可。

---

## 相关文档

| 文档 | 内容 |
| --- | --- |
| [`docs/api-contract.md`](docs/api-contract.md) | 服务端接口契约（游戏站与后台站都按它实现） |
| [`docs/deployment.md`](docs/deployment.md) | 部署、环境变量、HTTPS、备份、故障排查 |
| [`docs/requirements-extraction.md`](docs/requirements-extraction.md) | 从 MaaNTE-Map 提取图寻要素的过程与踩坑记录 |
