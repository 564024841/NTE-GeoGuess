# 图寻题库后台（`apps/admin`）

题库后台是给运维/出题人用的单页应用：**上传游戏截图 + 在地图上点选答案位置 = 一道题**。
它只做前端，所有数据都通过 `docs/api-contract.md` 里的后台接口读写，不落任何仓库文件。

```
浏览器 ──/api、/images、/icons、/mapsource-tiles──▶ 服务端 127.0.0.1:8787
   │                                                      │
   └── 复用 @nte-geoguess/shared（坐标换算、题库索引、图片校验、常量）
```

## 怎么跑

```bash
# 1) 在仓库根目录装依赖（npm workspaces，会把 apps/admin 一起链接好）
npm install

# 2) 起后端（另一个终端）
npm run dev:server          # 默认 127.0.0.1:8787，需要 ADMIN_PASSWORD
#   PowerShell 例子：$env:ADMIN_PASSWORD='你的密码'; npm run dev:server

# 3) 起后台
npm run dev --workspace apps/admin      # http://127.0.0.1:5175
```

生产预览：

```bash
npm run build --workspace apps/admin
npm run preview --workspace apps/admin  # http://127.0.0.1:4175
```

> 包名说明：`apps/admin` 的 `name` 是 `@nte-geoguess/admin`（不是 `apps/admin`）。
> npm 10 不接受含 `/` 的包名（`EINVALIDPACKAGENAME`），整个仓库都无法 `npm install`。
> 目录路径没变，所以 `--workspace apps/admin` 这种按路径写法依然可用；
> 也可以写 `--workspace @nte-geoguess/admin`。

开发与预览都把 `/api`、`/images`、`/icons`、`/mapsource-tiles` 代理到 `127.0.0.1:8787`
（`VITE_DEV_SERVER` 可改端口），因此**不需要 CORS，Cookie 也是同源**。

## 功能

| 功能 | 说明 | 用到的接口 |
| --- | --- | --- |
| 登录 / 退出 | 启动先探测会话；失败显示「密码不正确（还可尝试 N 次）」，限流显示还要等多少秒 | `GET /api/admin/session`、`POST /api/admin/login`、`POST /api/admin/logout` |
| 地图选点 | 底图参数与游戏站完全一致（CRS.Simple、瓦片 512、minZoom -3、maxZoom 1）；点地图即设定答案位置，面板回显**游戏坐标 / 底图像素 / 参考区域** | `GET /api/bootstrap` |
| 新建题目 | 点击或拖拽上传截图（PNG/JPEG/WebP/GIF/AVIF，≤ 8 MB）、填名称/分类/区域/备注、点选坐标 → 「保存到待提交清单」，可连续加多题 → 一次性提交 | `POST /api/admin/questions/batch` |
| 题库列表 | 关键字搜索（名称/ID，300ms 防抖）、按来源筛选（后台题库 / 内置点位 / 全部）、分页；每项显示缩略图、名称、坐标、分类、来源、创建时间 | `GET /api/admin/questions` |
| 编辑题目 | 改文字字段、换截图、重新在地图上点选坐标；「保存修改」整体替换 `images` | `PUT /api/admin/questions/:id` |
| 删除题目 | 二次确认后删除，被删题目独有的截图由服务端一并清理 | `DELETE /api/admin/questions/:id` |
| 分类管理 | 列表（含引用点位数）+ 新建 + 删除；删除前明确提示「引用了该分类的点位会被改到兜底分类」 | `GET/POST /api/admin/categories`、`DELETE /api/admin/categories/:id` |

细节约定：

- **地图上不画任何题库点位**（和游戏站一致）：后台地图一旦显示点位就等于把答案提前摆在眼前。
  地图上只会出现「当前正在编辑的那一个答案点」。
- **参考区域**由 `buildPuzzleIndex` 的九宫格给出。它的网格边界没有对外暴露，
  所以 `src/utils/region.js` 用同一套常量复算了边界，再回 `index.regions` 取标签与题量。
- **提交结果持久展示**：批量提交后即使清单清空，面板底部仍保留「成功 N 题 / 失败 N 题」
  与 `problems[].message`；批量接口始终返回 200，部分失败也走这条路显示。
- 所有失败都有可见提示：编辑器内是 `status-banner`，其它操作走右上角的提示条堆栈，
  不会只躺在 console 里。
- 所有请求都带 `credentials: 'include'`，并且**都有超时**：后端卡住时界面会显示
  「服务端 N 秒内没有响应」，而不是无限转圈（`VITE_API_TIMEOUT_MS` 可调）。

## 和游戏站、服务端的关系

- **共享逻辑**：坐标换算（`createGeometry`）、题库索引与九宫格（`buildPuzzleIndex`）、
  评分与格式化、图片路径与 MIME 白名单（`resolveImageUrl` / `isSupportedImageType` 等）
  全部 `import ... from '@nte-geoguess/shared'`，两端不各写一份。
- **不打包地图快照**：`@nte-geoguess/shared/seed`（700 KB 的 `map-data.json`）只给服务端用，
  后台的地图元信息、标定、分类、点位一律来自 `GET /api/bootstrap`。
- **与游戏站同一套视觉**：暗色玻璃拟态、`--accent: #8adfd6`、`.glass-panel`、`.view-tabs`、
  `.steps`、`.drop-zone`、`.answer-slot` 等 class 与 `apps/game/src/styles.css` 对齐；
  出题流程与 `apps/game/src/components/QuestionBankEditor.vue` 是同一个交互（游戏站是本地版，
  这里是线上版）。
- **Leaflet 入口照抄游戏站的 `src/utils/leaflet.js`**：先把 Leaflet 挂到 `window.L`，
  再用动态 `import()` 加载 `leaflet.markercluster`，否则插件会抛 `L is not defined`。
  启动同样是 `markerClusterReady.then(...)` 后再 `mount`——**不用顶层 await**（默认浏览器目标不支持）。

## 目录

```
apps/admin/
├── index.html
├── vite.config.js          dev 5175 / preview 4175，代理到 8787
├── src/
│   ├── main.js             先等 markercluster 就绪再挂载
│   ├── App.vue             登录态 + 启动数据的 gate：登录页 / 加载页 / 错误页 / 工作台
│   ├── api.js              API 客户端（credentials、统一错误、超时、dataUrl 读取）
│   ├── styles.css          暗色主题（与游戏站同源，另加后台专用样式）
│   ├── utils/              leaflet 入口、区域解析
│   ├── composables/        useAuth / useBootstrap / useMap / useQuestionEditor /
│   │                       useQuestionList / useCategories / useNotices / useConfirm
│   └── components/         LoginView / MapWorkspace / QuestionEditorPanel /
│                           QuestionListPanel / CategoryPanel / MapHud /
│                           NoticeStack / ConfirmDialog
└── scripts/selfcheck.mjs   端到端自查（截图写到仓库根 output/）
```

## 自查

```bash
# 会自动起 dev server（结束再关掉），截图写到 output/admin-*.png
node apps/admin/scripts/selfcheck.mjs --password=<ADMIN_PASSWORD>

node apps/admin/scripts/selfcheck.mjs --password=xxx --url=http://127.0.0.1:5175/ --no-server
node apps/admin/scripts/selfcheck.mjs --api=http://127.0.0.1:8787 --api-timeout=8000
```

脚本做的事：

1. 未登录时必须渲染登录页、不白屏、没有未捕获异常（这部分是硬性断言，后端挂掉也要通过）；
2. 后端可用时再走完整流程：登录 → 新建一题（截图 + 地图点选 + 保存）→ 批量提交 →
   列表搜索 → 编辑 → 删除（含二次确认）→ 分类管理 → 退出登录，并断言全程零未捕获异常。

后端不可用时脚本只做第 1 步，并在输出里注明「只校验登录页」。

## 排查提示

- 登录页显示「连不上服务端」：后端没起，或端口不是 8787（用 `VITE_DEV_SERVER` 改代理目标）。
- 登录后一直提示「服务端 N 秒内没有响应」：后端接口卡住了（不是前端问题）——
  先 `curl http://127.0.0.1:8787/api/health` 看进程，再看 `GET /api/admin/questions` 是否及时返回。
- 地图是黑的但能点选：底图瓦片目录没配好（服务端 `TILES_DIR` / `TILE_REDIRECT_BASE`），
  坐标链路本身是好的（面板里的坐标会正常变化）。
