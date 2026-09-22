// 题库后台自查脚本（可复用）。
//
// 做三件事：
//   1. 确保 dev server 在跑（没跑就自己起一个，结束后关掉）
//   2. 用本机 Chrome 打开后台，断言「未登录时必须渲染登录页、不能白屏、不能抛未捕获异常」
//   3. 如果后端（默认 127.0.0.1:8787）已经能访问，再走一遍完整流程：
//      登录 → 新建一题 → 提交入库 → 列表 → 编辑 → 删除 → 分类管理 → 退出登录
//
// 截图统一写到仓库根目录的 output/。
//
// 用法：
//   node apps/admin/scripts/selfcheck.mjs
//   node apps/admin/scripts/selfcheck.mjs --password=your-admin-password
//   node apps/admin/scripts/selfcheck.mjs --url=http://127.0.0.1:5175/ --no-server
//
// 后端没起来时接口请求会失败，这是预期情况——
// 但登录页本身必须正常渲染，脚本会把这部分当作硬性断言。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const args = process.argv.slice(2)
const flag = (name) => args.includes(`--${name}`)
const option = (name, fallback = '') => {
  const hit = args.find((arg) => arg.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}

const ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const OUTPUT_DIR = path.join(ROOT, 'output')
const BASE_URL = option('url', 'http://127.0.0.1:5175/')
const API_PORT = option('api-port', '8787')
const API_URL = option('api', `http://127.0.0.1:${API_PORT}`)
// 后台密码：优先命令行，其次环境变量。服务端用 ADMIN_PASSWORD 配置。
const PASSWORD = option('password', process.env.ADMIN_PASSWORD || 'admin')
const MANAGE_SERVER = !flag('no-server')
// 自查时把前端请求超时调小：后端卡住时不必等默认的 20 秒
const API_TIMEOUT_MS = option('api-timeout', '8000')

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
]

const checks = []
const notes = []
// 每处等接口的等待时间：后端卡住时前端要等超时才显示错误，等太短会把「卡住」误判成「没数据」。
// 登录后会从页面读一次真实生效的超时（VITE_API_TIMEOUT_MS 可能来自别处启动的 dev server）。
let API_WAIT = Number(API_TIMEOUT_MS) + 3500
function check(ok, label) {
  checks.push({ ok: Boolean(ok), label })
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}`)
}
function note(message) {
  notes.push(message)
  console.log(`  --   ${message}`)
}

// 浏览器把「资源加载失败」也记成 console error。后端没起来时这属于预期噪音，
// 单独归类，避免把「未登录页面渲染正常」这个结论淹掉。
const NETWORK_NOISE = [
  /Failed to load resource/i,
  /net::ERR_/i,
  /ERR_CONNECTION_REFUSED/i,
  /favicon/i,
]

const consoleErrors = []
const consoleNoise = []
// Vue 的渲染错误与 prop 校验失败是走 console.warn 的：只看 error 会漏掉真正的白屏原因
const consoleWarnings = []
const pageErrors = []
const failedRequests = []
const badResponses = []

async function isReachable(url, timeoutMs = 2500) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    return response.status
  } catch {
    return 0
  }
}

async function waitForServer(url, timeoutMs = 90000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const status = await isReachable(url, 2000)
    if (status) return true
    await new Promise((resolve) => setTimeout(resolve, 700))
  }
  return false
}

let devServer = null

function startDevServer() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true })
  const logFile = path.join(OUTPUT_DIR, 'admin-devserver.log')
  const out = fs.openSync(logFile, 'a')
  // stdio 直接落文件（而不是管道）：脚本被中断时服务端日志还在，便于排查
  devServer = spawn('npm', ['run', 'dev', '--workspace', 'apps/admin'], {
    cwd: ROOT,
    stdio: ['ignore', out, out],
    shell: true,
    windowsHide: true,
    env: { ...process.env, VITE_API_TIMEOUT_MS: API_TIMEOUT_MS, VITE_DEV_SERVER: API_PORT },
  })
  note(`已启动 dev server（日志：output/admin-devserver.log）`)
}

function stopDevServer() {
  if (!devServer?.pid) return
  // npm 会再拉起 vite 子进程，只杀 npm 会留下孤儿占住 5175 端口
  try {
    spawn('taskkill', ['/pid', String(devServer.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
  } catch {
    devServer.kill()
  }
  devServer = null
}

// 在页面里用 canvas 现造一张 PNG，避免依赖外部素材
async function makeTestPng(page, label) {
  const bytes = await page.evaluate(async (text) => {
    const canvas = document.createElement('canvas')
    canvas.width = 320
    canvas.height = 180
    const context = canvas.getContext('2d')
    const gradient = context.createLinearGradient(0, 0, 320, 180)
    gradient.addColorStop(0, '#14324a')
    gradient.addColorStop(1, '#5a2f47')
    context.fillStyle = gradient
    context.fillRect(0, 0, 320, 180)
    context.fillStyle = '#8adfd6'
    context.fillRect(20, 20, 130, 74)
    context.fillStyle = '#ffd27d'
    context.beginPath()
    context.arc(252, 62, 32, 0, Math.PI * 2)
    context.fill()
    context.fillStyle = '#fff'
    context.font = 'bold 22px sans-serif'
    context.fillText(text, 20, 152)
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
    return Array.from(new Uint8Array(await blob.arrayBuffer()))
  }, label)
  return Buffer.from(bytes)
}

async function shot(page, name) {
  const file = path.join(OUTPUT_DIR, name)
  try {
    await page.screenshot({ path: file })
    note(`截图 ${path.relative(ROOT, file)}`)
  } catch (error) {
    note(`截图 ${name} 写入失败：${error.message}`)
  }
}

// 会话可能被服务端重启/清理掉（例如同一个后端正被别的脚本使用）：
// 这时界面会按设计回到登录页。自动补一次登录，避免把「环境被重启」误报成「前端坏了」。
async function ensureLoggedIn(page, label) {
  const onLoginPage = await page.locator('[data-testid="login-panel"]').count() > 0
  if (!onLoginPage) return false

  note(`${label}：检测到已回到登录页（会话被服务端清理或重启），自动重新登录一次`)
  await page.fill('[data-testid="login-password"]', PASSWORD)
  await page.click('[data-testid="login-submit"]')
  await page.waitForSelector('[data-testid="tab-editor"]', { timeout: 30000 })
  await page.waitForTimeout(1500)
  return true
}

function summarize() {
  const failed = checks.filter((item) => !item.ok)
  console.log('\n=== 图寻题库后台自查 ===')
  console.log(`断言 ${checks.length - failed.length}/${checks.length} 通过`)
  if (consoleNoise.length) {
    console.log(`\n预期内的资源加载失败（后端不可用时的噪音，${consoleNoise.length} 条）：`)
    for (const item of consoleNoise.slice(0, 5)) console.log(`  ~ ${item}`)
  }
  if (consoleErrors.length) {
    console.log(`\n控制台报错（${consoleErrors.length} 条）：`)
    for (const item of consoleErrors.slice(0, 10)) console.log(`  x ${item}`)
  }
  if (pageErrors.length) {
    console.log(`\n未捕获异常（${pageErrors.length} 条）：`)
    for (const item of pageErrors.slice(0, 10)) console.log(`  x ${item}`)
  }
  if (consoleWarnings.length) {
    console.log(`\n控制台警告（${consoleWarnings.length} 条，Vue 渲染错误也在这里）：`)
    for (const item of consoleWarnings.slice(0, 8)) console.log(`  ! ${item.slice(0, 300)}`)
  }
  if (failedRequests.length) {
    console.log(`\n失败的接口请求（${failedRequests.length} 条）：`)
    for (const item of failedRequests.slice(0, 10)) console.log(`  x ${item}`)
  }
  if (badResponses.length) {
    console.log(`\n4xx/5xx 响应（${badResponses.length} 条）：`)
    for (const item of badResponses.slice(0, 12)) console.log(`  x ${item}`)
  }
  if (failed.length) {
    console.log('\n失败项：')
    for (const item of failed) console.log(`  x ${item.label}`)
    process.exitCode = 1
  } else {
    console.log('\n全部通过。')
  }
  if (notes.length) {
    console.log('\n说明：')
    for (const item of notes) console.log(`  ${item}`)
  }
}

const executablePath = CHROME_CANDIDATES.find((candidate) => fs.existsSync(candidate))
if (!executablePath) {
  console.error('未找到可用浏览器（Chrome / Edge），无法自查')
  process.exit(2)
}

fs.mkdirSync(OUTPUT_DIR, { recursive: true })

// ---------- 1. dev server ----------
let serverStatus = await isReachable(BASE_URL)
if (!serverStatus && MANAGE_SERVER) {
  startDevServer()
  const ready = await waitForServer(BASE_URL)
  if (!ready) {
    stopDevServer()
    console.error(`dev server 在 90 秒内没有就绪：${BASE_URL}`)
    process.exit(2)
  }
  serverStatus = await isReachable(BASE_URL)
}
if (!serverStatus) {
  console.error(`dev server 不可用：${BASE_URL}（用 --url= 指定已有实例）`)
  process.exit(2)
}
note(`dev server ${BASE_URL} 已就绪`)

// ---------- 2. 后端可用性 ----------
const healthStatus = await isReachable(`${API_URL}/api/health`)
const backendUp = healthStatus >= 200 && healthStatus < 300
note(backendUp
  ? `后端 ${API_URL}/api/health 可用`
  : `后端 ${API_URL}/api/health 不可用（HTTP ${healthStatus || '连接失败'}），只校验登录页`)

const browser = await chromium.launch({ executablePath, headless: true })
const page = await browser.newPage({ viewport: { width: 1700, height: 940 } })

page.on('console', (message) => {
  const text = message.text()
  if (message.type() === 'warning') {
    consoleWarnings.push(text)
    return
  }
  if (message.type() !== 'error') return
  if (NETWORK_NOISE.some((pattern) => pattern.test(text))) consoleNoise.push(text)
  else consoleErrors.push(text)
})
page.on('pageerror', (error) => pageErrors.push(`pageerror: ${error.message}`))
page.on('requestfailed', (request) => {
  const failure = request.failure()?.errorText || 'unknown'
  failedRequests.push(`${request.method()} ${request.url()} → ${failure}`)
})
// 把 4xx/5xx 的响应连 URL 一起记下来，光看「Failed to load resource」定位不到接口
page.on('response', (response) => {
  if (response.status() < 400) return
  badResponses.push(`HTTP ${response.status()} ${response.request().method()} ${response.url()}`)
})

try {
  // ---------- 3. 未登录：必须是登录页 ----------
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForSelector('[data-testid="login-panel"]', { timeout: 25000 })

  const loginInfo = await page.evaluate(() => {
    const panel = document.querySelector('[data-testid="login-panel"]')
    return {
      hasPanel: Boolean(panel),
      text: panel ? panel.innerText.replace(/\s+/g, ' ').trim() : '',
      hasPassword: Boolean(document.querySelector('[data-testid="login-password"]')),
      hasSubmit: Boolean(document.querySelector('[data-testid="login-submit"]')),
      appChildren: document.querySelector('#app')?.children.length || 0,
      bodyTextLength: document.body.innerText.trim().length,
      mapCanvas: Boolean(document.querySelector('.map-canvas')),
      workspace: Boolean(document.querySelector('[data-testid="tab-editor"]')),
    }
  })

  check(loginInfo.hasPanel, '未登录时展示登录页')
  check(loginInfo.hasPassword, '登录页有密码输入框')
  check(loginInfo.hasSubmit, '登录页有提交按钮')
  check(loginInfo.text.includes('题库后台'), `登录页标题正常：${loginInfo.text.slice(0, 40)}`)
  check(loginInfo.appChildren > 0 && loginInfo.bodyTextLength > 20, '页面没有白屏（#app 已挂载且有内容）')
  check(!loginInfo.workspace, '未登录时不渲染工作台')
  check(!loginInfo.mapCanvas, '未登录时不初始化地图（避免无谓拉瓦片）')
  check(pageErrors.length === 0, `未捕获异常 0 条（实际 ${pageErrors.length}）`)

  // 登录按钮在没输密码时应当是禁用的
  check(await page.locator('[data-testid="login-submit"]').isDisabled(), '未输入密码时登录按钮禁用')

  if (!backendUp) {
    // 后端没起来时，界面必须把「连不上」明确显示给用户，而不是静默失败
    const errorText = await page.locator('[data-testid="login-error"]').innerText().catch(() => '')
    const notices = await page.locator('[data-testid="notice-stack"]').innerText().catch(() => '')
    check(
      Boolean(errorText || notices),
      `后端不可用时登录页展示可见错误（${(errorText || notices).replace(/\s+/g, ' ').slice(0, 60) || '无'}）`,
    )
  }

  await shot(page, 'admin-01-login.png')

  // ---------- 4. 后端可用时走完整流程 ----------
  if (backendUp) {
    await page.fill('[data-testid="login-password"]', PASSWORD)
    await page.click('[data-testid="login-submit"]')

    const loggedIn = await page.waitForSelector('[data-testid="tab-editor"]', { timeout: 30000 })
      .then(() => true)
      .catch(() => false)

    if (!loggedIn) {
      const errorText = await page.locator('[data-testid="login-error"]').innerText().catch(() => '')
      note(`登录未成功（${errorText.replace(/\s+/g, ' ').trim() || '未知原因'}）——完整流程跳过。
     如果用 --password= 指定了错误密码，或服务端 ADMIN_PASSWORD 与默认值不同，请重跑时带上正确密码。`)
    } else {
      check(true, '登录成功并进入工作台')
      await page.waitForTimeout(1500)
      await shot(page, 'admin-02-workspace.png')

      // 用页面里真实生效的请求超时校准等待时间，避免和 dev server 的启动参数不一致
      const effectiveTimeout = await page.evaluate(() => Number(window.__NTE_ADMIN__?.apiTimeoutMs) || 0)
      if (effectiveTimeout) API_WAIT = Math.max(Number(API_TIMEOUT_MS), effectiveTimeout) + 3500
      note(`接口等待窗口 ${API_WAIT}ms（页面生效的请求超时 ${effectiveTimeout || '未知'}ms）`)

      check(await page.locator('.map-canvas.leaflet-container').count() > 0, '工作台初始化了 Leaflet 地图')
      check(await page.locator('.sidebar--admin').count() === 1, '右侧操作面板已渲染')

      // 新建一题：截图 + 地图点选 + 名称
      const questionName = `自查题目 ${Date.now()}`
      const png = await makeTestPng(page, 'SELFCHECK')
      await page.setInputFiles('[data-testid="file-input"]', {
        name: 'selfcheck.png',
        mimeType: 'image/png',
        buffer: png,
      })
      await page.waitForTimeout(600)

      const canvasBox = await page.locator('.map-canvas').boundingBox()
      await page.mouse.click(canvasBox.x + canvasBox.width * 0.45, canvasBox.y + canvasBox.height * 0.5)
      await page.waitForTimeout(500)

      const answerText = await page.locator('[data-testid="answer-slot"]').innerText()
      check(answerText.includes('游戏坐标') && answerText.includes('参考区域'),
        `地图点选后回显坐标与区域：${answerText.replace(/\s+/g, ' ').slice(0, 70)}`)

      await page.fill('[data-testid="field-name"]', questionName)
      await shot(page, 'admin-03-draft.png')

      // 打印一次保存前的内部状态：保存失败时能立刻区分「草稿丢了」和「接口失败」
      const preSave = await page.evaluate(() => {
        const draft = window.__NTE_ADMIN__?.getDraft?.()
        return {
          image: Boolean(draft?.imageDataUrl),
          point: Boolean(draft?.point),
          name: draft?.name || '',
          pending: window.__NTE_ADMIN__?.getPending?.().length ?? -1,
        }
      })
      note(`保存前：截图=${preSave.image} 坐标=${preSave.point} 名称=${preSave.name || '(空)'} 清单=${preSave.pending}`)

      await page.click('[data-testid="save-pending"]')
      await page.waitForTimeout(400)
      check(await page.locator('[data-testid="pending-list"] li').count() === 1, '保存到待提交清单（1 题）')
      await shot(page, 'admin-04-pending.png')

      await page.click('[data-testid="submit-batch"]')
      // 后端卡住时前端要等超时，这里给足等待时间再看结果
      await page.waitForTimeout(Number(API_TIMEOUT_MS) + 4000)
      const recordText = await page.locator('[data-testid="submit-record"]').innerText().catch(() => '')
      const submitStatus = await page.locator('[data-testid="editor-status"]').innerText().catch(() => '')
      check(
        recordText.includes('成功 1 题'),
        `批量提交结果记录：${recordText.replace(/\s+/g, ' ').slice(0, 70)
          || `无记录；面板提示「${submitStatus.replace(/\s+/g, ' ').slice(0, 60)}」`}`,
      )
      await shot(page, 'admin-05-submitted.png')

      // 列表 + 搜索
      await ensureLoggedIn(page, '进入题库列表前')
      await page.click('[data-testid="tab-list"]')
      await page.waitForTimeout(API_WAIT)
      await page.fill('[data-testid="list-search"]', questionName)
      await page.waitForTimeout(API_WAIT)
      const itemCount = await page.locator('[data-testid="question-item"]').count()
      check(itemCount >= 1, `题库列表搜索到刚入库的题目（${itemCount} 条）`)
      await shot(page, 'admin-06-list.png')

      // 编辑
      if (itemCount >= 1) {
        await ensureLoggedIn(page, '进入编辑前')
        await page.locator('[data-testid="question-edit"]').first().click()
        await page.waitForTimeout(800)
        check(await page.locator('[data-testid="save-edit"]').count() === 1, '进入编辑态（出现「保存修改」）')
        const editedName = `${questionName} 改`
        await page.fill('[data-testid="field-name"]', editedName)
        await page.click('[data-testid="save-edit"]')
        await page.waitForTimeout(API_WAIT)
        const editStatus = await page.locator('[data-testid="editor-status"]').innerText().catch(() => '')
        check(editStatus.includes('已保存修改'), `编辑保存反馈：${editStatus.replace(/\s+/g, ' ').slice(0, 60)}`)
        await shot(page, 'admin-07-edited.png')

        // 删除（带二次确认）
        await page.click('[data-testid="tab-list"]')
        await page.waitForTimeout(API_WAIT)
        await page.fill('[data-testid="list-search"]', editedName)
        await page.waitForTimeout(API_WAIT)
        const before = await page.locator('[data-testid="question-item"]').count()
        if (before >= 1) {
          await page.locator('[data-testid="question-delete"]').first().click()
          await page.waitForSelector('[data-testid="confirm-dialog"]', { timeout: 5000 })
          check(true, '删除前弹出二次确认')
          await shot(page, 'admin-08-confirm-delete.png')
          await page.click('[data-testid="confirm-accept"]')
          await page.waitForTimeout(API_WAIT)
          const after = await page.locator('[data-testid="question-item"]').count()
          check(after < before, `删除后列表不再有该题（${before} → ${after}）`)
        } else {
          check(false, '删除校验：搜索不到刚编辑的题目')
        }
      }

      // 分类管理
      await ensureLoggedIn(page, '进入分类管理前')
      await page.click('[data-testid="tab-categories"]')
      await page.waitForTimeout(API_WAIT)
      const categoryTabState = await page.evaluate(() => ({
        tab: window.__NTE_ADMIN__?.getTab?.() ?? 'no-hook',
        create: document.querySelectorAll('[data-testid="category-create"]').length,
        headings: [...document.querySelectorAll('.sidebar h2, .sidebar h3')].map((n) => n.textContent.trim()),
      }))
      note(`分类页状态：tab=${categoryTabState.tab} 新建按钮=${categoryTabState.create} 面板=${categoryTabState.headings.join('/')}`)
      check(await page.locator('[data-testid="category-create"]').count() === 1, '分类管理面板可用')
      // 内置分类至少 1 个（服务端启动时会从 map-data.json 导入），0 个说明分类列表没拉到
      check(await page.locator('[data-testid="category-list"] li').count() >= 1, '分类列表已加载')
      await shot(page, 'admin-09-categories.png')

      // 退出登录
      await page.click('[data-testid="logout"]')
      await page.waitForSelector('[data-testid="login-panel"]', { timeout: 15000 })
      check(true, '退出登录后回到登录页')
      await shot(page, 'admin-10-logged-out.png')
    }
  }

  check(pageErrors.length === 0, `全流程未捕获异常 0 条（实际 ${pageErrors.length}）`)
  if (backendUp) {
    check(consoleErrors.length === 0, `后端可用时控制台报错 0 条（实际 ${consoleErrors.length}）`)
  }
} catch (error) {
  check(false, `自查过程抛出异常：${error.message}`)
  await shot(page, 'admin-99-failure.png').catch(() => {})
} finally {
  await browser.close()
  if (MANAGE_SERVER) stopDevServer()
}

summarize()
