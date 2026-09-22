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
