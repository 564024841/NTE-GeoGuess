// 底图瓦片本地化：拉取 / 校验 Maa-NTE/MapSource 的 tiles。
//
// 为什么要单独一个脚本：瓦片不在本项目仓库里（30MB，独立仓库），
// 但**运行时必须是本地的**——服务端只从磁盘读瓦片，没有任何远程回退。
// 所以「把瓦片弄到服务器上」这一步要可靠、可重试、可校验。
//
// 用法：
//   node scripts/tiles.mjs verify                 只校验现有瓦片
//   node scripts/tiles.mjs fetch                  拉取（浅克隆 + 稀疏检出，断点可重跑）
//   node scripts/tiles.mjs fetch --dest /srv/tiles  指定目标目录
//   node scripts/tiles.mjs mirror <源目录>          从已有瓦片目录复制（离线/内网传输用）
//
// 环境变量：
//   TILES_DIR         目标目录（默认「仓库同级的 MapSource/tiles」）
//   MAPSOURCE_REPO    仓库地址（默认官方地址；内网可指向自己的镜像）
//   MAPSOURCE_BRANCH  分支（默认 main）

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

const REPO = process.env.MAPSOURCE_REPO || 'https://github.com/Maa-NTE/MapSource.git'
const BRANCH = process.env.MAPSOURCE_BRANCH || 'main'

// 默认放在仓库同级目录：容器 compose 的 TILES_HOST_DIR 默认就指这里
const DEFAULT_TILES_DIR = path.resolve(ROOT, '..', 'MapSource', 'tiles')

function parseArgs(argv) {
  const args = [...argv]
  const command = args.shift() || 'verify'
  let dest = process.env.TILES_DIR ? path.resolve(process.env.TILES_DIR) : DEFAULT_TILES_DIR
  const rest = []
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--dest') {
      dest = path.resolve(args[i + 1])
      i += 1
    } else {
      rest.push(args[i])
    }
  }
  return { command, dest, rest }
}

function run(cmd, cmdArgs, options = {}) {
  const result = spawnSync(cmd, cmdArgs, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...options,
  })
  if (result.status !== 0) {
    throw new Error(`命令失败（退出码 ${result.status}）：${cmd} ${cmdArgs.join(' ')}`)
  }
}

// 期望的瓦片网格：从内置快照推出来，避免脚本和数据对不上
function expectedGrid() {
  const mapData = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'packages/shared/data/map-data.json'), 'utf8'),
  )
  const width = Number(mapData.map.width)
  const tileSize = Number(mapData.map.tileSize)
  return {
    width,
    tileSize,
    tiles: 51, // 由下面的校验在运行时核对，这里只用于提示
    computed: Math.ceil(width / tileSize),
  }
}

// 抽样 + 结构校验（和服务端启动时的自检同一套判据，但更全）
export function verifyTiles(dir) {
  const problems = []
  if (!fs.existsSync(dir)) {
    return { ok: false, problems: [`目录不存在：${dir}`], zoom0Dirs: 0, sampled: 0 }
  }

  const zoom0 = path.join(dir, '0')
  if (!fs.existsSync(zoom0)) {
    return { ok: false, problems: [`缺少 z=0 目录（${zoom0}）`], zoom0Dirs: 0, sampled: 0 }
  }

  const xDirs = fs.readdirSync(zoom0, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => Number(entry.name))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b)

  if (!xDirs.length) {
    return { ok: false, problems: ['z=0 下没有任何 x 目录（目录是空的）'], zoom0Dirs: 0, sampled: 0 }
  }

  const minX = xDirs[0]
  const maxX = xDirs[xDirs.length - 1]
  const grid = expectedGrid()
  if (xDirs.length !== grid.computed) {
    problems.push(
      `z=0 下 x 目录数 ${xDirs.length} 与地图预期 ${grid.computed} 不符`
      + `（地图 ${grid.width}px / 瓦片 ${grid.tileSize}px）`,
    )
  }
  if (minX !== 0) problems.push(`x 目录不是从 0 开始（最小 ${minX}）`)

  // 抽样：四角 + 中心 + 低分辨率层代表
  const midX = Math.floor((minX + maxX) / 2)
  const samples = [
    [0, minX, minX], [0, minX, maxX], [0, maxX, minX], [0, maxX, maxX], [0, midX, midX],
    [-3, Math.floor(midX / 8), Math.floor(midX / 8)],
    [-1, Math.floor(midX / 2), Math.floor(midX / 2)],
  ]

  let sampled = 0
  for (const [z, x, y] of samples) {
    const file = path.join(dir, String(z), String(x), `${y}.jpg`)
    if (!fs.existsSync(file)) {
      problems.push(`缺少瓦片 ${z}/${x}/${y}.jpg`)
      continue
    }
    const size = fs.statSync(file).size
    if (size < 100) problems.push(`瓦片 ${z}/${x}/${y}.jpg 只有 ${size} 字节，疑似损坏`)
    sampled += 1
  }

  // 统计总量
  let total = 0
  let bytes = 0
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.jpg')) {
        total += 1
        bytes += fs.statSync(full).size
      }
    }
  }
  walk(dir)

  return {
    ok: problems.length === 0,
    problems,
    zoom0Dirs: xDirs.length,
    xRange: [minX, maxX],
    sampled,
    total,
    megabytes: Math.round((bytes / 1024 / 1024) * 10) / 10,
  }
}

function printVerify(dir, result) {
  console.log(`=== 瓦片校验：${dir}`)
  if (result.zoom0Dirs) {
    console.log(`  z=0 的 x 目录    ${result.zoom0Dirs} 个（${result.xRange[0]}–${result.xRange[1]}）`)
    console.log(`  瓦片总数        ${result.total} 张 / ${result.megabytes} MB`)
    console.log(`  抽样通过        ${result.sampled} 张`)
  }
  if (result.ok) {
    console.log('  结论            完整可用')
  } else {
    console.log('  问题：')
    for (const problem of result.problems) console.log(`    x ${problem}`)
  }
}

function fetchTiles(dest) {
  // 瓦片仓库是独立仓库，用「浅克隆 + 稀疏检出」只取 tiles 目录，
  // 不拉 README 之类；失败可以重复执行（git 会续上已有对象）。
  const repoDir = path.dirname(dest)
  const wantDir = path.basename(dest)

  console.log(`=== 拉取瓦片`)
  console.log(`  仓库    ${REPO}`)
  console.log(`  分支    ${BRANCH}`)
  console.log(`  目标    ${dest}`)
  console.log('')

  if (!fs.existsSync(path.join(repoDir, '.git'))) {
    console.log('[1/4] 浅克隆（--filter=blob:none，只取需要的对象）…')
    fs.mkdirSync(repoDir, { recursive: true })
    run('git', ['clone', '--depth', '1', '--filter=blob:none', '--no-checkout', '--branch', BRANCH, REPO, repoDir])
  } else {
    console.log('[1/4] 目录已存在，跳过克隆')
  }

  console.log(`[2/4] 配置稀疏检出，只取 ${wantDir}/ …`)
  run('git', ['-C', repoDir, 'sparse-checkout', 'init', '--cone'])
  run('git', ['-C', repoDir, 'sparse-checkout', 'set', wantDir])

  console.log('[3/4] 检出文件…')
  run('git', ['-C', repoDir, 'checkout', BRANCH])

  console.log('[4/4] 校验…\n')
  const result = verifyTiles(dest)
  printVerify(dest, result)
  if (!result.ok) {
    console.log('\n提示：网络不稳可以重复执行本命令，git 会续传；')
    console.log('      也可以在内网一台机器上拉好后整目录拷过来（用 mirror 子命令）。')
    process.exitCode = 1
  }
}

function mirrorTiles(source, dest) {
  if (!fs.existsSync(source)) {
    console.error(`源目录不存在：${source}`)
    process.exitCode = 1
    return
  }
  const sourceResult = verifyTiles(source)
  printVerify(source, sourceResult)
  if (!sourceResult.ok) {
    console.error('\n源目录本身不完整，先修好再复制。')
    process.exitCode = 1
    return
  }

  console.log(`\n=== 复制到 ${dest}`)
  fs.mkdirSync(dest, { recursive: true })
  run('cp', ['-r', `${source}${path.sep}.`, dest], { shell: false })

  const result = verifyTiles(dest)
  printVerify(dest, result)
  if (!result.ok) process.exitCode = 1
}

// ---------- 入口 ----------

const { command, dest, rest } = parseArgs(process.argv.slice(2))

try {
  if (command === 'verify') {
    const result = verifyTiles(dest)
    printVerify(dest, result)
    if (!result.ok) process.exitCode = 1
  } else if (command === 'fetch') {
    fetchTiles(dest)
  } else if (command === 'mirror') {
    const source = rest[0] ? path.resolve(rest[0]) : null
    if (!source) {
      console.error('用法：node scripts/tiles.mjs mirror <源瓦片目录> [--dest <目标目录>]')
      process.exitCode = 1
    } else {
      mirrorTiles(source, dest)
    }
  } else {
    console.error(`未知子命令：${command}`)
    console.error('可用：verify | fetch | mirror')
    process.exitCode = 1
  }
} catch (error) {
  console.error(`\n失败：${error.message}`)
  process.exitCode = 1
}
