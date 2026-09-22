// 后台的区域判定：既用于地图上的区域名标记，也用于「按答案位置自动选分类」。
//
// 早期版本是从「题库点位」算各区域重心再取最近的一个。那个做法现在必然失效：
// 6 个区域分类的点位在数据整理中被删掉了，题库里只剩「未标注」和「薄暮区」，
// 于是只能算出两个区域，永远推不出米格尔区之类。
//
// 现在改用 packages/shared/data/region-reference.json 里的 400 个带真实区域名的
// 参考点做 kNN 分类（留一法准确率 96.8%），这也是 scripts/classify-regions.mjs
// 给题库做批量归类时用的同一套算法 —— 后台拾取和批量归类因此不会互相打架。
import {
  buildRegionReferenceIndex,
  createRegionClassifier,
} from '@nte-geoguess/shared/regionClassify'

// geometry: createGeometry(...) 的返回值
export function createRegionResolver(geometry) {
  if (!geometry?.gameToMapPixel) return () => null

  const toPixel = (point) => geometry.gameToMapPixel(point)
  const classifier = createRegionClassifier(toPixel)
  const index = buildRegionReferenceIndex(toPixel)
  const indexByLabel = new Map(index.map((entry) => [entry.label, entry]))

  // point: 游戏坐标 { x, y }；location: 可选，点位自带的 region / district 可以直接采信
  return function resolveRegion(point, location = null) {
    if (!point || !Number.isFinite(Number(point.x)) || !Number.isFinite(Number(point.y))) return null

    // 点位已经写明归属（后台上传时人工选过，或批量归类写过 region 字段）时直接采信
    const declared = String(location?.region || '').trim()
    if (declared && indexByLabel.has(declared)) {
      const entry = indexByLabel.get(declared)
      return {
        label: declared,
        reason: 'declared',
        confidence: 1,
        nearestDistance: 0,
        referenceCount: entry.count,
      }
    }

    const pixel = toPixel(point)
    const result = classifier(pixel)
    if (!result) return null

    const entry = indexByLabel.get(result.label)
    return {
      label: result.label,
      reason: result.reason,
      confidence: result.confidence,
      nearestDistance: result.nearestDistance,
      // 该区域有多少参考点；薄暮区是兜底区域，没有参考点
      referenceCount: entry?.count || 0,
      votedLabel: result.votedLabel || null,
      // 落在参考点覆盖之外（地图西北那块飞地）时，投票结果会投给相邻城区，
      // 这个标志让界面能说清楚「为什么判成了薄暮区」
      outsideCoverage: result.reason === 'outside-coverage',
    }
  }
}

// 各区域的重心，用于在地图上摆区域名标签。
// 薄暮区没有参考点（它是「覆盖之外」的兜底），所以传进来的 supplement 可以补上它。
export function regionLabelPoints(geometry, supplement = []) {
  if (!geometry?.gameToMapPixel) return []
  const toPixel = (point) => geometry.gameToMapPixel(point)

  const points = buildRegionReferenceIndex(toPixel).map((entry) => ({
    id: entry.label,
    label: entry.label,
    pixelX: entry.centroidX,
    pixelY: entry.centroidY,
    referenceCount: entry.count,
  }))

  const known = new Set(points.map((point) => point.label))
  for (const extra of supplement) {
    if (!extra?.label || known.has(extra.label)) continue
    points.push({
      id: extra.id || extra.label,
      label: extra.label,
      pixelX: Number(extra.x ?? extra.pixelX),
      pixelY: Number(extra.y ?? extra.pixelY),
      referenceCount: 0,
    })
  }

  return points.filter((point) => Number.isFinite(point.pixelX) && Number.isFinite(point.pixelY))
}
