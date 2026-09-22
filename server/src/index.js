// 图寻服务端入口。
//
// 职责：
//   · 提供题库 API（公共只读 + 后台管理）
//   · 托管截图、分类图标与底图瓦片
//   · 首次启动把内置地图数据快照导入 SQLite
//
// 静态前端（游戏站 / 后台站）由 nginx 或对象存储托管，
// 本服务只负责数据与素材；需要同源部署时把它们的构建产物挂到 STATIC_DIR。

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import helmet from '@fastify/helmet'
import fastifyStatic from '@fastify/static'

import { config, describeConfig } from './config.js'
import { databaseStatus, closeDatabase } from './db.js'
import { seedIfNeeded } from './seed.js'
import { registerPublicRoutes } from './routes/public.js'
import { registerAdminRoutes } from './routes/admin.js'
import { UploadError, countUploadedImages } from './uploads.js'
import { ValidationError } from './validate.js'

function requestPathname(url) {
  return String(url || '').split('?')[0] || '/'
}

function sendHtmlFile(reply, filePath) {
  reply.type('text/html; charset=utf-8')
  // 深链接（/admin/xxx、/some/route）回落到入口 HTML —— 同样不能缓存住旧引用
  reply.header('Cache-Control', 'no-cache')
  return reply.send(fs.createReadStream(filePath))
}

export async function buildServer({ logger = true } = {}) {
  const app = Fastify({
    logger: logger
      ? {
          level: config.logLevel,
          // 生产环境用单行 JSON，开发环境给个简洁格式
          transport: config.isProduction
            ? undefined
            : undefined,
        }
      : false,
    bodyLimit: config.bodyLimitBytes,
    // 容器里通常在 nginx 后面，取 X-Forwarded-For 作为真实 IP（登录限流要用）
    trustProxy: true,
  })

  await app.register(helmet, {
    // 素材要被前端跨域加载（游戏站与后台站可能是不同源）
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    contentSecurityPolicy: false,
  })

  await app.register(cookie)

  // 允许后台前端跨域访问。只对 /api/admin/* 放开，并带上凭证（Cookie）。
  const allowedOrigins = new Set(config.corsOrigins)
  app.addHook('onRequest', async (request, reply) => {
    const origin = request.headers.origin
    if (!origin || !allowedOrigins.has(origin)) return
    reply.header('Access-Control-Allow-Origin', origin)
    reply.header('Access-Control-Allow-Credentials', 'true')
    reply.header('Vary', 'Origin')
  })
  app.options('/api/*', async (request, reply) => {
    const origin = request.headers.origin
    if (origin && allowedOrigins.has(origin)) {
      reply.header('Access-Control-Allow-Origin', origin)
      reply.header('Access-Control-Allow-Credentials', 'true')
      reply.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS')
      reply.header('Access-Control-Allow-Headers', 'Content-Type')
    }
    reply.code(204).send()
  })

  // 统一错误处理：业务错误给具体信息，未知错误不泄露内部细节
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof UploadError || error instanceof ValidationError) {
      reply.code(error.statusCode ?? 400).send({
        error: error.message,
        details: error.details ?? [],
      })
      return
    }
    if (error.validation) {
      reply.code(400).send({ error: '请求参数不合法', details: [error.message] })
      return
    }
    if (error.statusCode === 413) {
      reply.code(413).send({ error: '请求体过大，截图请压缩到 8MB 以内' })
      return
    }
    request.log.error({ err: error }, '未处理的请求错误')
    const status = error.statusCode && error.statusCode < 500 ? error.statusCode : 500
    reply.code(status).send({
      error: status < 500 ? error.message : '服务端异常，请查看服务端日志',
    })
  })

  // ---------------- 静态素材 ----------------

  // 内置点位截图（仓库自带，只读）
  if (fs.existsSync(config.seedImagesDir)) {
    await app.register(fastifyStatic, {
      root: config.seedImagesDir,
      prefix: '/images/locations/',
      decorateReply: false,
      maxAge: '7d',
    })
  } else {
    app.log.warn(`[静态] 未找到内置截图目录：${config.seedImagesDir}`)
  }

  // 后台上传的题库截图（可写）
  fs.mkdirSync(config.uploadsDir, { recursive: true })
  await app.register(fastifyStatic, {
    root: config.uploadsDir,
    prefix: '/images/questions/',
    decorateReply: false,
    maxAge: '1h',
  })

  // 分类图标
  if (fs.existsSync(config.iconsDir)) {
    await app.register(fastifyStatic, {
      root: config.iconsDir,
      prefix: '/icons/',
      decorateReply: false,
      maxAge: '7d',
    })
  }

  // 前端构建产物（同源部署时用）：
  //   /            -> 游戏站
  //   /admin(/...) -> 后台站
  let gameIndexFile = null
  let adminIndexFile = null

  // 前端产物里，带内容哈希的 js/css/图片可以放心长缓存；但**入口 HTML 不能**：
  // 发新版本后 HTML 引用的旧 JS 文件已经不存在（哈希变了），浏览器拿着缓存里的旧 HTML
  // 去请求旧文件名，只会拿到 SPA 兜底页（HTML），表现为「白屏 / 看不到新功能 / 后台地图没瓦片」。
  // 所以入口 HTML 一律 no-cache（每次用 ETag/Last-Modified 重新校验），其余按 maxAge 缓存。
  const frontendHeaders = (res, filePath) => {
    res.setHeader(
      'Cache-Control',
      filePath.endsWith('.html') ? 'no-cache' : 'public, max-age=3600',
    )
  }

  const gameStaticDir = process.env.STATIC_DIR ? path.resolve(process.env.STATIC_DIR) : ''
  if (gameStaticDir && fs.existsSync(gameStaticDir)) {
    gameIndexFile = path.join(gameStaticDir, 'index.html')
    await app.register(fastifyStatic, {
      root: gameStaticDir,
      prefix: '/',
      decorateReply: false,
      cacheControl: false,
      setHeaders: frontendHeaders,
    })
  } else if (process.env.STATIC_DIR) {
    app.log.warn(`[静态] STATIC_DIR 不存在：${gameStaticDir}`)
  }

  const adminStaticDir = process.env.ADMIN_STATIC_DIR ? path.resolve(process.env.ADMIN_STATIC_DIR) : ''
  if (adminStaticDir && fs.existsSync(adminStaticDir)) {
    adminIndexFile = path.join(adminStaticDir, 'index.html')
    await app.register(fastifyStatic, {
      root: adminStaticDir,
      prefix: '/admin/',
      decorateReply: false,
      cacheControl: false,
      setHeaders: frontendHeaders,
    })
  } else if (process.env.ADMIN_STATIC_DIR) {
    app.log.warn(`[静态] ADMIN_STATIC_DIR 不存在：${adminStaticDir}`)
  }

  // ---------------- 业务路由 ----------------

  registerPublicRoutes(app)
  registerAdminRoutes(app)

  // 便于测试与健康检查
  app.decorate('config', config)
  app.decorate('stats', () => ({
    database: databaseStatus(),
    images: countUploadedImages(),
  }))

  app.setNotFoundHandler((request, reply) => {
    const pathname = requestPathname(request.url)
    const isApiPath = pathname === '/api' || pathname.startsWith('/api/')
    if (isApiPath) {
      reply.code(404).send({ error: `接口不存在：${request.method} ${request.url}` })
      return
    }

    const isAssetPath = pathname.startsWith('/images/')
      || pathname.startsWith('/icons/')
      || pathname.startsWith('/mapsource-tiles/')
    if (isAssetPath) {
      reply.code(404).send({ error: `资源不存在：${request.method} ${request.url}` })
      return
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      reply.code(404).send({ error: `路径不存在：${request.method} ${request.url}` })
      return
    }

    if (adminIndexFile && (pathname === '/admin' || pathname.startsWith('/admin/'))) {
      return sendHtmlFile(reply, adminIndexFile)
    }
    if (gameIndexFile) {
      return sendHtmlFile(reply, gameIndexFile)
    }

    reply.code(404).send({ error: `路径不存在：${request.method} ${request.url}` })
  })

  return app
}

// 底图瓦片抽样自检。
// 全量 3516 张逐个 stat 太慢，所以检查目录结构 + 抽样若干张：
// 覆盖 z=0 的四角与中心（最容易缺的就是边缘瓦片），以及低分辨率层的代表。
function checkTiles() {
  const root = config.tilesDir
  if (!fs.existsSync(root)) {
    return { ok: false, reason: `目录不存在（${root}）` }
  }

  const zoom0 = path.join(root, '0')
  if (!fs.existsSync(zoom0)) {
    return { ok: false, reason: '目录里没有 z=0 这一级（可能挂载了空目录）' }
  }

  let zoom0Dirs = 0
  try {
    zoom0Dirs = fs.readdirSync(zoom0, { withFileTypes: true })
      .filter((entry) => entry.isDirectory()).length
  } catch (error) {
    return { ok: false, reason: `无法读取 z=0 目录：${error.message}` }
  }
  if (zoom0Dirs === 0) {
    return { ok: false, reason: 'z=0 下没有任何 x 目录（目录是空的）' }
  }

  // 抽样：z=0 的四角 + 中心（用实际存在的最大 x 目录号推算，不写死 50）
  const maxX = zoom0Dirs - 1
  const midX = Math.floor(maxX / 2)
  const samples = [
    [0, 0, 0], [0, 0, maxX], [0, maxX, 0], [0, maxX, maxX], [0, midX, midX],
    [-3, Math.floor(maxX / 8), Math.floor(maxX / 8)],
  ].map(([z, x, y]) => ({ z, x, y, file: path.join(root, String(z), String(x), `${y}.jpg`) }))

  for (const sample of samples) {
    if (!fs.existsSync(sample.file)) {
      return {
        ok: false,
        zoom0Dirs,
        reason: `缺少瓦片 ${sample.z}/${sample.x}/${sample.y}.jpg（瓦片不完整）`,
      }
    }
  }

  return { ok: true, zoom0Dirs, checked: samples.length }
}

async function main() {
  const app = await buildServer()

  app.log.info({ config: describeConfig() }, '[启动] 配置')

  const seedStats = seedIfNeeded(app.log)
  if (seedStats && !seedStats.skipped) {
    app.log.info({ seedStats }, '[启动] 内置数据导入完成')
  }

  if (!config.adminPassword) {
    app.log.warn('[启动] 未设置 ADMIN_PASSWORD，后台接口已禁用（登录会返回 503）')
  }

  // 瓦片自检。
  // 只判断「目录存在」不够：目录在但里面是空的（例如挂载点建了却忘了放瓦片），
  // 服务端会照常启动，然后所有瓦片 404、底图全黑——这种状态很难排查。
  // 所以这里抽样检查目录结构，必要时用 REQUIRE_TILES=1 直接拒绝启动。
  const tiles = checkTiles()
  if (tiles.ok) {
    app.log.info(
      `[启动] 底图瓦片就绪：${config.tilesDir}`
      + `（z=0 下 ${tiles.zoom0Dirs} 个 x 目录，抽样 ${tiles.checked} 张全部存在）`,
    )
  } else {
    const message = `[启动] 底图瓦片不可用：${config.tilesDir}\n`
      + `       原因：${tiles.reason}\n`
      + '       底图会全部 404、地图一片黑。\n'
      + '       处理：把 Maa-NTE/MapSource 的 tiles 放到该目录（npm run tiles:fetch），\n'
      + '             或设置 TILES_DIR 指向已有瓦片，或设 TILE_REDIRECT_BASE 交给 CDN。'
    if (config.requireTiles) {
      app.log.error(`${message}\n       REQUIRE_TILES=1，按配置拒绝启动。`)
      process.exitCode = 1
      return
    }
    app.log.warn(message)
  }

  try {
    await app.listen({ host: config.host, port: config.port })
  } catch (error) {
    app.log.error(error)
    process.exitCode = 1
  }

  const shutdown = async (signal) => {
    app.log.info(`[关闭] 收到 ${signal}，正在退出…`)
    try {
      await app.close()
      closeDatabase()
    } finally {
      process.exit(0)
    }
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

// 只有直接运行时才启动监听，被 import 时（测试/自检）不启动。
// Windows 的路径形态与 file:// URL 不同，用 pathToFileURL 稳妥。
const isDirectRun = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href
if (isDirectRun) {
  main()
}
