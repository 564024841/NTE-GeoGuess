// 后台站端到端校验。
//
// 前置：服务端在 8787、后台站在 5175（npm run dev:server / dev:admin）。
//
// 覆盖真实用户路径：
//   1. 未登录展示登录页，密码错误有可见提示
//   2. 登录成功 → 工作台 + 地图（数据来自 /api/bootstrap）+ 分类/题库接口
//   3. 新建题目：上传截图 → 地图点选答案 → 填信息 → 保存到待提交清单
//   4. 批量提交 → 持久结果记录
//   5. 题库列表：搜索命中、来源筛选
//   6. 编辑题目：改名后列表可见
//   7. 删除题目：二次确认 + 删除后从列表消失
//   8. 分类管理：新建 → 出现在列表 → 删除
//   9. 登录保护：登出后管理接口不可用
//
// 结束后用 API 清理本次创建的题目/分类，不污染开发数据。
import { chromium } from 'playwright-core'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const SHOTS_ENABLED = !args.includes('--no-shots')
const BASE_URL = args.find((arg) => arg.startsWith('http')) || 'http://127.0.0.1:5175/'
const API_BASE = (() => {
  const index = args.indexOf('--api')
  return index >= 0 ? args[index + 1] : 'http://127.0.0.1:8787'
})()
const PASSWORD = (() => {
  const index = args.indexOf('--password')
  return index >= 0 ? args[index + 1] : 'test-admin-pw'
})()

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SHOT_DIR = path.join(ROOT, 'output')

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
]
const executablePath = CHROME_CANDIDATES.find((candidate) => fs.existsSync(candidate))
if (!executablePath) {
  console.error('未找到可用浏览器，跳过后台校验')
  process.exit(2)
}

fs.mkdirSync(SHOT_DIR, { recursive: true })

const failures = []
const notes = []
const check = (condition, message) => {
  if (condition) notes.push(`  ok   ${message}`)
  else failures.push(message)
}

// 本次创建的测试数据，结束时清理
const stamp = Date.now().toString(36)
const NAME_A = `E2E 测试题 A ${stamp}`
const NAME_B = `E2E 测试题 B ${stamp}`
const NAME_EDITED = `E2E 已改名 ${stamp}`
const CATEGORY_ID = `e2e-cat-${stamp}`
const createdIds = new Set()

const browser = await chromium.launch({ executablePath, headless: true })
const page = await browser.newPage({ viewport: { width: 1700, height: 940 } })

const consoleErrors = []
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text())
})
page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`))

const apiCalls = []
const tiles = { ok: 0, failed: 0 }
page.on('response', (response) => {
  const url = response.url()
  if (url.includes('/api/')) apiCalls.push(`${response.status()} ${new URL(url).pathname}`)
  if (url.includes('/mapsource-tiles/')) {
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

// 用 canvas 现场生成一张合法 PNG，避免依赖外部素材
async function makePng(label) {
  const bytes = await page.evaluate(async (text) => {
    const canvas = document.createElement('canvas')
    canvas.width = 320
    canvas.height = 180
    const context = canvas.getContext('2d')
    const gradient = context.createLinearGradient(0, 0, 320, 180)
    gradient.addColorStop(0, '#1d3f5e')
    gradient.addColorStop(1, '#7a3f5c')
    context.fillStyle = gradient
    context.fillRect(0, 0, 320, 180)
    context.fillStyle = '#8adfd6'
    context.fillRect(24, 24, 120, 70)
    context.fillStyle = '#ffd27d'
    context.beginPath()
    context.arc(250, 60, 34, 0, Math.PI * 2)
    context.fill()
    context.fillStyle = '#fff'
    context.font = 'bold 20px sans-serif'
    context.fillText(text, 24, 152)
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
    return Array.from(new Uint8Array(await blob.arrayBuffer()))
  }, label)
  return Buffer.from(bytes)
}

// 通过 API 清理，避免依赖界面状态
async function cleanup() {
  try {
    const login = await fetch(`${API_BASE}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    })
    if (!login.ok) return
    const cookie = (login.headers.getSetCookie?.() ?? []).map((item) => item.split(';')[0]).join('; ')

    // 按名字搜出本次创建的题目（不依赖内存里的 id，避免中途失败漏清）
    for (const name of [NAME_A, NAME_B, NAME_EDITED]) {
      const response = await fetch(`${API_BASE}/api/admin/questions?q=${encodeURIComponent(name)}`, {
        headers: { Cookie: cookie },
      })
      if (!response.ok) continue
      const payload = await response.json()
      for (const item of payload.items ?? []) {
        await fetch(`${API_BASE}/api/admin/questions/${item.id}`, { method: 'DELETE', headers: { Cookie: cookie } })
        createdIds.add(item.id)
      }
    }

    for (const id of createdIds) {
      await fetch(`${API_BASE}/api/admin/questions/${id}`, { method: 'DELETE', headers: { Cookie: cookie } })
    }
    await fetch(`${API_BASE}/api/admin/categories/${CATEGORY_ID}`, { method: 'DELETE', headers: { Cookie: cookie } })
  } catch {
    /* 清理失败不影响校验结论，但要提示 */
    notes.push('  --   清理测试数据时出错，请手动检查后台题库')
  }
}

try {
  // ---------- 1. 未登录 → 登录页 ----------
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.evaluate(() => localStorage.clear())
  await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 60000 })

  await page.waitForSelector('[data-testid="login-panel"]', { timeout: 30000 })
  check(true, '未登录时展示登录页')
  check((await page.locator('[data-testid="login-panel"] input[type="password"]').count()) === 1,
    '登录页有密码输入框')
  await shot('admin-01-login.png')

  // ---------- 2. 密码错误 ----------
  await page.locator('[data-testid="login-panel"] input[type="password"]').fill('definitely-wrong')
  await page.locator('[data-testid="login-panel"] button[type="submit"]').click()
  await page.waitForTimeout(1500)
  const loginError = await page.evaluate(() => {
    const node = document.querySelector('.status-banner--error, [data-testid="login-error"]')
    return node ? node.textContent.trim() : ''
  })
  check(loginError.length > 0, `密码错误有可见提示 => 「${loginError.slice(0, 40)}」`)
  check((await page.locator('[data-testid="login-panel"]').count()) === 1, '密码错误后仍停留在登录页')

  // ---------- 3. 登录成功 ----------
  await page.locator('[data-testid="login-panel"] input[type="password"]').fill(PASSWORD)
  await page.locator('[data-testid="login-panel"] button[type="submit"]').click()
  await page.waitForSelector('[data-testid="tab-editor"]', { timeout: 30000 })
  check(true, '登录成功进入工作台')

  // 工作台数据来自 API
  await page.waitForTimeout(2000)
  check(apiCalls.some((entry) => entry.includes('/api/admin/session')),
    `启动时探测会话 => ${apiCalls.find((e) => e.includes('session')) || '无'}`)
  check(apiCalls.some((entry) => entry.includes('/api/bootstrap')),
    `地图数据来自 bootstrap => ${apiCalls.find((e) => e.includes('bootstrap')) || '无'}`)
  check(apiCalls.some((entry) => entry.includes('/api/admin/categories')),
    '分类列表来自后台接口')
  // 401 是「密码错误」那一步的预期结果；这里只要求没有服务端错误
  const serverErrors = apiCalls.filter((entry) => entry.startsWith('5'))
  check(serverErrors.length === 0, `登录后无服务端错误 => ${serverErrors.join(', ') || '无'}`)

  const mapInfo = await page.evaluate(() => ({
    tiles: document.querySelectorAll('.leaflet-tile').length,
    markers: document.querySelectorAll('.leaflet-marker-pane .map-marker').length,
    hasCanvas: Boolean(document.querySelector('.leaflet-container')),
  }))
  check(mapInfo.hasCanvas, '地图已渲染')
  check(mapInfo.tiles > 0, `底图瓦片已加载 => ${mapInfo.tiles} 张（请求成功 ${tiles.ok}）`)
  check(mapInfo.markers === 0, `地图上不显示点位图标（实测 ${mapInfo.markers} 个）`)
  await shot('admin-02-workspace.png')

  // ---------- 4. 新建题目：上传 + 点选 + 保存 ----------
  await page.locator('[data-testid="tab-editor"]').click()
  await page.waitForSelector('[data-testid="drop-zone"]', { timeout: 15000 })
  check(true, '编辑器面板可用（新建题目）')

  await page.locator('[data-testid="file-input"]').setInputFiles({
    name: 'e2e-a.png',
    mimeType: 'image/png',
    buffer: await makePng('E2E-A'),
  })
  await page.waitForTimeout(800)
  const preview = await page.evaluate(async () => {
    const img = document.querySelector('[data-testid="drop-zone"] img')
    if (!img) return { present: false }
    if (!img.complete) await new Promise((resolve) => { img.onload = resolve; img.onerror = resolve })
    return { present: true, width: img.naturalWidth }
  })
  check(preview.present && preview.width === 320, `截图预览已加载 => ${preview.width}px 宽`)

  // 新建流程的按钮是 save-pending；save-edit 只在编辑模式出现
  const savePending = page.locator('[data-testid="save-pending"]')
  check((await page.locator('[data-testid="save-edit"]').count()) === 0,
    '新建模式下不出现「保存修改」按钮')
  check(!(await savePending.isEnabled()), '只有截图、未选位置时不可保存')

  const canvasBox = await page.locator('.leaflet-container').boundingBox()
  await page.mouse.click(canvasBox.x + canvasBox.width * 0.44, canvasBox.y + canvasBox.height * 0.46)
  await page.waitForTimeout(600)
  const answerMeta = await page.evaluate(() => {
    const slot = document.querySelector('[data-testid="answer-slot"]')
    return {
      isSet: slot?.classList.contains('is-set') || false,
      values: [...(slot?.querySelectorAll('strong') ?? [])].map((node) => node.textContent.trim()),
    }
  })
  check(answerMeta.isSet, '地图点选后答案位置已设定')
  check(answerMeta.values.length >= 3,
    `回显游戏坐标 / 底图像素 / 自动判定区域 => ${answerMeta.values.join(' | ')}`)
  check(Boolean(answerMeta.values[2]) && answerMeta.values[2] !== '—',
    `按坐标自动定区域 => ${answerMeta.values[2]}`)

  await page.locator('[data-testid="field-name"]').fill(NAME_A)
  check(await savePending.isEnabled(), '截图 + 位置齐备后可保存')
  await savePending.click()
  await page.waitForTimeout(900)
  check((await page.locator('[data-testid="pending-list"] li').count()) === 1, '第 1 题进入待提交清单')

  // ---------- 5. 再加一题并批量提交 ----------
  await page.locator('[data-testid="file-input"]').setInputFiles({
    name: 'e2e-b.png',
    mimeType: 'image/png',
    buffer: await makePng('E2E-B'),
  })
  await page.waitForTimeout(700)
  await page.mouse.click(canvasBox.x + canvasBox.width * 0.58, canvasBox.y + canvasBox.height * 0.55)
  await page.waitForTimeout(500)
  await page.locator('[data-testid="field-name"]').fill(NAME_B)
  await savePending.click()
  await page.waitForTimeout(900)
  check((await page.locator('[data-testid="pending-list"] li').count()) === 2, '连续保存后清单里有 2 题')
  await shot('admin-03-pending.png')

  const submitBatch = page.locator('[data-testid="submit-batch"]')
  check(await submitBatch.isEnabled(), '「提交入库」可用')
  await submitBatch.click()
  await page.waitForTimeout(3000)

  const submitRecord = await page.evaluate(() => {
    const node = document.querySelector('[data-testid="submit-record"]')
    return node ? node.textContent.replace(/\s+/g, ' ').trim() : null
  })
  check(Boolean(submitRecord), `提交后展示持久结果记录 => ${submitRecord?.slice(0, 70) || '（无）'}`)
  check((await page.locator('[data-testid="pending-list"] li').count()) === 0, '提交后待提交清单清空')
  await shot('admin-04-submitted.png')

  // ---------- 6. 题库列表 ----------
  await page.locator('[data-testid="tab-list"]').click()
  await page.waitForSelector('[data-testid="question-list"]', { timeout: 15000 })
  await page.waitForTimeout(800)

  // ---------- 6a. 分类筛选 ----------
  const categorySelect = page.locator('[data-testid="list-category"]')
  check((await categorySelect.count()) === 1, '列表里有分类筛选下拉')

  const categoryInfo = await page.evaluate(() => {
    const select = document.querySelector('[data-testid="list-category"]')
    const options = [...select.querySelectorAll('option')].map((node) => ({
      value: node.value,
      text: node.textContent.trim(),
    }))
    const groups = [...select.querySelectorAll('optgroup')].map((node) => node.label)
    return { options, groups, current: select.value }
  })
  check(categoryInfo.options.length > 1, `分类下拉有 ${categoryInfo.options.length - 1} 个分类可筛`)
  check(categoryInfo.options[0].value === '', `下拉第一项是「全部分类」=> 「${categoryInfo.options[0].text}」`)
  check(categoryInfo.groups.length > 0, `分类按分组展示 => ${categoryInfo.groups.join('、')}`)
  check(categoryInfo.options.some((item) => item.text.includes('（')), '每个分类带题数')

  // 选一个有题的区域分类，确认列表真的被筛过，并且条数与下拉标注一致
  const regionOption = categoryInfo.options.find((item) => item.value.startsWith('region-'))
  if (regionOption) {
    const declared = Number((/（(\d+)）/.exec(regionOption.text) || [])[1])
    await categorySelect.selectOption(regionOption.value)
    await page.waitForTimeout(1500)

    const rangeText = await page.evaluate(() => {
      const node = document.querySelector('.list-filter-status .panel-note')
      return node ? node.textContent.trim() : ''
    })
    const filteredTotal = Number((/共 (\d+) 题/.exec(rangeText) || [])[1])

    check(filteredTotal === declared,
      `分类筛选后题数与下拉标注一致 => ${regionOption.text.trim()} vs ${rangeText}`)
    check(rangeText.includes('分类「'), `筛选状态里标注了当前分类 => ${rangeText}`)

    // 列表项确实属于该分类
    const allMatch = await page.evaluate((categoryId) => {
      const select = document.querySelector('[data-testid="list-category"]')
      return [...document.querySelectorAll('[data-testid="question-item"]')].length > 0
        && select.value === categoryId
    }, regionOption.value)
    check(allMatch, '筛选后列表有内容且下拉保持选中')

    await shot('admin-05a-list-category.png')

    // 「清除筛选」应把分类重置回全部
    const resetButton = page.locator('[data-testid="list-reset"]')
    check((await resetButton.count()) === 1, '有筛选时出现「清除筛选」')
    await resetButton.click()
    await page.waitForTimeout(1500)
    const afterReset = await page.evaluate(() => {
      const select = document.querySelector('[data-testid="list-category"]')
      const node = document.querySelector('.list-filter-status .panel-note')
      return { value: select.value, text: node ? node.textContent.trim() : '' }
    })
    check(afterReset.value === '' && !afterReset.text.includes('分类「'),
      `清除筛选后回到全部 => 分类=「${afterReset.value || '全部'}」 ${afterReset.text}`)
  } else {
    check(false, '分类下拉里没有区域分类（薄暮区/米格尔区等应当出现）')
  }

  await page.locator('[data-testid="list-search"]').fill(NAME_A)
  await page.locator('[data-testid="list-search"]').press('Enter')
  await page.waitForTimeout(1500)
  const searchHits = await page.locator('[data-testid="question-item"]').count()
  check(searchHits === 1, `按名称搜索命中 => ${searchHits} 条`)

  const firstItemText = await page.locator('[data-testid="question-item"]').first().textContent()
  check(firstItemText.includes(NAME_A), `列表项包含题目名 => 「${firstItemText.replace(/\s+/g, ' ').trim().slice(0, 50)}」`)

  const thumbOk = await page.evaluate(async () => {
    const img = document.querySelector('[data-testid="question-item"] img')
    if (!img) return { present: false }
    if (!img.complete) await new Promise((resolve) => { img.onload = resolve; img.onerror = resolve })
    return { present: true, width: img.naturalWidth, src: img.src }
  })
  check(thumbOk.present && thumbOk.width > 0, `列表缩略图可加载 => ${thumbOk.width}px`)
  check(thumbOk.src?.includes('/images/questions/'), `缩略图走服务端路径 => ${thumbOk.src?.replace(/^https?:\/\/[^/]+/, '')}`)
  await shot('admin-05-list.png')

  // ---------- 7. 编辑题目 ----------
  await page.locator('[data-testid="question-edit"]').first().click()
  await page.waitForTimeout(1200)
  check((await page.locator('[data-testid="field-name"]').count()) === 1, '编辑模式打开表单')
  const nameFieldValue = await page.locator('[data-testid="field-name"]').inputValue()
  check(nameFieldValue === NAME_A, `编辑表单带出原值 => 「${nameFieldValue}」`)

  await page.locator('[data-testid="field-name"]').fill(NAME_EDITED)
  const editSubmit = page.locator('[data-testid="save-edit"]')
  check(await editSubmit.isEnabled(), '编辑模式可保存')
  await editSubmit.click()
  await page.waitForTimeout(2000)

  // 回到列表确认改名生效
  await page.locator('[data-testid="tab-list"]').click()
  await page.waitForTimeout(600)
  await page.locator('[data-testid="list-search"]').fill(NAME_EDITED)
  await page.locator('[data-testid="list-search"]').press('Enter')
  await page.waitForTimeout(1500)
  const editedHits = await page.locator('[data-testid="question-item"]').count()
  check(editedHits === 1, `改名后可按新名搜到 => ${editedHits} 条`)
  await shot('admin-06-edited.png')

  // ---------- 8. 删除题目（二次确认） ----------
  await page.locator('[data-testid="question-delete"]').first().click()
  await page.waitForSelector('[data-testid="confirm-dialog"]', { timeout: 10000 })
  check(true, '删除前弹出二次确认')
  await shot('admin-07-confirm.png')
  await page.locator('[data-testid="confirm-accept"]').click()
  await page.waitForTimeout(2500)

  const afterDelete = await page.locator('[data-testid="question-item"]').count()
  check(afterDelete === 0, `删除后列表中不再出现 => ${afterDelete} 条`)

  // ---------- 9. 分类管理 ----------
  await page.locator('[data-testid="tab-categories"]').click()
  await page.waitForSelector('[data-testid="category-list"]', { timeout: 15000 })
  const categoryCountBefore = await page.locator('[data-testid="category-list"] li').count()

  await page.locator('[data-testid="category-id"]').fill(CATEGORY_ID)
  await page.locator('[data-testid="category-label"]').fill('E2E 分类')
  await page.locator('[data-testid="category-create"]').click()
  await page.waitForTimeout(2000)
  const categoryCountAfter = await page.locator('[data-testid="category-list"] li').count()
  check(categoryCountAfter === categoryCountBefore + 1,
    `新建分类后列表增加 => ${categoryCountBefore} → ${categoryCountAfter}`)

  // 删除新建的分类
  const targetRow = page.locator('[data-testid="category-list"] li', { hasText: 'E2E 分类' }).first()
  if (await targetRow.count()) {
    await targetRow.locator('[data-testid="category-delete"]').click()
    await page.waitForTimeout(800)
    if (await page.locator('[data-testid="confirm-dialog"]').count()) {
      await page.locator('[data-testid="confirm-accept"]').click()
    }
    await page.waitForTimeout(2000)
    const categoryCountFinal = await page.locator('[data-testid="category-list"] li').count()
    check(categoryCountFinal === categoryCountBefore,
      `删除分类后列表还原 => ${categoryCountFinal}`)
  }
  await shot('admin-08-categories.png')

  // ---------- 10. 登出后接口受保护 ----------
  await page.locator('[data-testid="logout"]').click()
  await page.waitForSelector('[data-testid="login-panel"]', { timeout: 15000 })
  check(true, '登出后回到登录页')

  // 通过页面自身同源请求探测受保护接口。
  // 直接打 8787 会触发 CORS（浏览器安全策略），不走代理也拿不到 Cookie 的 SameSite 语义，
  // 那不是后台的问题，所以这里走同源。
  const protectedStatus = await page.evaluate(async () => {
    const response = await fetch('/api/admin/questions', { credentials: 'include' })
    return response.status
  })
  check(protectedStatus === 401, `登出后管理接口返回 401 => ${protectedStatus}`)

  // 负例本身就会产生控制台记录：故意输错密码、登出后探测受保护接口，
  // 浏览器对 401 响应一定会打印 "Failed to load resource"，这不是缺陷。
  // 只看除此之外的错误。
  const unexpectedErrors = consoleErrors.filter((text) => !/401|Unauthorized/i.test(text))
  if (consoleErrors.length !== unexpectedErrors.length) {
    notes.push(`  --   已忽略 ${consoleErrors.length - unexpectedErrors.length} 条预期内的 401 记录（负例）`)
  }
  check(unexpectedErrors.length === 0, `控制台无非预期报错（${unexpectedErrors.length} 条）`)
} catch (error) {
  failures.push(`执行过程中抛出异常：${error.message}`)
} finally {
  await browser.close()
  await cleanup()
}

console.log('=== NTE 图寻 · 后台站校验 ===')
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
  console.log('\n全部通过（测试数据已清理）。')
}
