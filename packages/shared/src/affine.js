// 纯仿射数学：不 import 任何 JSON，供浏览器与 Node 共用。
//
// 为什么不把标定数据也放这里：Node 的 ESM 加载 JSON 需要 import attributes，
// 而打包器又是另一套规则。所以这一层只保留纯函数：
//   · 浏览器侧由 geometry.js 读入标定 JSON 后调用
//   · Node 侧由 server 读入同一份 JSON 后调用
// 两边跑的是同一段数学，不会出现判分口径不一致。

// 由 3 个标定点解 2×2 仿射变换（同时含平移、缩放、轻微旋转与剪切）
export function solveAffine(points) {
  if (!Array.isArray(points) || points.length < 3) throw new Error('至少需要 3 个坐标标定点')
  const [first, second, third] = points
  const [x1, y1] = first.raw
  const [x2, y2] = second.raw
  const [x3, y3] = third.raw
  const determinant = x1 * (y2 - y3) + x2 * (y3 - y1) + x3 * (y1 - y2)
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) {
    throw new Error('坐标标定点共线，无法建立仿射变换')
  }

  function coefficients(index) {
    const value1 = first.map[index]
    const value2 = second.map[index]
    const value3 = third.map[index]
    return {
      x: (value1 * (y2 - y3) + value2 * (y3 - y1) + value3 * (y1 - y2)) / determinant,
      y: (value1 * (x3 - x2) + value2 * (x1 - x3) + value3 * (x2 - x1)) / determinant,
      offset: (
        value1 * (x2 * y3 - x3 * y2)
        + value2 * (x3 * y1 - x1 * y3)
        + value3 * (x1 * y2 - x2 * y1)
      ) / determinant,
    }
  }

  const mapX = coefficients(0)
  const mapY = coefficients(1)
  const inverseDeterminant = mapX.x * mapY.y - mapX.y * mapY.x
  if (!Number.isFinite(inverseDeterminant) || Math.abs(inverseDeterminant) < 1e-12) {
    throw new Error('坐标标定矩阵不可逆')
  }

  return { mapX, mapY, inverseDeterminant }
}

// 游戏真实坐标 → 标定像素
export function applyAffine(affine, { x, y }) {
  const gameX = Number(x)
  const gameY = Number(y)
  return {
    pixelX: affine.mapX.x * gameX + affine.mapX.y * gameY + affine.mapX.offset,
    pixelY: affine.mapY.x * gameX + affine.mapY.y * gameY + affine.mapY.offset,
  }
}

// 标定像素 → 游戏真实坐标
export function invertAffine(affine, { pixelX, pixelY, sourceWidth, sourceHeight }, frame) {
  const frameWidth = Number(sourceWidth) > 0 ? Number(sourceWidth) : frame.sourceWidth
  const frameHeight = Number(sourceHeight) > 0 ? Number(sourceHeight) : frame.sourceHeight
  const calibratedX = Number(pixelX) * frame.sourceWidth / frameWidth
  const calibratedY = Number(pixelY) * frame.sourceHeight / frameHeight
  const shiftedX = calibratedX - affine.mapX.offset
  const shiftedY = calibratedY - affine.mapY.offset
  return {
    x: (shiftedX * affine.mapY.y - affine.mapX.y * shiftedY) / affine.inverseDeterminant,
    y: (affine.mapX.x * shiftedY - shiftedX * affine.mapY.x) / affine.inverseDeterminant,
  }
}

// 「游戏单位 / 标定像素」比例。
// 标定像素是 MapLocator 坐标系（例如 13056 见方），而 Leaflet 底图是
// mapWidth（26112）像素，两者差一个系数，换算到「底图像素」时要乘上它，
// 否则比例会算大数倍（实测差 2 倍）。
export function computeScale({ calibration, mapWidth, locatorWidth }) {
  const [first, second] = calibration.points
  const gameSpan = Math.hypot(second.raw[0] - first.raw[0], second.raw[1] - first.raw[1])
  const locatorPixelSpan = Math.hypot(second.map[0] - first.map[0], second.map[1] - first.map[1])
  if (!(locatorPixelSpan > 0)) throw new Error('标定点重合，无法计算比例')
  const unitsPerLocatorPixel = gameSpan / locatorPixelSpan
  return {
    unitsPerLocatorPixel,
    unitsPerMapPixel: unitsPerLocatorPixel * (mapWidth / locatorWidth),
    mapPixelsPerLocatorPixel: mapWidth / locatorWidth,
  }
}
