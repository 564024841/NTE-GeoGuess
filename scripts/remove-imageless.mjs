// 删除所有「无截图」的点位。
//
// 背景：这些点位是纯地图标记（谕石、打卡点之类），没有截图所以永远出不了题。
// 它们同时也是 6 个区域分类（向阳岛 / 新赫兰德区 / 未闻浦 / 桥间地 / 米格尔区 / 绘空町）
// 的全部内容，所以执行后这些分类会变成空分类（分类本身保留，之后可以在后台上传截图补题）。
//
// 用法：
//   node scripts/remove-imageless.mjs            # 演练：只打印将删除什么
//   node scripts/remove-imageless.mjs --apply    # 执行
//
// 幂等：再跑一次会显示「删除 0 个」。
// 不做自动备份（按使用者要求）；脚本会打印被删点位的完整清单，需要时可用于恢复。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SEED_FILE = path.join(ROOT, 'packages/shared/data/map-data.json')
const API_BASE = process.env.API_BASE || 'http://127.0.0.1:8787'
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'test-admin-pw'

const APPLY = process.argv.includes('--apply')

const data = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'))
const hasImage = (location) => Array.isArray(location.images) && location.images.length > 0

const kept = data.locations.filter(hasImage)
const removed = data.locations.filter((location) => !hasImage(location))

console.log('=== 删除无截图点位 ===')
console.log(`  当前点位      ${data.locations.length}`)
console.log(`  保留（有图）  ${kept.length}`)
console.log(`  删除（无图）  ${removed.length}`)

if (!removed.length) {
  console.log('\n没有可删除的点位（已经是干净状态）。')
  process.exit(0)
}

// 按分类统计将变成空的分类
const categoryMembers = new Map()
for (const location of data.locations) {
  for (const type of location.types || []) {
    if (!categoryMembers.has(type)) categoryMembers.set(type, { total: 0, withImage: 0 })
    const entry = categoryMembers.get(type)
    entry.total += 1
    if (hasImage(location)) entry.withImage += 1
  }
}

console.log('\n删除后各分类的点位/可出题数：')
const becomingEmpty = []
for (const category of data.categories) {
  const entry = categoryMembers.get(category.id) || { total: 0, withImage: 0 }
  const flag = entry.total > 0 && entry.withImage === 0 ? '  ← 会变空' : ''
  if (flag) becomingEmpty.push(category.label)
  console.log(`  ${category.label.padEnd(10)} ${String(entry.total).padStart(4)} → ${String(entry.withImage).padStart(3)}${flag}`)
}
if (becomingEmpty.length) {
  console.log(`\n注意：这些分类会变成空分类（分类保留，可在后台上传截图补题）：${becomingEmpty.join('、')}`)
}

if (!APPLY) {
  console.log('\n（演练模式，未写入任何文件。加 --apply 执行）')
  console.log('\n将删除的点位 id（前 20 个）：')
  console.log('  ' + removed.slice(0, 20).map((location) => location.id).join(', '))
  console.log(`  …共 ${removed.length} 个`)
  process.exit(0)
}

// ---------- 执行 ----------

const nextData = {
  ...data,
  version: (Number(data.version) || 1) + 1,
  locations: kept,
}
fs.writeFileSync(SEED_FILE, `${JSON.stringify(nextData, null, 2)}\n`, 'utf8')
console.log(`\n[写盘] ${path.relative(ROOT, SEED_FILE)}`)

// 完整删除清单：不打备份，但留下可恢复的依据
const manifestFile = path.join(ROOT, 'data/removed-imageless-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.json')
fs.mkdirSync(path.dirname(manifestFile), { recursive: true })
fs.writeFileSync(manifestFile, `${JSON.stringify(removed, null, 2)}\n`, 'utf8')
console.log(`[清单] ${path.relative(ROOT, manifestFile)}（被删点位的完整记录，需要恢复时用它）`)

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
  return {
    status: response.status,
    payload: await response.json().catch(() => null),
    setCookie: response.headers.getSetCookie?.() ?? [],
  }
}

const health = await api('/api/health').catch(() => null)
if (!health || health.status !== 200) {
  console.log(`[数据库] 服务端不可达（${API_BASE}）——重启时请设 FORCE_SEED=1 让它按新快照导入`)
} else {
  const login = await api('/api/admin/login', { method: 'POST', body: { password: ADMIN_PASSWORD } })
  if (login.status !== 200) {
    console.log(`[数据库] 登录失败（${login.status}），跳过同步`)
    process.exitCode = 1
  } else {
    const cookie = login.setCookie.map((item) => item.split(';')[0]).join('; ')
    const sync = await api('/api/admin/resync', {
      method: 'POST',
      cookie,
      body: { locations: kept, categories: data.categories },
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
console.log(`  点位 ${data.locations.length} → ${kept.length}，可出题仍为 ${kept.length}`)
