// 按坐标推断区域归属。
//
// 为什么需要它：476 道内置题的 `district` 全是占位值「全地图」，游戏里也没有可用的区域边界几何。
// 好在 MaaNTE-Map 里有 400 个点位带真实区域名（谕石/赠礼/异象/打卡/支线，见
// `data/region-reference.json`），它们把六块城区圈得比较干净 —— 于是用它们当参照点做 kNN 投票：
//
//   1. 取离目标点最近的 k（默认 7）个参照点，按 1/距离 加权投票，票数最高的区域胜出；
//   2. 离最近参照点超过 maxDistance（默认 1000 标定像素）的点，说明落在参照点覆盖之外
//      （地图西北那块飞地），归「薄暮区」—— 那边一个探索点都没有，硬投票只会投给相邻城区；
//   3. 参照点自检（留一法）约 96.8%：拿掉参照点自己再投票，387/400 能回到自己的区域。
//
// 用途：
//   · 后台出题时，按答案落点自动定区域（apps/admin）
//   · scripts/classify-regions.mjs 给整库归类（同一套规则，避免两处实现漂移）
//
// 注意：这是「按坐标推断」，不是权威边界；游戏里真正的区域划分以游戏内为准。

import referenceData from '../data/region-reference.json'

export const REGION_REFERENCE = referenceData

export const REGION_INFERENCE_DEFAULTS = {
  k: 7,
  /** 覆盖半径，单位是标定像素（整图宽 13056） */
  maxDistance: 1000,
  /** 参照点覆盖之外归到这个区域 */
  outsideLabel: '薄暮区',
}

function distance(ax, ay, bx, by) {
  return Math.hypot(ax - bx, ay - by)
}

// geometry: createGeometry(mapConfig, calibration) 的返回值
// reference: 默认用内置的 400 个参照点，测试或换数据时可以传别的
export function createRegionInference({
  geometry,
  reference = referenceData,
  k = REGION_INFERENCE_DEFAULTS.k,
  maxDistance = REGION_INFERENCE_DEFAULTS.maxDistance,
  outsideLabel = REGION_INFERENCE_DEFAULTS.outsideLabel,
} = {}) {
  if (!geometry?.gameToMapPixel) throw new Error('createRegionInference 需要 geometry')

  const points = (reference?.points || []).map((point) => {
    const pixel = geometry.gameToMapPixel({ x: point.x, y: point.y })
    return { id: point.id, label: point.district, pixelX: pixel.pixelX, pixelY: pixel.pixelY }
  })
  if (!points.length) throw new Error('createRegionInference 需要至少一个参照点')

  const labels = reference?.regions?.length
    ? [...reference.regions]
    : [...new Set(points.map((point) => point.label))]

  // 反距离加权投票。pool 允许剔除自身（留一法自检用）
  function vote(pixelX, pixelY, pool) {
    const nearest = pool
      .map((point) => ({ d: distance(pixelX, pixelY, point.pixelX, point.pixelY), label: point.label }))
      .sort((a, b) => a.d - b.d)
      .slice(0, k)

    const weightByLabel = new Map()
    for (const item of nearest) {
      weightByLabel.set(item.label, (weightByLabel.get(item.label) || 0) + 1 / Math.max(item.d, 1))
    }
    const total = [...weightByLabel.values()].reduce((sum, value) => sum + value, 0)
    const [label, weight] = [...weightByLabel.entries()].sort((a, b) => b[1] - a[1])[0]
    return { label, confidence: weight / total, nearestDistance: nearest[0]?.d ?? Infinity }
  }

  // point: 游戏真实坐标 { x, y }
  // 返回 { label, confidence, nearestDistance, outside, source }
  //   source = 'knn'（投票得出）| 'coverage'（参照点覆盖之外）
  function infer(point) {
    const x = Number(point?.x)
    const y = Number(point?.y)
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null

    const pixel = geometry.gameToMapPixel({ x, y })
    const result = vote(pixel.pixelX, pixel.pixelY, points)
    if (result.nearestDistance > maxDistance) {
      return { ...result, label: outsideLabel, source: 'coverage', outside: true }
    }
    return { ...result, source: 'knn', outside: false }
  }

  // 参照点留一法自检：准确率与逐点结果，脚本/自查用它交代「这套推断有多可信」
  function crossValidate() {
    const misses = []
    let hit = 0
    for (let index = 0; index < points.length; index += 1) {
      const self = points[index]
      const pool = points.filter((_, other) => other !== index)
      const result = vote(self.pixelX, self.pixelY, pool)
      if (result.label === self.label) hit += 1
      else misses.push({ id: self.id, expected: self.label, got: result.label })
    }
    return { total: points.length, hit, accuracy: hit / points.length, misses }
  }

  return {
    k,
    maxDistance,
    outsideLabel,
    labels,
    referenceCount: points.length,
    infer,
    crossValidate,
    inferLabel: (point) => infer(point)?.label ?? null,
  }
}
