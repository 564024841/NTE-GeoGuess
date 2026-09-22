// 地图上区域标签的落点。
//
// 这是内容数据（每个区域摆在哪），不是规则，所以放在 data/ 下。
// 位置来自各区域已有点位的重心；6 个区域分类的点位在数据整理中被删除后，
// 这里保留了位置作为权威来源，地图上的区域名标签就用它。
import positions from '../data/region-positions.json'
import { REGION_CATEGORY_IDS } from './constants.js'

export const REGION_POSITIONS = positions.regions

// 按 id 取；顺带把 label 对齐到代码里约定的区域名，避免两处写得不一致
export function getRegionPositions() {
  return REGION_POSITIONS.map((region) => ({
    ...region,
    // region-positions.json 里没写 label 时用常量表兜底
    label: region.label
      || Object.entries(REGION_CATEGORY_IDS).find(([, id]) => id === region.id)?.[0]
      || region.id,
  }))
}
