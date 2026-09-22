// Promise 版确认框。
//
// 删除题目、删除分类这类破坏性操作必须先确认（契约里也强调分类删除会影响引用它的点位）。
// 这里刻意不用 window.confirm：一是自定义弹层能写清「后果」（例如引用会被改到兜底分类），
// 二是它无法被自动化脚本稳定地断言。
import { reactive } from 'vue'

const state = reactive({
  open: false,
  title: '',
  message: '',
  detail: '',
  confirmLabel: '确认',
  cancelLabel: '取消',
  danger: false,
})

let resolveCurrent = null

export function useConfirm() {
  function ask(options = {}) {
    // 上一次没关掉就再问一次时，先把旧的那个当取消处理，避免 Promise 悬空
    resolveCurrent?.(false)

    Object.assign(state, {
      open: true,
      title: options.title || '请确认',
      message: options.message || '',
      detail: options.detail || '',
      confirmLabel: options.confirmLabel || '确认',
      cancelLabel: options.cancelLabel || '取消',
      danger: options.danger ?? true,
    })

    return new Promise((resolve) => {
      resolveCurrent = resolve
    })
  }

  function settle(value) {
    state.open = false
    const resolve = resolveCurrent
    resolveCurrent = null
    resolve?.(value)
  }

  return { state, ask, confirm: () => settle(true), cancel: () => settle(false) }
}
