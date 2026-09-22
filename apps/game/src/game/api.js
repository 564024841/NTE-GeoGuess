// 后端 API 客户端。
//
// 游戏站是只读的：只需要 bootstrap 与 health。
// API_BASE 默认空 = 同源（生产由 nginx 反代，开发由 vite proxy 转发）。

const API_BASE = (import.meta.env.VITE_API_BASE || '').replace(/\/+$/, '')

export function apiUrl(pathname) {
  const normalized = pathname.startsWith('/') ? pathname : `/${pathname}`
  return `${API_BASE}${normalized}`
}

class ApiError extends Error {
  constructor(message, { status, payload } = {}) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.payload = payload
  }
}

async function request(pathname, { timeoutMs = 15000, ...options } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(apiUrl(pathname), {
      ...options,
      signal: controller.signal,
      headers: { Accept: 'application/json', ...(options.headers || {}) },
    })

    const payload = await response.json().catch(() => null)
    if (!response.ok) {
      throw new ApiError(payload?.error || `请求失败（HTTP ${response.status}）`, {
        status: response.status,
        payload,
      })
    }
    return payload
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new ApiError('请求超时，请检查网络或稍后重试', { status: 0 })
    }
    if (error instanceof ApiError) throw error
    throw new ApiError(`无法连接服务端：${error.message}`, { status: 0 })
  } finally {
    clearTimeout(timer)
  }
}

export function fetchHealth() {
  return request('/api/health', { timeoutMs: 5000 })
}

// 一次拿全地图元数据、坐标标定、分类与点位
export function fetchBootstrap() {
  return request('/api/bootstrap', { timeoutMs: 30000 })
}

export { ApiError }
