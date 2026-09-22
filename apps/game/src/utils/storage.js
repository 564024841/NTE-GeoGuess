// localStorage 读写统一降级，坏数据不允许让应用启动失败。
import {
  HISTORY_STORAGE_KEY,
  MAP_VIEW_STORAGE_KEY,
  SETTINGS_STORAGE_KEY,
} from '../constants/mapApp'

function readJson(key, fallback = null) {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : fallback
  } catch {
    return fallback
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* 隐私模式或配额满时静默忽略，不影响游戏进行 */
  }
}

export function readStoredMapView() {
  const view = readJson(MAP_VIEW_STORAGE_KEY)
  if (!view || typeof view !== 'object') return null
  const lat = Number(view.lat)
  const lng = Number(view.lng)
  const zoom = Number(view.zoom)
  if (![lat, lng, zoom].every(Number.isFinite)) return null
  return { lat, lng, zoom }
}

export function persistMapView(view) {
  if (!view) return
  writeJson(MAP_VIEW_STORAGE_KEY, view)
}

export function readStoredSettings() {
  const settings = readJson(SETTINGS_STORAGE_KEY)
  return settings && typeof settings === 'object' ? settings : null
}

export function persistSettings(settings) {
  writeJson(SETTINGS_STORAGE_KEY, settings)
}

export function readStoredHistory() {
  const history = readJson(HISTORY_STORAGE_KEY, [])
  return Array.isArray(history) ? history : []
}

export function persistHistory(history) {
  writeJson(HISTORY_STORAGE_KEY, history.slice(0, 20))
}

export function clearStoredHistory() {
  try {
    localStorage.removeItem(HISTORY_STORAGE_KEY)
  } catch {
    /* 忽略 */
  }
}
