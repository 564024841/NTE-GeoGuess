// 服务端 API 端到端校验。
//
// 不需要浏览器：直接用 fetch 打真实 HTTP 接口，覆盖
//   健康检查 / bootstrap / 鉴权 / 登出 / 题目增删改查 / 批量提交 /
//   截图上传与魔数校验 / 分类管理 / 未登录拦截 / 输入校验
//
// 用法：
//   node scripts/qa-server.mjs                                    # 起一个临时服务端（推荐）
//   node scripts/qa-server.mjs --base-url http://127.0.0.1:8787   # 打已有服务端
//
// 临时服务端在同进程内启动（不 spawn 子进程）：端口用 0 让系统分配，
// 数据目录用临时目录，结束后清理，不污染开发数据。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const args = process.argv.slice(2)
const baseUrlArgIndex = args.indexOf('--base-url')
const externalBaseUrl = baseUrlArgIndex >= 0 ? args[baseUrlArgIndex + 1] : null

// 自己起临时服务端时用这个密码；打已有服务端（--base-url）时用 --password 指定的
const ADMIN_PASSWORD = (() => {
  const index = args.indexOf('--password')
  return index >= 0 ? args[index + 1] : 'qa-admin-password'
})()
const failures = []
const notes = []

function check(condition, message) {
  if (condition) notes.push(`  ok   ${message}`)
  else failures.push(message)
}

// ---------------- 临时服务端 ----------------

let app = null
let tempDir = null
let baseUrl = externalBaseUrl

async function startServer() {
  if (externalBaseUrl) {
    notes.push(`  --   使用已有服务端：${externalBaseUrl}`)
    return
  }

  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nte-geoguess-qa-'))
  // 配置在模块加载时读取，所以必须先设好环境变量再 import
  process.env.NODE_ENV = 'test'
  process.env.DATA_DIR = tempDir
  process.env.ADMIN_PASSWORD = ADMIN_PASSWORD
  process.env.LOG_LEVEL = 'warn'

  const { buildServer } = await import('../server/src/index.js')
  const { seedIfNeeded } = await import('../server/src/seed.js')

  app = await buildServer({ logger: false })
  seedIfNeeded({ info: () => {}, warn: () => {}, error: () => {} })

  // 端口 0 = 让系统分配空闲端口，避免与开发服务端冲突
  await app.listen({ host: '127.0.0.1', port: 0 })
  const address = app.server.address()
  baseUrl = `http://127.0.0.1:${address.port}`
  notes.push(`  --   已启动临时服务端 ${baseUrl}（数据目录 ${path.basename(tempDir)}）`)
}

async function stopServer() {
  if (app) {
    await app.close()
    app = null
  }
  const { closeDatabase } = await import('../server/src/db.js')
  closeDatabase()
  if (tempDir) {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true })
    } catch {
      /* Windows 上 sqlite 文件可能还被占用，忽略 */
    }
    tempDir = null
  }
}

// ---------------- HTTP 小工具 ----------------

let cookieJar = ''

async function api(pathname, { method = 'GET', body, headers = {}, raw = false, cookie = cookieJar } = {}) {
  const finalHeaders = { ...headers }
  if (body !== undefined) finalHeaders['Content-Type'] = 'application/json'
  if (cookie) finalHeaders.Cookie = cookie

  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: finalHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  })

  const setCookie = response.headers.getSetCookie?.() ?? []
  if (setCookie.length) {
    cookieJar = setCookie.map((item) => item.split(';')[0]).join('; ')
  }

  const contentType = response.headers.get('content-type') || ''
  const payload = raw
    ? Buffer.from(await response.arrayBuffer())
    : contentType.includes('application/json')
      ? await response.json().catch(() => null)
      : await response.text()

  return { status: response.status, payload, headers: response.headers }
}

// 生成一张合法的 1x1 PNG（带正确魔数），用于上传校验
const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='

function pngDataUrl() {
  return `data:image/png;base64,${TINY_PNG_BASE64}`
}

// ---------------- 校验流程 ----------------

const createdIds = []

try {
  await startServer()

  // ---------- 公共接口 ----------
  {
    const health = await api('/api/health')
    check(health.status === 200 && health.payload?.status === 'ok', `GET /api/health => ${health.status} ${health.payload?.status}`)

    const stats = await api('/api/stats')
    check(stats.status === 200 && stats.payload.locations > 0 && stats.payload.puzzles > 0,
      `GET /api/stats => 点位 ${stats.payload?.locations}、可出题 ${stats.payload?.puzzles}`)

    const bootstrap = await api('/api/bootstrap')
    const payload = bootstrap.payload
    check(bootstrap.status === 200, `GET /api/bootstrap => ${bootstrap.status}`)
    check(Number(payload?.map?.width) === 26112 && Number(payload?.map?.tileSize) === 512,
      `bootstrap.map 正确 => ${payload?.map?.width}x${payload?.map?.height} tile ${payload?.map?.tileSize}`)
    check(Array.isArray(payload?.calibration?.points) && payload.calibration.points.length >= 3,
      `bootstrap.calibration 含 ${payload?.calibration?.points?.length} 个标定点`)
    check(payload?.locations?.length > 0 && payload.locations.every((item) => item.images.length > 0),
      `bootstrap 只下发有截图的点位 => ${payload?.locations?.length} 条`)
    check(
      payload?.categories?.length > 0 && payload.categories.every((item) => item.id && item.label),
      `bootstrap.categories 结构完整 => ${payload?.categories?.length} 个：${payload?.categories?.map((item) => item.label).join("/")}`,
    )
    check(payload?.stats?.puzzles === payload?.locations?.length,
      `bootstrap.stats.puzzles 与下发数量一致 => ${payload?.stats?.puzzles}`)
    check(typeof payload?.map?.tileUrl === 'string' && payload.map.tileUrl.includes('{z}'),
      `地图瓦片模板由服务端下发 => ${payload?.map?.tileUrl}`)

    // ETag 复用
    const etag = bootstrap.headers.get('etag')
    check(Boolean(etag), `bootstrap 带 ETag => ${etag}`)
    if (etag) {
      const cached = await api('/api/bootstrap', { headers: { 'If-None-Match': etag } })
      check(cached.status === 304, `带 If-None-Match 返回 304 => ${cached.status}`)
    }
  }

  // ---------- 未登录拦截 ----------
  {
    const list = await api('/api/admin/questions', { cookie: '' })
    check(list.status === 401, `未登录访问后台接口 => ${list.status}`)

    const create = await api('/api/admin/questions', {
      method: 'POST',
      cookie: '',
      body: { name: 'x', types: ['lost-wallet'], x: 0, y: 0, images: [] },
    })
    check(create.status === 401, `未登录创建题目被拦截 => ${create.status}`)

    const session = await api('/api/admin/session', { cookie: '' })
    check(session.status === 200 && session.payload?.authenticated === false,
      `未登录时 session 返回 authenticated=false => ${session.status}`)
  }

  // ---------- 登录 ----------
  {
    const wrong = await api('/api/admin/login', { method: 'POST', cookie: '', body: { password: 'nope' } })
    check(wrong.status === 401, `密码错误 => ${wrong.status}（剩余尝试 ${wrong.payload?.remainingAttempts}）`)

    const login = await api('/api/admin/login', { method: 'POST', cookie: '', body: { password: ADMIN_PASSWORD } })
    check(login.status === 200 && login.payload?.ok === true, `登录成功 => ${login.status}`)
    check(cookieJar.includes('nte_admin_session'), `下发会话 Cookie => ${cookieJar.split(';')[0]}`)

    const session = await api('/api/admin/session')
    check(session.payload?.authenticated === true, `登录后 session.authenticated=true`)
  }

  // ---------- 题目：新建（含截图上传） ----------
  {
    const create = await api('/api/admin/questions', {
      method: 'POST',
      body: {
        name: 'QA 测试题 A',
        types: ['lost-wallet'],
        district: '',
        description: '由 qa-server 创建',
        x: -33092.123,
        y: 71073.456,
        images: [{ dataUrl: pngDataUrl() }],
      },
    })
    check(create.status === 201, `创建题目 => ${create.status}`)
    const question = create.payload
    check(Boolean(question?.id?.startsWith('qb-')), `生成题目 id => ${question?.id}`)
    check(question?.source === 'question-bank', `来源标记 => ${question?.source}`)
    check(question?.images?.length === 1 && question.images[0].startsWith('/images/questions/'),
      `截图路径 => ${question?.images?.[0]}`)
    check(question?.x === -33092.123 && question?.y === 71073.456, `坐标原样保存 => ${question?.x}, ${question?.y}`)
    createdIds.push(question.id)

    // 截图必须真的能取到
    const image = await api(question.images[0], { raw: true, cookie: '' })
    check(image.status === 200 && image.payload.length > 0,
      `上传的截图可访问 => ${image.status} ${image.payload?.length} bytes`)
    check(image.headers.get('content-type')?.includes('image/png'),
      `截图 Content-Type => ${image.headers.get('content-type')}`)
  }

  // ---------- 校验：非法输入 ----------
  {
    const badCoords = await api('/api/admin/questions', {
      method: 'POST',
      body: { name: 'bad', types: ['lost-wallet'], x: 'abc', y: 1, images: [] },
    })
    check(badCoords.status === 400, `坐标非数字 => ${badCoords.status} ${badCoords.payload?.error}`)

    const badTypes = await api('/api/admin/questions', {
      method: 'POST',
      body: { name: 'bad', types: [], x: 1, y: 1, images: [] },
    })
    check(badTypes.status === 400, `types 为空 => ${badTypes.status}`)

    // 伪装成图片的文本：魔数校验必须拦下
    const fakeImage = await api('/api/admin/questions', {
      method: 'POST',
      body: {
        name: 'bad image',
        types: ['lost-wallet'],
        x: 1,
        y: 1,
        images: [{ dataUrl: `data:image/png;base64,${Buffer.from('not an image at all').toString('base64')}` }],
      },
    })
    check(fakeImage.status === 400, `伪造图片被魔数校验拦下 => ${fakeImage.status} ${fakeImage.payload?.error}`)

    const missingImage = await api('/api/admin/questions', {
      method: 'POST',
      body: { name: 'no image', types: ['lost-wallet'], x: 1, y: 1, images: [] },
    })
    check(missingImage.status === 201, `允许先建无截图草稿 => ${missingImage.status}`)
    if (missingImage.status === 201) createdIds.push(missingImage.payload.id)
  }

  // ---------- 题目：列表 / 搜索 / 分页 / 分类筛选 ----------
  {
    const list = await api('/api/admin/questions?source=question-bank&limit=100')
    check(list.status === 200 && list.payload.total >= 2,
      `题库列表 => total ${list.payload?.total}`)
    check(list.payload.items.every((item) => item.source === 'question-bank'),
      `来源筛选生效（全部是自建题）`)

    // 默认不传 source 时应看到全部 —— 内置题都在 map-data 里，
    // 默认只给 question-bank 会让列表为空、分类筛选也无从谈起
    const defaultList = await api('/api/admin/questions?limit=1')
    check(defaultList.payload.source === 'all' && defaultList.payload.total > 0,
      `默认来源为 all => source=${defaultList.payload?.source} total=${defaultList.payload?.total}`)
    check(defaultList.payload.total > list.payload.total,
      `默认总数大于仅自建题 => ${defaultList.payload?.total} > ${list.payload?.total}`)

    const search = await api('/api/admin/questions?q=QA%20测试题')
    check(search.payload.total >= 1, `搜索命中 => ${search.payload?.total}`)

    const paged = await api('/api/admin/questions?limit=1&offset=0')
    check(paged.payload.items.length === 1, `分页 limit=1 => 返回 ${paged.payload?.items?.length} 条`)

    const all = await api('/api/admin/questions?source=all&limit=5')
    check(all.payload.total > 0, `source=all 能看到内置点位 => ${all.payload?.total}`)

    // ---- 分类筛选 ----
    const options = await api('/api/admin/questions/category-options?source=all')
    check(options.status === 200 && Array.isArray(options.payload.items),
      `分类选项接口可用 => ${options.payload?.items?.length} 个分类`)
    check(options.payload.items.every((item) => item.count > 0),
      `分类选项只含有题的分类（不含空分类）`)
    check(options.payload.items.every((item) => item.id && item.label && item.group),
      `分类选项带 id / label / group`)

    // 选项里的计数必须与按该分类筛选出来的 total 吻合
    const sample = options.payload.items[0]
    if (sample) {
      const filtered = await api(`/api/admin/questions?category=${encodeURIComponent(sample.id)}&limit=1`)
      check(filtered.payload.total === sample.count,
        `分类筛选计数一致 => ${sample.label}: 选项 ${sample.count} vs 筛选 ${filtered.payload?.total}`)
      check(filtered.payload.items.every((item) => item.types.includes(sample.id)),
        `筛选结果都真的属于该分类`)
    }

    // 多选（逗号分隔）
    const twoCategories = options.payload.items.slice(0, 2).map((item) => item.id)
    if (twoCategories.length === 2) {
      const multi = await api(`/api/admin/questions?category=${twoCategories.join(',')}&limit=1`)
      const expected = options.payload.items
        .filter((item) => twoCategories.includes(item.id))
        .reduce((sum, item) => sum + item.count, 0)
      check(multi.payload.total === expected && multi.payload.categoryIds.length === 2,
        `多选分类 => ${twoCategories.join('+')} total=${multi.payload?.total}（期望 ${expected}）`)
    }

    // 非法分类值应被忽略，不能悄悄变成「筛选了别的分类」或报 500
    const bogus = await api('/api/admin/questions?category=bad%3BDROP%20TABLE&limit=1')
    check(bogus.status === 200 && bogus.payload.categoryIds.length === 0,
      `非法分类值被忽略 => categoryIds=[${bogus.payload?.categoryIds?.join(',')}]`)

    // 分类 + 来源组合：自建题里不会有「未标注」这个分类
    const combo = await api('/api/admin/questions?category=unlabeled&source=question-bank&limit=1')
    check(combo.status === 200 && combo.payload.total === 0,
      `分类与来源可组合 => unlabeled + question-bank total=${combo.payload?.total}`)
  }

  // ---------- 题目：修改 ----------
  {
    const id = createdIds[0]
    const update = await api(`/api/admin/questions/${id}`, {
      method: 'PUT',
      body: { name: 'QA 测试题 A（已改名）', x: -1000.5, y: 2000.25 },
    })
    check(update.status === 200 && update.payload.name === 'QA 测试题 A（已改名）',
      `修改题目 => ${update.status} ${update.payload?.name}`)
    check(update.payload.x === -1000.5 && update.payload.y === 2000.25, `坐标已更新 => ${update.payload?.x}, ${update.payload?.y}`)
    check(update.payload.images.length === 1, `未传 images 时保留原截图 => ${update.payload?.images?.length}`)

    // 替换截图：旧图应被清理
    const replace = await api(`/api/admin/questions/${id}`, {
      method: 'PUT',
      body: { images: [{ dataUrl: pngDataUrl() }] },
    })
    check(replace.status === 200 && replace.payload.images.length === 1, `替换截图 => ${replace.payload?.images?.[0]}`)

    const missing = await api('/api/admin/questions/qb-does-not-exist', { method: 'PUT', body: { name: 'x' } })
    check(missing.status === 404, `修改不存在的题目 => ${missing.status}`)
  }

  // ---------- 批量提交 ----------
  {
    const batch = await api('/api/admin/questions/batch', {
      method: 'POST',
      body: {
        questions: [
          { name: 'QA 批量 1', types: ['lost-wallet'], x: 100, y: 200, images: [{ dataUrl: pngDataUrl() }] },
          { name: 'QA 批量 2', types: ['lost-wallet'], x: 300, y: 400, images: [{ dataUrl: pngDataUrl() }] },
          // 故意坏一条：坐标非法
          { name: 'QA 批量 坏数据', types: ['lost-wallet'], x: 'oops', y: 1, images: [{ dataUrl: pngDataUrl() }] },
        ],
      },
    })
    check(batch.status === 200, `批量提交 HTTP 状态 => ${batch.status}`)
    check(batch.payload.created === 2 && batch.payload.failed === 1,
      `部分失败被如实报告 => created ${batch.payload?.created} / failed ${batch.payload?.failed}`)
    check(batch.payload.problems?.[0]?.message?.includes('x'),
      `失败原因可读 => ${batch.payload.problems?.[0]?.message}`)
    batch.payload.items.forEach((item) => createdIds.push(item.id))

    // 新题应出现在 bootstrap 里（游戏站能抽到）
    const bootstrap = await api('/api/bootstrap')
    const batchIds = batch.payload.items.map((item) => item.id)
    const visible = bootstrap.payload.locations.filter((item) => batchIds.includes(item.id))
    check(visible.length === 2, `新题立即出现在 /api/bootstrap => ${visible.length} 条`)
  }

  // ---------- 分类管理 ----------
  {
    const list = await api('/api/admin/categories')
    check(list.payload.items.length > 0, `分类列表 => ${list.payload?.items?.length} 个`)
    // 分类的引用计数必须真的等于引用它的点位数。
    // 这里曾经因为 SQL 里 GROUP BY 到 json_each 的列上而恒为 0（静默出错）。
    const bootstrapForCounts = await api('/api/bootstrap?includeAll=1')
    const expected = new Map()
    for (const location of bootstrapForCounts.payload.locations) {
      for (const type of location.types || []) expected.set(type, (expected.get(type) || 0) + 1)
    }
    const mismatched = list.payload.items.filter((item) => (item.count || 0) !== (expected.get(item.id) || 0))
    check(mismatched.length === 0,
      `分类引用计数与点位一致 => 不一致 ${mismatched.length} 个${mismatched.length ? `（${mismatched.map((i) => `${i.id}:${i.count}≠${expected.get(i.id) || 0}`).join(', ')}）` : ''}`)
    check(list.payload.items.every((item) => typeof item.count === 'number'),
      `分类带引用计数 => 例如 ${list.payload.items[0]?.label}=${list.payload.items[0]?.count}`)

    const create = await api('/api/admin/categories', {
      method: 'POST',
      body: { id: 'qa-category', group: 'QA', label: 'QA 分类', color: '#123456' },
    })
    check(create.status === 201, `新建分类 => ${create.status}`)

    const duplicate = await api('/api/admin/categories', {
      method: 'POST',
      body: { id: 'qa-category', group: 'QA', label: '重复' },
    })
    check(duplicate.status === 409, `重复分类 id => ${duplicate.status}`)

    // 建一个引用该分类的题目，再删分类，点位应被改到兜底分类
    const withCategory = await api('/api/admin/questions', {
      method: 'POST',
      body: { name: 'QA 用自定义分类', types: ['qa-category'], x: 5, y: 6, images: [{ dataUrl: pngDataUrl() }] },
    })
    check(withCategory.status === 201, `用自定义分类建题 => ${withCategory.status}`)
    createdIds.push(withCategory.payload.id)

    const removeCategory = await api('/api/admin/categories/qa-category', { method: 'DELETE' })
    check(removeCategory.status === 200 && removeCategory.payload.reassigned === 1,
      `删除分类并改派点位 => reassigned ${removeCategory.payload?.reassigned}`)

    const afterUpdate = await api(`/api/admin/questions/${withCategory.payload.id}`)
    check(afterUpdate.payload.types.includes('question-bank'),
      `被改派到兜底分类 => ${JSON.stringify(afterUpdate.payload?.types)}`)
  }

  // ---------- 删除题目 ----------
  {
    const id = createdIds[0]
    const before = await api(`/api/admin/questions/${id}`)
    const imagePath = before.payload.images[0]

    const remove = await api(`/api/admin/questions/${id}`, { method: 'DELETE' })
    check(remove.status === 200 && remove.payload.ok === true, `删除题目 => ${remove.status}`)
    check(remove.payload.removedImages?.includes(imagePath),
      `删除时清理了独占截图 => ${remove.payload.removedImages?.[0]}`)

    const gone = await api(`/api/admin/questions/${id}`)
    check(gone.status === 404, `删除后再查 => ${gone.status}`)

    const image = await api(imagePath, { raw: true, cookie: '' })
    check(image.status === 404, `截图文件已删除 => ${image.status}`)

    const again = await api(`/api/admin/questions/${id}`, { method: 'DELETE' })
    check(again.status === 404, `重复删除 => ${again.status}`)
  }

  // ---------- 瓦片 ----------
  {
    const tile = await api('/mapsource-tiles/0/25/25.jpg', { raw: true, cookie: '' })
    const available = tile.status === 200
    if (available) {
      check(tile.payload.length > 1000 && tile.headers.get('content-type')?.includes('image/jpeg'),
        `瓦片可访问 => ${tile.payload.length} bytes ${tile.headers.get('content-type')}`)
    } else {
      check(false, `瓦片不可访问 => HTTP ${tile.status}（请确认 TILES_DIR 指向 MapSource/tiles）`)
    }

    const badTile = await api('/mapsource-tiles/0/abc/25.jpg', { raw: true, cookie: '' })
    check(badTile.status === 400, `非法瓦片坐标 => ${badTile.status}`)

    const missingTile = await api('/mapsource-tiles/0/9999/9999.jpg', { raw: true, cookie: '' })
    check(missingTile.status === 404, `不存在的瓦片 => ${missingTile.status}`)
  }

  // ---------- 登出 ----------
  {
    const logout = await api('/api/admin/logout', { method: 'POST' })
    check(logout.status === 200, `登出 => ${logout.status}`)

    const afterLogout = await api('/api/admin/questions', { cookie: '' })
    check(afterLogout.status === 401, `登出后后台接口再次被拦截 => ${afterLogout.status}`)
  }
} catch (error) {
  failures.push(`执行过程中抛出异常：${error.message}`)
} finally {
  await stopServer()
}

console.log('=== NTE 图寻 · 服务端 API 校验 ===')
for (const note of notes) console.log(note)
if (failures.length) {
  console.log('\n失败项：')
  for (const failure of failures) console.log(`  x ${failure}`)
  process.exitCode = 1
} else {
  console.log('\n全部通过。')
}
