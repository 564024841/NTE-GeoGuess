// 区域分类预览图：把「区域边界 + 参照点 + 题目的归属」画在一张地图上，用来肉眼复核分类。
//
// 画什么：
//   · 白色细线 = 区域边界（用 shared 的 regionInference 在网格上逐格投票，跟服务端同一套规则）
//   · 彩色方块 = 400 个参照点（来自 packages/shared/data/region-reference.json，按它的区域上色）
//   · 彩色圆点 = 题目的落点，颜色取它**现在**的归属（map-data.json 里的 types）
//   · 红色圈   = 这题的坐标推断结果和当前归属不一致（要么覆盖之外、要么两区交界置信度<0.6）
//   · 区域名   = 来自 packages/shared/data/region-positions.json
//
// 依赖：
//   · 底图瓦片目录（默认 ../MapSource/tiles，`npm run tiles:fetch` 会拉到那里；--tiles= 可指定）
//   · 想顺便出 PNG 的话需要 ImageMagick（magick 命令）；只出 SVG 则不需要
//
// 用法：
//   node scripts/region-map-preview.mjs                    # 输出到仓库 data/region-map.svg
//   node scripts/region-map-preview.mjs --png              # 顺便渲染 PNG（需要 magick）
//   node scripts/region-map-preview.mjs --tiles=/path/to/tiles --zoom=-3 --out=/tmp/qa

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createGeometry } from '@nte-geoguess/shared/geometry'
import { createRegionInference, REGION_REFERENCE } from '@nte-geoguess/shared/regionInference'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SEED_FILE = process.env.SEED_FILE || path.join(ROOT, 'packages/shared/data/map-data.json')
const CALIBRATION_FILE = path.join(ROOT, 'packages/shared/data/navi-coordinate-calibration.json')
const REGION_POSITIONS_FILE = path.join(ROOT, 'packages/shared/data/region-positions.json')

function option(name, fallback) {
  const prefix = `--${name}=`
  const hit = process.argv.find((arg) => arg.startsWith(prefix))
  return hit ? hit.slice(prefix.length) : fallback
}

const TILES_DIR = path.resolve(option('tiles', path.join(ROOT, '..', 'MapSource', 'tiles')))
const ZOOM = Number(option('zoom', -4))
const OUT_DIR = path.resolve(option('out', path.join(ROOT, 'data')))
const WANT_PNG = process.argv.includes('--png')
const TILE_SIZE = 512

const seed = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'))
const calibration = JSON.parse(fs.readFileSync(CALIBRATION_FILE, 'utf8'))
const regionPositions = JSON.parse(fs.readFileSync(REGION_POSITIONS_FILE, 'utf8'))
const geometry = createGeometry(seed.map, calibration)
const inference = createRegionInference({ geometry })

const colorByLabel = Object.fromEntries(
  (seed.categories || []).filter((c) => c.label && c.color).map((c) => [c.label, c.color]),
)
const fallbackColor = '#9aa4ad'

// 底图像素 → 该缩放级别下的拼图坐标
const mapPixelToMosaic = (pixel) => {
  const ratio = Number(seed.map.width) / (Number(calibration.sourceWidth) || 13056)
  return { x: (pixel.pixelX * ratio) / 2 ** -ZOOM, y: (pixel.pixelY * ratio) / 2 ** -ZOOM }
}
const gameToMosaic = (point) => mapPixelToMosaic(geometry.gameToMapPixel(point))
const locatorToMosaic = (point) => mapPixelToMosaic({ pixelX: point.pixelX, pixelY: point.pixelY })

// ---------- 瓦片 ----------

const tileSpan = TILE_SIZE * 2 ** -ZOOM   // 一张瓦片覆盖多少底图像素
const tileCount = Math.ceil(Number(seed.map.width) / tileSpan)
const mosaicSize = tileCount * TILE_SIZE

const tileImages = []
let missingTiles = 0
for (let ty = 0; ty < tileCount; ty += 1) {
  for (let tx = 0; tx < tileCount; tx += 1) {
    const file = path.join(TILES_DIR, String(ZOOM), String(tx), `${ty}.jpg`)
    // 地图边缘之外的那几张瓦片本来就不存在，缺了就当透明，不报错
    if (!fs.existsSync(file)) { missingTiles += 1; continue }
    tileImages.push(
      `<image xlink:href="${file}" x="${tx * TILE_SIZE}" y="${ty * TILE_SIZE}" width="${TILE_SIZE}" height="${TILE_SIZE}"/>`,
    )
  }
}

if (!tileImages.length) {
  console.error(`找不到瓦片：${path.join(TILES_DIR, String(ZOOM))}`)
  console.error('先 `npm run tiles:fetch`（拉到仓库同级的 MapSource/tiles），或用 --tiles=<瓦片目录> 指定。')
  process.exit(1)
}

// ---------- 区域边界（网格逐格投票）----------

const STEP = 64   // 标定像素；越小边界越细，SVG 也越大
const locatorWidth = Number(calibration.sourceWidth) || 13056
// 标定像素中心 → 游戏坐标（先换成底图像素，再反算）
const locatorCenterToGame = (x, y) => geometry.mapPixelToGame(
  geometry.mapLocatorToMapPixel({ pixelX: x, pixelY: y }),
)
const cellLabel = new Map()
for (let x = 0; x < locatorWidth; x += STEP) {
  for (let y = 0; y < locatorWidth; y += STEP) {
    const label = inference.infer(locatorCenterToGame(x + STEP / 2, y + STEP / 2))?.label
    cellLabel.set(`${x},${y}`, label || null)
  }
}

const scale = mapPixelToMosaic({ pixelX: 1, pixelY: 1 })   // 1 标定像素 = 多少拼图像素（近似，够画线用）
const cellSize = STEP * scale.x
const borders = []
for (const [key, label] of cellLabel) {
  const [x, y] = key.split(',').map(Number)
  const right = cellLabel.get(`${x + STEP},${y}`)
  const below = cellLabel.get(`${x},${y + STEP}`)
  const pos = locatorToMosaic({ pixelX: x, pixelY: y })
  if (right !== undefined && right !== label) {
    borders.push(`<line x1="${pos.x + cellSize}" y1="${pos.y}" x2="${pos.x + cellSize}" y2="${pos.y + cellSize}"/>`)
  }
  if (below !== undefined && below !== label) {
    borders.push(`<line x1="${pos.x}" y1="${pos.y + cellSize}" x2="${pos.x + cellSize}" y2="${pos.y + cellSize}"/>`)
  }
}

// ---------- 参照点 / 题目点 / 区域名 ----------

const referenceSvg = REGION_REFERENCE.points.map((point) => {
  const pos = gameToMosaic(point)
  return `<rect x="${(pos.x - 2.5).toFixed(1)}" y="${(pos.y - 2.5).toFixed(1)}" width="5" height="5" fill="${colorByLabel[point.district] || fallbackColor}" stroke="#000" stroke-width="1"/>`
})

let mismatch = 0
let outside = 0
const puzzleSvg = (seed.locations || []).map((location) => {
  const pos = gameToMosaic(location)
  const current = (seed.categories || []).find((c) => c.id === (location.types || [])[0])
  const currentLabel = current?.label || location.region || '未标注'
  const inferred = inference.infer(location)
  const mismatchHere = inferred && inferred.label !== currentLabel
  if (mismatchHere) mismatch += 1
  if (inferred?.outside) outside += 1
  const ring = mismatchHere
    ? ` stroke="#ff2d55" stroke-width="2" ${inferred.outside ? '' : 'stroke-dasharray="3,2"'}`
    : ''
  return `<circle cx="${pos.x.toFixed(1)}" cy="${pos.y.toFixed(1)}" r="3.4" fill="${colorByLabel[currentLabel] || fallbackColor}" fill-opacity="0.95"${ring}><title>${location.id} · ${currentLabel}${mismatchHere ? ` · 推断为 ${inferred.label}` : ''}</title></circle>`
})

const labelSvg = (regionPositions.regions || []).map((region) => {
  const pos = locatorToMosaic({ pixelX: region.x, pixelY: region.y })
  return `<text x="${pos.x.toFixed(1)}" y="${pos.y.toFixed(1)}" fill="${colorByLabel[region.label] || fallbackColor}" font-size="26" font-weight="700" text-anchor="middle" paint-order="stroke" stroke="#000" stroke-width="4" stroke-opacity="0.85">${region.label}</text>`
})

const labelGroup = `<g>${labelSvg.join('')}</g>`
const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${mosaicSize}" height="${mosaicSize}" viewBox="0 0 ${mosaicSize} ${mosaicSize}">
${tileImages.join('\n')}
<g fill="none" stroke="#ffffff" stroke-width="1.4" stroke-opacity="0.75">${borders.join('')}</g>
<g>${referenceSvg.join('')}</g>
<g>${puzzleSvg.join('')}</g>
${labelGroup}
</svg>
`

fs.mkdirSync(OUT_DIR, { recursive: true })
const svgFile = path.join(OUT_DIR, 'region-map.svg')
fs.writeFileSync(svgFile, svg, 'utf8')

console.log(`[预览] ${svgFile}`)
console.log(`  瓦片      ${tileImages.length} 张（${TILES_DIR}，z=${ZOOM}；地图边缘缺失 ${missingTiles} 张属正常）`)
console.log(`  参照点    ${referenceSvg.length} 个，题目 ${puzzleSvg.length} 道`)
console.log(`  与坐标推断不一致的题 ${mismatch} 个（其中覆盖之外 ${outside} 个）—— 图上是红圈`)

if (WANT_PNG) {
  const pngFile = path.join(OUT_DIR, 'region-map.png')
  // ImageMagick 的内置 SVG 渲染器画文字需要一个字体文件（找不到就报 `unable to read font`）。
  // 先按常见路径找一个；实在没有就退化成「不带区域名」的版本，SVG 里始终是完整的。
  const font = [
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',   // Linux / 容器
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/TTF/DejaVuSans.ttf',
    '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',   // macOS
    '/System/Library/Fonts/Helvetica.ttc',
  ].find((candidate) => fs.existsSync(candidate))

  const attempts = [
    { note: font ? `字体 ${path.basename(font)}` : '无字体', text: svg, args: font ? ['-font', font] : [] },
    { note: '不带区域名（渲染器找不到字体）', text: svg.replace(labelGroup, ''), args: [] },
  ]

  let rendered = null
  let lastError = null
  for (const attempt of attempts) {
    try {
      fs.writeFileSync(svgFile, attempt.text, 'utf8')
      execFileSync('magick', ['-background', 'none', ...attempt.args, svgFile, pngFile], { stdio: 'pipe' })
      rendered = attempt.note
      break
    } catch (error) {
      lastError = error
    }
  }

  if (rendered) {
    console.log(`  已渲染   ${pngFile}（${rendered}）`)
  } else {
    // 失败时把 SVG 还原成完整版（含区域名），只提示 PNG 没出来
    fs.writeFileSync(svgFile, svg, 'utf8')
    console.warn(`  渲染 PNG 失败（需要 ImageMagick：magick 命令）：${lastError?.message || '未知错误'}`)
    console.warn('  SVG 仍然是完整的，可以用浏览器打开或自己转 PNG。')
    process.exitCode = 1
  }
}
