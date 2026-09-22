// 服务端配置：全部来自环境变量，带合理默认值，方便本机直接 npm run dev。
//
// 部署相关变量见 docs/deployment.md。

import path from 'node:path'
import { fileURLToPath } from 'node:url'

const serverRoot = fileURLToPath(new URL('..', import.meta.url))
const repoRoot = path.resolve(serverRoot, '..')

// 允许用仓库根的 .env 提供部署环境变量（Node >= 20.12 自带能力，不需要 dotenv）。
//
// 用途：宝塔面板的「Node 项目（默认项目）」启动时只导出 PATH，不会注入任何自定义
// 环境变量，而启动命令里也不能写 `VAR=value cmd` 这种前缀（面板是 nohup 直接执行
// 第一个词）。所以生产环境把 PORT / STATIC_DIR / ADMIN_STATIC_DIR / TILES_DIR /
// DATA_DIR / REQUIRE_TILES / ADMIN_PASSWORD 等写进仓库根的 .env，由这里读取。
//
// 文件不存在时静默跳过；已经存在的真实环境变量优先级更高（loadEnvFile 不会覆盖）。
try {
  process.loadEnvFile(path.join(repoRoot, '.env'))
} catch {}

function env(name, fallback = '') {
  const value = process.env[name]
  return value === undefined || value === '' ? fallback : value
}

function envInt(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? '', 10)
  return Number.isFinite(value) ? value : fallback
}

function envBool(name, fallback) {
  const value = env(name)
  if (!value) return fallback
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase())
}

// 默认数据目录放在仓库根下的 data/，而不是 server/data/。
//
// 原因：`npm run dev:server` 用 `node --watch src/index.js`，
// Node 的 watcher 会盯着被运行脚本所在的整个目录树。SQLite 与上传的截图
// 恰好写在 server 目录里，于是每次写库都会触发服务端重启、会话被清空、
// 后台编辑中断。放到仓库根下就彻底避开了这个目录。
// 生产部署时用 DATA_DIR 指向挂载卷（见 deploy/docker-compose.yml）。
const dataDir = path.resolve(env('DATA_DIR', path.join(repoRoot, 'data')))

export const config = {
  nodeEnv: env('NODE_ENV', 'development'),
  get isProduction() {
    return this.nodeEnv === 'production'
  },
  host: env('HOST', '0.0.0.0'),
  port: envInt('PORT', 8787),

  // 数据目录：SQLite 与上传的截图都放这里，容器里挂卷
  dataDir,
  databaseFile: path.resolve(env('DATABASE_FILE', path.join(dataDir, 'nte-geoguess.sqlite'))),
  uploadsDir: path.resolve(env('UPLOADS_DIR', path.join(dataDir, 'uploads'))),

  // 内置素材（仓库自带）
  seedDataFile: path.resolve(env(
    'SEED_DATA_FILE',
    path.join(repoRoot, 'packages/shared/data/map-data.json'),
  )),
  calibrationFile: path.resolve(env(
    'CALIBRATION_FILE',
    path.join(repoRoot, 'packages/shared/data/navi-coordinate-calibration.json'),
  )),
  // 区域标签落点（内容数据，同样支持用挂载文件覆盖，不必进 git）
  regionPositionsFile: path.resolve(env(
    'REGION_POSITIONS_FILE',
    path.join(repoRoot, 'packages/shared/data/region-positions.json'),
  )),
  // 内置点位截图目录（public/images/locations）
  seedImagesDir: path.resolve(env(
    'SEED_IMAGES_DIR',
    path.join(repoRoot, 'apps/game/public/images/locations'),
  )),
  // 分类图标目录
  iconsDir: path.resolve(env(
    'ICONS_DIR',
    path.join(repoRoot, 'apps/game/public/icons'),
  )),
  // 底图瓦片目录（Maa-NTE/MapSource 的 tiles）
  tilesDir: path.resolve(env(
    'TILES_DIR',
    path.join(repoRoot, '..', 'MapSource', 'tiles'),
  )),

  // 后台鉴权
  adminPassword: env('ADMIN_PASSWORD', ''),
  sessionTtlHours: envInt('SESSION_TTL_HOURS', 12),
  loginMaxAttempts: envInt('LOGIN_MAX_ATTEMPTS', 5),
  loginWindowMinutes: envInt('LOGIN_WINDOW_MINUTES', 15),
  cookieSecure: envBool('COOKIE_SECURE', false),
  cookieName: 'nte_admin_session',

  // 登录后可跨域访问后台接口的来源（逗号分隔）。空 = 只允许同源。
  corsOrigins: env('CORS_ORIGINS', '').split(',').map((item) => item.trim()).filter(Boolean),

  // 底图瓦片对外的 URL 模板，下发给前端
  tileUrlTemplate: env('TILE_URL_TEMPLATE', '/mapsource-tiles/{z}/{x}/{y}.jpg'),
  // 需要反向代理到别处时可用（例如 CDN），留空表示由本服务提供
  tileRedirectBase: env('TILE_REDIRECT_BASE', ''),

  // 关闭启动时的 seed（例如数据已经迁移到外部库）
  disableSeed: envBool('DISABLE_SEED', false),

  // 设为 1 时，瓦片缺失会让服务端直接拒绝启动（默认只是警告）。
  // 生产建议打开：避免「服务起来了但底图全黑」这种难排查的状态。
  requireTiles: envBool('REQUIRE_TILES', false),
  logLevel: env('LOG_LEVEL', 'info'),

  // 请求体上限：截图以 data URL 提交，8MB 图片 base64 后约 11MB，取 32MB 余量
  bodyLimitBytes: envInt('BODY_LIMIT_BYTES', 32 * 1024 * 1024),
}

export function describeConfig() {
  return {
    nodeEnv: config.nodeEnv,
    host: config.host,
    port: config.port,
    dataDir: config.dataDir,
    databaseFile: config.databaseFile,
    uploadsDir: config.uploadsDir,
    seedDataFile: config.seedDataFile,
    seedImagesDir: config.seedImagesDir,
    iconsDir: config.iconsDir,
    tilesDir: config.tilesDir,
    tileUrlTemplate: config.tileUrlTemplate,
    adminPasswordConfigured: Boolean(config.adminPassword),
    tilesDir: config.tilesDir,
    requireTiles: config.requireTiles,
    cookieSecure: config.cookieSecure,
  }
}
