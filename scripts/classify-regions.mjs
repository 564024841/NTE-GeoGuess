// 按坐标把题归到区域（区域分类 region-hyuga / region-new-holland / … / region-twilight）。
//
// 背景：476 道可出题的截图题，原始 `district` 全是占位值「全地图」，所以按区域筛题一直是空的。
// 上游 MaaNTE-Map 里有 400 个点位带真实区域名（谕石/赠礼/异象/打卡/支线，见
// `scripts/data/region-reference.json`），它们把六块城区圈得比较干净 —— 用它们当参考点做 kNN
// 投票，就能把 476 道题按坐标归到区域。
//
// 规则：
//   1. 点的 `district` 是真实区域名时直接采信（不参与投票）；
//   2. 否则取最近 K 个参考点，按 1/距离 加权投票，票数最高的区域胜出；
//   3. 离最近参考点超过 MAX_DIST（标定像素）的点，说明落在参考点覆盖之外（地图西北那块飞地），
//      归「薄暮区」——那边一个探索度点位都没有，硬按 kNN 投只会投给相邻城区。
//
// 参考点自检（留一法）：400 个参考点逐个拿掉自己再投票，97% 能回到自己的区域 ——
// 用 `--cv` 复现。城区里 471 道题离最近参考点 ≤235 像素，之后直接跳到 1368 像素，
// 1000 这条覆盖线就落在这个空档里。
//
// 用法：
//   node scripts/classify-regions.mjs                  # 演练：只打印会改什么
//   node scripts/classify-regions.mjs --cv             # 顺带打印参考点自检准确率
//   node scripts/classify-regions.mjs --apply          # 执行（先备份，再写盘 + 同步数据库）
//   node scripts/classify-regions.mjs --k=9 --max-dist=1200 --apply   # 调参
//
// 幂等：算出来的归属只由坐标决定，重复执行结果一致；没有变化时不会写盘、也不会碰数据库。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createGeometry } from '@nte-geoguess/shared'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SEED_FILE = process.env.SEED_FILE || path.join(ROOT, 'packages/shared/data/map-data.json')
const CALIBRATION_FILE = path.join(ROOT, 'packages/shared/data/navi-coordinate-calibration.json')
const REFERENCE_FILE = path.join(ROOT, 'scripts/data/region-reference.json')
const BACKUP_DIR = path.join(ROOT, 'data/backups')
const API_BASE = process.env.API_BASE || 'http://127.0.0.1:8787'
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'test-admin-pw'

const APPLY = process.argv.includes('--apply')
const CROSS_VALIDATE = process.argv.includes('--cv')

const PLACEHOLDER = '全地图'
const UNLABELED_LABEL = '未标注'
const TWILIGHT_LABEL = '薄暮区'
const REGION_GROUP = '区域'

function option(name, fallback) {
  const prefix = `--${name}=`
  const hit = process.argv.find((arg) => arg.startsWith(prefix))
  return hit ? Number(hit.slice(prefix.length)) : fallback
}

const K = option('k', 7)
const MAX_DIST = option('max-dist', 1000)

const seed = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'))
const calibration = JSON.parse(fs.readFileSync(CALIBRATION_FILE, 'utf8'))
const reference = JSON.parse(fs.readFileSync(REFERENCE_FILE, 'utf8'))
const geometry = createGeometry(seed.map, calibration)

// 分类 id ↔ 区域名：直接照 seed 里的分类表来，避免脚本里再抄一份映射表（抄了就会漂）
const regionCategoryByLabel = new Map(
  (seed.categories || [])
    .filter((category) => category.group === REGION_GROUP)
    .map((category) => [category.label, category]),
)

function regionCategory(label) {
  const category = regionCategoryByLabel.get(label)
  if (!category) {
    throw new Error(`分类表里没有「${label}」这个区域分类，先跑 npm run add:region-twilight 或补上分类`)
  }
  return category
}

const twilight = regionCategory(TWILIGHT_LABEL)

// ---------- 参考点：游戏坐标 → 标定像素 ----------

const references = reference.points.map((point) => {
  const pixel = geometry.gameToMapPixel({ x: point.x, y: point.y })
  return { pixelX: pixel.pixelX, pixelY: pixel.pixelY, label: point.district, id: point.id }
})

const distance = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by)

// 反距离加权投票：返回 { label, confidence, nearestDistance }
function vote(pixelX, pixelY, pool = references, k = K) {
  const sorted = pool
    .map((point) => ({ d: distance(pixelX, pixelY, point.pixelX, point.pixelY), label: point.label }))
    .sort((a, b) => a.d - b.d)
    .slice(0, k)

  const weightByLabel = new Map()
  for (const item of sorted) {
    weightByLabel.set(item.label, (weightByLabel.get(item.label) || 0) + 1 / Math.max(item.d, 1))
  }
  const total = [...weightByLabel.values()].reduce((sum, value) => sum + value, 0)
  const [label, weight] = [...weightByLabel.entries()].sort((a, b) => b[1] - a[1])[0]
  return { label, confidence: weight / total, nearestDistance: sorted[0]?.d ?? Infinity }
}

function isRealDistrict(location) {
  const district = (location.district || '').trim()
  return Boolean(district) && district !== PLACEHOLDER
}

// 一个点位最终归到哪个区域
function classify(location) {
  const district = (location.district || '').trim()
  if (district && district !== PLACEHOLDER && regionCategoryByLabel.has(district)) {
    return { label: district, reason: 'district', confidence: 1, nearestDistance: 0 }
  }
  const pixel = geometry.gameToMapPixel({ x: location.x, y: location.y })
  const result = vote(pixel.pixelX, pixel.pixelY)
  if (result.nearestDistance > MAX_DIST) {
    // 注意顺序：先铺开投票结果，再用覆盖规则覆盖 label —— 反过来会被 kNN 的票数盖掉
    return { ...result, label: TWILIGHT_LABEL, reason: 'outside-coverage' }
  }
  return { ...result, reason: 'knn' }
}

// ---------- 逐个点位归类 ----------

const rows = (seed.locations || []).map((location) => {
  const result = classify(location)
  const category = regionCategory(result.label)
  const currentLabel = regionCategoryByLabel.get((location.types || [])[0])?.label
    || (location.region || '').trim()
    || UNLABELED_LABEL
  return { location, category, result, currentLabel }
})

const distribution = new Map()
for (const row of rows) {
  distribution.set(row.result.label, (distribution.get(row.result.label) || 0) + 1)
}

const changed = rows.filter((row) => row.currentLabel !== row.result.label)
const borderline = rows.filter((row) => row.result.reason === 'knn' && row.result.confidence < 0.6)
const outside = rows.filter((row) => row.result.reason === 'outside-coverage')
const fromDistrict = rows.filter((row) => row.result.reason === 'district')

console.log('=== 按坐标分类区域 ===')
console.log(`  参考点        ${references.length} 个（${[...new Set(references.map((point) => point.label))].length} 个区域）`)
console.log(`  参数          k=${K}，覆盖半径 ${MAX_DIST} 标定像素（整图宽 13056）`)
console.log(`  点位          ${rows.length} 个，其中按 district 直接采信 ${fromDistrict.length} 个`)
console.log('  分类结果：')
for (const [label, count] of [...distribution.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${label.padEnd(6)} ${String(count).padStart(4)}`)
}

if (CROSS_VALIDATE) {
  let hit = 0
  for (let index = 0; index < references.length; index += 1) {
    const self = references[index]
    const pool = references.filter((_, other) => other !== index)
    if (vote(self.pixelX, self.pixelY, pool).label === self.label) hit += 1
  }
  console.log(`  参考点自检    留一法准确率 ${(hit / references.length * 100).toFixed(1)}%（${hit}/${references.length}）`)
}

console.log(`\n  归属会变化的点位 ${changed.length} 个`)
for (const row of changed.slice(0, 20)) {
  const { result } = row
  console.log(`    ${row.location.id.padEnd(26)} ${row.currentLabel} → ${result.label}   (${result.reason}, conf=${result.confidence.toFixed(2)}, 最近参考点 ${Math.round(result.nearestDistance)}px)`)
}
if (changed.length > 20) console.log(`    …另有 ${changed.length - 20} 个`)

if (borderline.length) {
  console.log(`\n  两区交界、置信度 <0.6（建议人工复核）${borderline.length} 个：`)
  for (const row of borderline.sort((a, b) => a.result.confidence - b.result.confidence)) {
    console.log(`    ${row.location.id.padEnd(26)} ${row.result.label}  conf=${row.result.confidence.toFixed(2)} 最近参考点 ${Math.round(row.result.nearestDistance)}px`)
  }
}

if (outside.length) {
  console.log(`\n  参考点覆盖之外 → ${TWILIGHT_LABEL}${outside.length} 个：`)
  for (const row of outside.sort((a, b) => a.result.nearestDistance - b.result.nearestDistance)) {
    console.log(`    ${row.location.id.padEnd(26)} 原属 ${row.currentLabel}，最近参考点 ${Math.round(row.result.nearestDistance)}px`)
  }
}

if (!changed.length) {
  console.log('\n没有需要改的点位（幂等：重复执行不会写盘）。')
  process.exit(0)
}

if (!APPLY) {
  console.log('\n（演练模式，未写入。加 --apply 执行）')
  process.exit(0)
}

// ---------- 写盘 ----------

fs.mkdirSync(BACKUP_DIR, { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const backupFile = path.join(BACKUP_DIR, `map-data.${stamp}.json`)
fs.copyFileSync(SEED_FILE, backupFile)
console.log(`\n[备份] ${path.relative(ROOT, backupFile)}`)

const nextLocations = rows.map((row) => {
  const { location, category, result } = row
  if (row.currentLabel === result.label) return location
  const tags = (location.tags || []).filter((tag) => !['unlabeled', UNLABELED_LABEL, ...regionCategoryByLabel.keys()].includes(tag))
  return {
    ...location,
    types: [category.id],
    region: result.label,
    tags: [...tags, result.label],
  }
})

const nextData = {
  ...seed,
  version: (Number(seed.version) || 1) + 1,
  locations: nextLocations,
}

fs.writeFileSync(SEED_FILE, `${JSON.stringify(nextData, null, 2)}\n`, 'utf8')
console.log(`[写盘] ${path.relative(ROOT, SEED_FILE)}（version ${seed.version} → ${nextData.version}）`)

// ---------- 同步数据库 ----------

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
      body: { locations: nextLocations, categories: nextData.categories },
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
