// 全局提示条。
//
// 后台每个失败都必须「看得见」——服务端没起来、会话过期、限流、字段不合法
// 都不能只躺在 console 里。所有请求的错误提示都汇总到这里，由 NoticeStack 渲染。
//
// 状态放在模块顶层：后台是单页应用，一个提示栈就够了，
// 这样任意 composable 都能推消息，不必一层层往下传 emit。
import { reactive } from 'vue'

const notices = reactive([])
let sequence = 0

// 成功/提示类消息自动消失，错误必须用户手动关掉——错误信息常常要照着改数据。
const AUTO_DISMISS_MS = { ok: 5000, info: 6000 }

export function useNotices() {
  function dismiss(id) {
    const index = notices.findIndex((notice) => notice.id === id)
    if (index >= 0) notices.splice(index, 1)
  }

  function push(kind, message, { details = [], sticky = false } = {}) {
    if (!message) return null
    // 同一条错误可能被重复触发（例如连点两次），去重避免刷屏
    const duplicate = notices.find((notice) => notice.kind === kind && notice.message === message)
    if (duplicate) return duplicate.id

    sequence += 1
    const id = sequence
    notices.push({ id, kind, message, details })

    const ttl = sticky ? 0 : AUTO_DISMISS_MS[kind]
    if (ttl) setTimeout(() => dismiss(id), ttl)
    return id
  }

  return {
    notices,
    push,
    ok: (message, options) => push('ok', message, options),
    info: (message, options) => push('info', message, options),
    error: (message, options) => push('error', message, { sticky: true, ...options }),
    dismiss,
    clear: () => notices.splice(0, notices.length),
  }
}
