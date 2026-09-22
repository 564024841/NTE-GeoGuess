// 把 shared 包打包成浏览器与 Node 都能直接加载的产物。
//
// 为什么需要这一步：geometry.js 依赖 JSON 标定文件，
//   · 浏览器侧（Vite）直接 import JSON 没问题
//   · Node 的 ESM 加载 JSON 却要求 import attributes，直接跑源码会报
//     ERR_IMPORT_ATTRIBUTE_MISSING
// 用 esbuild 预先把 JSON 内联进产物，两个运行时拿到的就是同一份代码，
// 而且后端与前端跑的是同一段几何/评分数学。
import { build } from 'esbuild'
import { rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const outdir = path.join(root, 'dist')

rmSync(outdir, { recursive: true, force: true })

const result = await build({
  entryPoints: {
    index: path.join(root, 'src/index.js'),
    affine: path.join(root, 'src/affine.js'),
    geometry: path.join(root, 'src/geometry.js'),
    puzzles: path.join(root, 'src/puzzles.js'),
    scoring: path.join(root, 'src/scoring.js'),
    constants: path.join(root, 'src/constants.js'),
    format: path.join(root, 'src/format.js'),
    regionPositions: path.join(root, 'src/regionPositions.js'),
    regionInference: path.join(root, 'src/regionInference.js'),
    images: path.join(root, 'src/images.js'),
    imageRegistry: path.join(root, 'src/imageRegistry.js'),
  },
  outdir,
  bundle: true,
  format: 'esm',
  // 浏览器与 Node 20+ 都支持的语法级别
  target: ['es2022', 'node20'],
  sourcemap: true,
  logLevel: 'info',
})

if (result.errors.length) process.exitCode = 1
