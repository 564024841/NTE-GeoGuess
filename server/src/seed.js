// 首次启动时把内置地图数据快照写进数据库。
//
// 用 meta.seed_version 记录是否已经 seed 过，而不是判断「表是否为空」——
// 后者会在管理员清空题库后又被数据填回来。
//
// 需要重新 seed 时删掉 data/ 目录，或设置 FORCE_SEED=1。

import fs from 'node:fs'
import { config } from './config.js'
import {
  countCategories,
  countLocations,
  db,
  isSeeded,
  markSeeded,
  upsertCategory,
  upsertLocation,
} from './db.js'
import { SOURCE_MAP_DATA } from '@nte-geoguess/shared/constants'

function readJson(file, label) {
  if (!fs.existsSync(file)) {
    throw new Error(`找不到${label}：${file}`)
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

export function seedIfNeeded(logger = console) {
  if (config.disableSeed) {
    logger.info?.('[seed] DISABLE_SEED=1，跳过内置数据导入')
    return { skipped: true }
  }
  if (isSeeded() && process.env.FORCE_SEED !== '1') {
    return { skipped: true }
  }

  const mapData = readJson(config.seedDataFile, '地图数据快照')
  const categories = Array.isArray(mapData.categories) ? mapData.categories : []
  const locations = Array.isArray(mapData.locations) ? mapData.locations : []

  // 防呆：快照可能是「占位骨架」——键都在、值全空。
  // 这种文件在仓库里很容易因为误打包/误替换而产生，而它的表现是
  // 「服务正常启动、游戏能打开，但一道题都抽不出来、地图上一个点都没有」，
  // 排查成本很高。所以这里直接拒绝导入，并把原因说清楚。
  if (!categories.length || !locations.length) {
    throw new Error(
      `内置地图数据快照是空的（分类 ${categories.length} 个、点位 ${locations.length} 个）：`
      + `${config.seedDataFile}\n`
      + '       这通常是打包/上传时把 packages/shared/data/*.json 换成了占位文件。\n'
      + '       请用真实数据替换后重试；确实不想导入内置数据时用 DISABLE_SEED=1。',
    )
  }

  const withImages = locations.filter(
    (location) => Array.isArray(location.images) && location.images.length > 0,
  )
  if (!withImages.length) {
    throw new Error(
      `内置地图数据里没有任何带截图的点位（共 ${locations.length} 个）：${config.seedDataFile}\n`
      + '       这样游戏一道题都抽不出来，请检查数据文件是否完整。',
    )
  }

  const before = countLocations()
  const startedAt = Date.now()

  // 单事务写入：1600+ 点位 + 40 分类，避免逐条提交
  const run = db.transaction(() => {
    categories.forEach((category, index) => {
      upsertCategory({
        id: category.id,
        group: category.group,
        label: category.label,
        icon: category.icon,
        iconUrl: category.iconUrl,
        color: category.color,
        isDefault: category.isDefault,
        isHidden: category.isHidden,
        sortOrder: index,
      })
    })

    for (const location of locations) {
      if (!Number.isFinite(Number(location.x)) || !Number.isFinite(Number(location.y))) continue
      upsertLocation({
        id: location.id,
        name: location.name,
        types: location.types ?? [],
        district: location.district ?? '',
        description: location.description ?? '',
        tags: location.tags ?? [],
        images: location.images ?? [],
        x: location.x,
        y: location.y,
        source: location.source ?? SOURCE_MAP_DATA,
      })
    }
  })
  run()

  const after = countLocations()
  const stats = {
    categories: countCategories(),
    locations: after.total,
    questions: after.withImages,
    durationMs: Date.now() - startedAt,
    // 首次导入前库里已有的自建题数量（正常情况下是 0）
    preexisting: before.total,
  }
  markSeeded(stats)

  logger.info?.(
    `[seed] 已导入内置数据：分类 ${stats.categories}、点位 ${stats.locations}`
    + `（其中可出题 ${stats.questions}），耗时 ${stats.durationMs}ms`,
  )
  return stats
}

// 供自检脚本复用：删库重来
export function forceSeed(logger = console) {
  process.env.FORCE_SEED = '1'
  const stats = seedIfNeeded(logger)
  delete process.env.FORCE_SEED
  return stats
}
