// 截图上传处理。
//
// 只信任文件内容的魔数，不信任上传时声明的 MIME 与文件名后缀：
// 前者可以被伪造，后者可能带路径穿越。落盘文件名一律由题目 id 生成，
// 因此不可能写到自己该在的目录之外。

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { config } from './config.js'
import {
  EXTENSION_BY_MIME_TYPE,
  MAX_QUESTION_IMAGE_BYTES,
  QUESTION_IMAGE_PREFIX,
} from '@nte-geoguess/shared/constants'

// 文件头魔数 → 真实类型
const SIGNATURES = [
  { ext: 'png', mime: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { ext: 'jpg', mime: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { ext: 'gif', mime: 'image/gif', bytes: [0x47, 0x49, 0x46, 0x38] },
]

function matchesSignature(buffer, signature) {
  if (buffer.length < signature.bytes.length) return false
  return signature.bytes.every((byte, index) => buffer[index] === byte)
}

// WebP / AVIF 都是 RIFF 或 ISO-BMFF 容器，需要多看几个字节
function detectContainerFormat(buffer) {
  if (buffer.length >= 12
    && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
    && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { ext: 'webp', mime: 'image/webp' }
  }
  if (buffer.length >= 12 && buffer.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = buffer.subarray(8, 12).toString('ascii')
    if (brand.startsWith('avif') || brand.startsWith('avis') || brand.startsWith('mif1')) {
      return { ext: 'avif', mime: 'image/avif' }
    }
  }
  return null
}

export function detectImageType(buffer) {
  for (const signature of SIGNATURES) {
    if (matchesSignature(buffer, signature)) return { ext: signature.ext, mime: signature.mime }
  }
  return detectContainerFormat(buffer)
}

export function decodeDataUrl(dataUrl) {
  const match = /^data:([^;]+);base64,([\s\S]+)$/.exec(String(dataUrl ?? ''))
  if (!match) return null
  const declaredMime = match[1].toLowerCase()
  const buffer = Buffer.from(match[2], 'base64')
  return { declaredMime, buffer }
}

export class UploadError extends Error {
  constructor(message, statusCode = 400) {
    super(message)
    this.statusCode = statusCode
  }
}

// 把一张截图写到 uploads 目录，返回可访问的 web 路径。
// questionId 由服务端或调用方生成，只允许 [A-Za-z0-9_-]。
export function saveQuestionImage({ questionId, dataUrl }) {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(questionId)) {
    throw new UploadError(`题目 id 不合法：${questionId}`)
  }
  const decoded = decodeDataUrl(dataUrl)
  if (!decoded) throw new UploadError('截图数据不是合法的 data URL')
  if (decoded.buffer.length === 0) throw new UploadError('截图内容为空')
  if (decoded.buffer.length > MAX_QUESTION_IMAGE_BYTES) {
    throw new UploadError(
      `截图超过 ${Math.round(MAX_QUESTION_IMAGE_BYTES / 1024 / 1024)} MB 上限`,
      413,
    )
  }

  const detected = detectImageType(decoded.buffer)
  if (!detected) {
    throw new UploadError('无法识别的图片格式（支持 PNG / JPEG / WebP / GIF / AVIF）')
  }

  const fileName = `${questionId}.${detected.ext}`
  const filePath = path.join(config.uploadsDir, fileName)
  // 双保险：解析后的路径必须仍在 uploads 目录内
  if (!path.resolve(filePath).startsWith(path.resolve(config.uploadsDir))) {
    throw new UploadError('目标路径越界')
  }

  fs.mkdirSync(config.uploadsDir, { recursive: true })
  fs.writeFileSync(filePath, decoded.buffer)

  return {
    path: `${QUESTION_IMAGE_PREFIX}${fileName}`,
    bytes: decoded.buffer.length,
    mimeType: detected.mime,
    sha256: crypto.createHash('sha256').update(decoded.buffer).digest('hex'),
  }
}

// 校验一个已存在的题库截图路径是否真的在 uploads 目录里
export function isManagedQuestionImage(webPath) {
  if (typeof webPath !== 'string' || !webPath.startsWith(QUESTION_IMAGE_PREFIX)) return false
  const fileName = webPath.slice(QUESTION_IMAGE_PREFIX.length)
  if (!/^[A-Za-z0-9_-]{1,80}\.[a-z0-9]{2,5}$/.test(fileName)) return false
  const filePath = path.join(config.uploadsDir, fileName)
  return path.resolve(filePath).startsWith(path.resolve(config.uploadsDir))
}

export function questionImageFile(webPath) {
  if (!isManagedQuestionImage(webPath)) return null
  return path.join(config.uploadsDir, webPath.slice(QUESTION_IMAGE_PREFIX.length))
}

export function deleteQuestionImage(webPath) {
  const filePath = questionImageFile(webPath)
  if (!filePath) return false
  try {
    fs.rmSync(filePath, { force: true })
    return true
  } catch {
    return false
  }
}

export function countUploadedImages() {
  try {
    return fs.readdirSync(config.uploadsDir).filter((name) => EXTENSION_BY_MIME_TYPE[name.split('.').pop()]).length
  } catch {
    return 0
  }
}
