// 请求数据校验小工具。
//
// 不用 JSON Schema 库：字段不多，手写校验能给出更具体的中文错误，
// 也少一层依赖。所有校验失败都抛 ValidationError，由统一错误处理转成 400。

export class ValidationError extends Error {
  constructor(message, details = []) {
    super(message)
    this.statusCode = 400
    this.details = details
  }
}

export function isValidId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value)
}

export function requireId(value, field = 'id') {
  if (!isValidId(value)) {
    throw new ValidationError(`${field} 不合法：只允许字母、数字、下划线、连字符，长度 1-80`)
  }
  return value
}

export function optionalString(value, { field, maxLength = 200, fallback = '' } = {}) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'string') throw new ValidationError(`${field} 必须是字符串`)
  const trimmed = value.trim()
  if (trimmed.length > maxLength) {
    throw new ValidationError(`${field} 过长（最多 ${maxLength} 个字符）`)
  }
  return trimmed
}

export function requireCoordinate(value, field) {
  const number = Number(value)
  if (!Number.isFinite(number)) {
    throw new ValidationError(`${field} 必须是有限数字（游戏真实坐标）`)
  }
  // 游戏坐标量级在 ±1e6 以内，超出基本可判定是错误数据
  if (Math.abs(number) > 1e7) {
    throw new ValidationError(`${field} 超出合理范围（±1e7）`)
  }
  return Number(number.toFixed(3))
}

export function optionalStringArray(value, { field, maxItems = 40, maxLength = 60 } = {}) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new ValidationError(`${field} 必须是数组`)
  if (value.length > maxItems) throw new ValidationError(`${field} 最多 ${maxItems} 项`)
  return value.map((item) => optionalString(item, { field, maxLength })).filter(Boolean)
}

export function requireIdArray(value, { field, minItems = 1 } = {}) {
  const items = optionalStringArray(value, { field })
  if (items.length < minItems) throw new ValidationError(`${field} 至少需要 ${minItems} 项`)
  for (const item of items) requireId(item, field)
  return items
}

// 截图输入：{ dataUrl } 上传新图，或 { path } 复用已有图
export function normalizeImagesInput(value) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new ValidationError('images 必须是数组')
  return value.map((item, index) => {
    if (typeof item === 'string') {
      // 兼容直接传路径数组
      if (!item.startsWith('/images/')) {
        throw new ValidationError(`images[${index}] 路径必须以 /images/ 开头`)
      }
      return { path: item }
    }
    if (!item || typeof item !== 'object') {
      throw new ValidationError(`images[${index}] 必须是 { dataUrl } 或 { path }`)
    }
    if (typeof item.dataUrl === 'string' && item.dataUrl) {
      return { dataUrl: item.dataUrl }
    }
    if (typeof item.path === 'string' && item.path) {
      if (!item.path.startsWith('/images/')) {
        throw new ValidationError(`images[${index}].path 必须以 /images/ 开头`)
      }
      return { path: item.path }
    }
    throw new ValidationError(`images[${index}] 缺少 dataUrl 或 path`)
  })
}

export function parsePositiveInt(value, { field, fallback, min = 0, max = 1000 }) {
  if (value === undefined || value === null || value === '') return fallback
  const number = Number.parseInt(value, 10)
  if (!Number.isFinite(number)) throw new ValidationError(`${field} 必须是整数`)
  return Math.min(max, Math.max(min, number))
}
