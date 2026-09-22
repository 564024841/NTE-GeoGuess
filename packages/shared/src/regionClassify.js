// 按坐标判断点位属于哪个区域。
//
// 为什么需要参考点：区域边界是游戏设定，数据里没有任何边界几何（上游也没有多边形），
// 所以「这个点属于哪个区」只能靠已知归属的点位来推断。上游 MaaNTE-Map 里有 400 个
// 带真实区域名的点位（谕石/赠礼/异象/打卡/支线，见 data/region-reference.json），
// 它们把六块城区圈得比较干净——拿它们当参考点做 kNN 反距离加权投票，就能给任意
// 坐标判区域。留一法自检准确率 96.8%（用 scripts/classify-regions.mjs --cv 复现）。
//
// 三种判据，按可信度从高到低：
//   1. 点自带真实区域名（district 不是占位值「全地图」）——直接采信
//   2. kNN 投票（默认 k=7）——给出置信度与最近参考点距离，交界处置信度会明显降低
//   3. 离最近参考点超过覆盖半径——说明落在参考点覆盖之外（地图西北那块），归薄暮区
//
// 注意：这是「推断」不是「权威」。后台用它给分类预选值，但允许人工改；
// 置信度低或落在覆盖外时会明确标出来，让使用者知道该复核。
import reference from '../data/region-reference.json'

export const REGION_REFERENCE_POINTS = reference.points

// 默认参数（与 scripts/classify-regions.mjs 保持一致，改这里也要改那边或改成共用）
export const REGION_KNN_K = 7
export const REGION_MAX_DIST = 1000

const PLACEHOLDER_DISTRICT = '全地图'

// district → 是否是真实区域名（占位值不算）
export function isRealDistrictName(district) {
  const value = String(district || '').trim()
  return Boolean(value) && value !== PLACEHOLDER_DISTRICT
}

// 用参考点算每个区域的重心与范围（像素坐标）。
// toPixel: (gamePoint) => { pixelX, pixelY }，由调用方注入 geometry 后提供——
// 这样本模块不必知道坐标换算规则，也不必加载地图数据。
export function buildRegionReferenceIndex(toPixel) {
  const stats = new Map()
  for (const point of REGION_REFERENCE_POINTS) {
    const label = point.district
    if (!isRealDistrictName(label)) continue
    const pixel = toPixel(point)
    if (!Number.isFinite(pixel?.pixelX) || !Number.isFinite(pixel?.pixelY)) continue

    if (!stats.has(label)) {
      stats.set(label, {
        label,
        count: 0,
        sumX: 0,
        sumY: 0,
        minX: Number.POSITIVE_INFINITY,
        maxX: Number.NEGATIVE_INFINITY,
        minY: Number.POSITIVE_INFINITY,
        maxY: Number.NEGATIVE_INFINITY,
      })
    }
    const entry = stats.get(label)
    entry.count += 1
    entry.sumX += pixel.pixelX
    entry.sumY += pixel.pixelY
    entry.minX = Math.min(entry.minX, pixel.pixelX)
    entry.maxX = Math.max(entry.maxX, pixel.pixelX)
    entry.minY = Math.min(entry.minY, pixel.pixelY)
    entry.maxY = Math.max(entry.maxY, pixel.pixelY)
  }

  return [...stats.values()].map((entry) => ({
    label: entry.label,
    count: entry.count,
    centroidX: entry.sumX / entry.count,
    centroidY: entry.sumY / entry.count,
    minX: entry.minX,
    maxX: entry.maxX,
    minY: entry.minY,
    maxY: entry.maxY,
  }))
}

// 建一个分类器。toPixel 同 buildRegionReferenceIndex。
// 返回的函数吃 { pixelX, pixelY }，给出 { label, reason, confidence, nearestDistance }。
export function createRegionClassifier(toPixel, options = {}) {
  const k = Number(options.k) > 0 ? Number(options.k) : REGION_KNN_K
  const maxDistance = Number(options.maxDistance) > 0 ? Number(options.maxDistance) : REGION_MAX_DIST
  const fallbackLabel = options.fallbackLabel || '薄暮区'

  const pool = []
  for (const point of REGION_REFERENCE_POINTS) {
    const label = point.district
    if (!isRealDistrictName(label)) continue
    const pixel = toPixel(point)
    if (!Number.isFinite(pixel?.pixelX) || !Number.isFinite(pixel?.pixelY)) continue
    pool.push({ pixelX: pixel.pixelX, pixelY: pixel.pixelY, label, id: point.id })
  }

  if (!pool.length) return () => null

  function classify(pixel) {
    if (!pixel || !Number.isFinite(pixel.pixelX) || !Number.isFinite(pixel.pixelY)) return null

    const nearest = pool
      .map((point) => ({
        distance: Math.hypot(pixel.pixelX - point.pixelX, pixel.pixelY - point.pixelY),
        label: point.label,
        id: point.id,
      }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, k)

    const weightByLabel = new Map()
    for (const item of nearest) {
      // 1/距离 加权；距离为 0 时用 1 兜底，避免除零
      const weight = 1 / Math.max(item.distance, 1)
      weightByLabel.set(item.label, (weightByLabel.get(item.label) || 0) + weight)
    }
    const total = [...weightByLabel.values()].reduce((sum, value) => sum + value, 0)
    const [label, weight] = [...weightByLabel.entries()].sort((a, b) => b[1] - a[1])[0]
    const nearestDistance = nearest[0]?.distance ?? Number.POSITIVE_INFINITY

    if (nearestDistance > maxDistance) {
      // 参考点覆盖之外：硬投只会投给相邻城区，所以明确归到 fallback（薄暮区）
      return {
        label: fallbackLabel,
        reason: 'outside-coverage',
        confidence: 0,
        nearestDistance: Math.round(nearestDistance),
        // 投票本来会给出什么，留着便于人工判断
        votedLabel: label,
      }
    }

    return {
      label,
      reason: 'knn',
      confidence: total > 0 ? weight / total : 0,
      nearestDistance: Math.round(nearestDistance),
      nearestId: nearest[0]?.id || null,
    }
  }

  classify.pool = pool
  classify.k = k
  classify.maxDistance = maxDistance
  return classify
}
