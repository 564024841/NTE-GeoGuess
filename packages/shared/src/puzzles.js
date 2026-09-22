// 题库索引构建、区域归类与抽题。
//
// 数据来源（两套，形状一致）：
//   · 线上：后端 /api/bootstrap 返回 { map, categories, locations, tileUrl }
//   · 本地/自检：packages/shared/data/map-data.json 快照（见 seed.js）
//
// 题目 = 一张截图 + 该截图对应的游戏真实坐标。
// 注意：地图数据里 1600+ 点位只有一部分带截图，抽题只在「有截图且坐标合法」的点位里进行。
//
// 区域归属由「区域分类」表达（向阳岛 / 米格尔区 / 薄暮区 …）：
// 以前这里还有一套按坐标算的九宫格方位分区（北西/中中…），已删除——
// 方位不是游戏里的真实区域，游戏侧的区域筛选改用分类本身。
// 每个题目的区域信息：
//   regionId    区域分类 id（没有区域分类时回退到自建/未标注）
//   regionLabel 区域名，直接取自分类的 label
//
// 坐标换算由调用方注入 geometry（见 geometry.js 的 createGeometry），
// 本模块不加载地图数据。

import {
  CUSTOM_REGION_LABEL,
  DISTRICT_PLACEHOLDER,
  REGION_CATEGORY_GROUP,
  REGION_NAME_BY_CATEGORY_ID,
  SOURCE_MAP_DATA,
  SOURCE_QUESTION_BANK,
} from './constants.js'

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

// 这个分类算不算「区域分类」：看 group，或看 id 是否在我们的区域 id 表里
function isRegionCategory(category) {
  if (!category) return false
  if (category.group === REGION_CATEGORY_GROUP) return true
  return Boolean(REGION_NAME_BY_CATEGORY_ID[category.id])
}

// mapData: { categories?, locations? }
// geometry: createGeometry(...) 的返回值
export function buildPuzzleIndex(mapData = {}, geometry) {
  if (!geometry?.gameToMapPixel) throw new Error('buildPuzzleIndex 需要 geometry')
  const categories = Array.isArray(mapData.categories) ? mapData.categories : []
  const locations = Array.isArray(mapData.locations) ? mapData.locations : []

  // 每个分类下的点位数量（不论有没有截图）——UI 用它解释「为什么这个分类出不了题」
  const locationCountByCategory = new Map()

  // 服务端（或快照）可能已经带了 count，先合并进来，后面按实际点位累加覆盖
  const categoriesWithCounts = categories.map((category) => ({
    ...category,
    count: Number(category.count) || 0,
  }))
  const categoriesById = new Map(categoriesWithCounts.map((category) => [category.id, category]))

  const allLocations = []
  const puzzles = []
  // 记录「有截图的点位」落在哪些分类上，用于区分「能出题」与「仅有点位」
  const puzzleCategoryIds = new Set()

  for (const location of locations) {
    const x = Number(location.x)
    const y = Number(location.y)
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue

    const district = normalizeString(location.district)
    const types = Array.isArray(location.types)
      ? location.types.filter((id) => categoriesById.has(id))
      : []
    for (const type of types) {
      locationCountByCategory.set(type, (locationCountByCategory.get(type) || 0) + 1)
    }
    const images = Array.isArray(location.images) ? location.images.filter(Boolean) : []
    const record = {
      id: location.id,
      name: normalizeString(location.name) || location.id,
      district,
      types,
      images,
      x,
      y,
      source: location.source === SOURCE_QUESTION_BANK ? SOURCE_QUESTION_BANK : SOURCE_MAP_DATA,
    }
    allLocations.push(record)

    if (!images.length) continue
    for (const type of types) puzzleCategoryIds.add(type)
    puzzles.push({
      ...record,
      categoryIds: types,
      primaryCategoryId: types[0] || null,
      pixel: geometry.gameToMapPixel(record),
    })
  }

  // 区域归属：优先看点位自己的分类是不是区域分类（这是数据里的权威来源），
  // 其次用显式的 region 字段，最后回退到自建/未标注。
  // 不再有九宫格方位分区。
  for (const puzzle of puzzles) {
    const regionCategory = puzzle.categoryIds
      .map((id) => categoriesById.get(id))
      .find((category) => isRegionCategory(category))

    if (regionCategory) {
      puzzle.regionId = regionCategory.id
      puzzle.regionLabel = regionCategory.label
      continue
    }

    const explicit = normalizeString(puzzle.region)
    if (explicit && explicit !== DISTRICT_PLACEHOLDER) {
      puzzle.regionId = explicit
      puzzle.regionLabel = explicit
      continue
    }

    // 自建题（没有区域分类）用区域下拉里填的值，没填就归「自建题目」
    if (puzzle.source === SOURCE_QUESTION_BANK) {
      puzzle.regionId = puzzle.district ? `district:${puzzle.district}` : `district:${CUSTOM_REGION_LABEL}`
      puzzle.regionLabel = puzzle.district || CUSTOM_REGION_LABEL
      continue
    }

    puzzle.regionId = 'unlabeled'
    puzzle.regionLabel = '未标注'
  }

  // 区域清单 = 有题的区域分类（设置面板的过滤器用），加上自建题目
  const regionCounts = new Map()
  for (const puzzle of puzzles) {
    regionCounts.set(puzzle.regionId, (regionCounts.get(puzzle.regionId) || 0) + 1)
  }
  const regions = [...regionCounts.entries()].map(([id, count]) => {
    const category = categoriesById.get(id)
    return {
      id,
      label: category?.label || puzzles.find((puzzle) => puzzle.regionId === id)?.regionLabel || id,
      count,
      color: category?.color || null,
      isCustom: !category,
    }
  }).sort((a, b) => b.count - a.count)

  const customCount = puzzles.filter((puzzle) => puzzle.source === SOURCE_QUESTION_BANK).length

  // 分类的 count 优先用传入值（服务端是按全量库统计的，最准）；
  // 只有调用方没给 count 时（例如直接用本地快照构建）才用本地累加兜底。
  // 注意不能无条件覆盖：mapData.locations 可能只含「有截图的」点位，
  // 用它算出来的计数会把区域分类的 0 变成「没数据」。
  for (const category of categoriesWithCounts) {
    if (!category.count) {
      category.count = locationCountByCategory.get(category.id) || 0
    }
  }

  const categoryIdsInOrder = categoriesWithCounts
    .filter((category) => !category.isHidden)
    .map((category) => category.id)

  // 真实点位总数。注意 mapData.locations 可能只包含「有截图的」点位
  // （/api/bootstrap 默认如此），此时 allLocations.length 会偏小；
  // 而每个分类的 count 是服务端按全量库统计的，所以用分类计数求和更准。
  const categoryTotal = categoriesWithCounts
    .reduce((sum, category) => sum + (Number(category.count) || 0), 0)
  const locationCount = Math.max(allLocations.length, categoryTotal)

  return {
    allLocations,
    locationCount,
    puzzles,
    categories: categoriesWithCounts,
    categoriesById,
    // 全部可见分类：筛选面板要列出所有分类，即使某个分类下的点位暂时都没有截图。
    // （曾经这里只列「有截图的分类」，导致按区域建好的分类因为点位没图而整个消失。）
    puzzleCategoryIds: categoryIdsInOrder,
    // 有题可出的分类，用于提示「这个分类现在出不了题」
    categoriesWithPuzzles: [...puzzleCategoryIds],
    // 每个分类的点位数量
    locationCountByCategory,
    regions,
    customPuzzleCount: customCount,
  }
}

// 分类分组（设置面板与后台的分组展示用）
// 传入 categoriesWithPuzzles 时，只保留真正能出题的分组——游戏侧用这个，
// 避免列出「点了却没有题」的分类；后台侧传全部，以便维护数据。
export function groupPuzzleCategories(index, { onlyWithPuzzles = false } = {}) {
  const usable = onlyWithPuzzles
    ? new Set(index.categoriesWithPuzzles || [])
    : null

  const groups = new Map()
  for (const id of index.puzzleCategoryIds) {
    if (usable && !usable.has(id)) continue
    const category = index.categoriesById.get(id)
    if (!category) continue
    const group = category.group || '其他'
    if (!groups.has(group)) groups.set(group, [])
    groups.get(group).push(category)
  }
  return [...groups.entries()].map(([group, items]) => ({ group, items }))
}

// 确定性伪随机：同一个种子永远抽出同一套题，便于复盘与分享
function createRandom(seed) {
  let state = seed >>> 0
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function shuffle(items, random) {
  const result = [...items]
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1))
    ;[result[i], result[j]] = [result[j], result[i]]
  }
  return result
}

export function createSeed() {
  return Math.floor(Math.random() * 0xffffffff) >>> 0
}

// 抽题筛选。区域不再单独筛（九宫格已删除）——
// 区域本身就是分类，所以「按区域出题」直接用 categoryIds 就够，
// 不需要两套并行的筛选维度。
export function filterPuzzles(index, settings) {
  const { categoryIds = [] } = settings || {}
  const categoryFilter = new Set(categoryIds)

  return index.puzzles.filter((puzzle) => {
    if (categoryFilter.size && !puzzle.categoryIds.some((id) => categoryFilter.has(id))) return false
    return true
  })
}

export function selectRounds(index, settings) {
  const { count = 5, seed = 0 } = settings || {}
  const candidates = filterPuzzles(index, settings)
  const random = createRandom(seed)
  return shuffle(candidates, random).slice(0, Math.max(0, count))
}

export function countCandidates(index, settings) {
  return filterPuzzles(index, settings).length
}
