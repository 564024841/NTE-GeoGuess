// 后台鉴权：一次性密码 + httpOnly 会话 Cookie。
//
// 安全要点：
//   · 密码用 timingSafeEqual 比较，避免计时侧信道
//   · 数据库里只存会话 token 的 SHA-256，泄库也无法直接冒用
//   · Cookie 为 httpOnly + SameSite=Lax，生产环境加 Secure
//   · 同一 IP 连续失败会临时锁定，防暴力破解

import crypto from 'node:crypto'
import { config } from './config.js'
import {
  clearLoginFailures,
  createSession,
  deleteSession,
  findSession,
  getLoginAttempts,
  purgeExpiredSessions,
  recordLoginFailure,
} from './db.js'

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function safeEqual(a, b) {
  const bufferA = Buffer.from(String(a))
  const bufferB = Buffer.from(String(b))
  if (bufferA.length !== bufferB.length) return false
  return crypto.timingSafeEqual(bufferA, bufferB)
}

export function isPasswordConfigured() {
  return Boolean(config.adminPassword)
}

export function verifyPassword(candidate) {
  if (!isPasswordConfigured()) return false
  return safeEqual(candidate ?? '', config.adminPassword)
}

export function checkLoginAllowed(ip) {
  const record = getLoginAttempts(ip)
  if (!record?.locked_until) return { allowed: true }
  const lockedUntil = new Date(record.locked_until).getTime()
  if (Number.isNaN(lockedUntil) || lockedUntil <= Date.now()) return { allowed: true }
  return {
    allowed: false,
    retryAfterSeconds: Math.ceil((lockedUntil - Date.now()) / 1000),
  }
}

export function registerLoginFailure(ip) {
  return recordLoginFailure(ip, {
    maxAttempts: config.loginMaxAttempts,
    windowMinutes: config.loginWindowMinutes,
  })
}

export function registerLoginSuccess(ip) {
  clearLoginFailures(ip)
}

export function issueSession(reply, { userAgent }) {
  const token = crypto.randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + config.sessionTtlHours * 3600 * 1000)

  createSession({ tokenHash: sha256(token), expiresAt: expiresAt.toISOString(), userAgent })
  // 顺手清理过期会话，避免表无限增长
  purgeExpiredSessions()

  reply.setCookie(config.cookieName, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: config.cookieSecure,
    expires: expiresAt,
  })

  return { expiresAt: expiresAt.toISOString() }
}

export function revokeSession(request, reply) {
  const token = request.cookies?.[config.cookieName]
  if (token) deleteSession(sha256(token))
  reply.clearCookie(config.cookieName, { path: '/' })
}

export function readSession(request) {
  const token = request.cookies?.[config.cookieName]
  if (!token) return null
  const row = findSession(sha256(token))
  if (!row) return null
  return { expiresAt: row.expires_at }
}

// Fastify preHandler：后台接口统一挂这个。
//
// 必须是 async：Fastify 的 hookRunner 只在「返回 thenable」或「自己调用 next」
// 时才继续往下走。同步返回 undefined 会让请求既不进 handler 也不返回，直接挂死。
export async function requireAdmin(request, reply) {
  const session = readSession(request)
  if (!session) {
    reply.code(401).send({ error: '未登录或会话已过期' })
    return
  }
  request.adminSession = session
}
