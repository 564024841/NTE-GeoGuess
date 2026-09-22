// 后台的 API 客户端：所有请求都从这里发出。
//
// 约定（见 docs/api-contract.md）：
//   · 鉴权靠 httpOnly 会话 Cookie，前端不需要拿 token，但每个请求必须带 credentials: 'include'
//   · 错误统一形状 { error, details? }，另外登录接口会额外带 remainingAttempts / retryAfterSeconds
//   · 这里把「网络不可达」「HTTP 错误」「会话过期」收敛成一个 ApiError，
//     让调用方只关心「有没有 message 要给用户看」，不用各自解析响应。

const API_BASE = (import.meta.env.VITE_API_BASE || '').replace(/\/+$/, '')

// 截图 / 图标 / 底图瓦片这些「服务端托管」的静态资源前缀。
//
// 必须用 API 前缀，**不能**用 Vite 的 BASE_URL：后台自己的构建产物在 /admin/ 下，
// 但服务端的静态资源挂在站点根路径（/images/**、/icons/**、/mapsource-tiles/**）。
// 用 BASE_URL 会拼出 /admin/images/... 这种地址，服务端找不到就落到后台的 SPA 兜底上
// （返回 200 + HTML），浏览器解码失败 —— 表现就是「后台里图标、截图、底图全裂」。
// 后台与 API 不同源（VITE_API_BASE）时，资源也跟着 API 走。
export const ASSET_BASE = (import.meta.env.VITE_API_BASE || '').replace(/\/+$/, '')

// 每个请求都带超时。
// 教训：服务端某个 preHandler 卡住时，请求会一直挂着不返回，
// 界面上表现成「永远在加载」，用户既看不到错误也不知道该干什么。
// 超时后必须变成一个可见的错误提示。
// 可用 VITE_API_TIMEOUT_MS 覆盖（自查脚本会把默认值调小，避免等太久）。
export const DEFAULT_TIMEOUT_MS = Number(import.meta.env.VITE_API_TIMEOUT_MS) || 15000
// 涉及上传/落盘的接口更慢一些（一批截图可能好几 MB）
const UPLOAD_TIMEOUT_MS = Math.max(DEFAULT_TIMEOUT_MS, 60000)

const TIMEOUT_REASON = Symbol('api-timeout')

export class ApiError extends Error {
  constructor(message, { status = 0, details = [], payload = null } = {}) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.details = details
    // 后端可能在 payload 里带额外字段（remainingAttempts / retryAfterSeconds / problems）
    this.payload = payload
  }
}

// 会话失效的唯一出口：由 useAuth 注册。
// 后台里任何一个接口返回 401 都说明 Cookie 过期了，此时必须把界面切回登录页，
// 否则用户会对着一个「看起来还登录着」的界面反复点失败的操作。
let unauthorizedHandler = null

export function setUnauthorizedHandler(handler) {
  unauthorizedHandler = handler
}

function buildUrl(path) {
  if (/^https?:/i.test(path)) return path
  return `${API_BASE}${path}`
}

function toQuery(params = {}) {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    search.set(key, String(value))
  }
  const query = search.toString()
  return query ? `?${query}` : ''
}

async function request(path, { method = 'GET', body, signal, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  // 外部 signal（切页/重复请求取消）与超时 signal 合到一个 controller 上
  const controller = new AbortController()
  const abortFromCaller = () => controller.abort(signal?.reason)
  if (signal) {
    if (signal.aborted) abortFromCaller()
    else signal.addEventListener('abort', abortFromCaller, { once: true })
  }
  const timer = timeoutMs > 0
    ? setTimeout(() => controller.abort(TIMEOUT_REASON), timeoutMs)
    : null

  const options = {
    method,
    credentials: 'include',
    headers: {},
    signal: controller.signal,
  }
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json'
    options.body = JSON.stringify(body)
  }

  let response
  try {
    response = await fetch(buildUrl(path), options)
  } catch (error) {
    if (controller.signal.reason === TIMEOUT_REASON) {
      const seconds = Math.round(timeoutMs / 1000)
      throw new ApiError(`服务端 ${seconds} 秒内没有响应，已放弃本次请求（后端可能卡住或仍在启动）`, { status: 0 })
    }
    // 主动取消（切换页面/重复请求）不该弹错误提示，原样抛出让调用方忽略
    if (error?.name === 'AbortError') throw error
    throw new ApiError('连不上服务端：请确认后端已启动（127.0.0.1:8787）', { status: 0 })
  } finally {
    if (timer) clearTimeout(timer)
    signal?.removeEventListener('abort', abortFromCaller)
  }

  if (response.status === 204) return null

  let payload = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }

  if (!response.ok) {
    // 登录接口的 401 是「密码不正确」，不是会话过期，不能触发登出
    const isLoginAttempt = path.startsWith('/api/admin/login')
    if (response.status === 401 && !isLoginAttempt) unauthorizedHandler?.()

    throw new ApiError(payload?.error || `请求失败（HTTP ${response.status}）`, {
      status: response.status,
      details: Array.isArray(payload?.details) ? payload.details : [],
      payload,
    })
  }

  return payload
}

export const api = {
  health: () => request('/api/health'),

  // 后台拿地图 + 分类 + 点位构建题库索引；includeAll 让后端连没截图的点位一起下发
  bootstrap: ({ includeAll = true } = {}) => request(`/api/bootstrap${includeAll ? '?includeAll=1' : ''}`),

  session: () => request('/api/admin/session'),
  login: (password) => request('/api/admin/login', { method: 'POST', body: { password } }),
  logout: () => request('/api/admin/logout', { method: 'POST' }),

  listQuestions: (params) => request(`/api/admin/questions${toQuery(params)}`),
  // 分类筛选的选项与计数（带 source，避免给出选了没题的分类）
  listQuestionCategoryOptions: (params) => request(`/api/admin/questions/category-options${toQuery(params)}`),
  createQuestion: (payload) => request(
    '/api/admin/questions',
    { method: 'POST', body: payload, timeoutMs: UPLOAD_TIMEOUT_MS },
  ),
  updateQuestion: (id, payload) => request(
    `/api/admin/questions/${encodeURIComponent(id)}`,
    { method: 'PUT', body: payload, timeoutMs: UPLOAD_TIMEOUT_MS },
  ),
  deleteQuestion: (id) => request(
    `/api/admin/questions/${encodeURIComponent(id)}`,
    { method: 'DELETE' },
  ),
  // 批量新建：HTTP 始终 200，部分失败体现在 created / failed / problems 上
  batchCreateQuestions: (questions) => request(
    '/api/admin/questions/batch',
    { method: 'POST', body: { questions }, timeoutMs: UPLOAD_TIMEOUT_MS },
  ),

  listCategories: () => request('/api/admin/categories'),
  createCategory: (payload) => request('/api/admin/categories', { method: 'POST', body: payload }),
  deleteCategory: (id) => request(
    `/api/admin/categories/${encodeURIComponent(id)}`,
    { method: 'DELETE' },
  ),
}

// 把 ApiError 翻成用户能读懂的一句话。
// 契约里的状态码各有含义，这里逐条给出可操作的提示，而不是把 error 字段原样抛出去。
export function describeApiError(error) {
  if (!error) return '未知错误'
  if (!(error instanceof ApiError)) return error.message || String(error)

  const detail = error.details.length ? `（${error.details.join('；')}）` : ''

  switch (error.status) {
    case 0:
      return error.message
    case 400:
      return `请求数据不合法：${error.message}${detail}`
    case 401:
      return error.payload?.remainingAttempts !== undefined
        ? `${error.message}（还可尝试 ${error.payload.remainingAttempts} 次）`
        : '登录状态已失效，请重新登录'
    case 403:
      return '当前账号没有权限执行这个操作'
    case 404:
      return `资源不存在：${error.message}`
    case 409:
      return `冲突：${error.message}`
    case 413:
      return '截图太大，服务端拒绝接收（单张上限 8 MB）'
    case 429: {
      const seconds = Number(error.payload?.retryAfterSeconds)
      const wait = Number.isFinite(seconds) && seconds > 0 ? `，请等待约 ${Math.ceil(seconds)} 秒` : '，请稍后再试'
      return `${error.message}${wait}`
    }
    case 500:
      return `服务端异常：${error.message}`
    default:
      return `${error.message}${detail}`
  }
}

// 上传截图要转成 data URL（契约里 images[].dataUrl）。
// 不信任文件名后缀，扩展名由服务端按 mimeType 决定。
export function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new ApiError('读取图片失败，请重试'))
    reader.readAsDataURL(file)
  })
}
