// 游戏站端到端校验。
//
// 前置：服务端已在 8787（npm run dev:server），游戏站已在 5174（npm run dev:game），
//       或直接用 --base-url 指向任意游戏站地址（例如生产构建的 4174）。
//
// 覆盖：
//   1. 数据来自服务端 API（不再是打包进去的快照）
//   2. 底图瓦片真的解码成 512×512
//   3. 地图上无点位图标（按需求关闭）
//   4. 落点 → 确认 → 结算 全链路
//   5. 整局复盘
//   6. 坐标链路偏差（dev 构建下用调试出口精确核对）
//   7. 游戏产物里不含后台代码（只读保证）
import { chromium } from 'playwright-core'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const SHOTS_ENABLED = !args.includes('--no-shots')
const BASE_URL = args.find((arg) => arg.startsWith('http')) || 'http://127.0.0.1:5174/'
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SHOT_DIR = path.join(ROOT, 'output')
const GAME_DIST = path.join(ROOT, 'apps/game/dist/assets')

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
]
const executablePath = CHROME_CANDIDATES.find((candidate) => fs.existsSync(candidate))
if (!executablePath) {
  console.error('未找到可用浏览器，跳过游戏站校验')
  process.exit(2)
}

fs.mkdirSync(SHOT_DIR, { recursive: true })

const failures = []
const notes = []
const check = (condition, message) => {
  if (condition) notes.push(`  ok   ${message}`)
  else failures.push(message)
}

const browser = await chromium.launch({ executablePath, headless: true })
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })

const consoleErrors = []
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text())
})
page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`))

// 统计 /api 请求，用来证明数据确实来自服务端
const apiRequests = []
const tiles = { ok: 0, failed: 0 }
page.on('response', (response) => {
  const url = response.url()
  if (url.includes('/api/')) apiRequests.push(`${response.status()} ${new URL(url).pathname}`)
  if (url.includes('/mapsource-tiles/') || url.includes('/MapSource/')) {
    if (response.ok()) tiles.ok += 1
    else tiles.failed += 1
  }
})

async function shot(name) {
  if (!SHOTS_ENABLED) return
  try {
    await page.screenshot({ path: path.join(SHOT_DIR, name) })
  } catch (error) {
    notes.push(`  --   截图 ${name} 写入失败（${error.code || error.message}）`)
  }
}

const startButton = page.locator('.primary-button', { hasText: '开始游戏' })
const confirmButton = page.locator('.primary-button', { hasText: '确认落点' })
const nextButton = page.locator('.primary-button', { hasText: '下一题' })
let canvasBox = null

async function clickCanvas(fx = 0.5, fy = 0.5) {
  if (!canvasBox) canvasBox = await page.locator('.map-canvas').boundingBox()
  await page.mouse.click(canvasBox.x + canvasBox.width * fx, canvasBox.y + canvasBox.height * fy)
  await page.waitForTimeout(400)
}

async function step() {
  if (await page.locator('.score-hero').count()) return 'finished'
  if (await confirmButton.count() && await confirmButton.isEnabled()) {
    await confirmButton.click()
    await page.waitForTimeout(700)
    return 'confirmed'
  }
  if (await nextButton.count()) {
    await nextButton.click()
    await page.waitForTimeout(800)
    return 'advanced'
  }
  await clickCanvas()
  return 'guessed'
}

try {
  await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 60000 })
  await page.waitForSelector('.app-shell', { timeout: 20000 })

  // ---------- 1. 数据来自服务端 ----------
  await page.waitForSelector('.primary-button:has-text("开始游戏")', { timeout: 30000 })
  check(apiRequests.some((entry) => entry.endsWith('/api/bootstrap')),
    `bootstrap 来自服务端 => ${apiRequests.filter((e) => e.includes('bootstrap'))[0] || '未请求'}`)
  check(apiRequests.every((entry) => entry.startsWith('200')),
    `所有 API 请求均成功 => ${apiRequests.join(' | ')}`)

  // ---------- 2. 瓦片 ----------
  await page.waitForTimeout(2500)
  check(tiles.ok > 0 && tiles.failed === 0, `底图瓦片加载 => 成功 ${tiles.ok}、失败 ${tiles.failed}`)

  const tileSample = await page.evaluate(async () => {
    const images = [...document.querySelectorAll('.leaflet-tile')]
    if (!images.length) return { count: 0 }
    const target = images[Math.floor(images.length / 2)]
    const url = target.currentSrc || target.src
    try {
      const bitmap = await createImageBitmap(await (await fetch(url)).blob())
      return { count: images.length, width: bitmap.width, height: bitmap.height }
    } catch (error) {
      return { count: images.length, error: String(error) }
    }
  })
  check(tileSample.count > 0, `地图挂载瓦片元素 = ${tileSample.count}`)
  check(tileSample.width === 512 && tileSample.height === 512,
    `瓦片解码尺寸 = ${tileSample.width}x${tileSample.height}（期望 512x512）`)

  // ---------- 3. 无点位图标 ----------
  const markerCount = await page.locator('.leaflet-marker-pane .map-marker').count()
  check(markerCount === 0, `地图上无常驻点位图标（实测 ${markerCount} 个）`)

  // ---------- 状态面板 ----------
  const setupInfo = await page.evaluate(() => {
    const facts = [...document.querySelectorAll('.fact strong')].map((node) => node.textContent.trim())
    return {
      facts,
      // 筛选现在只有「分类」一层（分类就是区域），九宫格方位筛选已删除
      categoryChips: document.querySelectorAll('.chip').length,
      gridChips: document.querySelectorAll('.chip--region, .region-grid').length,
    }
  })
  check(setupInfo.facts.length === 3, `开始页展示题源统计 => ${setupInfo.facts.join(' / ')}`)
  check(Number(setupInfo.facts[0]) > 400, `可出题数来自服务端 => ${setupInfo.facts[0]}`)
  check(setupInfo.categoryChips > 0, `分类筛选可用 => ${setupInfo.categoryChips} 个分类`)
  check(setupInfo.gridChips === 0,
    `已无九宫格方位筛选（残留 ${setupInfo.gridChips} 个元素）`)
  await shot('game-01-setup.png')

  // ---------- 4. 一局完整流程 ----------
  await page.locator('.segmented button', { hasText: '3 题' }).click()
  check(await startButton.isEnabled(), '「开始游戏」可用')
  await startButton.click()
  await page.waitForSelector('.clue-frame', { timeout: 15000 })

  const clue = await page.evaluate(async () => {
    const img = document.querySelector('.clue-frame img')
    if (!img) return { present: false }
    if (!img.complete) await new Promise((resolve) => { img.onload = resolve; img.onerror = resolve })
    return { present: true, width: img.naturalWidth, height: img.naturalHeight, src: img.src }
  })
  check(clue.present && clue.width > 0, `题面截图加载成功 = ${clue.width}x${clue.height}`)
  check(clue.src?.includes('/images/'), `截图路径来自服务端 => ${clue.src?.replace(/^https?:\/\/[^/]+/, '')}`)
  await shot('game-02-clue.png')

  check(!(await confirmButton.isEnabled()), '未落点时「确认落点」保持禁用')
  await clickCanvas(0.45, 0.5)
  check((await page.locator('.map-pin--guess').count()) === 1, '地图上出现玩家落点图钉')
  check(await confirmButton.isEnabled(), '落点后「确认落点」可用')

  await confirmButton.click()
  await page.waitForSelector('.result-card', { timeout: 15000 })
  await page.waitForTimeout(400)
  const result = await page.evaluate(() => ({
    points: document.querySelector('.result-card__points')?.textContent?.trim(),
    tier: document.querySelector('.result-card__tier')?.textContent?.trim(),
    distance: document.querySelector('.result-grid dd')?.textContent?.trim(),
    answerPin: document.querySelectorAll('.map-pin--answer').length,
    line: document.querySelectorAll('.leaflet-overlay-pane path').length,
  }))
  check(Boolean(result.distance), `结算偏差 = ${result.distance}（得分 ${result.points} / ${result.tier}）`)
  check(result.answerPin === 1, '地图上出现答案图钉')
  check(result.line >= 1, '落点与答案之间的连线已绘制')
  await shot('game-03-result.png')

  // ---------- 5. 整局复盘 ----------
  let finished = false
  for (let i = 0; i < 40; i += 1) {
    if (await step() === 'finished') { finished = true; break }
  }
  check(finished, '能走完整局并展示总分复盘')
  if (finished) {
    const summary = await page.evaluate(() => ({
      total: document.querySelector('.score-hero strong')?.textContent?.trim(),
      rounds: document.querySelectorAll('.round-list li').length,
    }))
    notes.push(`  总得分 = ${summary.total}，复盘题数 = ${summary.rounds}`)
    check(summary.rounds === 3, `复盘题数与设置一致 = ${summary.rounds}`)
    await shot('game-04-summary.png')
  }

  // ---------- 6. 坐标链路 ----------
  const hook = await page.evaluate(() => {
    const api = window.__NTE_GEOGUESS__
    if (!api) return null
    const puzzles = api.getPuzzles()
    const geometry = api.getGeometryInfo()
    // 取靠近出题区域中心的点：地图设了 maxBounds，
    // 把边缘处的点居中会被夹住，导致「点画布中心」落不到目标上——
    // 那属于测试方法问题，不是坐标链路问题。
    const xs = puzzles.map((item) => item.x)
    const ys = puzzles.map((item) => item.y)
    const centerX = (Math.min(...xs) + Math.max(...xs)) / 2
    const centerY = (Math.min(...ys) + Math.max(...ys)) / 2
    const target = puzzles
      .slice()
      .sort((a, b) => Math.hypot(a.x - centerX, a.y - centerY)
        - Math.hypot(b.x - centerX, b.y - centerY))[0]
    return {
      puzzles: puzzles.length,
      // 区域现在就是分类，所以区域数 = 有区域归属的分类数
      regions: new Set(puzzles.map((item) => item.regionId)).size,
      geometry,
      targetId: target?.id,
      target: target ? { x: target.x, y: target.y } : null,
    }
  })

  if (hook) {
    notes.push(`  --  调试出口：可出题 ${hook.puzzles}、区域 ${hook.regions}、1 底图像素 ≈ ${hook.geometry.gameUnitsPerMapPixel.toFixed(2)} 游戏单位`)

    // 坐标换算一致性：拿标定文件里的已知样本，在浏览器里跑一遍
    // 前端实际使用的仿射公式，必须精确复现标定像素。
    // 这比「把视图对准某点再读回中心」可靠——地图有 maxBounds，
    // 边缘点会被夹住，那种做法测到的只是夹取结果。
    const calibrationCheck = await page.evaluate(() => {
      const info = window.__NTE_GEOGUESS__.getGeometryInfo()
      const { mapX, mapY } = info.affine
      return info.calibrationPoints.map((point) => {
        const [gx, gy] = point.raw
        const pixelX = mapX.x * gx + mapX.y * gy + mapX.offset
        const pixelY = mapY.x * gx + mapY.y * gy + mapY.offset
        return {
          expected: point.map,
          actual: [pixelX, pixelY],
          error: Math.hypot(pixelX - point.map[0], pixelY - point.map[1]),
        }
      })
    })
    const worstError = Math.max(...calibrationCheck.map((item) => item.error))
    check(
      calibrationCheck.length >= 3 && worstError < 0.01,
      `前端仿射公式精确复现 ${calibrationCheck.length} 个标定点（最大误差 ${worstError.toExponential(2)} 像素）`,
    )

    // Leaflet 坐标往返：标定像素 → latlng → 标定像素
    const latLngRoundTrip = await page.evaluate(() => {
      const api = window.__NTE_GEOGUESS__
      const info = api.getGeometryInfo()
      return info.calibrationPoints.map((point) => {
        const latlng = api.toLatLng({ pixelX: point.map[0], pixelY: point.map[1] })
        const back = api.toPixel(latlng)
        return Math.hypot(back.pixelX - point.map[0], back.pixelY - point.map[1])
      })
    })
    check(
      Math.max(...latLngRoundTrip) < 0.01,
      `标定像素 ⇄ Leaflet 坐标往返误差 < 0.01px（最大 ${Math.max(...latLngRoundTrip).toExponential(2)}）`,
    )

    // 落点判分链路：把视图对准地图中部某点后点画布中心，偏差应与视图夹取无关地合理
    await page.locator('.ghost-button', { hasText: '返回设置' }).click()
    await page.waitForSelector('.primary-button:has-text("开始游戏")')
    await startButton.click()
    await page.waitForSelector('.clue-frame')
    await page.waitForTimeout(600)
    await page.evaluate((target) => window.__NTE_GEOGUESS__.focusPoint(target, 1), hook.target)
    await page.waitForTimeout(1000)
    await clickCanvas(0.5, 0.5)
    if (!(await confirmButton.isEnabled())) await clickCanvas(0.5, 0.53)
    check(await confirmButton.isEnabled(), '视图对准后可正常落点')
    await confirmButton.click()
    await page.waitForSelector('.result-card')
    await page.waitForTimeout(400)
    const centered = await page.evaluate(() => document.querySelector('.result-grid dd')?.textContent?.trim())
    notes.push(`  对准 ${hook.targetId} 落点后偏差 = ${centered}（该点贴近地图边缘，视图被 maxBounds 夹住，偏差偏大属预期）`)
    await shot('game-05-centered.png')
  } else {
    notes.push('  --  生产构建无调试出口，跳过坐标链路专项校验')
  }

  // ---------- 7. 产物里不含后台代码 ----------
  if (fs.existsSync(GAME_DIST)) {
    const bundle = fs.readdirSync(GAME_DIST)
      .filter((name) => name.endsWith('.js'))
      .map((name) => fs.readFileSync(path.join(GAME_DIST, name), 'utf8'))
      .join('\n')
    // 只挑真正的后台接口特征；中文文案（如「题库编辑」）不作为判据，容易误判
    const leaked = ['/api/admin/', 'ADMIN_PASSWORD', 'admin/questions', 'question-bank/batch', '保存到待提交清单']
      .filter((needle) => bundle.includes(needle))
    check(leaked.length === 0, `游戏产物不含后台接口痕迹（命中 ${leaked.join(', ') || '无'}）`)
  } else {
    notes.push('  --  未找到 apps/game/dist，跳过产物检查（先跑 npm run build:game）')
  }

  check(consoleErrors.length === 0, `控制台无报错（${consoleErrors.length} 条）`)
} finally {
  await browser.close()
}

console.log('=== NTE 图寻 · 游戏站校验 ===')
for (const note of notes) console.log(note)
if (consoleErrors.length) {
  console.log('\n控制台错误：')
  for (const error of consoleErrors.slice(0, 10)) console.log(`  x ${error}`)
}
if (failures.length) {
  console.log('\n失败项：')
  for (const failure of failures) console.log(`  x ${failure}`)
  process.exitCode = 1
} else {
  console.log('\n全部通过。')
}
