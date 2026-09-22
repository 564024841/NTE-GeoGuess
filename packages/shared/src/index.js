// 共享逻辑的统一出口。
// 游戏前端、后台前端、后端都从这里取。
//
// 注意：这里不含「题库快照」。题库 JSON 既不打包进前端、也不进镜像，
// 由后端从挂载的数据目录读（SEED_DATA_FILE），缺了由容器入口下载。
// 区域标签与区域推断参照点是几何/分类用的小数据，走 ./regionPositions 与 ./regionInference 两个子路径导出。

export * from './constants.js'
export * from './affine.js'
export * from './geometry.js'
export * from './puzzles.js'
export * from './scoring.js'
export * from './format.js'
export * from './images.js'
export * from './imageRegistry.js'
