// 截图路径的约定与解析。
//
// 线上由后端提供 /images/locations/* 与 /images/questions/*，
// 路径本身就是可直接请求的 URL（VITE_API_BASE 为空时即同源）。

import { EXTENSION_BY_MIME_TYPE, LOCATION_IMAGE_PREFIX, QUESTION_IMAGE_PREFIX } from './constants.js'
import { resolveRegisteredImage } from './imageRegistry.js'

export function isRemoteImage(path) {
  return typeof path === 'string' && /^(?:[a-z]+:)?\/\//i.test(path)
}

export function isQuestionBankImage(path) {
  return typeof path === 'string' && path.startsWith(QUESTION_IMAGE_PREFIX)
}

export function isLocationImage(path) {
  return typeof path === 'string' && path.startsWith(LOCATION_IMAGE_PREFIX)
}

// 解析成可直接给 <img src> 的地址。
// 优先用运行期登记的 URL（后台在静态托管下会用 blob 顶替新上传的截图）。
export function resolveImageUrl(path, apiBase = '') {
  if (!path) return null
  const registered = resolveRegisteredImage(path)
  if (registered) return registered
  if (isRemoteImage(path) || path.startsWith('data:') || path.startsWith('blob:')) return path
  const normalized = path.startsWith('/') ? path : `/${path}`
  return apiBase ? `${apiBase.replace(/\/+$/, '')}${normalized}` : normalized
}

export function questionImagePath(questionId, mimeType) {
  const extension = EXTENSION_BY_MIME_TYPE[mimeType] || 'png'
  return `${QUESTION_IMAGE_PREFIX}${questionId}.${extension}`
}

export function isSupportedImageType(mimeType) {
  return Object.hasOwn(EXTENSION_BY_MIME_TYPE, mimeType)
}

export function extensionForMimeType(mimeType) {
  return EXTENSION_BY_MIME_TYPE[mimeType] || null
}

export function createQuestionId() {
  const random = Math.random().toString(36).slice(2, 7)
  return `qb-${Date.now().toString(36)}-${random}`
}
