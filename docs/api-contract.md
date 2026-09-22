# 服务端 API 契约

游戏站与后台站都只通过这份契约与后端通信。
实现见 `server/src/`，类型形状由 `packages/shared` 保证两端一致。

所有响应均为 JSON（图片除外）。错误统一形状：

```json
{ "error": "错误说明", "details": ["可选的具体问题"] }
```

| 状态码 | 含义 |
| --- | --- |
| 400 | 请求数据不合法（坐标不是数字、缺少字段等） |
| 401 | 未登录或会话过期（后台接口） |
| 403 | 已登录但无权限 |
| 404 | 资源不存在 |
| 409 | 冲突（例如重复创建） |
| 413 | 请求体过大（截图超限） |
| 429 | 触发限流（登录失败次数过多） |
| 500 | 服务端异常 |

---

## 公共接口（无需登录）

### `GET /api/health`

健康检查，用于容器探针与部署自检。

```json
{ "status": "ok", "version": "1.0.0", "uptimeSeconds": 12.5, "database": "ok" }
```

### `GET /api/bootstrap`

游戏站启动时要的全部数据（一次请求，避免多次往返）。

```json
{
  "map": {
    "width": 26112,
    "height": 26112,
    "tileSize": 512,
    "tileUrl": "/mapsource-tiles/{z}/{x}/{y}.jpg",
    "mapLocatorSourceWidth": 13056,
    "mapLocatorSourceHeight": 13056,
    "coordinateSystem": "game-affine-v1"
  },
  "calibration": {
    "version": 1,
    "coordinateFrame": "map-2026-08",
    "sourceWidth": 13056,
    "sourceHeight": 13056,
    "points": [{ "raw": [-134394.56, 199913.53, 11416.17], "map": [4323, 8488] }]
  },
  "categories": [
    { "id": "lost-wallet", "group": "资源", "label": "丢失的钱包",
      "icon": "👛", "iconUrl": "/icons/...", "color": "#e8a6ff", "isHidden": false }
  ],
  "locations": [
    { "id": "lost-wallet-001", "name": "丢失的钱包 #001", "types": ["lost-wallet"],
      "district": "全地图", "description": "...", "tags": ["资源"],
      "images": ["/images/locations/lost-wallet-001/<sha256>.webp"],
      "x": -279503.84, "y": 336964.114, "source": "map-data" }
  ],
  "stats": { "locations": 1622, "puzzles": 476, "categories": 40, "questionBank": 0 }
}
```

- `calibration` 由前端交给 `createGeometry(map, calibration)`，前端据此自行算坐标，
  不需要为每个点位下发像素坐标。
- 只下发**有截图**的点位（可选 `?includeAll=1` 拿全量，后台用）。
- 响应带 `ETag`，客户端可用 `If-None-Match` 复用缓存。

### `GET /api/stats`

轻量统计，用于页脚或部署自检。

```json
{ "locations": 1622, "puzzles": 476, "questionBank": 12, "categories": 40, "images": 489 }
```

### 静态资源

| 路径 | 说明 |
| --- | --- |
| `GET /images/locations/<id>/<sha256>.<ext>` | 内置点位截图 |
| `GET /images/questions/<id>.<ext>` | 后台上传的题库截图 |
| `GET /icons/**` | 分类图标 |
| `GET /mapsource-tiles/<z>/<x>/<y>.jpg` | 底图瓦片（可由 nginx 直接接管） |
| `GET /healthz` | 不经过 /api 的健康检查，给负载均衡用 |

---

## 后台接口（需要登录）

鉴权方式：登录后下发 **httpOnly 会话 Cookie**（`nte_admin_session`）。
后台前端不需要自己处理 token，`fetch` 带上 `credentials: 'include'` 即可。

### `POST /api/admin/login`

```json
{ "password": "..." }
```

成功：

```json
{ "ok": true, "expiresAt": "2026-09-22T10:00:00.000Z" }
```

失败：`401 { "error": "密码不正确" }`；同一 IP 连续失败 5 次后返回
`429 { "error": "尝试过于频繁，请稍后再试" }`。

### `POST /api/admin/logout`

清除会话，返回 `{ "ok": true }`。

### `GET /api/admin/session`

后台启动时探测登录状态：

```json
{ "authenticated": true, "expiresAt": "..." }
```

未登录返回 `200 { "authenticated": false }`（不是 401，方便前端分支）。

### `GET /api/admin/questions`

后台题库列表，支持查询参数：

| 参数 | 说明 |
| --- | --- |
| `q` | 按名称 / id 模糊搜索 |
| `source` | `question-bank`（默认）或 `map-data` 或 `all` |
| `category` | 按分类筛选。支持 `category=a`、`category=a,b`、`category=a&category=b` |
| `limit` / `offset` | 分页，默认 50 / 0 |

分类是数组字段（一个点位可属于多个分类），命中其中任意一个即算匹配。
服务端用 `EXISTS + json_each` 实现，避免 JOIN 导致多分类点位在结果里重复、`total` 被算大。
响应里会回带解析后的 `categoryIds`，便于调用方确认筛选真的生效了。

```json
{
  "total": 12,
  "limit": 50,
  "offset": 0,
  "items": [
    { "id": "qb-...", "name": "...", "types": ["lost-wallet"], "district": "",
      "description": "", "tags": [], "images": ["/images/questions/qb-....png"],
      "x": -33092.123, "y": 71073.456, "source": "question-bank",
      "createdAt": "...", "updatedAt": "..." }
  ]
}
```

### `GET /api/admin/questions/category-options`

分类筛选下拉的选项与计数。带 `source` 参数，按该来源统计，
所以不会出现「选了之后一条都没有」的空选项。

```json
{
  "source": "all",
  "items": [
    { "id": "region-miguel", "label": "米格尔区", "group": "区域", "color": "#ffd27d", "count": 80 },
    { "id": "unlabeled", "label": "未标注", "group": "区域", "color": "#9aa4ad", "count": 472 }
  ]
}
```

> 注册顺序注意：这条路由必须排在 `/questions/:id` 之前，否则 `category-options`
> 会被当成一个题目 id 匹配掉。

### `POST /api/admin/questions`

新建题目。请求体：

```json
{
  "name": "绘空町 · 屋顶的猫",
  "types": ["lost-wallet"],
  "district": "",
  "description": "线索提示",
  "tags": ["资源"],
  "x": -33092.123,
  "y": 71073.456,
  "images": [
    { "mimeType": "image/png", "dataUrl": "data:image/png;base64,..." }
  ]
}
```

- `x` / `y` 是**游戏真实坐标**（前端从地图点击得到）。
- `images` 里的截图由服务端落盘，返回的 `images` 是最终可访问路径。
- 只想登记已有路径时可传 `images: [{ "path": "/images/questions/xxx.png" }]`。
- 成功返回 `201` 加创建后的题目对象。

### `PUT /api/admin/questions/:id`

修改题目，字段同 `POST`（可只传要改的字段）。
`images` 传数组表示**整体替换**：带 `dataUrl` 的上传新图，带 `path` 的保留已有图。

### `DELETE /api/admin/questions/:id`

删除题目，同时清理只被该题引用的截图。

### `POST /api/admin/questions/batch`

批量新建（后台「保存多题后一次性提交」用）。

```json
{ "questions": [ { /* 同 POST /api/admin/questions */ } ] }
```

返回：

```json
{ "created": 3, "failed": 0, "items": [ /* ... */ ], "problems": [] }
```

部分失败时 `created` 与 `failed` 都会有值，`problems` 给出具体原因，HTTP 仍为 `200`。

### `GET /api/admin/categories`

```json
{ "items": [ { "id": "...", "group": "...", "label": "...", "color": "...", "count": 42 } ] }
```

`count` 是引用该分类的点位数，后台删除分类前可据此判断。

### `POST /api/admin/categories`

```json
{ "id": "custom-cat", "group": "自建题目", "label": "自建分类", "icon": "📷", "color": "#8adfd6" }
```

### `DELETE /api/admin/categories/:id`

引用了该分类的点位会被改到 `question-bank` 兜底分类（不会连带删点位）。
