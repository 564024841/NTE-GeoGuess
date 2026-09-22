// 新增区域分类「薄暮区」。
//
// 背景：地图西北角（米格尔区以北、绘空町以西）在现有数据里几乎没有点位。
// 本脚本做三件事：
//   1. 新增分类 region-twilight（薄暮区），归类在「区域」分组下
//   2. 给所有点位补一个显式的 `region` 字段，把「区域归属」从 district 里独立出来
//      （district 有 1222 个占位值，不适合当归属依据）
//   3. 把落在已知 6 区范围之外的未标注点位改归薄暮区
//
// 用法：
//   node scripts/add-region-twilight.mjs            # 演练
//   node scripts/add-region-twilight.mjs --apply    # 执行（先自动备份）
//
// 幂等：重复执行不会重复添加分类，也不会把已归属的点再改一次。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createGeometry } from '@nte-geoguess/shared'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SEED_FILE = path.join(ROOT, 'packages/shared/data/map-data.json')
const CALIBRATION_FILE = path.join(ROOT, 'packages/shared/data/navi-coordinate-calibration.json')
const BACKUP_DIR = path.join(ROOT, 'data/backups')
const API_BASE = process.env.API_BASE || 'http://127.0.0.1:8787'
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'test-admin-pw'

const APPLY = process.argv.includes('--apply')

const REGION_ID = 'region-twilight'
const REGION_LABEL = '薄暮区'
const PLACEHOLDER = '全地图'
const UNLABELED = '未标注'

// 未标注分类 id → 区域名的映射（保持与 migrate-regions.mjs 一致）
const CATEGORY_TO_REGION = {
  'region-hyuga': '向阳岛',
  'region-new-holland': '新赫兰德区',
  'region-miminoura': '未闻浦',
  'region-hashima': '桥间地',
  'region-miguel': '米格尔区',
  'region-ekuumachi': '绘空町',
}

const data = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'))
const calibration = JSON.parse(fs.readFileSync(CALIBRATION_FILE, 'utf8'))
const geometry = createGeometry(data.map, calibration)

// ---------- 1. 先给所有点位补 region 字段 ----------

const withRegion = data.locations.map((location) => {
  const district = (location.district || '').trim()
  const categoryId = (location.types || [])[0]
  const region = CATEGORY_TO_REGION[categoryId]
    || (district && district !== PLACEHOLDER ? district : UNLABELED)
  // 已有显式 region 的以显式值为准（支持后续手工修正）
  return { ...location, region: location.region || region }
})

// ---------- 2. 找出已知 6 区范围之外的未标注点位 ----------

const named = withRegion.filter((location) => location.region && location.region !== UNLABELED)
const pixel = (location) => geometry.gameToMapPixel({ x: location.x, y: location.y })

const namedPixels = named.map(pixel)
const minX = Math.min(...namedPixels.map((p) => p.pixelX))
const maxX = Math.max(...namedPixels.map((p) => p.pixelX))
const minY = Math.min(...namedPixels.map((p) => p.pixelY))
const maxY = Math.max(...namedPixels.map((p) => p.pixelY))

const candidates = withRegion.filter((location) => {
  if (location.region !== UNLABELED) return false
  const p = pixel(location)
  return p.pixelX < minX || p.pixelX > maxX || p.pixelY < minY || p.pixelY > maxY
})

console.log('=== 薄暮区迁移方案 ===')
console.log(`  已知 6 区范围：X ${minX.toFixed(0)}–${maxX.toFixed(0)}  Y ${minY.toFixed(0)}–${maxY.toFixed(0)}`)
console.log(`  分类           ${data.categories.length} → ${data.categories.some((c) => c.id === REGION_ID) ? data.categories.length : data.categories.length + 1}`)
console.log(`  将归入薄暮区   ${candidates.length} 个（全部在已知区域范围之外）`)
for (const location of candidates) {
  const p = pixel(location)
  const reasons = []
  if (p.pixelX < minX) reasons.push(`西 ${(minX - p.pixelX).toFixed(0)}px`)
  if (p.pixelX > maxX) reasons.push(`东 ${(p.pixelX - maxX).toFixed(0)}px`)
  if (p.pixelY < minY) reasons.push(`北 ${(minY - p.pixelY).toFixed(0)}px`)
  if (p.pixelY > maxY) reasons.push(`南 ${(p.pixelY - maxY).toFixed(0)}px`)
  console.log(`    ${location.id.padEnd(24)} px=${p.pixelX.toFixed(0)},${p.pixelY.toFixed(0)}  ${reasons.join(' ')}`)
}

if (!APPLY) {
  console.log('\n（演练模式，未写入。加 --apply 执行）')
  process.exit(0)
}

// ---------- 3. 应用 ----------

fs.mkdirSync(BACKUP_DIR, { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const backupFile = path.join(BACKUP_DIR, `map-data.${stamp}.json`)
fs.copyFileSync(SEED_FILE, backupFile)
console.log(`\n[备份] ${path.relative(ROOT, backupFile)}`)

const categoryExists = data.categories.some((category) => category.id === REGION_ID)
const nextCategories = categoryExists
  ? data.categories
  : [
      ...data.categories,
      {
        id: REGION_ID,
        group: '区域',
        label: REGION_LABEL,
        icon: '🌆',
        color: '#b39ddb',
        isDefault: false,
      },
    ]

const candidateIds = new Set(candidates.map((location) => location.id))
const nextLocations = withRegion.map((location) => {
  if (!candidateIds.has(location.id)) return location
  const tags = new Set([...(location.tags || []).filter((tag) => tag !== UNLABELED), REGION_LABEL])
  return {
    ...location,
    types: [REGION_ID],
    region: REGION_LABEL,
    tags: [...tags],
  }
})

const nextData = {
  ...data,
  version: (Number(data.version) || 1) + 1,
  categories: nextCategories,
  locations: nextLocations,
}

fs.writeFileSync(SEED_FILE, `${JSON.stringify(nextData, null, 2)}\n`, 'utf8')
console.log(`[写盘] ${path.relative(ROOT, SEED_FILE)}`)

// ---------- 4. 同步数据库 ----------

async function api(pathname, { method = 'GET', body, cookie } = {}) {
  const headers = { Accept: 'application/json' }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (cookie) headers.Cookie = cookie
  const response = await fetch(`${API_BASE}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: response.status, payload: await response.json().catch(() => null), setCookie: response.headers.getSetCookie?.() ?? [] }
}

const health = await api('/api/health').catch(() => null)
if (!health || health.status !== 200) {
  console.log(`[数据库] 服务端不可达（${API_BASE}）——重启时请设 FORCE_SEED=1 让它按新快照导入`)
} else {
  const login = await api('/api/admin/login', { method: 'POST', body: { password: ADMIN_PASSWORD } })
  if (login.status !== 200) {
    console.log(`[数据库] 登录失败（${login.status}），跳过同步`)
  } else {
    const cookie = login.setCookie.map((item) => item.split(';')[0]).join('; ')
    const sync = await api('/api/admin/resync', {
      method: 'POST',
      cookie,
      body: { locations: nextLocations, categories: nextCategories },
    })
    if (sync.status === 200) {
      console.log(`[数据库] 已同步：分类 ${sync.payload.categories}、点位 ${sync.payload.locations}、可出题 ${sync.payload.puzzles}`)
    } else {
      console.log(`[数据库] 同步失败（${sync.status}）：${sync.payload?.error || ''}`)
      process.exitCode = 1
    }
  }
}

console.log('\n=== 完成 ===')
console.log(`  薄暮区现在有 ${candidates.length} 个点位（全部带截图，可出题）`)
