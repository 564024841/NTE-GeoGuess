// 格式化辅助（两个前端共用）

// 偏差统一用「底图像素」表达——玩家能直接在地图上量出来。
export function formatPixels(pixels) {
  if (!Number.isFinite(pixels)) return '—'
  return `${Math.round(pixels)} px`
}

// 游戏真实坐标的距离，作为辅助信息展示（数值很大，用千分位）
export function formatGameUnits(value) {
  if (!Number.isFinite(value)) return '—'
  return Math.round(value).toLocaleString('zh-CN')
}

export function formatDateTime(value) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString('zh-CN')
}

export function formatDateTimeShort(value) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}
