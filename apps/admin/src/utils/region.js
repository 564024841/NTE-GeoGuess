// 后台出题时的「参考区域」。
//
// 以前这里复算过九宫格（北西/中中…），现在区域只有一种表达：区域分类
// （向阳岛 / 米格尔区 / 薄暮区 / 未标注 …）。所以这个模块改成
// 「离你点的位置最近的已标注区域」——它只是一个提示，不是权威归属，
// 因为区域边界是游戏设定，数据里并没有边界几何。
//
// 想给出有意义的最近区域，就要有参照点。这里用各区域已有点位的重心，
// 同时把距离一起返回，让界面能如实说明这个提示有多可信。

function distance(a, b) {
  return Math.hypot(a.pixelX - b.pixelX, a.pixelY - b.pixelY)
}

// index 是 buildPuzzleIndex 的返回值
export function createRegionResolver(index) {
  const puzzles = index?.puzzles || []
  if (!puzzles.length) return () => null

  // 各区域的重心与范围（用像素坐标，与 index 内部同一套）
  const stats = new Map()
  for (const puzzle of puzzles) {
    const id = puzzle.regionId
    if (!id) continue
    if (!stats.has(id)) {
      stats.set(id, {
        id,
        label: puzzle.regionLabel || id,
        count: 0,
        sumX: 0,
        sumY: 0,
        minX: Number.POSITIVE_INFINITY,
        maxX: Number.NEGATIVE_INFINITY,
        minY: Number.POSITIVE_INFINITY,
        maxY: Number.NEGATIVE_INFINITY,
      })
    }
    const entry = stats.get(id)
    entry.count += 1
    entry.sumX += puzzle.pixel.pixelX
    entry.sumY += puzzle.pixel.pixelY
    entry.minX = Math.min(entry.minX, puzzle.pixel.pixelX)
    entry.maxX = Math.max(entry.maxX, puzzle.pixel.pixelX)
    entry.minY = Math.min(entry.minY, puzzle.pixel.pixelY)
    entry.maxY = Math.max(entry.maxY, puzzle.pixel.pixelY)
  }

  const regions = [...stats.values()].map((entry) => ({
    ...entry,
    centroidX: entry.sumX / entry.count,
    centroidY: entry.sumY / entry.count,
  }))

  // pixel: { pixelX, pixelY }（标定像素）
  return function resolveRegion(pixel) {
    if (!pixel || !Number.isFinite(pixel.pixelX) || !Number.isFinite(pixel.pixelY)) return null
    if (!regions.length) return null

    let best = null
    for (const region of regions) {
      const d = distance(pixel, { pixelX: region.centroidX, pixelY: region.centroidY })
      if (!best || d < best.distance) best = { region, distance: d }
    }

    // 是否落在该区域已有点位的包围盒里——落在里面说明这个提示比较可信
    const inside = pixel.pixelX >= best.region.minX && pixel.pixelX <= best.region.maxX
      && pixel.pixelY >= best.region.minY && pixel.pixelY <= best.region.maxY

    return {
      id: best.region.id,
      label: best.region.label,
      count: best.region.count,
      // 到该区域重心的距离（单位：标定像素）
      distance: Math.round(best.distance),
      inside,
    }
  }
}
