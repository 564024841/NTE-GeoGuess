// 后台登录状态。
//
// 启动顺序（对应契约里的两个接口）：
//   1. GET  /api/admin/session  —— 未登录返回 200 { authenticated: false }，用来决定首屏渲染登录页还是工作台
//   2. POST /api/admin/login    —— 失败 401（带 remainingAttempts）、限流 429（带 retryAfterSeconds）
//   3. POST /api/admin/logout   —— 顶栏的「退出登录」
//
// 会话本体是 httpOnly Cookie，前端看不见也不需要看；
// 这里只维护「界面该显示什么」，以及任何接口 401 时自动退回登录页。
import { computed, reactive } from 'vue'
import { api, describeApiError, setUnauthorizedHandler } from '../api'
import { useNotices } from './useNotices'

// 单页应用全局只有一份登录状态
const state = reactive({
  // checking: 启动探测中 / anonymous: 未登录 / authenticated: 已登录
  status: 'checking',
  expiresAt: null,
  submitting: false,
  error: '',
})

const notices = useNotices()
let handlerInstalled = false

function installUnauthorizedHandler() {
  if (handlerInstalled) return
  handlerInstalled = true

  // 任何一个后台接口返回 401 都会走到这里：立刻切回登录页并说明原因。
  setUnauthorizedHandler(() => {
    if (state.status !== 'authenticated') return
    state.status = 'anonymous'
    state.expiresAt = null
    notices.error('登录状态已失效，请重新登录。')
  })
}

export function useAuth() {
  installUnauthorizedHandler()

  const isAuthenticated = computed(() => state.status === 'authenticated')
  const isChecking = computed(() => state.status === 'checking')

  async function checkSession() {
    state.status = 'checking'
    state.error = ''
    try {
      const payload = await api.session()
      state.status = payload?.authenticated ? 'authenticated' : 'anonymous'
      state.expiresAt = payload?.expiresAt || null
    } catch (error) {
      // 后端没起来时不能白屏：退回登录页，并把原因显示在登录表单里
      state.status = 'anonymous'
      state.expiresAt = null
      state.error = describeApiError(error)
      notices.error(describeApiError(error))
    }
  }

  async function login(password) {
    if (!password) {
      state.error = '请输入后台密码'
      return false
    }
    state.submitting = true
    state.error = ''
    try {
      const payload = await api.login(password)
      state.status = 'authenticated'
      state.expiresAt = payload?.expiresAt || null
      notices.ok('登录成功。')
      return true
    } catch (error) {
      state.error = describeApiError(error)
      return false
    } finally {
      state.submitting = false
    }
  }

  async function logout() {
    try {
      await api.logout()
      notices.info('已退出登录。')
    } catch (error) {
      // 退出失败（例如会话已经过期）也要把界面切回登录页，不能把用户困在工作台
      notices.error(`退出登录失败：${describeApiError(error)}`)
    } finally {
      state.status = 'anonymous'
      state.expiresAt = null
    }
  }

  return { state, isAuthenticated, isChecking, checkSession, login, logout }
}
