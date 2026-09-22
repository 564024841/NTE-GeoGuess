// 题库分类按区域名重建。
//
// 背景：原始数据里 1622 个点位有 1222 个的 district 是占位值「全地图」，
// 剩下 400 个才有真实区域名；而 476 道可出题的截图题**全部**落在占位值那一批里
// （两个集合完全不相交）。所以本次迁移的策略是：
//
//   1. 分类改为 6 个真实区域名 + 一个「未标注」
//   2. 保留有区域名的点位（400），以及有截图的点位（476，归入「未标注」）
//   3. 删除真正无用的：既无区域名又无截图的 752 个占位点位
//
// 用法：
//   node scripts/migrate-regions.mjs            # 演练，只打印将要发生什么
//   node scripts/migrate-regions.mjs --apply    # 真正执行（先自动备份）
//
// 改动目标：
//   · packages/shared/data/map-data.json   （seed 快照，Docker 镜像也用它）
//   · 运行中的数据库（data/nte-geoguess.sqlite，经服务端 API 做同步）
// 后台上传的题库条目（source=question-bank）不会被触碰。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SEED_FILE = path.join(ROOT, 'packages/shared/data/map-data.json')
const BACKUP_DIR = path.join(ROOT, 'data/backups')
const API_BASE = process.env.API_BASE || 'http://127.0.0.1:8787'
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'test-admin-pw'

const APPLY = process.argv.includes('--apply')
const PLACEHOLDER = '全地图'
const UNLABELED_ID = 'unlabeled'
const UNLABELED_LABEL = '未标注'

// 六个真实区域名 → 稳定的分类 id
const REGION_CATEGORY_IDS = {
  新赫兰德区: 'region-new-holland',
  绘空町: 'region-ekuumachi',
  米格尔区: 'region-miguel',
  桥间地: 'region-hashima',
  未闻浦: 'region-miminoura',
  向阳岛: 'region-hyuga',
}

// 每个区域给一个主题色，地图标记与筛选面板会用到
const REGION_COLORS = {
  新赫兰德区: '#8adfd6',
  绘空町: '#a3d4ff',
  米格尔区: '#ffd27d',
  桥间地: '#c7a6ff',
  未闻浦: '#7fe3b0',
  向阳岛: '#ffab6e',
}

const ICONS = {
  [UNLABELED_ID]: '❔',
  'region-new-holland': '🏙',
  'region-ekuumachi': '🏘',
  'region-miguel': '🏢',
  'region-hashima': '🌉',
  'region-miminoura': '🌊',
  'region-hyuga': '🌅',
}

function hasRealDistrict(location) {
  const district = (location.district || '').trim()
  return Boolean(district) && district !== PLACEHOLDER
}

function hasImage(location) {
  return Array.isArray(location.images) && location.images.length > 0
}

function categoryIdFor(location) {
  const district = (location.district || '').trim()
  return REGION_CATEGORY_IDS[district] || UNLABELED_ID
}

function buildCategories(regionNames) {
  const categories = regionNames.map((name, index) => ({
    id: REGION_CATEGORY_IDS[name],
    group: '区域',
    label: name,
    icon: ICONS[REGION_CATEGORY_IDS[name]],
    color: REGION_COLORS[name] || '#8adfd6',
    isDefault: index === 0,
  }))
  categories.push({
    id: UNLABELED_ID,
    group: '区域',
    label: UNLABELED_LABEL,
    icon: ICONS[UNLABELED_ID],
    color: '#9aa4ad',
    isDefault: false,
  })
  return categories
}

// ---------- 1. 计算迁移方案 ----------

const original = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'))
const allLocations = original.locations

const regionNames = [...new Set(
  allLocations.filter(hasRealDistrict).map((location) => location.district.trim()),
)].sort()

const kept = allLocations.filter((location) => hasRealDistrict(location) || hasImage(location))
const removed = allLocations.filter((location) => !hasRealDistrict(location) && !hasImage(location))

const removedWithImages = removed.filter(hasImage).length
const keptPuzzles = kept.filter(hasImage).length

console.log('=== 迁移方案 ===')
console.log(`  原分类                 ${original.categories.length} 个`)
console.log(`  新分类                 ${regionNames.length + 1} 个（${regionNames.join('、')}、${UNLABELED_LABEL}）`)
console.log(`  原点位                 ${allLocations.length}`)
console.log(`  保留                   ${kept.length}`)
console.log(`  删除                   ${removed.length}（其中带截图的 ${removedWithImages} 个）`)
console.log(`  可出题                 ${allLocations.filter(hasImage).length} → ${keptPuzzles}`)

if (removedWithImages > 0) {
  console.error(`\n✗ 中止：删除列表里出现了 ${removedWithImages} 个带截图的点位，这会减少可出题数`)
  process.exit(1)
}
if (keptPuzzles === 0) {
  console.error('\n✗ 中止：迁移后可出题数为 0，游戏将无法开局')
  process.exit(1)
}

const nextLocations = kept.map((location) => {
  const typeId = categoryIdFor(location)
  // tags 里原本塞了分类 id 与区域名，重建后统一刷新，避免留下失效引用
  const tags = new Set([typeId])
  const district = (location.district || '').trim()
  if (district && district !== PLACEHOLDER) tags.add(district)
  return {
    ...location,
    types: [typeId],
    tags: [...tags],
  }
})

const nextData = {
  ...original,
  version: (Number(original.version) || 1) + 1,
  categories: buildCategories(regionNames),
  locations: nextLocations,
}

if (!APPLY) {
  console.log('\n（演练模式，未写入任何文件。加 --apply 真正执行）')
  console.log('\n各分类将包含的点位/可出题数：')
  for (const category of nextData.categories) {
    const members = nextLocations.filter((location) => location.types.includes(category.id))
    console.log(`  ${category.label.padEnd(8)} 点位 ${String(members.length).padStart(4)}  可出题 ${String(members.filter(hasImage).length).padStart(3)}`)
  }
  process.exit(0)
}

// ---------- 2. 备份 ----------

fs.mkdirSync(BACKUP_DIR, { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const backupFile = path.join(BACKUP_DIR, `map-data.${stamp}.json`)
fs.copyFileSync(SEED_FILE, backupFile)
console.log(`\n[备份] ${path.relative(ROOT, backupFile)}`)

// ---------- 3. 写入 seed 快照 ----------

fs.writeFileSync(SEED_FILE, `${JSON.stringify(nextData, null, 2)}\n`, 'utf8')
console.log(`[写盘] ${path.relative(ROOT, SEED_FILE)}`)

// ---------- 4. 同步运行中的数据库 ----------

async function api(pathname, { method = 'GET', body, cookie } = {}) {
  const headers = { Accept: 'application/json' }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (cookie) headers.Cookie = cookie
  const response = await fetch(`${API_BASE}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const payload = await response.json().catch(() => null)
  return { status: response.status, payload, setCookie: response.headers.getSetCookie?.() ?? [] }
}

async function syncDatabase() {
  const health = await api('/api/health').catch(() => null)
  if (!health || health.status !== 200) {
    console.log(`[数据库] 服务端不可达（${API_BASE}），跳过数据库同步。`)
    console.log('         重启服务端前请设置 FORCE_SEED=1，让它按新快照重新导入。')
    return
  }

  const login = await api('/api/admin/login', { method: 'POST', body: { password: ADMIN_PASSWORD } })
  if (login.status !== 200) {
    console.log(`[数据库] 登录失败（${login.status}），跳过数据库同步。请检查 ADMIN_PASSWORD。`)
    return
  }
  const cookie = login.setCookie.map((item) => item.split(';')[0]).join('; ')

  const sync = await api('/api/admin/resync', { method: 'POST', cookie, body: { locations: nextLocations, categories: nextData.categories } })
  if (sync.status !== 200) {
    console.log(`[数据库] 同步失败（${sync.status}）：${sync.payload?.error || '未知错误'}`)
    process.exitCode = 1
    return
  }
  console.log(`[数据库] 已同步：分类 ${sync.payload.categories}、点位 ${sync.payload.locations}（保留自建题 ${sync.payload.keptQuestionBank}）`)
}

await syncDatabase()

console.log('\n=== 迁移完成 ===')
console.log(`  分类 ${nextData.categories.length} 个、点位 ${nextLocations.length}、可出题 ${keptPuzzles}`)
console.log(`  回滚：把 ${path.relative(ROOT, backupFile)} 覆盖回 ${path.relative(ROOT, SEED_FILE)}，再设 FORCE_SEED=1 重启服务端`)
