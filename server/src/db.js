// SQLite 存储层。
//
// 设计取舍：
//   · 点位的 x/y 直接存游戏真实坐标，像素坐标由前端用共享的仿射变换算，
//     这样标定文件变了不需要迁移数据。
//   · images / tags / types 存 JSON 文本，SQLite 的 json1 扩展能直接查询，
//     对 1600 量级的点位完全够用，也避免多表 join 的复杂度。
//   · 用一个 meta 表记录 seed 版本，避免「启动时表非空就跳过 seed」这种判断
//     导致管理员清空题库后又被数据填回来。

import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { config } from './config.js'

fs.mkdirSync(config.dataDir, { recursive: true })
fs.mkdirSync(config.uploadsDir, { recursive: true })

export const db = new Database(config.databaseFile)

// WAL 模式：读写并发更好，容器里单文件也安全
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

const SCHEMA_VERSION = '3'

db.exec(`
  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS categories (
    id         TEXT PRIMARY KEY,
    "group"    TEXT NOT NULL DEFAULT '其他',
    label      TEXT NOT NULL,
    icon       TEXT,
    icon_url   TEXT,
    color      TEXT,
    is_default INTEGER NOT NULL DEFAULT 0,
    is_hidden  INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS locations (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL DEFAULT '',
    types       TEXT NOT NULL DEFAULT '[]',
    district    TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    tags        TEXT NOT NULL DEFAULT '[]',
    images      TEXT NOT NULL DEFAULT '[]',
    x           REAL NOT NULL,
    y           REAL NOT NULL,
    source      TEXT NOT NULL DEFAULT 'question-bank',
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_locations_source ON locations(source);
  CREATE INDEX IF NOT EXISTS idx_locations_district ON locations(district);

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    last_seen  TEXT,
    user_agent TEXT
  );

  CREATE TABLE IF NOT EXISTS login_attempts (
    ip           TEXT PRIMARY KEY,
    attempts     INTEGER NOT NULL DEFAULT 0,
    first_at     TEXT NOT NULL DEFAULT (datetime('now')),
    locked_until TEXT
  );
`)

export function getMeta(key) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key)
  return row?.value ?? null
}

export function setMeta(key, value) {
  db.prepare(`
    INSERT INTO meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, String(value))
}

// ---------------- 点位 ----------------

function rowToLocation(row) {
  if (!row) return null
  return {
    id: row.id,
    name: row.name,
    types: safeParseArray(row.types),
    district: row.district,
    description: row.description,
    tags: safeParseArray(row.tags),
    images: safeParseArray(row.images),
    x: row.x,
    y: row.y,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function safeParseArray(value) {
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function listLocations({ source = null, withImagesOnly = false } = {}) {
  const where = []
  const params = {}
  if (source) {
    where.push('source = @source')
    params.source = source
  }
  if (withImagesOnly) {
    where.push("images != '[]'")
  }
  const sql = `SELECT * FROM locations ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id`
  return db.prepare(sql).all(params).map(rowToLocation)
}

export function countLocations() {
  const total = db.prepare('SELECT COUNT(*) AS n FROM locations').get().n
  const withImages = db.prepare("SELECT COUNT(*) AS n FROM locations WHERE images != '[]'").get().n
  const questionBank = db.prepare("SELECT COUNT(*) AS n FROM locations WHERE source = 'question-bank'").get().n
  return { total, withImages, questionBank }
}

export function getLocation(id) {
  return rowToLocation(db.prepare('SELECT * FROM locations WHERE id = ?').get(id))
}

export function upsertLocation(location) {
  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO locations (id, name, types, district, description, tags, images, x, y, source, created_at, updated_at)
    VALUES (@id, @name, @types, @district, @description, @tags, @images, @x, @y, @source, @now, @now)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      types = excluded.types,
      district = excluded.district,
      description = excluded.description,
      tags = excluded.tags,
      images = excluded.images,
      x = excluded.x,
      y = excluded.y,
      source = excluded.source,
      updated_at = excluded.updated_at
  `).run({
    id: location.id,
    name: location.name ?? '',
    types: JSON.stringify(location.types ?? []),
    district: location.district ?? '',
    description: location.description ?? '',
    tags: JSON.stringify(location.tags ?? []),
    images: JSON.stringify(location.images ?? []),
    x: Number(location.x),
    y: Number(location.y),
    source: location.source ?? 'question-bank',
    now,
  })
  return getLocation(location.id)
}

export function deleteLocation(id) {
  const result = db.prepare('DELETE FROM locations WHERE id = ?').run(id)
  return result.changes > 0
}

// 分页 + 搜索 + 来源筛选 + 分类筛选
export function queryLocations({ q = '', source = 'all', categoryIds = [], limit = 50, offset = 0 } = {}) {
  const where = []
  const params = { limit, offset }
  if (source && source !== 'all') {
    where.push('source = @source')
    params.source = source
  }
  if (q) {
    where.push('(name LIKE @like OR id LIKE @like OR district LIKE @like)')
    params.like = `%${q}%`
  }

  // 分类筛选：点位可以属于多个分类（types 是数组），命中任意一个即算匹配。
  // 用 EXISTS + json_each 而不是 JOIN：JOIN 会让「同时属于多个分类」的点位
  // 在结果里出现多行，total 也会被算大。
  const wanted = (Array.isArray(categoryIds) ? categoryIds : []).filter(Boolean)
  if (wanted.length) {
    const placeholders = wanted.map((id, index) => {
      params[`category${index}`] = id
      return `@category${index}`
    })
    where.push(`EXISTS (
      SELECT 1 FROM json_each(locations.types)
      WHERE json_each.value IN (${placeholders.join(', ')})
    )`)
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const total = db.prepare(`SELECT COUNT(*) AS n FROM locations ${whereSql}`).get(params).n
  const items = db.prepare(`
    SELECT * FROM locations ${whereSql}
    ORDER BY created_at DESC, id DESC
    LIMIT @limit OFFSET @offset
  `).all(params).map(rowToLocation)
  return { total, items }
}

// 按分类统计点位数：列表的分类下拉用它显示「这个分类有多少题」，
// 避免出现选了之后一条都没有的空选项。
export function countLocationsByCategory({ source = 'all' } = {}) {
  const params = {}
  let where = ''
  if (source && source !== 'all') {
    where = 'WHERE source = @source'
    params.source = source
  }
  return db.prepare(`
    SELECT json_each.value AS category_id, COUNT(*) AS n
    FROM locations, json_each(locations.types)
    ${where}
    GROUP BY json_each.value
  `).all(params).reduce((map, row) => {
    map[row.category_id] = row.n
    return map
  }, {})
}

// 某个截图路径是否还被任何点位引用
export function isImagePathUsed(webPath) {
  const row = db.prepare(`
    SELECT COUNT(*) AS n FROM locations, json_each(locations.images) WHERE json_each.value = ?
  `).get(webPath)
  return row.n > 0
}

// ---------------- 分类 ----------------

function rowToCategory(row) {
  if (!row) return null
  return {
    id: row.id,
    group: row.group,
    label: row.label,
    icon: row.icon,
    iconUrl: row.icon_url,
    color: row.color,
    isDefault: Boolean(row.is_default),
    isHidden: Boolean(row.is_hidden),
    sortOrder: row.sort_order,
  }
}

export function listCategories() {
  // 注意：这里必须用 `json_each`.`value` 并显式加别名。
  // 直接写 `json_each.value AS id` 再 `GROUP BY type` 时，SQLite 会把 type
  // 解析成 json_each 自己的列（值是 'text'），导致所有分类的计数都被聚成一行，
  // 界面上一律显示 0（静默出错，不报错）。
  const counts = new Map(
    db.prepare(`
      SELECT json_each.value AS category_id, COUNT(*) AS n
      FROM locations, json_each(locations.types)
      GROUP BY json_each.value
    `).all().map((row) => [row.category_id, row.n]),
  )
  return db.prepare('SELECT * FROM categories ORDER BY sort_order, id').all()
    .map((row) => ({ ...rowToCategory(row), count: counts.get(row.id) || 0 }))
}

export function getCategory(id) {
  return rowToCategory(db.prepare('SELECT * FROM categories WHERE id = ?').get(id))
}

export function upsertCategory(category) {
  const existing = db.prepare('SELECT sort_order FROM categories WHERE id = ?').get(category.id)
  const sortOrder = existing?.sort_order ?? db.prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM categories').get().n
  db.prepare(`
    INSERT INTO categories (id, "group", label, icon, icon_url, color, is_default, is_hidden, sort_order, updated_at)
    VALUES (@id, @group, @label, @icon, @iconUrl, @color, @isDefault, @isHidden, @sortOrder, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      "group" = excluded."group",
      label = excluded.label,
      icon = excluded.icon,
      icon_url = excluded.icon_url,
      color = excluded.color,
      is_default = excluded.is_default,
      is_hidden = excluded.is_hidden,
      updated_at = datetime('now')
  `).run({
    id: category.id,
    group: category.group ?? '其他',
    label: category.label ?? category.id,
    icon: category.icon ?? null,
    iconUrl: category.iconUrl ?? null,
    color: category.color ?? null,
    isDefault: category.isDefault ? 1 : 0,
    isHidden: category.isHidden ? 1 : 0,
    sortOrder,
  })
  return getCategory(category.id)
}

// 删除分类：引用它的点位改到兜底分类，不连带删点位。
// 注意 json_each 也有 id 列，必须显式写 locations.id 并 DISTINCT，否则会取错列、也会重复。
export function deleteCategory(id, fallbackId = 'question-bank') {
  const affected = db.prepare(`
    SELECT DISTINCT locations.id AS location_id, locations.types AS types
    FROM locations, json_each(locations.types)
    WHERE json_each.value = ?
  `).all(id)

  const update = db.prepare('UPDATE locations SET types = ?, updated_at = ? WHERE id = ?')
  const now = new Date().toISOString()
  const run = db.transaction(() => {
    for (const row of affected) {
      const types = safeParseArray(row.types).filter((type) => type !== id)
      if (!types.includes(fallbackId)) types.push(fallbackId)
      update.run(JSON.stringify(types), now, row.location_id)
    }
    db.prepare('DELETE FROM categories WHERE id = ?').run(id)
  })
  run()
  return { removed: true, reassigned: affected.length }
}

export function countCategories() {
  return db.prepare('SELECT COUNT(*) AS n FROM categories').get().n
}

// ---------------- 会话与登录限流 ----------------

export function createSession({ tokenHash, expiresAt, userAgent }) {
  db.prepare(`
    INSERT INTO sessions (token_hash, expires_at, last_seen, user_agent)
    VALUES (?, ?, datetime('now'), ?)
  `).run(tokenHash, expiresAt, userAgent ?? null)
}

export function findSession(tokenHash) {
  const row = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(tokenHash)
  if (!row) return null
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash)
    return null
  }
  db.prepare('UPDATE sessions SET last_seen = datetime(\'now\') WHERE token_hash = ?').run(tokenHash)
  return row
}

export function deleteSession(tokenHash) {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash)
}

export function purgeExpiredSessions() {
  db.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')").run()
}

export function getLoginAttempts(ip) {
  return db.prepare('SELECT * FROM login_attempts WHERE ip = ?').get(ip) ?? null
}

export function recordLoginFailure(ip, { maxAttempts, windowMinutes }) {
  const now = Date.now()
  const existing = getLoginAttempts(ip)
  const windowMs = windowMinutes * 60 * 1000

  if (!existing) {
    db.prepare('INSERT INTO login_attempts (ip, attempts, first_at) VALUES (?, 1, datetime(\'now\'))').run(ip)
    return { attempts: 1, lockedUntil: null }
  }

  const firstAt = new Date(existing.first_at).getTime()
  const withinWindow = now - firstAt < windowMs
  const attempts = withinWindow ? existing.attempts + 1 : 1
  const lockedUntil = attempts >= maxAttempts
    ? new Date(now + windowMs).toISOString()
    : null

  db.prepare(`
    UPDATE login_attempts SET attempts = ?, first_at = ?, locked_until = ? WHERE ip = ?
  `).run(attempts, withinWindow ? existing.first_at : new Date().toISOString(), lockedUntil, ip)

  return { attempts, lockedUntil }
}

export function clearLoginFailures(ip) {
  db.prepare('DELETE FROM login_attempts WHERE ip = ?').run(ip)
}

// ---------------- 按快照重建（内置数据迁移用） ----------------

// 删除某个来源的点位，返回被删的 id
export function deleteLocationsBySource(source) {
  const rows = db.prepare('SELECT id FROM locations WHERE source = ?').all(source)
  if (!rows.length) return []
  const run = db.transaction(() => {
    db.prepare('DELETE FROM locations WHERE source = ?').run(source)
  })
  run()
  return rows.map((row) => row.id)
}

// 用一份新的分类表整体替换（后台上传时新增的分类也会被覆盖，所以先备份传入）
export function replaceCategories(categories) {
  const run = db.transaction(() => {
    db.prepare('DELETE FROM categories').run()
    categories.forEach((category, index) => {
      upsertCategoryFromSnapshot(category, index)
    })
  })
  run()
  return countCategories()
}

function upsertCategoryFromSnapshot(category, index) {
  db.prepare(`
    INSERT INTO categories (id, "group", label, icon, icon_url, color, is_default, is_hidden, sort_order, updated_at)
    VALUES (@id, @group, @label, @icon, @iconUrl, @color, @isDefault, @isHidden, @sortOrder, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      "group" = excluded."group",
      label = excluded.label,
      icon = excluded.icon,
      icon_url = excluded.icon_url,
      color = excluded.color,
      is_default = excluded.is_default,
      is_hidden = excluded.is_hidden,
      sort_order = excluded.sort_order,
      updated_at = excluded.updated_at
  `).run({
    id: category.id,
    group: category.group ?? '其他',
    label: category.label ?? category.id,
    icon: category.icon ?? null,
    iconUrl: category.iconUrl ?? null,
    color: category.color ?? null,
    isDefault: category.isDefault ? 1 : 0,
    isHidden: category.isHidden ? 1 : 0,
    sortOrder: Number.isFinite(index) ? index : 0,
  })
}

// ---------------- 首次启动 seed ----------------

export function isSeeded() {
  return getMeta('seed_version') === SCHEMA_VERSION
}

export function markSeeded(stats) {
  setMeta('seed_version', SCHEMA_VERSION)
  setMeta('seeded_at', new Date().toISOString())
  if (stats) setMeta('seed_stats', JSON.stringify(stats))
}

export function databaseStatus() {
  try {
    db.prepare('SELECT 1').get()
    return 'ok'
  } catch (error) {
    return `error: ${error.message}`
  }
}

export function closeDatabase() {
  try {
    db.close()
  } catch {
    /* 忽略关闭失败 */
  }
}

export { path }
