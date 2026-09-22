# 从 MaaNTE-Map 提取「图寻」所需要素

本文是对 `MaaNTE-Map-main`（下称**原项目**）的 README 与源码的提取结论，说明做一个
**图寻（看游戏内截图 → 在大地图上猜位置 → 按距离评分）** 网站时，
哪些东西可以直接复用、哪些必须自己造、哪些是坑。

原项目本身是「互动点位地图 + 点位编辑器 + 实时定位」，**没有**图寻玩法。
它的价值在于它已经把「这张游戏大地图」的所有底层问题（瓦片、坐标系、点位数据）
解决干净了，图寻站可以完全站在它上面。

---

## 1. 玩法定义（先对齐需求）

用户给出的定义：

> 以一张地图为底图，系统给出一张来自游戏中的截图，玩家根据图中线索在地图上标出
> 他认为的位置；猜测位置离实际地点越近，得分越高。

因此图寻站需要的三件核心资产是：

| 资产 | 作用 | 原项目是否提供 |
| --- | --- | --- |
| 底图瓦片金字塔 | 玩家用来标点的大地图 | ✅ 独立仓库 `Maa-NTE/MapSource` |
| 「题面截图 + 真实坐标」配对 | 题目本身 | ✅ 点位数据里的 `images` + `x/y` |
| 游戏坐标 ⇄ 地图坐标换算 | 判分与标点 | ✅ 标定文件 + 仿射变换代码 |

---

## 2. 可以直接复用的东西

### 2.1 技术栈与工程配置

原项目 README「开发说明 → 目录结构」与 `package.json` 给出：

- **Vue 3 + Vite 6 + Leaflet 1.9**，`@vitejs/plugin-vue`
- `leaflet.markercluster` 做点位聚合
- 运行方式：`npm run dev`（默认 `http://127.0.0.1:5173`）、`npm run build`

这套栈对图寻站完全够用，不需要引入框架层的东西。

### 2.2 地图数据快照 `src/data/map-data.json`

README「本地数据」段落定义了顶层结构，实际文件内容已核实：

```jsonc
{
  "version": 1,
  "map": {
    "width": 26112, "height": 26112,     // 底图总像素
    "tileSize": 512,                      // 瓦片边长 → 26112/512 = 51×51 张瓦片
    "mapLocatorSourceWidth": 13056,       // 定位服务使用的坐标系尺寸
    "mapLocatorSourceHeight": 13056,
    "tileUrl": "https://raw.githubusercontent.com/Maa-NTE/MapSource/main/tiles/{z}/{x}/{y}.jpg",
    "coordinateSystem": "game-affine-v1"
  },
  "categories": [ /* 40 个分类，见下 */ ],
  "locations":  [ /* 1622 个点位 */ ],
  "routes":     [ /* 1 条路线，10 个路段 */ ]
}
```

**分类字段**（README「分类字段」明确定义）：

| 字段 | 含义 |
| --- | --- |
| `id` | 稳定标识，点位通过 `types` 数组引用 |
| `group` / `label` | 侧边栏分组与显示名 |
| `icon` / `iconUrl` / `color` | 标记样式 |
| `isDefault` | 保留的导入字段 |
| `isHidden` | `true` 时只在编辑器保留，不进浏览界面 |

分类分组统计（实测）：探索度 5、资源 7、传送点 4、怪物 24。

**点位字段**（实测的字段并集）：

```
id, name, types[], district, description, tags[], images[], x, y
```

`x/y` 是**游戏真实坐标**（不是像素），`images` 是截图相对路径数组。

**路线字段**：`routes[].{id, name, isHidden, segments[]}`，
`segments[].{id, name, isHidden, points[]}`，`points[].{locationId, x, y}`。

### 2.3 坐标系统 —— 最容易踩坑的部分

README「坐标与扩图」给出的链路：

```
游戏真实坐标 ⇄ 标定像素坐标 ⇄ Leaflet CRS.Simple 坐标
```

实现细节在 `src/data/locations.js`，需要照搬的逻辑有三块：

**(a) 由 3 个标定点解 2×2 仿射变换**

`navi-coordinate-calibration.json` 存 `points[].{raw:[x,y,z], map:[px,py]}`，
README 说明仿射「同时处理平移、缩放、轻微旋转和剪切」，所以**不能**用简单的
线性等比换算。源码用克拉默法则解出 `mapX`、`mapY` 两组系数与 `offset`。

**(b) Leaflet CRS.Simple 的映射方向**

```js
// 标定像素 → Leaflet
lat = -pixelY * MAP_HEIGHT / sourceHeight
lng =  pixelX * MAP_WIDTH  / sourceWidth
```

注意 **lat 是负的**（README 未写，必须读源码）：
地图覆盖范围是 `lat ∈ [-26112, 0]`、`lng ∈ [0, 26112]`。

**(c) 地图初始化参数**（`useMapApp.js` 的 `onMounted`）

```js
const bounds = L.latLngBounds([-MAP_HEIGHT, 0], [0, MAP_WIDTH])
L.map(el, {
  crs: L.CRS.Simple,
  minZoom: -3, maxZoom: 1,
  maxBounds: bounds.pad(0.18),
  zoomControl: false, attributionControl: false,
})
L.tileLayer(url, {
  bounds, minZoom: -3,
  maxNativeZoom: 0,   // 瓦片仓库最高只到 z=0，再放大由 Leaflet 复用
  maxZoom: 1, noWrap: true,
  tileSize: 512, keepBuffer: 3,
})
```

这些数字是配套的：**`tileSize: 512` 与 `maxNativeZoom: 0` 决定了缩放级别的含义**
（zoom 0 时 1 lat/lng 单位 = 1 屏幕像素，所以 zoom -3 时 1 单位 = 1/8 像素）。
改任意一个都会让地图与点位错位，不要凭感觉调。

### 2.4 「题面截图」素材 —— 最大的意外收获

原项目的点位截图 `public/images/locations/<点位 id>/<sha256>.webp`
**就是游戏内实拍画面**（实测：室内场景、家具、目标物，部分还带红圈标注），
完全可以当作图寻的题面。

实测统计：

- 477 张截图，11.3 MB，全部 `.webp`
- 476 个点位带截图（其余 1146 个点位是纯地图标记，无截图）
- 有截图的点位游戏坐标覆盖全图跨度的 **95%（X）/ 98%（Y）**

> ⚠️ 这意味着**图寻的题源天然只有 476 道**，且实测全部属于同一个分类
> `lost-wallet`（丢失的钱包），`district` 字段全部是占位值「全地图」。
> 具体影响见第 4 节。

### 2.5 其他值得照搬的小件

- `src/utils/assets.js` 的 `publicAssetUrl()`：给 public 资源补 Vite base，兼容子路径部署
- `src/utils/storage.js`：localStorage 读取统一 try/catch 降级，坏数据不让应用启动失败
- `src/constants/mapApp.js`：把缩放默认值、storage key 集中管理
- 「点位标记用 `L.divIcon` + HTML/CSS」而不是图片图标（`markerHtml` / `createIcon`）

---

## 3. 必须自己造的部分

原项目**没有**图寻玩法，以下全部需要新写：

1. **题源索引**：从 1622 个点位里筛出「有截图 + 坐标合法」的，并挂上分类信息
2. **抽题器**：按分类/区域/题数筛选，支持固定种子（同种子出同一套题，便于复盘）
3. **评分引擎**：距离 → 分数 → 评价分档
4. **游戏状态机**：`setup → playing → revealed → finished`
5. **题目界面**：截图展示、地图落点、结算卡片、逐题复盘、总分面板
6. **地图覆盖物**：玩家落点图钉、答案图钉、两者之间的偏差连线

---

## 4. 踩坑记录（做图寻时实际遇到的）

### 4.1 评分尺度：**不能把游戏坐标当米**

最初按「游戏坐标 ≈ 米」折算距离，结果偏 5 像素就 0 分，评分曲线完全失真。

实测（`npm run qa` 会复现）：

```
标定文件给出           1 标定像素 ≈ 61.0 游戏单位
标定像素 : 底图像素    = 13056 : 26112 = 1 : 2
⇒                      1 底图像素 ≈ 122 游戏单位
```

而且**局部标定比例与全量点位的宏观比例完全一致**（61.0 vs 60.99），
说明地图与游戏坐标是等比线性的，可以放心用常数换算。

结论：**按「底图像素」评分**。玩家能直接在地图上量出偏了几个像素，
比「偏了 200000 游戏单位」直观得多。本项目取
`points = 100 × 2^(-像素偏差 / 50)`。

### 4.2 `leaflet.markercluster` 在打包器里会崩

原项目 `src/App.vue` 只引了 CSS：

```js
import 'leaflet.markercluster/dist/MarkerCluster.css'
```

但源码里 `L.markerClusterGroup` 是**从未被引用的死代码**，所以原项目没暴露这个问题。

新项目一旦真的 import 插件，就会遇到：

```
ReferenceError: L is not defined
```

原因：`leaflet.markercluster@1.5.3` 的 UMD 包装虽然写了 `factory(exports)`，
但**源码内部直接使用裸标识符 `L`**，旧版靠 `(function(global){…}(this))` 里的
`this === window` 才能取到全局 Leaflet；Leaflet 官方 **ESM 构建不会设置 `window.L`**。

解决办法（见 `src/utils/leaflet.js`）：加载插件前先 `window.L = L`，
且因为静态 `import` 会被提升，必须用**动态 import** 才能保证顺序：

```js
import L from 'leaflet'
if (typeof window !== 'undefined') window.L = L
export const markerClusterReady = import('leaflet.markercluster')
```

然后在 `main.js` 里等 `markerClusterReady` 完成再 `createApp().mount()`。
注意默认浏览器目标（`es2020` / chrome87）**不支持顶层 await**，所以用 `.then()`
而不是 `await`，否则 `vite build` 会直接失败。

### 4.3 瓦片默认不能用远程地址

原项目 README 写「生产构建默认读取 `raw.githubusercontent.com/...`」，
本地开发才映射到同级 `MapSource/tiles`。实测瓦片是 **2601 张 z=0 全图（51×51）
+ z=-1..-6 低分辨率层，合计 3516 张 / 29.8 MB**。

对图寻站来说，开发与构建**都走本地瓦片**更合适：不依赖外网、离线可用、
也不会出现「生产环境首次加载等 CDN」的问题。只有真正要部署到静态托管时，
才用 `VITE_MAP_TILE_URL` 指向瓦片 CDN。

因此本项目把 `/mapsource-tiles/*` 中间件**同时挂在 dev 与 preview**，
让构建产物也能在本地完整跑起来（`vite preview` 默认没有这个中间件）。

### 4.4 数据里的 `district` 可能是占位值

476 道题的 `district` **全部**是「全地图」，直接拿它做「区域筛选」就是个空功能。
本项目改为：**字段有真实值时用它，否则按地图九宫格自动分区**
（见 `src/game/puzzles.js` 的 `buildRegionTable`），并在 UI 上说明是自动分区。

### 4.5 数据自检必须做

原项目 README 的修改流程要求每次提交前跑
`npm run build` / `qa:location-bundle` / `qa:static-location-bundle` / `qa`。
图寻站同样需要，重点是**「截图文件真的存在」**——
`images` 里存的是路径，文件缺失时只有抽到那一题才会炸。

---

## 5. 提取结论一览

| 图寻需要的能力 | 来源 | 本项目落地文件 |
| --- | --- | --- |
| 瓦片金字塔 | `Maa-NTE/MapSource` 仓库 | `vite.config.js` 的 `/mapsource-tiles` 中间件 |
| 地图尺寸/瓦片尺寸 | `map-data.json` 的 `map` | `src/data/locations.js` |
| 游戏坐标 → 像素 | 标定文件 + 仿射变换 | `src/data/locations.js` |
| 像素 → Leaflet 坐标 | `CRS.Simple` 映射 | `src/data/locations.js` |
| 地图初始化参数 | 原 `useMapApp.js` | `src/game/useMap.js` |
| 点位/分类数据 | `map-data.json` | `src/data/map-data.json`（快照） |
| 题面截图 | `public/images/locations/` | `public/images/locations/`（复制 477 张） |
| 分类图标 | `public/icons/` | `public/icons/`（复制 35 个） |
| 题源索引 / 抽题 | 需自造 | `src/game/puzzles.js` |
| 评分引擎 | 需自造 | `src/game/scoring.js` |
| 游戏状态机 | 需自造 | `src/game/useGame.js` |
| 游戏界面 | 需自造 | `src/components/*`、`src/App.vue` |
| 数据自检 | 参考原 `scripts/qa-map.mjs` | `scripts/qa-map.mjs` |
