// 公共接口：游戏站用（无需登录）。

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { config } from '../config.js'
import { countCategories, countLocations, listCategories, listLocations } from '../db.js'
import { countUploadedImages } from '../uploads.js'
import { SOURCE_QUESTION_BANK } from '@nte-geoguess/shared/constants'

function readJsonFile(file, label) {
  if (!fs.existsSync(file)) {
    const error = new Error(`服务端缺少${label}：${file}`)
    error.statusCode = 500
    throw error
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

// 地图元数据与标定文件都很小且不变，启动时读一次缓存起来
let cachedMapConfig = null
let cachedCalibration = null

function mapConfig() {
  if (!cachedMapConfig) {
    const seed = readJsonFile(config.seedDataFile, '地图数据快照')
    cachedMapConfig = {
      ...seed.map,
      // 瓦片地址由服务端下发，便于换 CDN 而不重新构建前端
      tileUrl: config.tileUrlTemplate,
    }
  }
  return cachedMapConfig
}

function calibration() {
  if (!cachedCalibration) {
    cachedCalibration = readJsonFile(config.calibrationFile, '坐标标定文件')
  }
  return cachedCalibration
}

// 区域名标签的落点：优先用运行时可挂载的文件；读不到就返回空数组，
// 前端会回退到构建时内联的那份（packages/shared/data/region-positions.json）。
function regionPositions() {
  try {
    return readJsonFile(config.regionPositionsFile, '区域位置文件')
  } catch {
    return []
  }
}

// bootstrap 内容是「数据变了才变」，用 ETag 让浏览器复用缓存
function computeEtag(payload) {
  const hash = crypto.createHash('sha1')
  hash.update(JSON.stringify(payload.stats ?? {}))
  hash.update(String(payload.locations.length))
  hash.update(payload.locations.map((item) => `${item.id}:${item.updatedAt ?? ''}`).join(','))
  return `"${hash.digest('hex')}"`
}

// 条件请求比较。
// 反向代理（nginx 开 gzip 时）会把强 ETag 改写成弱标签 `W/"..."`，
// 客户端再发回来就是弱标签；这里按 RFC 9110 的弱比较语义去掉 W/ 前缀再比，
// 否则经过代理后每次都会 200，缓存复用失效、白白重传一份数据。
function etagMatches(ifNoneMatch, etag) {
  if (!ifNoneMatch) return false
  const normalized = (value) => value.trim().replace(/^W\//, '')
  return ifNoneMatch
    .split(',')
    .map((item) => normalized(item))
    .some((item) => item === '*' || item === normalized(etag))
}

export function registerPublicRoutes(app) {
  app.get('/healthz', async () => ({ status: 'ok' }))

  app.get('/api/health', async () => {
    return {
      status: 'ok',
      version: '1.0.0',
      uptimeSeconds: Math.round(process.uptime() * 10) / 10,
      database: 'ok',
    }
  })

  app.get('/api/stats', async () => {
    const locations = countLocations()
    return {
      locations: locations.total,
      puzzles: locations.withImages,
      questionBank: locations.questionBank,
      categories: countCategories(),
      images: countUploadedImages(),
    }
  })

  // 游戏站启动数据：一次请求拿全，避免多次往返
  app.get('/api/bootstrap', async (request, reply) => {
    const includeAll = request.query?.includeAll === '1'
    const locations = listLocations({ withImagesOnly: !includeAll })

    const counts = countLocations()
    const payload = {
      map: mapConfig(),
      calibration: calibration(),
      regionPositions: regionPositions(),
      categories: listCategories(),
      locations,
      stats: {
        locations: counts.total,
        puzzles: counts.withImages,
        questionBank: counts.questionBank,
        categories: countCategories(),
        categoriesWithPuzzles: new Set(locations.flatMap((item) => item.types)).size,
      },
      generatedAt: new Date().toISOString(),
    }

    const etag = computeEtag(payload)
    reply.header('ETag', etag)
    reply.header('Cache-Control', 'public, max-age=60')
    if (etagMatches(request.headers['if-none-match'], etag)) {
      reply.code(304)
      return null
    }
    return payload
  })

  // 底图瓦片：可以交给 nginx 直接读盘，这里是内置兜底实现。
  app.get('/mapsource-tiles/*', async (request, reply) => {
    // 路径整体是自由通配，所以坐标合法性要自己校验：
    // 这样 /mapsource-tiles/0/abc/25.jpg 会得到 400 而不是 404。
    // 注意 find-my-way 把通配段放在 request.params['*'] 里（键名就是星号）。
    const wildcard = request.params['*']
    const relative = String(wildcard || '').replace(/^\/+/, '')
    const match = /^(-?\d+)\/(\d+)\/(\d+)\.jpg$/.exec(relative)
    if (!match) {
      reply.code(400).send({
        error: '瓦片坐标不合法，应形如 /mapsource-tiles/{z}/{x}/{y}.jpg',
        received: relative,
      })
      return
    }
    const [, z, x, y] = match

    if (config.tileRedirectBase) {
      reply.redirect(`${config.tileRedirectBase.replace(/\/+$/, '')}/${z}/${x}/${y}.jpg`)
      return
    }

    const filePath = path.join(config.tilesDir, z, x, `${y}.jpg`)
    // 双保险：解析后的路径必须仍在瓦片目录内
    if (!path.resolve(filePath).startsWith(path.resolve(config.tilesDir))) {
      reply.code(403).send({ error: '禁止访问' })
      return
    }
    if (!fs.existsSync(filePath)) {
      reply.code(404).send({ error: '瓦片不存在' })
      return
    }
    reply.header('Content-Type', 'image/jpeg')
    reply.header('Cache-Control', 'public, max-age=604800, immutable')
    return reply.send(fs.createReadStream(filePath))
  })

  // 自建题目数量（后台顶栏与游戏页脚都可能用）
  app.get('/api/question-bank/summary', async () => {
    const locations = listLocations({ source: SOURCE_QUESTION_BANK })
    return {
      total: locations.length,
      withImages: locations.filter((item) => item.images.length > 0).length,
      latest: locations
        .slice()
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        .slice(0, 5)
        .map((item) => ({ id: item.id, name: item.name, createdAt: item.createdAt })),
    }
  })
}
