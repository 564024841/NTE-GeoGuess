// 地图几何与坐标换算（纯函数版）。
//
// 这是整个项目最关键、也最容易出错的部分，提取自 MaaNTE-Map：
//
//     游戏真实坐标 ⇄ MapLocator 标定像素 ⇄ Leaflet CRS.Simple 坐标
//
// 由 3 个标定点解 2×2 仿射变换。仿射同时承担平移、缩放、轻微旋转与剪切，
// 所以游戏坐标与地图像素不是简单等比关系。
//
// 这里刻意不 import 地图数据 JSON：地图数据有 700KB，
// 一旦被 import 就会被打进每个引用本模块的产物（连 scoring 都会变成 800KB）。
// 需要地图元数据时用 createGeometry(mapConfig, calibration) 显式构造。

import { applyAffine, computeScale, invertAffine, solveAffine } from './affine.js'

export { solveAffine, applyAffine, invertAffine }

export const DEFAULT_LOCATOR_SIZE = 13056

// 构造一套绑定具体标定的坐标换算函数。
// mapConfig: { width, height, tileSize, mapLocatorSourceWidth?, mapLocatorSourceHeight? }
// calibration: { coordinateFrame?, sourceWidth, sourceHeight, points: [{ raw, map }] }
export function createGeometry(mapConfig, calibration) {
  if (!mapConfig || !Number.isFinite(Number(mapConfig.width)) || !Number.isFinite(Number(mapConfig.height))) {
    throw new Error('createGeometry 需要合法的 mapConfig.width / mapConfig.height')
  }
  if (!calibration?.points) throw new Error('createGeometry 需要坐标标定数据')

  const mapWidth = Number(mapConfig.width)
  const mapHeight = Number(mapConfig.height)
  const tileSize = Number(mapConfig.tileSize) || 512
  const locatorWidth = Number(calibration.sourceWidth)
    || Number(mapConfig.mapLocatorSourceWidth)
    || DEFAULT_LOCATOR_SIZE
  const locatorHeight = Number(calibration.sourceHeight)
    || Number(mapConfig.mapLocatorSourceHeight)
    || DEFAULT_LOCATOR_SIZE

  const frame = {
    id: calibration.coordinateFrame || 'current',
    sourceWidth: locatorWidth,
    sourceHeight: locatorHeight,
    affine: solveAffine(calibration.points),
  }

  const scale = computeScale({ calibration, mapWidth, locatorWidth })

  // 游戏真实坐标 → 标定像素
  function gameToMapPixel(point) {
    return applyAffine(frame.affine, point)
  }

  // 标定像素 → 游戏真实坐标
  function mapPixelToGame(pixel) {
    return invertAffine(frame.affine, pixel, frame)
  }

  // 底图像素 → Leaflet CRS.Simple 坐标。
  //
  // 注意这里**只做翻转，不做缩放**：入参就是底图像素（Leaflet 的像素空间）。
  // 标定像素（MapLocator，例如 13056 见方）与底图像素（例如 26112 见方）
  // 之间存在 MAP_WIDTH / sourceWidth 的缩放，那一步由调用方显式完成
  // （见 mapLocatorToMapPixel），否则「标定像素 → Leaflet → 标定像素」
  // 的往返会被缩放两次，相差整整一个比例系数。
  //
  // lat 是负的：地图覆盖 lat ∈ [-mapHeight, 0]、lng ∈ [0, mapWidth]
  function mapPixelToMapLatLng({ pixelX, pixelY }) {
    return { lat: -Number(pixelY), lng: Number(pixelX) }
  }

  // Leaflet 坐标 → 底图像素
  function mapLatLngToMapPixel({ lat, lng }) {
    return { pixelX: Number(lng), pixelY: -Number(lat) }
  }

  // 标定像素 → 底图像素（就是上面说的那一步缩放）
  function mapLocatorToMapPixel({ pixelX, pixelY, sourceWidth, sourceHeight }) {
    const inputWidth = Number(sourceWidth) > 0 ? Number(sourceWidth) : locatorWidth
    const inputHeight = Number(sourceHeight) > 0 ? Number(sourceHeight) : locatorHeight
    return {
      pixelX: Number(pixelX) * mapWidth / inputWidth,
      pixelY: Number(pixelY) * mapHeight / inputHeight,
    }
  }

  // 底图像素 → 标定像素
  function mapPixelToMapLocator({ pixelX, pixelY, sourceWidth, sourceHeight }) {
    const inputWidth = Number(sourceWidth) > 0 ? Number(sourceWidth) : mapWidth
    const inputHeight = Number(sourceHeight) > 0 ? Number(sourceHeight) : mapHeight
    return {
      pixelX: Number(pixelX) * locatorWidth / inputWidth,
      pixelY: Number(pixelY) * locatorHeight / inputHeight,
    }
  }

  // Leaflet 坐标 → 标定像素
  function mapLatLngToMapLocator(latlng) {
    return mapPixelToMapLocator(mapLatLngToMapPixel(latlng))
  }

  // 标定像素 → Leaflet 坐标
  function mapLocatorToMapLatLng(pixel) {
    return mapPixelToMapLatLng(mapLocatorToMapPixel(pixel))
  }

  // 游戏真实坐标 → Leaflet 坐标（渲染用）。
  // 转成 [lat, lng] 数组，方便直接交给 Leaflet 的 Marker / Polyline。
  function gameToMapLatLng(point) {
    const { lat, lng } = mapLocatorToMapLatLng(gameToMapPixel(point))
    return [lat, lng]
  }

  // Leaflet 坐标 → 游戏真实坐标（玩家点击落点用）
  function mapLatLngToGame(latlng) {
    return mapPixelToGame(mapLatLngToMapLocator(latlng))
  }

  // 全部底图覆盖物的包围盒
  function bounds() {
    return { minLat: -mapHeight, maxLat: 0, minLng: 0, maxLng: mapWidth }
  }

  return {
    mapWidth,
    mapHeight,
    tileSize,
    locatorWidth,
    locatorHeight,
    coordinateFrame: frame.id,
    affine: frame.affine,
    unitsPerMapPixel: scale.unitsPerMapPixel,
    unitsPerLocatorPixel: scale.unitsPerLocatorPixel,
    mapPixelsPerLocatorPixel: scale.mapPixelsPerLocatorPixel,
    gameToMapPixel,
    mapPixelToGame,
    mapPixelToMapLatLng,
    mapLatLngToMapPixel,
    mapLocatorToMapPixel,
    mapPixelToMapLocator,
    mapLatLngToMapLocator,
    mapLocatorToMapLatLng,
    gameToMapLatLng,
    mapLatLngToGame,
    bounds,
  }
}
