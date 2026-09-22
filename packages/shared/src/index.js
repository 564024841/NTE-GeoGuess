// 共享逻辑的统一出口。
// 游戏前端、后台前端、后端都从这里取。
//
// 注意：这里刻意不导出 ./seed.js——那份内置地图数据有 700KB，
// 只有真正需要初始快照的地方（后端 seed、离线兜底）才显式 import '@nte-geoguess/shared/seed'。

export * from './constants.js'
export * from './affine.js'
export * from './geometry.js'
export * from './puzzles.js'
export * from './scoring.js'
export * from './format.js'
export * from './images.js'
export * from './imageRegistry.js'
