// 内置数据快照的访问入口。
//
// 单独放一个模块的好处：只有真正需要「初始题库快照」的地方才会引到这份 700KB 数据，
// 其余模块（几何、评分、抽题）都保持轻量。
//
//   · 后端首次启动时用它做 seed
//   · 前端开发态可以在没有服务端时用它本地兜底
import mapData from '../data/map-data.json'
import calibration from '../data/navi-coordinate-calibration.json'
import { createGeometry } from './geometry.js'

export const SEED_MAP_DATA = mapData
export const SEED_MAP_CONFIG = mapData.map
export const SEED_CALIBRATION = calibration

export const seedGeometry = createGeometry(SEED_MAP_CONFIG, SEED_CALIBRATION)
