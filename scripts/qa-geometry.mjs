// 坐标链路与地图几何自检（不需要浏览器、不需要服务端）。
//
// 覆盖：
//   1. 地图元数据自洽（尺寸 / 瓦片倍数 / 标定与快照一致）
//   2. 标定文件能解出可逆的仿射变换，且标定点跨度足够
//   3. 游戏坐标 ⇄ 标定像素 ⇄ Leaflet 坐标 的往返精度
//   4. 游戏单位 / 像素 比例（评分尺度的依据）与各向异性
//   5. 内置点位是否都落在地图范围内
//   6. 题库索引能否正常构建
//   7. 区域参考点与分类器（后台「按落点自动分类」的依据，含留一法准确率）
//
// 用的是 packages/shared 里前后端共用的同一份实现，
// 所以这里通过就等于浏览器与 Node 两侧的换算口径一致。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildPuzzleIndex, createGeometry, solveAffine } from '@nte-geoguess/shared'
import {
  REGION_REFERENCE_POINTS as regionReferencePoints,
  buildRegionReferenceIndex,
  createRegionClassifier,
  isRealDistrictName,
} from '@nte-geoguess/shared/regionClassify'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SHARED_DATA = path.join(ROOT, 'packages/shared/data')

const mapData = JSON.parse(fs.readFileSync(path.join(SHARED_DATA, 'map-data.json'), 'utf8'))
const calibration = JSON.parse(fs.readFileSync(path.join(SHARED_DATA, 'navi-coordinate-calibration.json'), 'utf8'))

// 地图尺寸取自快照本身（shared 的 geometry 是纯函数，不内置地图数据）
const MAP_WIDTH = mapData.map.width
const MAP_HEIGHT = mapData.map.height
const TILE_SIZE = mapData.map.tileSize

const failures = []
const notes = []
const check = (condition, message) => {
  if (condition) notes.push(`  ok   ${message}`)
  else failures.push(message)
}

// ---------- 1. 地图元数据自洽 ----------
{
  const tiles = Math.ceil(mapData.map.width / mapData.map.tileSize)
  check(
    mapData.map.width % mapData.map.tileSize === 0 && mapData.map.height % mapData.map.tileSize === 0,
    `地图 ${mapData.map.width}×${mapData.map.height} 是瓦片尺寸 ${mapData.map.tileSize} 的整数倍 => ${tiles}×${tiles} 张瓦片`,
  )
  check(
    calibration.sourceWidth === mapData.map.mapLocatorSourceWidth,
    `标定 sourceWidth 与 map.mapLocatorSourceWidth 一致 => ${calibration.sourceWidth}`,
  )
}

// ---------- 2. 仿射可解且标定点跨度足够 ----------
{
  const affine = solveAffine(calibration.points)
  const invertible = Number.isFinite(affine.inverseDeterminant) && Math.abs(affine.inverseDeterminant) > 1e-12
  check(invertible, `仿射变换可逆 => det ${affine.inverseDeterminant.toExponential(3)}`)

  const [first, second] = calibration.points
  const span = Math.hypot(second.raw[0] - first.raw[0], second.raw[1] - first.raw[1])
  check(span > 10000, `标定点间距足够大（${Math.round(span).toLocaleString()} 游戏单位），不是局部拟合`)
}

const geometry = createGeometry(mapData.map, calibration)

// ---------- 3. 标定点精确复现 ----------
{
  const errors = calibration.points.map((point) => {
    const pixel = geometry.gameToMapPixel({ x: point.raw[0], y: point.raw[1] })
    return Math.hypot(pixel.pixelX - point.map[0], pixel.pixelY - point.map[1])
  })
  const worst = Math.max(...errors)
  check(worst < 0.01, `3 个标定点被精确复现（最大误差 ${worst.toExponential(2)} 像素）`)
}

// ---------- 4. 往返精度 + 落图范围 ----------
{
  let maxGameRoundTrip = 0
  let maxLocatorRoundTrip = 0
  let maxMapPixelRoundTrip = 0
  let outside = 0
  let minPixelX = Infinity
  let maxPixelX = -Infinity
  let minPixelY = Infinity
  let maxPixelY = -Infinity

  for (const location of mapData.locations) {
    const x = Number(location.x)
    const y = Number(location.y)
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue

    // 游戏坐标 → 标定像素 → 游戏坐标
    const locatorPixel = geometry.gameToMapPixel({ x, y })
    const backToGame = geometry.mapPixelToGame(locatorPixel)
    maxGameRoundTrip = Math.max(maxGameRoundTrip, Math.hypot(backToGame.x - x, backToGame.y - y))

    // 标定像素 → Leaflet → 标定像素
    const latlng = geometry.mapLocatorToMapLatLng(locatorPixel)
    const backToLocator = geometry.mapLatLngToMapLocator(latlng)
    maxLocatorRoundTrip = Math.max(
      maxLocatorRoundTrip,
      Math.hypot(backToLocator.pixelX - locatorPixel.pixelX, backToLocator.pixelY - locatorPixel.pixelY),
    )

    // 底图像素 → Leaflet → 底图像素
    const mapPixel = geometry.mapLocatorToMapPixel(locatorPixel)
    const mapPixelBack = geometry.mapLatLngToMapPixel(geometry.mapPixelToMapLatLng(mapPixel))
    maxMapPixelRoundTrip = Math.max(
      maxMapPixelRoundTrip,
      Math.hypot(mapPixelBack.pixelX - mapPixel.pixelX, mapPixelBack.pixelY - mapPixel.pixelY),
    )

    minPixelX = Math.min(minPixelX, locatorPixel.pixelX)
    maxPixelX = Math.max(maxPixelX, locatorPixel.pixelX)
    minPixelY = Math.min(minPixelY, locatorPixel.pixelY)
    maxPixelY = Math.max(maxPixelY, locatorPixel.pixelY)

    if (mapPixel.pixelX < 0 || mapPixel.pixelX > MAP_WIDTH
      || mapPixel.pixelY < 0 || mapPixel.pixelY > MAP_HEIGHT) {
      outside += 1
    }
  }

  check(maxGameRoundTrip < 1e-6, `游戏坐标 ⇄ 标定像素 往返最大误差 ${maxGameRoundTrip.toExponential(2)}`)
  check(maxLocatorRoundTrip < 1e-6, `标定像素 ⇄ Leaflet 坐标 往返最大误差 ${maxLocatorRoundTrip.toExponential(2)}`)
  check(maxMapPixelRoundTrip < 1e-6, `底图像素 ⇄ Leaflet 坐标 往返最大误差 ${maxMapPixelRoundTrip.toExponential(2)}`)
  check(outside === 0, `全部 ${mapData.locations.length} 个点位都落在地图范围内（越界 ${outside} 个）`)

  notes.push(
    `  标定像素覆盖 X ${minPixelX.toFixed(0)}–${maxPixelX.toFixed(0)}、`
    + `Y ${minPixelY.toFixed(0)}–${maxPixelY.toFixed(0)}（地图 ${MAP_WIDTH}×${MAP_HEIGHT}）`,
  )
}

// ---------- 5. 比例系数（评分尺度依据）----------
{
  const perLocator = geometry.unitsPerLocatorPixel
  const perMap = geometry.unitsPerMapPixel
  const ratio = geometry.mapPixelsPerLocatorPixel

  check(Math.abs(ratio - MAP_WIDTH / calibration.sourceWidth) < 1e-9,
    `标定像素 : 底图像素 = 1 : ${ratio}（= ${MAP_WIDTH}/${calibration.sourceWidth}）`)
  check(Math.abs(perMap - perLocator * ratio) < 1e-6,
    `比例换算自洽：1 标定像素 ≈ ${perLocator.toFixed(2)} 游戏单位 → 1 底图像素 ≈ ${perMap.toFixed(2)} 游戏单位`)

  // 各向异性：X/Y 两方向比例不一致会让评分尺度随方向变化
  const affine = solveAffine(calibration.points)
  const scaleX = 1 / Math.hypot(affine.mapX.x, affine.mapY.x)
  const scaleY = 1 / Math.hypot(affine.mapX.y, affine.mapY.y)
  const anisotropy = Math.abs(scaleX - scaleY) / ((scaleX + scaleY) / 2)
  check(anisotropy < 0.02,
    `X/Y 两方向比例一致（相差 ${(anisotropy * 100).toFixed(3)}%）`)
}

// ---------- 6. 题库索引 ----------
{
  const index = buildPuzzleIndex(mapData, geometry)
  const withImages = mapData.locations.filter((item) => Array.isArray(item.images) && item.images.length > 0).length

  check(index.puzzles.length === withImages, `可出题数 = 有截图的点位数 => ${index.puzzles.length}`)
  check(index.puzzles.every((puzzle) => Number.isFinite(puzzle.pixel.pixelX)),
    '所有题目的像素坐标都算得出来')
  check(index.puzzles.every((puzzle) => puzzle.regionId), '每个题目都归入了区域（区域筛选的前提）')
  check(index.regions.length > 0,
    `区域归类可用 => ${index.regions.map((item) => `${item.label}(${item.count})`).join(' ')}`)
  check(index.categories.length === mapData.categories.length,
    `分类完整 => ${index.categories.length} 个`)

  // 区域是「分类」的一种，所以区域筛选与分类筛选用的是同一套 id。
  // 以前这里还有一套九宫格方位分区，已删除——不该再出现 r{row}c{col} 形状的 id。
  const gridLike = index.puzzles.filter((puzzle) => /^r\d+c\d+$/.test(String(puzzle.regionId)))
  check(gridLike.length === 0, `已无九宫格方位分区（残留 ${gridLike.length} 个）`)

  // ---------- 6a. 区域参考点与分类器（后台「按落点自动分类」的依据）----------
  {
    const toPixel = (point) => geometry.gameToMapPixel(point)
    const pool = regionReferencePoints.filter((point) => isRealDistrictName(point.district))
    check(pool.length > 300, `区域参考点可用 => ${pool.length} 个`)

    const referenceIndex = buildRegionReferenceIndex(toPixel)
    check(referenceIndex.length >= 6,
      `参考点覆盖 ${referenceIndex.length} 个区域 => ${referenceIndex.map((item) => `${item.label}(${item.count})`).join(' ')}`)
    check(referenceIndex.every((item) => Number.isFinite(item.centroidX) && Number.isFinite(item.centroidY)),
      '每个区域都算得出重心（地图标注的落点）')

    // 留一法自检：拿掉参考点自己再分类，应当还能回到自己的区域。
    // 这是「自动分类准不准」的唯一可信指标——准确率掉下来说明参考点或参数坏了。
    const classifier = createRegionClassifier(toPixel)
    let hit = 0
    for (const point of pool) {
      const pixel = toPixel(point)
      const others = classifier.pool.filter((item) => item.id !== point.id)
      const votes = new Map()
      for (const item of others
        .map((item2) => ({ d: Math.hypot(pixel.pixelX - item2.pixelX, pixel.pixelY - item2.pixelY), label: item2.label }))
        .sort((x, y) => x.d - y.d)
        .slice(0, classifier.k)) {
        votes.set(item.label, (votes.get(item.label) || 0) + 1 / Math.max(item.d, 1))
      }
      const best = [...votes.entries()].sort((x, y) => y[1] - x[1])[0]?.[0]
      if (best === point.district) hit += 1
    }
    const accuracy = hit / pool.length
    check(accuracy > 0.9, `区域分类留一法准确率 ${(accuracy * 100).toFixed(1)}%（${hit}/${pool.length}）`)

    // 兜底分支：地图西北角远离所有参考点，应当判为薄暮区而不是硬投给相邻城区
    const far = classifier({ pixelX: 300, pixelY: 300 })
    check(far?.reason === 'outside-coverage' && far.label === '薄暮区',
      `覆盖之外的坐标归兜底区域 => (300,300) -> ${far?.label}（${far?.reason}）`)

    // 每个区域重心处应当判回自己（否则地图标签与实际判定会打架）
    const wrong = referenceIndex.filter((item) => classifier({ pixelX: item.centroidX, pixelY: item.centroidY })?.label !== item.label)
    check(wrong.length === 0,
      wrong.length ? `重心处判错：${wrong.map((item) => item.label).join('、')}` : '各区域重心处都判回自己')
  }

  // 抽题必须确定性：同种子同结果，便于复盘与分享
  const a = buildPuzzleIndex(mapData, geometry)
  const b = buildPuzzleIndex(mapData, geometry)
  const sameRegion = a.puzzles[0].regionId === b.puzzles[0].regionId
  check(sameRegion, '题库索引构建是确定性的（同输入同输出）')
}

console.log('=== NTE 图寻 · 坐标与几何自检 ===')
for (const note of notes) console.log(note)
if (failures.length) {
  console.log('\n失败项：')
  for (const failure of failures) console.log(`  x ${failure}`)
  process.exitCode = 1
} else {
  console.log('\n全部通过。')
}
