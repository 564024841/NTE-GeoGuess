// 后台接口：题库管理（全部需要登录）。

import crypto from 'node:crypto'
import {
  countLocations,
  countLocationsByCategory,
  deleteCategory,
  deleteLocation,
  deleteLocationsBySource,
  getCategory,
  getLocation,
  isImagePathUsed,
  listCategories,
  queryLocations,
  replaceCategories,
  upsertCategory,
  upsertLocation,
} from '../db.js'
import {
  checkLoginAllowed,
  issueSession,
  isPasswordConfigured,
  readSession,
  registerLoginFailure,
  registerLoginSuccess,
  requireAdmin,
  revokeSession,
  verifyPassword,
} from '../auth.js'
import { UploadError, deleteQuestionImage, saveQuestionImage } from '../uploads.js'
import { config } from '../config.js'
import {
  ValidationError,
  normalizeImagesInput,
  optionalString,
  optionalStringArray,
  parsePositiveInt,
  requireCoordinate,
  requireId,
  requireIdArray,
} from '../validate.js'
import { CUSTOM_REGION_LABEL, SOURCE_MAP_DATA, SOURCE_QUESTION_BANK } from '@nte-geoguess/shared/constants'

const LOGIN_MAX_ATTEMPTS = config.loginMaxAttempts

// 分类筛选参数解析：支持 category=a、category=a,b、category=a&category=b 三种写法。
// 分类 id 只允许字母数字下划线连字符，非法值直接忽略（避免拼进 SQL 参数之外的地方）。
function parseCategoryFilter(value) {
  if (value === undefined || value === null) return []
  const raw = Array.isArray(value) ? value : [value]
  const ids = raw
    .flatMap((item) => String(item).split(','))
    .map((item) => item.trim())
    .filter((item) => /^[A-Za-z0-9_-]{1,80}$/.test(item))
  return [...new Set(ids)]
}

function createQuestionId() {
  return `qb-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`
}

// 把请求体转成数据库记录。
// partial=true 时（PUT）只覆盖显式传入的字段。
function buildQuestionPayload(body, { partial = false, existing = null } = {}) {
  const payload = {}

  const has = (key) => Object.hasOwn(body, key) && body[key] !== undefined

  if (!partial || has('name')) {
    payload.name = optionalString(body.name, { field: 'name', maxLength: 60 })
  }
  if (!partial || has('types')) {
    payload.types = has('types') ? requireIdArray(body.types, { field: 'types' }) : [SOURCE_QUESTION_BANK]
  }
  if (!partial || has('district')) {
    payload.district = optionalString(body.district, { field: 'district', maxLength: 20 })
  }
  if (!partial || has('description')) {
    payload.description = optionalString(body.description, { field: 'description', maxLength: 200 })
  }
  if (!partial || has('tags')) {
    payload.tags = has('tags') ? optionalStringArray(body.tags, { field: 'tags', maxLength: 40 }) : []
  }
  if (!partial || has('x')) payload.x = requireCoordinate(body.x, 'x')
  if (!partial || has('y')) payload.y = requireCoordinate(body.y, 'y')

  return payload
}

// 截图处理：dataUrl 落盘，path 复用。
// 返回最终 images 数组；同时收集本次新写入的文件，失败时回滚删除。
function resolveImages({ questionId, imagesInput, previousImages = [] }) {
  if (!imagesInput) return { images: previousImages, written: [] }

  const images = []
  const written = []
  for (const item of imagesInput) {
    if (item.dataUrl) {
      const saved = saveQuestionImage({ questionId, dataUrl: item.dataUrl })
      images.push(saved.path)
      written.push(saved.path)
    } else if (item.path) {
      images.push(item.path)
    }
  }
  return { images, written }
}

// 清理不再被任何题目引用的上传截图
function cleanupOrphanImages(candidatePaths) {
  const removed = []
  for (const webPath of candidatePaths) {
    if (!isImagePathUsed(webPath) && deleteQuestionImage(webPath)) {
      removed.push(webPath)
    }
  }
  return removed
}

export function registerAdminRoutes(app) {
  // ---------- 登录 ----------

  app.post('/api/admin/login', async (request, reply) => {
    if (!isPasswordConfigured()) {
      reply.code(503).send({
        error: '服务端未配置 ADMIN_PASSWORD，后台已禁用。请设置环境变量后重启。',
      })
      return
    }

    const ip = request.ip
    const allowed = checkLoginAllowed(ip)
    if (!allowed.allowed) {
      reply.code(429).send({
        error: `尝试过于频繁，请在 ${allowed.retryAfterSeconds} 秒后重试`,
        retryAfterSeconds: allowed.retryAfterSeconds,
      })
      return
    }

    const body = request.body ?? {}
    if (!verifyPassword(body.password)) {
      const result = registerLoginFailure(ip)
      const remaining = Math.max(0, LOGIN_MAX_ATTEMPTS - result.attempts)
      reply.code(401).send({
        error: '密码不正确',
        remainingAttempts: remaining,
        lockedUntil: result.lockedUntil,
      })
      return
    }

    registerLoginSuccess(ip)
    const session = issueSession(reply, { userAgent: request.headers['user-agent'] })
    return { ok: true, expiresAt: session.expiresAt }
  })

  app.post('/api/admin/logout', async (request, reply) => {
    revokeSession(request, reply)
    return { ok: true }
  })

  app.get('/api/admin/session', async (request) => {
    const session = readSession(request)
    return session
      ? { authenticated: true, expiresAt: session.expiresAt }
      : { authenticated: false }
  })

  // ---------- 以下都需要登录 ----------

  app.get('/api/admin/questions', { preHandler: requireAdmin }, async (request) => {
    const q = optionalString(request.query?.q, { field: 'q', maxLength: 60 })
    // 默认 all：内置 476 道题都在 source=map-data 里，默认只看 question-bank
    // 会得到空列表，分类筛选也就无从谈起。要只看后台上传的题就显式传 source。
    const source = optionalString(request.query?.source, { field: 'source', maxLength: 20 }) || 'all'
    const limit = parsePositiveInt(request.query?.limit, { field: 'limit', fallback: 50, min: 1, max: 200 })
    const offset = parsePositiveInt(request.query?.offset, { field: 'offset', fallback: 0, min: 0, max: 1e6 })
    const categoryIds = parseCategoryFilter(request.query?.category)

    const result = queryLocations({ q, source, categoryIds, limit, offset })
    return { total: result.total, limit, offset, source, categoryIds, items: result.items }
  })

  // 分类筛选的选项与计数。按当前 source 统计，所以不会出现「选了却没有题」的空选项。
  // 必须注册在 /questions/:id 之前，否则 category-options 会被当成一个 id。
  app.get('/api/admin/questions/category-options', { preHandler: requireAdmin }, async (request) => {
    const source = optionalString(request.query?.source, { field: 'source', maxLength: 20 }) || 'all'
    const counts = countLocationsByCategory({ source })
    const items = listCategories()
      .filter((category) => !category.isHidden)
      .map((category) => ({
        id: category.id,
        label: category.label,
        group: category.group,
        color: category.color,
        count: counts[category.id] || 0,
      }))
      .filter((category) => category.count > 0)

    return { source, items }
  })

  app.get('/api/admin/questions/:id', { preHandler: requireAdmin }, async (request, reply) => {
    const id = requireId(request.params.id, 'id')
    const location = getLocation(id)
    if (!location) {
      reply.code(404).send({ error: '题目不存在' })
      return
    }
    return location
  })

  app.post('/api/admin/questions', { preHandler: requireAdmin }, async (request, reply) => {
    const body = request.body ?? {}
    const id = body.id ? requireId(body.id, 'id') : createQuestionId()

    if (getLocation(id)) {
      reply.code(409).send({ error: `题目 id 已存在：${id}` })
      return
    }

    const payload = buildQuestionPayload(body)
    let images = []
    let written = []
    try {
      const resolved = resolveImages({
        questionId: id,
        imagesInput: normalizeImagesInput(body.images),
      })
      images = resolved.images
      written = resolved.written
    } catch (error) {
      // 写盘失败时不要把已写入的图片留下
      for (const path of written) deleteQuestionImage(path)
      throw error
    }

    const location = upsertLocation({
      id,
      name: payload.name || `自建题目 ${id}`,
      types: payload.types,
      district: payload.district,
      description: payload.description,
      tags: payload.tags,
      images,
      x: payload.x,
      y: payload.y,
      source: SOURCE_QUESTION_BANK,
    })

    reply.code(201)
    return location
  })

  app.put('/api/admin/questions/:id', { preHandler: requireAdmin }, async (request, reply) => {
    const id = requireId(request.params.id, 'id')
    const existing = getLocation(id)
    if (!existing) {
      reply.code(404).send({ error: '题目不存在' })
      return
    }

    const body = request.body ?? {}
    const payload = buildQuestionPayload(body, { partial: true, existing })

    const imagesInput = Object.hasOwn(body, 'images') ? normalizeImagesInput(body.images) : null
    let images = existing.images
    let written = []
    const previousImages = [...existing.images]

    if (imagesInput) {
      try {
        const resolved = resolveImages({ questionId: id, imagesInput, previousImages: [] })
        images = resolved.images
        written = resolved.written
      } catch (error) {
        for (const path of written) deleteQuestionImage(path)
        throw error
      }
    }

    const location = upsertLocation({
      ...existing,
      ...payload,
      id,
      images,
      // 内置点位被后台修改时仍然保留原来源标记
      source: existing.source,
    })

    // 整体替换截图后，清理不再被引用的旧图
    if (imagesInput) {
      const dropped = previousImages.filter((path) => !images.includes(path))
      cleanupOrphanImages(dropped)
    }

    return location
  })

  app.delete('/api/admin/questions/:id', { preHandler: requireAdmin }, async (request, reply) => {
    const id = requireId(request.params.id, 'id')
    const existing = getLocation(id)
    if (!existing) {
      reply.code(404).send({ error: '题目不存在' })
      return
    }

    deleteLocation(id)
    const removedImages = cleanupOrphanImages(existing.images)
    return { ok: true, id, removedImages }
  })

  // 批量新建：后台「攒多题一次性提交」用。
  // 逐条独立处理，部分失败也返回 200 并在 problems 里说明。
  app.post('/api/admin/questions/batch', { preHandler: requireAdmin }, async (request, reply) => {
    const body = request.body ?? {}
    const questions = Array.isArray(body.questions) ? body.questions : null
    if (!questions || !questions.length) {
      reply.code(400).send({ error: 'questions 必须是非空数组' })
      return
    }
    if (questions.length > 100) {
      reply.code(400).send({ error: '单次最多提交 100 题' })
      return
    }

    const items = []
    const problems = []

    questions.forEach((input, index) => {
      try {
        const id = input?.id ? requireId(input.id, 'id') : createQuestionId()
        if (getLocation(id)) throw new ValidationError(`题目 id 已存在：${id}`)

        const payload = buildQuestionPayload(input ?? {})
        const resolved = resolveImages({
          questionId: id,
          imagesInput: normalizeImagesInput(input?.images),
        })
        if (!resolved.images.length) {
          throw new ValidationError('缺少截图')
        }

        items.push(upsertLocation({
          id,
          name: payload.name || `自建题目 ${id}`,
          types: payload.types,
          district: payload.district,
          description: payload.description,
          tags: payload.tags,
          images: resolved.images,
          x: payload.x,
          y: payload.y,
          source: SOURCE_QUESTION_BANK,
        }))
      } catch (error) {
        problems.push({ index, message: error.message })
      }
    })

    return {
      created: items.length,
      failed: problems.length,
      items,
      problems,
    }
  })

  // ---------- 分类 ----------

  app.get('/api/admin/categories', { preHandler: requireAdmin }, async () => {
    return { items: listCategories() }
  })

  app.post('/api/admin/categories', { preHandler: requireAdmin }, async (request, reply) => {
    const body = request.body ?? {}
    const id = requireId(body.id, 'id')
    if (getCategory(id)) {
      reply.code(409).send({ error: `分类 id 已存在：${id}` })
      return
    }
    const category = upsertCategory({
      id,
      group: optionalString(body.group, { field: 'group', maxLength: 20 }) || CUSTOM_REGION_LABEL,
      label: optionalString(body.label, { field: 'label', maxLength: 30 }) || id,
      icon: optionalString(body.icon, { field: 'icon', maxLength: 8 }) || '📷',
      iconUrl: optionalString(body.iconUrl, { field: 'iconUrl', maxLength: 200 }) || null,
      color: optionalString(body.color, { field: 'color', maxLength: 20 }) || '#8adfd6',
      isDefault: false,
      isHidden: Boolean(body.isHidden),
    })
    reply.code(201)
    return category
  })

  app.delete('/api/admin/categories/:id', { preHandler: requireAdmin }, async (request, reply) => {
    const id = requireId(request.params.id, 'id')
    if (!getCategory(id)) {
      reply.code(404).send({ error: '分类不存在' })
      return
    }
    const result = deleteCategory(id, SOURCE_QUESTION_BANK)
    return { ok: true, id, reassigned: result.reassigned }
  })

  // 后台概览数字
  app.get('/api/admin/overview', { preHandler: requireAdmin }, async () => {
    const counts = countLocations()
    return {
      ...counts,
      categories: listCategories().length,
      images: countUploadedImages(),
    }
  })

  // 按快照整体重建内置数据（分类体系变更、点位批量迁移时用）。
  // 只动 source=map-data 的行；后台上传的 source=question-bank 完全保留。
  // scripts/migrate-regions.mjs 会调用它，避免手工改库。
  app.post('/api/admin/resync', { preHandler: requireAdmin }, async (request, reply) => {
    const body = request.body ?? {}
    const locations = Array.isArray(body.locations) ? body.locations : null
    const categories = Array.isArray(body.categories) ? body.categories : null

    if (!locations || !locations.length) {
      reply.code(400).send({ error: 'locations 必须是非空数组' })
      return
    }
    if (!categories || !categories.length) {
      reply.code(400).send({ error: 'categories 必须是非空数组' })
      return
    }

    // 校验：引用闭合（每个点位的 types 都能在 categories 里找到）
    const categoryIds = new Set(categories.map((category) => category?.id).filter(Boolean))
    if (categoryIds.size !== categories.length) {
      reply.code(400).send({ error: 'categories 里有重复或缺失的 id' })
      return
    }
    const dangling = []
    for (const location of locations) {
      const types = Array.isArray(location?.types) ? location.types : []
      if (!types.length) dangling.push(`${location?.id}: 没有分类`)
      for (const type of types) {
        if (!categoryIds.has(type)) dangling.push(`${location?.id}: 引用了不存在的分类 ${type}`)
      }
      if (!Number.isFinite(Number(location?.x)) || !Number.isFinite(Number(location?.y))) {
        dangling.push(`${location?.id}: 坐标非法`)
      }
    }
    if (dangling.length) {
      reply.code(400).send({ error: '数据校验未通过', details: dangling.slice(0, 10) })
      return
    }

    const questionBankBefore = queryLocations({ source: SOURCE_QUESTION_BANK, limit: 1, offset: 0 }).total

    const removedIds = deleteLocationsBySource(SOURCE_MAP_DATA)
    for (const location of locations) {
      upsertLocation({
        id: location.id,
        name: location.name ?? '',
        types: location.types ?? [],
        district: location.district ?? '',
        description: location.description ?? '',
        tags: location.tags ?? [],
        images: Array.isArray(location.images) ? location.images : [],
        x: Number(location.x),
        y: Number(location.y),
        source: SOURCE_MAP_DATA,
      })
    }
    const categoryCount = replaceCategories(categories)

    const after = countLocations()
    const questionBankAfter = queryLocations({ source: SOURCE_QUESTION_BANK, limit: 1, offset: 0 }).total

    return {
      ok: true,
      removed: removedIds.length,
      locations: after.total,
      categories: categoryCount,
      puzzles: after.withImages,
      keptQuestionBank: questionBankAfter,
      questionBankUnchanged: questionBankBefore === questionBankAfter,
    }
  })
}
