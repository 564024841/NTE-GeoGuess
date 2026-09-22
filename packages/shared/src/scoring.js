// 评分引擎（前端判分与后端复核共用同一份实现）。
//
// 规则：
//   1. 玩家点击地图得到 Leaflet 坐标，反算成游戏真实坐标
//   2. 与题目真实坐标求距离，并换算到「底图像素」尺度
//   3. 分数按半衰曲线衰减：
//        points = 满分 × 2^(-像素距离 / 半衰像素)
//      点中得满分，偏差等于半衰距离（50px）时得一半分，偏差越大越趋近 0
//
// 依赖的坐标换算由调用方注入（geometry），这样本模块不需要加载地图数据。

import { DISTANCE_TIERS, ROUND_MAX_POINTS, SCORE_HALF_LIFE_PIXELS } from './constants.js'

// 游戏坐标系下的直线距离（原始单位，仅用于记录与展示）
export function gameDistance(a, b) {
  const dx = Number(a.x) - Number(b.x)
  const dy = Number(a.y) - Number(b.y)
  if (![dx, dy].every(Number.isFinite)) return Number.NaN
  return Math.hypot(dx, dy)
}

// 底图像素坐标系下的距离，这是评分与展示使用的尺度
export function pixelDistance(a, b, geometry) {
  if (!geometry?.gameToMapPixel) throw new Error('pixelDistance 需要 geometry')
  const pixelA = geometry.gameToMapPixel(a)
  const pixelB = geometry.gameToMapPixel(b)
  const dx = pixelA.pixelX - pixelB.pixelX
  const dy = pixelA.pixelY - pixelB.pixelY
  if (![dx, dy].every(Number.isFinite)) return Number.NaN
  return Math.hypot(dx, dy)
}

export function scoreForPixelDistance(pixels) {
  if (!Number.isFinite(pixels)) return 0
  const raw = ROUND_MAX_POINTS * 2 ** (-Math.max(0, pixels) / SCORE_HALF_LIFE_PIXELS)
  return Math.round(raw * 10) / 10
}

export function tierForPixelDistance(pixels) {
  const value = Number.isFinite(pixels) ? Math.max(0, pixels) : Number.POSITIVE_INFINITY
  return DISTANCE_TIERS.find((tier) => value <= tier.maxPixels) || DISTANCE_TIERS[DISTANCE_TIERS.length - 1]
}

// 结算一道题：像素偏差、游戏坐标距离、分数、评价
export function evaluateRound({ answer, guess, geometry }) {
  const pixels = pixelDistance(answer, guess, geometry)
  return {
    distancePixels: pixels,
    gameDistance: gameDistance(answer, guess),
    points: scoreForPixelDistance(pixels),
    tier: tierForPixelDistance(pixels),
  }
}

// 整局汇总
export function summarizeSession(rounds) {
  const settled = (rounds || []).filter((round) => round.result)
  if (!settled.length) {
    return {
      totalPoints: 0,
      maxPoints: 0,
      averagePoints: 0,
      averageDistancePixels: 0,
      bestRound: null,
      worstRound: null,
      settledCount: 0,
    }
  }

  const totalPoints = settled.reduce((sum, round) => sum + round.result.points, 0)
  const totalPixels = settled.reduce((sum, round) => sum + round.result.distancePixels, 0)
  const sorted = [...settled].sort((a, b) => b.result.points - a.result.points)

  return {
    totalPoints: Math.round(totalPoints * 10) / 10,
    maxPoints: settled.length * ROUND_MAX_POINTS,
    averagePoints: Math.round((totalPoints / settled.length) * 10) / 10,
    averageDistancePixels: totalPixels / settled.length,
    bestRound: sorted[0],
    worstRound: sorted[sorted.length - 1],
    settledCount: settled.length,
  }
}
